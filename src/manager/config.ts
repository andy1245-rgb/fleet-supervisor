// Manager configuration. Every limit that keeps an unattended supervisor from
// doing damage in one tick is explicit here rather than buried in the loop.
//
// Two of them are the human-in-the-loop policy. `ask` is how often the manager
// stops for the operator before acting, from AGENTFLEET_ASK (default "fork"),
// and `askByGroup` lets one project override it. The overrides are read from
// `<state>/policy.json`, so changing them never needs a restart of the loop and
// never needs a code change:
//
//   { "askByGroup": { "fleet-supervisor": "always", "home": "often" } }
//
// A bare map — `{ "fleet-supervisor": "always" }` — is accepted as well, and entries
// whose value is not a policy are ignored rather than trusted.
//
// Policies (`AskPolicy` in ./ask.ts):
//   never  — act, then report. The operator sees every action after the fact.
//   fork   — ask on a hard fork only: the action kills a live agent, or it
//            reaches beyond this pane. A model disagreement is deliberately not
//            a fork — a refusal is not an opinion (see ./ask.ts).
//   often  — ask on any fork, soft ones included: the tick is at its prompt cap,
//            or the nudge is long / names a path outside the agent's tree.
//   always — ask on every non-`leave` decision.
//
// `inspector` is the other spend control: how cross-agent triggers are handled,
// from AGENTFLEET_INSPECTOR. `off` announces a trigger and stops there, `cheap`
// asks the escalator for a finding, `deep` gives one bounded `pi -p` child a look
// first. `maxInspectionsPerTick` caps a trigger storm at a fixed number of
// findings per tick, worst first, so a fleet-wide flap cannot become a
// fleet-wide spend. Nothing here lets an inspection act: a finding is a proposal
// and the ask gate still decides.
//
// `dailyCostCapUsd` is the one limit that is not per tick or per pane, and it is
// the only one that bounds a day. `AGENTFLEET_MAX_PROMPTS=3` at a 60 s interval
// still permits 4,320 prompts a day by construction; a dollar ceiling is what makes
// that a number and not an unbounded one. It is checked in ./tick.ts before the
// first model call.
//
// `globalSpendCapUsd` is the second one, wider: it bounds the *whole account's* day
// (every agent on this machine plus this supervisor, see ../metrics/global.ts) rather
// than only what the supervisor spent. Two caps, one rule — whichever is lower and
// enabled wins — stated where the check runs, in ./tick.ts. Both are **off until the
// operator sets them**: the fleet's own cap ships `null` too, so a fresh install spends
// and records rather than refusing.

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { DEFAULT_TIMEOUT_MS, EFFORTS, type ReasoningEffort } from "../decision/adapters/commandcode.ts";
import { isAskPolicy, normalizePolicy, type AskPolicy } from "./ask.ts";
import { stateDir } from "../fleet/where.ts";

/** How far the manager goes when a cross-agent trigger fires. */
export type InspectorMode = "off" | "cheap" | "deep";

/** `reasoning.effort` for a hosted decision call. `low`, deliberately not `none`.
 *
 *  `none` is cheaper and it is legal on this wire, but it was never measured for answer
 *  quality, and it is not a free choice: it changes the request. On one 145,746-byte
 *  body, `high` → `none` with no other field touched cut the *prompt* from 35,830 to
 *  30,099 tokens, because the provider stops rendering replayed reasoning items
 *  (`P4-7oh.md §6.1`). Turning it down therefore buys a smaller bill and asks a
 *  different question in the same edit, which is the one thing a default must not do. */
export const DEFAULT_EFFORT: ReasoningEffort = "low";

/** Anything unrecognised means the default rather than passing through: the provider
 *  rejects `off` with HTTP 400, and a typo in an env var must not cost a tick. */
export function normalizeEffort(value: unknown): ReasoningEffort {
	return typeof value === "string" && (EFFORTS as readonly string[]).includes(value) ? (value as ReasoningEffort) : DEFAULT_EFFORT;
}

/** A hard ceiling on one local day's model spend, in dollars, or `null` for off.
 *
 *  `null`, matching the global cap, and for the operator's own reason: the fleet
 *  runs on a flat commandcode plan, so a dollar ceiling over calls that are not
 *  billed per token is a refusal with no saving behind it. Off is the shipped
 *  state; the mechanism is intact, tested, and one variable away — set
 *  `AGENTFLEET_DAILY_COST_CAP_USD=0.50` and the tick stops calling models at that
 *  number again. `0` is still accepted as the other way to say off, because it was
 *  the documented switch and an operator's `0` must not become a cap of nothing.
 *
 *  Stop *recording* spend when this is off? No. Accounting and refusal are two
 *  different promises: the tick still prices every call into `costUsd` and still
 *  folds the day's total, so the figure on the row and in the Cost screen is
 *  unchanged. Only the refusal is switched off. */
export const DEFAULT_DAILY_COST_CAP_USD: number | null = null;

/** The account's day, in dollars, or `null` for "not enforced".
 *
 *  `null` and not `0`, because this cap is a different question from the fleet's: it
 *  measures spend the supervisor does not control, so it must not arrive switched on
 *  for an operator who never asked for it. The operator has budget and does not want
 *  it biting today; the mechanism exists, is tested, and is off. Set it —
 *  `AGENTFLEET_GLOBAL_SPEND_CAP_USD=20` — and the tick stops calling models when the
 *  account's UTC day reaches that number. */
export const DEFAULT_GLOBAL_SPEND_CAP_USD: number | null = null;

/** Dollars, or `null` for off, or a rejection.
 *
 *  Every other limit in this file falls back to its default on nonsense, because a
 *  typo in `AGENTFLEET_CONCURRENCY` should not cost a tick. This one is the
 *  exception: a cap the operator believes he set and did not is the exact failure the
 *  cap exists to prevent, so `fifty` is an error at startup rather than a silent
 *  return to uncapped. Deliberately not `Number()`'s grammar — `0x10`, `1e3` and
 *  `0.5abc` are not dollar amounts an operator typed on purpose.
 *
 *  Unset, `""` and `"0"` all mean off. `null` rather than `0` as the off value, so
 *  "no cap" is one fact with one spelling rather than two that a reader has to
 *  reconcile — and so a `0` cannot be reported as "a cap of zero dollars". */
export function parseDailyCostCap(value: string | undefined): number | null {
	if (value === undefined || value.trim() === "") return DEFAULT_DAILY_COST_CAP_USD;
	const text = value.trim();
	if (!/^(\d+(\.\d*)?|\.\d+)$/.test(text)) {
		throw new Error(
			`AGENTFLEET_DAILY_COST_CAP_USD must be a non-negative dollar amount such as "0.50"; leave it unset (or 0) to disable the cap. Got "${value}"`,
		);
	}
	const n = Number(text);
	if (!Number.isFinite(n)) {
		throw new Error(`AGENTFLEET_DAILY_COST_CAP_USD is not a finite number: got "${value}"`);
	}
	return n === 0 ? null : n;
}

/** Dollars, or `null` for off, or a rejection.
 *
 *  Same grammar and the same refusal to fall back as `parseDailyCostCap`: an operator
 *  who sets `AGENTFLEET_GLOBAL_SPEND_CAP_USD=twenty` and gets a silently disabled cap
 *  believes he is covered when he is not. Unset and `""` mean `null` — off — because
 *  that is the documented default, and `"0"` means the same thing on purpose: `0`
 *  dollars is not a cap any fleet can tick under. */
export function parseGlobalSpendCap(value: string | undefined): number | null {
	if (value === undefined || value.trim() === "") return DEFAULT_GLOBAL_SPEND_CAP_USD;
	const text = value.trim();
	if (!/^(\d+(\.\d*)?|\.\d+)$/.test(text)) {
		throw new Error(
			`AGENTFLEET_GLOBAL_SPEND_CAP_USD must be a non-negative dollar amount such as "20"; leave it unset (or 0) to disable the cap. Got "${value}"`,
		);
	}
	const n = Number(text);
	if (!Number.isFinite(n)) {
		throw new Error(`AGENTFLEET_GLOBAL_SPEND_CAP_USD is not a finite number: got "${value}"`);
	}
	return n;
}

export const INSPECTOR_MODES: readonly InspectorMode[] = ["off", "cheap", "deep"];

function isInspectorMode(value: unknown): value is InspectorMode {
	return typeof value === "string" && (INSPECTOR_MODES as readonly string[]).includes(value);
}

/** Anything unrecognised means the default mode, not `off`: a typo must not
 *  silently turn Tier 2 back into a rule. */
export function normalizeInspectorMode(value: unknown): InspectorMode {
	return isInspectorMode(value) ? value : "cheap";
}

export interface Config {
	/** Seconds between ticks. */
	intervalMs: number;
	/** Run exactly one tick and exit. */
	once: boolean;
	/** Decide and report, but send no prompts and write no claim files. */
	dry: boolean;
	/** Observe: run the whole pipeline — stage 0's verdict for every pane, the model's
	 *  proposal for every pane that moved — record all of it, join each decision to the
	 *  pane's next observed state, and send nothing at all: no prompt, no notification,
	 *  no held ask. Distinct from `dry`, which decides and discards: a dry tick judges
	 *  nothing and records no pending decision, so there is no join to what happened
	 *  next, which is the whole point of observing. */
	observe: boolean;
	/** Model that decides first: a `commandcode/…` id for the responses wire, `needle3`
	 *  for the retired local engine, or an OpenRouter model id. */
	primary: string;
	/** Model consulted when the primary refuses or is unsure. */
	escalator: string;
	/** Escalate when primary confidence is below this. */
	threshold: number;
	/** `reasoning.effort` on a hosted decision call. */
	effort: ReasoningEffort;
	/** Per-call deadline for one decision. 90 s: the hosted call completed in 62.1 s and
	 *  64.6 s on the faithful-wire arm, so a 20 s cap records a timeout on a success. */
	decisionTimeoutMs: number;
	/** Lines of terminal tail handed to a decision model. */
	readLines: number;
	/** Concurrent terminal reads + decisions. */
	concurrency: number;
	/** Hard cap on prompts sent in a single tick. */
	maxPromptsPerTick: number;
	/** Minutes before the same pane may be nudged again. */
	nudgeCooldownMin: number;
	/** Hard ceiling on one local day's model spend, in dollars, or `null` for off (the
	 *  shipped state). The only limit here that is not per-tick: a tick that finds the
	 *  day at or over this makes no model call at all (see `tick.ts`). */
	dailyCostCapUsd: number | null;
	/** Hard ceiling on one **UTC** day's spend across every agent on this machine plus
	 *  the supervisor, in dollars. `null` or `0` disables it, and it is `null` by
	 *  default. When both caps are enabled the lower one is the one that fires. */
	globalSpendCapUsd: number | null;
	/** The per-call agent usage log the global cap reads. Local disk only: another
	 *  machine's spend is not in this file and no local file could hold it. */
	usageLogPath: string;
	/** How cross-agent triggers are investigated: off, cheap or deep. */
	inspector: InspectorMode;
	/** Findings per tick. A trigger storm is inspected worst-first, not in full. */
	maxInspectionsPerTick: number;
	/** Fleet-wide default: when a would-be action stops for the operator instead. */
	ask: AskPolicy;
	/** Per-group overrides of `ask`, keyed by the same group names grouping uses. */
	askByGroup: Record<string, AskPolicy>;
	eventsPath: string;
	triggerHistoryPath: string;
	cooldownsPath: string;
	/** Append-only log of held actions; the answer CLI resolves it. */
	asksPath: string;
	/** Where `askByGroup` is read from. */
	policyPath: string;
	/** Watchdog fan-out: report long-running commands each tick. */
	watchdog: boolean;
}

function num(value: string | undefined, fallback: number): number {
	const n = Number(value);
	return Number.isFinite(n) ? n : fallback;
}

function bool(value: string | undefined): boolean {
	return value === "1" || value === "true" || value === "yes";
}

/** Reads the group overrides. A malformed or absent file is not an error: the
 *  supervisor must keep running on its default policy rather than refuse a tick. */
function readGroupPolicies(path: string): Record<string, AskPolicy> {
	let raw: unknown;
	try {
		raw = JSON.parse(readFileSync(path, "utf8")) as unknown;
	} catch {
		return {};
	}
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return {};
	const bag = raw as Record<string, unknown>;
	const wrapped = bag.askByGroup;
	const source =
		typeof wrapped === "object" && wrapped !== null && !Array.isArray(wrapped)
			? (wrapped as Record<string, unknown>)
			: bag;
	const out: Record<string, AskPolicy> = {};
	for (const [group, policy] of Object.entries(source)) {
		if (isAskPolicy(policy)) out[group] = policy;
	}
	return out;
}

/** The only place the two sources are resolved, so a policy can never be read
 *  from one and applied from another. */
export function askPolicyFor(config: Config, group: string): AskPolicy {
	return config.askByGroup[group] ?? config.ask;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
	const state = stateDir(env);
	const policyPath = join(state, "policy.json");
	return {
		intervalMs: num(env.AGENTFLEET_INTERVAL_MS, 60_000),
		once: bool(env.AGENTFLEET_ONCE),
		dry: bool(env.AGENTFLEET_DRY),
		// Both may be set. Observe is the stricter promise (nothing leaves) and the one
		// that leaves a record, so where they differ it decides.
		observe: bool(env.AGENTFLEET_OBSERVE),
		// The decision step runs on the hosted model. AGENTFLEET_PRIMARY still selects
		// anything else, `needle3` included: the local engine is retired from the hot path,
		// not deleted, and its artefacts go in phase 8.
		primary: env.AGENTFLEET_PRIMARY || "commandcode/deepseek/deepseek-v4.1-flash",
		escalator: env.AGENTFLEET_ESCALATOR || "z-ai/glm-5.3-flash",
		threshold: num(env.AGENTFLEET_THRESHOLD, 0.7),
		effort: normalizeEffort(env.AGENTFLEET_EFFORT),
		decisionTimeoutMs: num(env.AGENTFLEET_DECISION_TIMEOUT_MS, DEFAULT_TIMEOUT_MS),
		readLines: num(env.AGENTFLEET_READ_LINES, 40),
		concurrency: num(env.AGENTFLEET_CONCURRENCY, 4),
		maxPromptsPerTick: num(env.AGENTFLEET_MAX_PROMPTS, 3),
		nudgeCooldownMin: num(env.AGENTFLEET_COOLDOWN_MIN, 10),
		dailyCostCapUsd: parseDailyCostCap(env.AGENTFLEET_DAILY_COST_CAP_USD),
		globalSpendCapUsd: parseGlobalSpendCap(env.AGENTFLEET_GLOBAL_SPEND_CAP_USD),
		usageLogPath: env.AGENTFLEET_USAGE_LOG || join(homedir(), ".pi", "agent", "usage.jsonl"),
		inspector: normalizeInspectorMode(env.AGENTFLEET_INSPECTOR),
		maxInspectionsPerTick: num(env.AGENTFLEET_MAX_INSPECTIONS, 2),
		ask: normalizePolicy(env.AGENTFLEET_ASK),
		askByGroup: readGroupPolicies(policyPath),
		eventsPath: join(state, "events.jsonl"),
		triggerHistoryPath: join(state, "triggers.json"),
		cooldownsPath: join(state, "cooldowns.json"),
		asksPath: join(state, "asks.jsonl"),
		policyPath,
		watchdog: env.AGENTFLEET_WATCHDOG !== "0",
	};
}
