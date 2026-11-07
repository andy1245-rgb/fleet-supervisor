// The `pi` decision path: one subprocess, one system prompt, one JSON contract.
//
// This is the alternative to the hosted-responses adapter plus the escalation
// ladder (./adapters/commandcode.ts + ./escalation.ts). It exists because that
// arrangement has a top rung that has never fired on this box — the escalator is
// GLM through OpenRouter, there is no OpenRouter key here, so every escalation is a
// failed second call. One call with one contract has no dead layer to fail in.
//
// What it inherits from the adapter path, deliberately: `renderInput` (so the two
// modes are compared on identical input), and `parseDecision` (so a malformed answer
// is refused the same way). What it does not: the escalator. In this mode there is
// no second call at all, and the tick records that rather than leaving a quiet log
// that reads as agreement.
//
// Everything below is measured on this box; the numbers are in the phase report.
//
//   pi -p --provider commandcode --model deepseek/deepseek-v4.1-flash ...
//
// `--mode json` writes NDJSON and its last assistant `turn_end` carries the text, the
// usage block and the dollar figure, so nothing here has to assume a price. The
// flags that matter and why:
//
//   --thinking off     the value that stops reasoning on this build. `none` is not a
//                      `--thinking` level here (the level names are off/minimal/low/
//                      medium/high/xhigh/max) and `off` is proven to cap it at zero:
//                      `usage.reasoning` is 0 and every level above it both adds
//                      reasoning tokens and re-renders the request at ~16.7k input
//                      tokens, the same effect the adapter's `effort` field documents.
//   --no-tools         no tool schemas in the request. `--no-builtin-tools` is not
//                      enough: it keeps extension tools, which is where the bloat is.
//   --no-skills, --no-context-files, --no-prompt-templates
//                      nothing discovered on this machine may join the prompt. A
//                      decision must not depend on which repo `pi` was standing in.
//   --no-session       no session file, so a tick leaves nothing behind to resume.
//
// `--system-prompt` takes text or a path and tries the path first, so the prompt is
// passed as text: a multi-line string can never be mistaken for a file name.

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { renderInput } from "./prompt.ts";
import { parseDecision, type Decision, type DecisionInput, type DecisionModel } from "./types.ts";
import { stateDir } from "../fleet/where.ts";

/** The model the operator named, on the provider the adapter path already uses. */
export const PI_MODEL = "deepseek/deepseek-v4.1-flash";
export const PI_PROVIDER = "commandcode";

/** The `--thinking` level that means "no reasoning". Named here, next to the flags,
 *  so the row's `reasoning: "none"` and the argv cannot drift apart. */
export const PI_THINKING = "off";

/** Hard per-call deadline. The tick's own bound is 90 s (`decisionTimeoutMs`,
 *  measured on the hosted wire); this sits well under it so a slow call is a
 *  recorded timeout rather than a tick that overruns its interval. Measured cold
 *  start for one decision-sized call on this box: p50 2.0 s, p95 3.3 s. */
export const PI_TIMEOUT_MS = 45_000;

/** Twelve lines is the ceiling and this is eight. Each line is doing one job:
 *  line 1 says what decision this is; line 2 is the output contract the parser
 *  accepts; lines 3-6 are the four ops, one clause each, because a model that has
 *  not been told what `declare_done` means will invent a meaning; line 7 forbids
 *  inventing evidence; line 8 is the fail-soft rule, which is the one that must
 *  never break. No role-play, no worked example, no restatement of the rulebook. */
export const PI_SYSTEM = [
	"You supervise one unattended coding agent. Decide exactly one op for it.",
	'Reply with one JSON object and nothing else, always all three keys: {"op":"leave"|"nudge"|"declare_done"|"flag","argument":"<one sentence>","confidence":<0..1>}',
	"leave: it is on track — argument is a short reason.",
	"nudge: it stopped before finishing — argument is the instruction to send it.",
	"declare_done: its acceptance criteria are met — argument is what was delivered.",
	"flag: it needs a human — argument is the problem.",
	"Judge only from the fields given; never invent a fact.",
	"When uncertain, output leave. Doing nothing is safe; a wrong nudge is not.",
].join("\n");

/** What one `pi` process did. `timedOut` is separate from `code` because a kill
 *  and an exit are different failures and the row says which. */
export interface PiRun {
	code: number | null;
	stdout: string;
	stderr: string;
	timedOut: boolean;
}

/** Everything the module needs from outside itself. The runner is an injection point
 *  and nothing else: it is how the four fail-soft tests run without a network, and
 *  production never passes one. */
export type PiRunner = (argv: readonly string[], options: { env: NodeJS.ProcessEnv; cwd: string; timeoutMs: number }) => Promise<PiRun>;

export interface PiAccounting {
	/** `usage.input` as `pi` reported it. */
	promptTokens: number;
	completionTokens: number;
	reasoningTokens: number;
	/** `pi`'s own dollar figure, which reconciles against the verified card to the
	 *  microdollar on this wire. Null when the call never produced a usage block: a
	 *  cost of zero for a call that failed is a measurement nobody made. */
	costUsd: number | null;
	costReason?: string;
}

export interface PiDecision extends Decision {
	readonly accounting: PiAccounting;
}

/** A `DecisionModel` whose decisions also carry the usage block. Declared as its own
 *  interface rather than an intersection, so a caller that wants the tokens gets them
 *  without a cast while `tick.ts` still sees a plain `DecisionModel`. */
export interface PiModel {
	readonly name: string;
	readonly costPerCallUsd: number;
	decide(input: DecisionInput): Promise<PiDecision>;
}

export interface PiOptions {
	model?: string;
	provider?: string;
	timeoutMs?: number;
	/** The agent dir the child runs with. Owned by this module — see `provisionAgentDir`. */
	agentDir?: string;
	run?: PiRunner;
}

const ZERO_USAGE: PiAccounting = { promptTokens: 0, completionTokens: 0, reasoningTokens: 0, costUsd: null, costReason: "no usage block" };

/** The argv for one decision. Pure and exported so a test can assert the flags
 *  without a subprocess, and so the report can quote exactly what runs. */
export function piArgv(input: DecisionInput, options: PiOptions = {}): string[] {
	return [
		"-p",
		"--provider",
		options.provider ?? PI_PROVIDER,
		"--model",
		options.model ?? PI_MODEL,
		"--mode",
		"json",
		"--no-session",
		"--thinking",
		PI_THINKING,
		"--no-tools",
		"--no-skills",
		"--no-context-files",
		"--no-prompt-templates",
		"--system-prompt",
		PI_SYSTEM,
		renderInput(input),
	];
}

/** The real runner: one child, stdout and stderr collected, killed at the deadline.
 *
 *  `SIGKILL` and not `SIGTERM`: a node process that has an in-flight socket does not
 *  reliably honour a polite signal, and a tick waiting on a zombie is the failure
 *  mode this deadline exists to prevent. The kill is unconditional at the deadline;
 *  whatever arrived before it is returned with `timedOut` set, and the caller decides. */
const spawnRunner: PiRunner = (argv, { env, cwd, timeoutMs }) =>
	new Promise<PiRun>((resolve) => {
		let stdout = "";
		let stderr = "";
		let timedOut = false;
		let settled = false;
		const child = spawn("pi", [...argv], { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
		const finish = (code: number | null): void => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			resolve({ code, stdout, stderr, timedOut });
		};
		const timer = setTimeout(() => {
			timedOut = true;
			child.kill("SIGKILL");
		}, timeoutMs);
		child.stdout.setEncoding("utf8");
		child.stderr.setEncoding("utf8");
		child.stdout.on("data", (chunk: string) => {
			stdout += chunk;
		});
		child.stderr.on("data", (chunk: string) => {
			stderr += chunk;
		});
		child.on("error", (e) => {
			stderr += `spawn failed: ${e.message}`;
			finish(null);
		});
		child.on("close", (code) => finish(code));
	});

interface Turn {
	text: string;
	usage: PiAccounting;
}

/** The last assistant `turn_end` in the NDJSON stream, or the reason there is none.
 *
 *  A failed call is not a non-zero exit on this build: a bad model id warns on stderr
 *  and exits **0**, then reports `stopReason: "error"` with the provider's message in
 *  the stream. So the exit code alone is not a success signal and this function is
 *  the one that decides. */
export function readTurn(ndjson: string): { turn: Turn } | { error: string } {
	let found: Record<string, unknown> | undefined;
	for (const line of ndjson.split("\n")) {
		const trimmed = line.trim();
		if (trimmed === "") continue;
		let event: unknown;
		try {
			event = JSON.parse(trimmed);
		} catch {
			continue; // a non-JSON line is not a turn; the real one may be further on
		}
		if (typeof event !== "object" || event === null) continue;
		const bag = event as Record<string, unknown>;
		if (bag.type !== "turn_end") continue;
		const message = bag.message;
		if (typeof message !== "object" || message === null) continue;
		if ((message as Record<string, unknown>).role !== "assistant") continue;
		found = message as Record<string, unknown>;
	}
	if (found === undefined) return { error: "pi produced no assistant turn" };

	const stop = found.stopReason;
	if (typeof stop === "string" && stop !== "stop") {
		const detail = typeof found.errorMessage === "string" ? found.errorMessage : "";
		return { error: `pi stop reason ${stop}${detail === "" ? "" : `: ${detail.slice(0, 200)}`}` };
	}

	const content = found.content;
	const text =
		Array.isArray(content) && content.length > 0
			? content
					.map((part) => (typeof part === "object" && part !== null && typeof (part as Record<string, unknown>).text === "string" ? ((part as Record<string, unknown>).text as string) : ""))
					.join("")
			: "";
	if (text.trim() === "") return { error: "pi returned an empty answer" };

	const usage = found.usage;
	if (typeof usage !== "object" || usage === null) return { turn: { text, usage: ZERO_USAGE } };
	const u = usage as Record<string, unknown>;
	const num = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) ? value : 0);
	const costBag = typeof u.cost === "object" && u.cost !== null ? (u.cost as Record<string, unknown>) : undefined;
	const total = costBag?.total;
	return {
		turn: {
			text,
			usage: {
				promptTokens: num(u.input),
				completionTokens: num(u.output),
				reasoningTokens: num(u.reasoning),
				costUsd: typeof total === "number" && Number.isFinite(total) ? total : null,
				...(typeof total === "number" && Number.isFinite(total) ? {} : { costReason: "pi reported no cost.total" }),
			},
		},
	};
}

/** The auth files `pi` itself reads, in the same order the adapter resolves a
 *  credential from, so the two paths agree about which file holds the key. */
function authCandidates(home: string): string[] {
	return [join(home, ".pi", "agent", "auth.json"), join(home, ".omp", "agent", "auth.json"), join(home, ".commandcode", "auth.json")];
}

/** A `pi` agent dir that loads the provider and nothing else.
 *
 *  Not cosmetic. With the operator's own agent dir (`~/.pi/agent`, which loads the
 *  orchestration package) the same call reports a usage block that does not reconcile
 *  against the verified card — 54 input tokens for a request that cannot be that
 *  small, and a dollar figure 2.8x the card's arithmetic — and it intermittently
 *  reports ~16.7k input tokens instead. With only `pi-commandcode-provider` loaded,
 *  the same call is stable at `input: 115` and its own `cost.total` matches
 *  `input*0.15 + output*0.60` per million to the microdollar, off-peak. A metrics row
 *  is only worth recording if its price is the price.
 *
 *  `auth.json` is a **symlink** to the file the adapter already resolves, never a
 *  copy: the key is not read here, not duplicated, and not written anywhere. */
export function provisionAgentDir(dir: string, options: { home?: string } = {}): void {
	mkdirSync(dir, { recursive: true });
	const settings = join(dir, "settings.json");
	if (!existsSync(settings)) {
		writeFileSync(settings, `${JSON.stringify({ packages: ["npm:pi-commandcode-provider"] }, null, "\t")}\n`);
	}
	const auth = join(dir, "auth.json");
	if (existsSync(auth)) return;
	const home = options.home ?? homedir();
	for (const candidate of authCandidates(home)) {
		if (!existsSync(candidate)) continue;
		symlinkSync(candidate, auth);
		return;
	}
	// No credential file anywhere is not this module's error to raise: the call will
	// fail with pi's own message, which is what the row should carry.
}

/** A failure becomes the same `flag`/`refused` decision `parseDecision` returns for
 *  garbage, with the reason in the argument. Never throws, never `leave`, never
 *  `nudge`: a supervisor that cannot think must not act. */
function failure(reason: string, meta: { model: string; latencyMs: number }, usage: PiAccounting = ZERO_USAGE): PiDecision {
	return {
		op: "flag",
		argument: `pi: ${reason}`,
		confidence: 0,
		model: meta.model,
		costUsd: usage.costUsd ?? 0,
		latencyMs: meta.latencyMs,
		refused: true,
		raw: "",
		accounting: usage,
	};
}

export function piModel(options: PiOptions = {}): PiModel {
	const model = options.model ?? PI_MODEL;
	const timeoutMs = options.timeoutMs ?? PI_TIMEOUT_MS;
	const agentDir = options.agentDir ?? join(stateDir(), "pi-agent");
	const run = options.run ?? spawnRunner;
	const name = `pi:${model}`;
	// A subscription-free per-token call: the measured price of one decision, doubled
	// for the peak window, which is how the adapter path prices its own ceiling.
	const costPerCallUsd = (200 * 0.15 + 120 * 0.6) / 1_000_000;

	return {
		name,
		costPerCallUsd,

		async decide(input: DecisionInput): Promise<PiDecision> {
			const startedAt = Date.now();
			const meta = { model: name, latencyMs: 0 };
			try {
				provisionAgentDir(agentDir);
			} catch (e) {
				return failure(`agent dir ${agentDir} unusable: ${(e as Error).message}`, { ...meta, latencyMs: Date.now() - startedAt });
			}

			let result: PiRun;
			try {
				result = await run(piArgv(input, options), {
					// The child inherits the environment so it can find node and its own
					// paths; only the agent dir is overridden.
					env: { ...process.env, PI_CODING_AGENT_DIR: agentDir },
					// A neutral working directory: `pi` sends the cwd's git state in its
					// request body, so a decision must not depend on where the supervisor
					// happens to be standing.
					cwd: agentDir,
					timeoutMs,
				});
			} catch (e) {
				return failure(`could not run pi: ${(e as Error).message}`, { ...meta, latencyMs: Date.now() - startedAt });
			}
			const latencyMs = Date.now() - startedAt;

			if (result.timedOut) return failure(`timed out after ${timeoutMs} ms`, { ...meta, latencyMs });
			if (result.code !== 0) {
				const detail = result.stderr.trim().split("\n").slice(-2).join(" ").slice(0, 200);
				return failure(`exited ${result.code ?? "with no code"}${detail === "" ? "" : `: ${detail}`}`, { ...meta, latencyMs });
			}

			const read = readTurn(result.stdout);
			if ("error" in read) return failure(read.error, { ...meta, latencyMs });

			// The same defensive parse the adapter path uses. A missing `op` or a
			// non-object becomes `flag`+`refused`, which is "do nothing to the pane".
			const decision = parseDecision(read.turn.text, { model: name, costUsd: read.turn.usage.costUsd ?? 0, latencyMs });
			return { ...decision, accounting: read.turn.usage };
		},
	};
}
