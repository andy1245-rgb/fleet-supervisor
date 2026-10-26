// Manager configuration. Every limit that keeps an unattended supervisor from
// doing damage in one tick is explicit here rather than buried in the loop.
//
// Two of them are the human-in-the-loop policy. `ask` is how often the manager
// stops for the operator before acting, from AGENTFLEET_ASK (default "fork"),
// and `askByGroup` lets one project override it. The overrides are read from
// `<state>/policy.json`, so changing them never needs a restart of the loop and
// never needs a code change:
//
//   { "askByGroup": { "agentFleet": "always", "home": "often" } }
//
// A bare map — `{ "agentFleet": "always" }` — is accepted as well, and entries
// whose value is not a policy are ignored rather than trusted.
//
// Policies (`AskPolicy` in ./ask.ts):
//   never  — act, then report. The operator sees every action after the fact.
//   fork   — ask on a hard fork only: the models disagreed, the action kills a
//            live agent, or it reaches beyond this pane.
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

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { isAskPolicy, normalizePolicy, type AskPolicy } from "./ask.ts";

/** How far the manager goes when a cross-agent trigger fires. */
export type InspectorMode = "off" | "cheap" | "deep";

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
	/** Model that decides first: "needle3" or an OpenRouter model id. */
	primary: string;
	/** Model consulted when the primary refuses or is unsure. */
	escalator: string;
	/** Escalate when primary confidence is below this. */
	threshold: number;
	/** Lines of terminal tail handed to a decision model. */
	readLines: number;
	/** Concurrent terminal reads + decisions. */
	concurrency: number;
	/** Hard cap on prompts sent in a single tick. */
	maxPromptsPerTick: number;
	/** Minutes before the same pane may be nudged again. */
	nudgeCooldownMin: number;
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
	const state = env.AGENTFLEET_STATE_DIR || join(homedir(), ".pi", "agent", "fleet-state");
	const policyPath = join(state, "policy.json");
	return {
		intervalMs: num(env.AGENTFLEET_INTERVAL_MS, 60_000),
		once: bool(env.AGENTFLEET_ONCE),
		dry: bool(env.AGENTFLEET_DRY),
		primary: env.AGENTFLEET_PRIMARY || "needle3",
		escalator: env.AGENTFLEET_ESCALATOR || "z-ai/glm-5.3-flash",
		threshold: num(env.AGENTFLEET_THRESHOLD, 0.7),
		readLines: num(env.AGENTFLEET_READ_LINES, 40),
		concurrency: num(env.AGENTFLEET_CONCURRENCY, 4),
		maxPromptsPerTick: num(env.AGENTFLEET_MAX_PROMPTS, 3),
		nudgeCooldownMin: num(env.AGENTFLEET_COOLDOWN_MIN, 10),
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
