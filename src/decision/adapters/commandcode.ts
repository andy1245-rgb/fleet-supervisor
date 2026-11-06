// Hosted `commandcode` adapter: one POST to the responses wire per decision.
//
// The body is the envelope R5 sent live and SPEC §4.2 pinned: `input[]` items with a
// bare-string system message, `max_output_tokens`, `reasoning.effort`, `stream: true`
// — and deliberately none of `messages`, `response_format`, `text.format` or
// `instructions`, because this wire accepts no output-constraint field at all. The
// output constraint is SYSTEM (`../prompt.ts`) plus `parseDecision`, unchanged.
//
// Two things this file does not do, both of them phase 2: it never retries (pi's own
// host retry already makes eight attempts on 429/5xx), and it holds no per-window
// cooldown, so a quota stop surfaces as a refusal and the ladder may spend one
// escalation on it.
//
// One invariant it does hold: every number it emits is either measured or absent on
// purpose. A token count the wire did not carry is 0 as a documented default; a cost
// the card cannot price is null with a reason. Nothing here can produce NaN, because
// these values reach the GUI's cost tile and the bench record, and a wrong dollar
// figure in either is worse than a missing one.

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { renderInput, SYSTEM } from "../prompt.ts";
import { parseDecision, type Decision, type DecisionInput, type DecisionModel } from "../types.ts";
import { responsesReader, type ResponsesOutcome, type ResponsesUsage } from "./responses.ts";

/** SPEC §4.7: a 4-op object needs ~40 tokens, but reasoning is inside this cap, and
 *  at 512 the reasoning models in this family burned the budget and answered nothing. */
export const DEFAULT_MAX_OUTPUT_TOKENS = 2048;

const BASE_URL = "https://api.commandcode.ai/provider/v1";

/** Exactly the values this provider accepts. `off` is not one of them: it is rejected
 *  with HTTP 400 on this wire (`none` is the value that stops reasoning).
 *
 *  `none` is a request parameter, not a decode lever. Measured on one 145,746-byte
 *  body: `effort: "high"` → `"none"` with no other field changed cut
 *  the *prompt* from 35,830 to 30,099 tokens, because with `none` the provider stops
 *  rendering the replayed reasoning items. So an experiment that flips it is not
 *  comparing two decodes of one input; it is comparing two inputs. Never tune it as
 *  though it were temperature. */
export const EFFORTS = ["none", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type ReasoningEffort = (typeof EFFORTS)[number];

/** USD per million tokens, the verified card (`pi-commandcode-provider/src/pricing.ts`). */
export const PRICES = { input: 0.15, output: 0.6, cacheRead: 0.003, cacheWrite: 0 } as const;

/** Headers as sent for the captured call. R5 records all five `x-…`/`User-Agent`
 *  headers as optional; they are sent here so the adapter's request is the one the
 *  fixture records rather than a near miss. */
const HEADERS = {
	"content-type": "application/json",
	accept: "text/event-stream",
	"x-command-code-version": "1.79.2",
	"x-cli-environment": "production",
	"x-project-slug": "fleet-supervisor",
	"x-taste-learning": "true",
	"user-agent": "cli",
} as const;

export interface CommandCodeOptions {
	/** Wire model id, e.g. `deepseek/deepseek-v4.1-flash`. */
	model: string;
	apiKey?: string;
	baseUrl?: string;
	timeoutMs?: number;
	maxOutputTokens?: number;
	effort?: ReasoningEffort;
	/** The clock the peak rule and the latency figure read. Injected only so a replay
	 *  of a capture can assert an exact dollar figure — the peak multiplier reads the
	 *  wall clock, so an un-injected replay would cost double between 01:00 and 04:00
	 *  UTC and 06:00 and 10:00 UTC on a weekday — and an exact latency. Production
	 *  leaves it undefined. */
	clock?: () => Date;
}

export interface CommandCodeBody {
	model: string;
	stream: true;
	input: [
		{ role: "system"; content: string },
		{ role: "user"; content: { type: "input_text"; text: string }[] },
	];
	max_output_tokens: number;
	reasoning: { effort: ReasoningEffort; summary: "auto" };
}

/** The request body. Pure, so a test can pin every field without a socket.
 *
 *  No `include` array. Phase 1 sent `["reasoning.encrypted_content"]` and the verdict
 *  is now measurable rather than assumed: the capture's 43 frames contain the string
 *  `encrypted_content` **zero** times, the echo carries no `include` field at all, and
 *  no error frame arrived — so the provider neither returns the blob nor rejects the
 *  request, it ignores the field. That blob only has a use if a caller replays
 *  reasoning items into a later request, which this adapter never does (every
 *  decision is a fresh system+user body), so sending it documented an intent the wire
 *  does not honour and made the request record disagree with what the provider does.
 *  Re-add it the day a response is seen carrying `encrypted_content`. */
export function buildRequest(input: DecisionInput, options: CommandCodeOptions): CommandCodeBody {
	return {
		model: options.model,
		stream: true,
		input: [
			{ role: "system", content: SYSTEM },
			{ role: "user", content: [{ type: "input_text", text: renderInput(input) }] },
		],
		max_output_tokens: options.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
		reasoning: { effort: options.effort ?? "low", summary: "auto" },
	};
}

export interface CredentialSource {
	env?: NodeJS.ProcessEnv;
	authPaths?: readonly string[];
	homeDir?: () => string;
}

export interface Credential {
	key: string;
	/** Where it came from, for a log line that is allowed to name a path but never a key. */
	from: string;
}

/** The three files the provider itself reads, in its order. */
function defaultAuthPaths(home: string): string[] {
	return [join(home, ".commandcode", "auth.json"), join(home, ".pi", "agent", "auth.json"), join(home, ".omp", "agent", "auth.json")];
}

function scopedKeyOf(value: unknown): string | undefined {
	if (typeof value === "string") return value;
	if (typeof value !== "object" || value === null) return undefined;
	const scoped = value as Record<string, unknown>;
	if (typeof scoped.key === "string") return scoped.key;
	if (typeof scoped.access === "string") return scoped.access;
	return undefined;
}

/** Resolution order: `COMMAND_CODE_API_KEY` → `COMMANDCODE_API_KEY` → the auth files,
 *  and inside a file the scoped `commandcode.key` **before** the top-level `apiKey`.
 *
 *  The scoped pass runs over every file before the flat pass runs over any, because
 *  the two-placement trap is not confined to one file: on the box this was built on,
 *  `~/.commandcode/auth.json` carries only a dead legacy `apiKey` and the live
 *  credential is the scoped entry in `~/.pi/agent/auth.json`. A per-file
 *  scoped-then-flat scan returns the dead key and 401s (see P1-adapter.md §2). */
export function resolveCredential(source: CredentialSource = {}): Credential {
	const env = source.env ?? process.env;
	if (env.COMMAND_CODE_API_KEY) return { key: env.COMMAND_CODE_API_KEY, from: "env:COMMAND_CODE_API_KEY" };
	if (env.COMMANDCODE_API_KEY) return { key: env.COMMANDCODE_API_KEY, from: "env:COMMANDCODE_API_KEY" };

	const paths = source.authPaths ?? defaultAuthPaths((source.homeDir ?? homedir)());
	const files: { path: string; parsed: Record<string, unknown> }[] = [];
	for (const path of paths) {
		if (!existsSync(path)) continue;
		try {
			const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
			if (typeof parsed === "object" && parsed !== null) files.push({ path, parsed: parsed as Record<string, unknown> });
		} catch {
			// A malformed auth file is skipped, not fatal: another one may hold the key.
		}
	}
	for (const { path, parsed } of files) {
		const scoped = scopedKeyOf(parsed.commandcode) ?? scopedKeyOf(parsed["command-code"]);
		if (scoped) return { key: scoped, from: `${path}[commandcode.key]` };
	}
	for (const { path, parsed } of files) {
		if (typeof parsed.apiKey === "string" && parsed.apiKey !== "") return { key: parsed.apiKey, from: `${path}[apiKey]` };
	}
	throw new Error("no commandcode credential: set COMMAND_CODE_API_KEY, or put commandcode.key in ~/.pi/agent/auth.json");
}

/** DeepSeek V4 rates are exactly 2x on weekdays 01–04 and 06–10 UTC. */
export function peakMultiplier(at: Date): number {
	const day = at.getUTCDay();
	if (day === 0 || day === 6) return 1;
	const hour = at.getUTCHours();
	return (hour >= 1 && hour < 4) || (hour >= 6 && hour < 10) ? 2 : 1;
}

export interface Accounting {
	/** The residual: `input_tokens` minus the cached prefix and cache writes. 0 when
	 *  the wire carried no input count — a documented zero, with `costUsd` null beside
	 *  it so the row cannot be read as a free call. */
	promptTokens: number;
	completionTokens: number;
	reasoningTokens: number;
	cacheReadTokens: number;
	cacheWriteTokens: number;
	/** Null when the two numbers the card needs were not both on the wire. A wrong
	 *  dollar figure is worse than a missing one: this value reaches the GUI's cost
	 *  tile and the bench record, and a $0 or a NaN built from a partial usage block
	 *  poisons both. */
	costUsd: number | null;
	/** Present exactly when `costUsd` is null, and says which field was missing. */
	costReason?: string;
}

/** A number the wire carried, or null.
 *
 *  The guard is here, at the arithmetic boundary, and not only in `usageOf`, because
 *  this function's argument can arrive from `JSON.parse` — the fixture loader and any
 *  later reader of a stored usage block hand it raw JSON — and TypeScript does not
 *  check what JSON holds. Before this guard, `accountUsage({inputTokens: {}})` returned
 *  `promptTokens: NaN, costUsd: NaN`, which the tick summed into `$NaN`. */
function finite(value: unknown): number | null {
	return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** Token and dollar accounting for one call.
 *
 *  The subtraction is the part that is easy to get wrong: the provider's
 *  `input_tokens` includes the cached tokens, so billing raw `input_tokens` as prompt
 *  tokens overbills the cached prefix by 50x ($0.15/M against $0.003/M). Reasoning is
 *  inside `output_tokens` and is billed as output, so it is reported and not added.
 *
 *  Three kinds of absence, three different answers, all of them documented:
 *    - a cached / cache-write / reasoning count the block omitted is 0, because there
 *      is no charge to account for and the provider's own arithmetic does the same;
 *    - `input_tokens` or `output_tokens` omitted makes the cost **null with a reason**,
 *      because those two are what the card cannot price;
 *    - no usage block at all leaves every token count at 0 and the cost null. */
export function accountUsage(usage: ResponsesUsage | undefined, at: Date): Accounting {
	const input = finite(usage?.inputTokens);
	const output = finite(usage?.outputTokens);
	const cacheReadTokens = finite(usage?.cachedTokens) ?? 0;
	const cacheWriteTokens = finite(usage?.cacheWriteTokens) ?? 0;
	const reasoningTokens = finite(usage?.reasoningTokens) ?? 0;
	const promptTokens = Math.max(0, (input ?? 0) - cacheReadTokens - cacheWriteTokens);
	const completionTokens = output ?? 0;
	const tokens = { promptTokens, completionTokens, reasoningTokens, cacheReadTokens, cacheWriteTokens };

	if (input === null || output === null) {
		const omitted = [input === null ? "input_tokens" : undefined, output === null ? "output_tokens" : undefined].filter(Boolean).join(" and ");
		return {
			...tokens,
			costUsd: null,
			costReason: usage === undefined ? "the response carried no usage block" : `the usage block omitted ${omitted}`,
		};
	}

	const costUsd =
		((promptTokens * PRICES.input + cacheReadTokens * PRICES.cacheRead + cacheWriteTokens * PRICES.cacheWrite + completionTokens * PRICES.output) / 1_000_000) *
		peakMultiplier(at);
	return { ...tokens, costUsd };
}

export interface DecisionMeta {
	model: string;
	/** Null when the card could not be priced. The Decision contract types `costUsd`
	 *  as a number (`../types.ts`, not this module's to widen), so the decision carries
	 *  0 and the returned `accounting` carries the null and its reason. */
	costUsd: number | null;
	latencyMs: number;
}

/** Which clock `latencyMs` came from. SPEC §4.8 defines latency as first byte to last
 *  event; a turn that failed before its first frame has no such number, so it is
 *  labelled rather than silently pooled with the streamed ones. */
export type LatencyDefinition = "first-byte-to-last-event" | "time-to-failure";

/** What `decide` hands back: the Decision the ladder consumes, plus the numbers that
 *  are reported rather than branched on. `Decision` carries only `costUsd` and
 *  `latencyMs`, so the tokens — and an honest null cost with its reason — ride here
 *  and can reach the metrics row without widening a contract every other adapter
 *  implements. */
export interface AccountedDecision extends Decision {
	readonly accounting: Accounting;
	readonly latencyDefinition: LatencyDefinition;
}

/** Turns one stream outcome into a Decision. A failure never becomes `leave` and never
 *  becomes `nudge` (SPEC §4.4) — it becomes `flag`, refused, with the reason in the
 *  argument, and a truncated fragment is named rather than parsed. */
export function decisionFrom(outcome: ResponsesOutcome, meta: DecisionMeta): Decision {
	// `?? 0` on the cost only here: a refusal is not a billed call, and the decision's
	// own field is a number. The null and its reason stay on `accounting`.
	const carried = { model: meta.model, costUsd: meta.costUsd ?? 0, latencyMs: meta.latencyMs };
	const base = { ...carried, raw: outcome.text, refused: true, confidence: 0 };
	switch (outcome.stop) {
		case "completed":
			// A completed turn can still carry no message item at all; parseDecision
			// returns its own `flag` for empty text rather than throwing.
			return parseDecision(outcome.text, carried);
		case "truncated":
			return { op: "flag", argument: `truncated at ${outcome.usage?.outputTokens ?? 0} output tokens`, ...base };
		case "filtered": {
			const type = outcome.contentFilter?.type;
			return { op: "flag", argument: type ? `content_filter: ${type}` : "content_filter", ...base };
		}
		case "failed":
		case "error":
			return { op: "flag", argument: `commandcode ${outcome.stop}: ${outcome.error?.message ?? "no message"}`, ...base };
		default:
			return { op: "flag", argument: "commandcode stream ended without a terminal event", ...base };
	}
}

/** A `DecisionModel` whose decisions also carry their accounting. The wider return type
 *  exists so a caller — the metrics row, a bench, a replay test — can read the token
 *  counts the `Decision` contract does not have a field for, without a cast. */
export interface CommandCodeModel extends DecisionModel {
	decide(input: DecisionInput): Promise<AccountedDecision>;
}

export function commandcodeModel(options: CommandCodeOptions): CommandCodeModel {
	const baseUrl = options.baseUrl ?? BASE_URL;
	const timeoutMs = options.timeoutMs ?? 20_000;
	const model = options.model;
	// Resolved at construction so a machine without a credential degrades the ladder
	// (buildLadderModels catches this) instead of failing one decision at a time.
	const credential = options.apiKey ? { key: options.apiKey, from: "options" } : resolveCredential();
	// Worst case for one call: the decision prompt in, the cap out.
	const costPerCallUsd = ((800 * PRICES.input + (options.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS) * PRICES.output) / 1_000_000) * 2;

	return {
		name: `commandcode:${model}`,
		costPerCallUsd,

		async decide(input: DecisionInput): Promise<AccountedDecision> {
			const clock = options.clock ?? (() => new Date());
			const at = clock();
			const startedAt = at.getTime();
			let firstByteAt: number | undefined;
			let lastEventAt = startedAt;
			const controller = new AbortController();
			const timer = setTimeout(() => controller.abort(), timeoutMs);
			try {
				const res = await fetch(`${baseUrl}/responses`, {
					method: "POST",
					headers: { ...HEADERS, authorization: `Bearer ${credential.key.trim()}` },
					body: JSON.stringify(buildRequest(input, { ...options, model })),
					signal: controller.signal,
				});
				if (!res.ok) {
					const detail = await res.text();
					throw new Error(`commandcode API error (${res.status}): ${detail.slice(0, 300)}`);
				}
				const body = res.body;
				if (!body) throw new Error("commandcode returned no body");

				const reader = responsesReader();
				const decoder = new TextDecoder();
				const chunks = body.getReader();
				let frames = 0;
				for (;;) {
					const { done, value } = await chunks.read();
					if (done) break;
					if (value === undefined) continue;
					const now = clock().getTime();
					if (firstByteAt === undefined) firstByteAt = now;
					// The timestamp of the last *frame*, not the last chunk. A keep-alive, a
					// trailing blank line or a frame split across two reads leaves a chunk that
					// carries no event, and timing the chunk instead of the event is how a
					// streamed call's latency quietly becomes a request-to-stream-end number.
					const handled = reader.feed(decoder.decode(value, { stream: true }));
					if (handled > 0) {
						frames += handled;
						lastEventAt = now;
					}
				}
				const outcome = reader.finish();
				// A terminal frame that arrived in the trailing buffer with no blank line after
				// it is still the last event.
				if (outcome.events > frames) lastEventAt = clock().getTime();
				// First byte to last event: what SPEC §4.8 defines, and the only latency a
				// streamed call can honestly report.
				const latencyMs = Math.max(0, lastEventAt - (firstByteAt ?? lastEventAt));
				const accounting = accountUsage(outcome.usage, at);
				return { ...decisionFrom(outcome, { model: outcome.model ?? model, costUsd: accounting.costUsd, latencyMs }), accounting, latencyDefinition: "first-byte-to-last-event" };
			} catch (e) {
				// A decision model that throws aborts the tick. Everything the wire can do
				// to us — a refused connection, a quota body, a deadline — becomes a
				// refusal with the reason in the argument, which the ladder can escalate.
				const reason = controller.signal.aborted ? `commandcode timeout after ${timeoutMs}ms` : (e as Error).message;
				return {
					op: "flag",
					argument: reason,
					confidence: 0,
					model,
					costUsd: 0,
					// Time to failure, not time to the last event: there was no event. Labelled
					// so the bench can keep the two apart instead of averaging them together.
					latencyMs: Math.max(0, clock().getTime() - startedAt),
					refused: true,
					raw: "",
					accounting: accountUsage(undefined, at),
					latencyDefinition: "time-to-failure",
				};
			} finally {
				clearTimeout(timer);
			}
		},
	};
}
