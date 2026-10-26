// Manager configuration. Every limit that keeps an unattended supervisor from
// doing damage in one tick is explicit here rather than buried in the loop.

import { homedir } from "node:os";
import { join } from "node:path";

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
	eventsPath: string;
	triggerHistoryPath: string;
	cooldownsPath: string;
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

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
	const state = env.AGENTFLEET_STATE_DIR || join(homedir(), ".pi", "agent", "fleet-state");
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
		eventsPath: join(state, "events.jsonl"),
		triggerHistoryPath: join(state, "triggers.json"),
		cooldownsPath: join(state, "cooldowns.json"),
		watchdog: env.AGENTFLEET_WATCHDOG !== "0",
	};
}
