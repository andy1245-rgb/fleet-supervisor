// Where every file this system reads lives, resolved in one place.
//
// Three copies of the state-dir string existed before this file: the supervisor's
// `config.ts`, the GUI's `paths.mjs` and `fleet-manager`'s `fast.ts`. They agreed by
// accident, and the day one of them was overridden with `AGENTFLEET_STATE_DIR` the
// other two would have read a different directory while both claiming to report the
// same supervisor. So the resolution lives here, and the three callers import it.
//
// Every function takes `env` as an argument with `process.env` as the default, so a
// test can point the core at a temp directory without mutating the process.

import { homedir } from "node:os";
import { join, resolve } from "node:path";

/** The supervisor's state dir: `AGENTFLEET_STATE_DIR`, else `~/.pi/agent/fleet-state`. */
export function stateDir(env: NodeJS.ProcessEnv = process.env): string {
	return env.AGENTFLEET_STATE_DIR || join(homedir(), ".pi", "agent", "fleet-state");
}

/** The claim registry: one file per pane, worker-authored. */
export function registryDir(env: NodeJS.ProcessEnv = process.env): string {
	return env.AGENTFLEET_REGISTRY || join(homedir(), ".pi", "agent", "fleet");
}

/** The installed pi profile, whose tier table the fast switch rewrites. */
export function profilesFile(env: NodeJS.ProcessEnv = process.env): string {
	return env.FLEET_RULES_CONFIG || join(homedir(), ".pi", "profiles", "config.json");
}

/** The notes board, whose directories are offered as places to start a conversation. */
export function notesDir(env: NodeJS.ProcessEnv = process.env): string {
	return env.FLEET_NOTES_DIR || join(homedir(), ".pi", "agent", "fleet-notes");
}

/** The supervisor's checkout. `fleet-manager` resolves its own sibling by URL; this
 *  process has no such relation to it, and one env var beats a guess in a route. */
export function agentFleetRoot(env: NodeJS.ProcessEnv = process.env): string {
	return resolve(env.AGENTFLEET_ROOT || join(homedir(), "agentFleet"));
}

/** The state files the supervisor writes, by the name `loadConfig` gives them.
 *  `settings` and `decision-mode` sit beside `policy.json` because the operator's
 *  decisions already live in this directory. */
export function statePaths(dir: string): {
	dir: string;
	events: string;
	asks: string;
	marks: string;
	triggers: string;
	cooldowns: string;
	pending: string;
	policy: string;
	settings: string;
	decisionMode: string;
} {
	return {
		dir,
		events: join(dir, "events.jsonl"),
		asks: join(dir, "asks.jsonl"),
		marks: join(dir, "marks.json"),
		triggers: join(dir, "triggers.json"),
		cooldowns: join(dir, "cooldowns.json"),
		pending: join(dir, "pending.json"),
		policy: join(dir, "policy.json"),
		settings: join(dir, "settings.json"),
		decisionMode: join(dir, "decision-mode.json"),
	};
}

/** The checked-in sample fleet. The bytes stay in the GUI's `fixtures/` (they are
 *  data about a sample fleet); the rule that may use them is the core's. */
export function fixturePaths(dir: string): {
	dir: string;
	events: string;
	asks: string;
	marks: string;
	triggers: string;
	cooldowns: string;
	pending: string;
	policy: string;
	panes: string;
	claims: string;
	meta: string;
	workspaces: string;
	transcripts: string;
	tails: string;
} {
	return {
		dir,
		events: join(dir, "events.jsonl"),
		asks: join(dir, "asks.jsonl"),
		marks: join(dir, "marks.json"),
		triggers: join(dir, "triggers.json"),
		cooldowns: join(dir, "cooldowns.json"),
		pending: join(dir, "pending.json"),
		policy: join(dir, "policy.json"),
		panes: join(dir, "panes.json"),
		claims: join(dir, "claims"),
		meta: join(dir, "fixture.json"),
		workspaces: join(dir, "workspaces.json"),
		transcripts: join(dir, "transcripts.json"),
		tails: join(dir, "tails.json"),
	};
}

/** The one script that releases a held ask. Quoted into documents, never shelled by
 *  a route: the server spawns it with an argv array. */
export function answerScript(root: string): string {
	return join(root, "src", "manager", "answer.ts");
}

export function answerVerb(root: string, id: string, verdict: "yes" | "no" = "yes"): string {
	return `node ${answerScript(root)} ${id} ${verdict}`;
}

/** The 24h report, as a command a person can run. Display only. */
export function reportVerb(root: string, window: string): string {
	return `node ${join(root, "src", "metrics", "report.ts")} --window=${window} --json`;
}
