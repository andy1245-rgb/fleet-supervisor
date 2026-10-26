// The ask gate. How often the supervisor stops for the operator before acting is
// a policy, so it is computed here from the policy and the facts the tick already
// holds — never by a hardcoded rule buried in the action path.
//
// A *fork* is a concrete reason not to act unilaterally: the two decision models
// disagreed, the action cannot be undone, it has consequences outside this pane,
// the nudge redirects the agent out of its own tree, or the tick is already at
// its prompt cap. Policies differ only in which severities they care about.
//
// Pure by construction: no fs, no fetch, no clock. Every input is an argument, so
// the gate is testable without a fleet, and `askId` is deterministic for a seed.

import { isAbsolute, relative, resolve, sep } from "node:path";
import type { Decision, Op } from "../decision/types.ts";
import type { Trigger } from "./triggers.ts";

export type AskPolicy = "never" | "fork" | "often" | "always";

export const ASK_POLICIES: readonly AskPolicy[] = ["never", "fork", "often", "always"];

export function isAskPolicy(value: unknown): value is AskPolicy {
	return typeof value === "string" && (ASK_POLICIES as readonly string[]).includes(value);
}

/** Anything unrecognised — a hand-edited policy.json, a stale env var — means the
 *  default: a fork is worth stopping for. */
export function normalizePolicy(value: unknown): AskPolicy {
	return isAskPolicy(value) ? value : "fork";
}

export interface Fork {
	reason: string;
	severity: "hard" | "soft";
}

/** A nudge longer than this is a brief, not a nudge. */
export const NUDGE_LENGTH_LIMIT = 300;

/** Everything the gate is allowed to look at. All of it is already in the tick. */
export interface AskInput {
	/** The op about to be performed. */
	op: Op;
	/** nudge → the text to send; declare_done → the summary to claim. */
	argument: string;
	/** The pane the action targets. */
	paneId: string;
	/** That pane's own tree: the boundary a nudge may not redirect past. */
	cwd: string;
	/** Home, so `~/…` in a nudge resolves to a real path instead of a guess. */
	home?: string;
	/** Ladder trail. Two entries means the escalator was consulted. */
	trail: readonly Decision[];
	/** This tick's cross-agent triggers. */
	triggers: readonly Trigger[];
	/** Prompts already sent this tick. */
	promptsSent: number;
	maxPromptsPerTick: number;
}

export interface AskDecision {
	ask: boolean;
	why: string;
	forks: Fork[];
}

/** Path-shaped tokens a nudge could hand an agent: absolute, parent-relative or
 *  homedir-relative. A bare `a/b` is deliberately not a candidate — it can only
 *  resolve inside the agent's own tree, so it is not a redirection. */
const PATH_TOKEN = /(?:^|[\s"'`([<=>,;:])(~?(?:\.{1,2})?\/[^\s"'`)\]}>,;]+)/g;

function pathTokens(text: string): string[] {
	const tokens: string[] = [];
	for (const match of text.matchAll(PATH_TOKEN)) {
		const token = match[1];
		// `scheme://host` arrives here as `//host`: a URL is not a filesystem path.
		if (token === undefined || token.startsWith("//")) continue;
		tokens.push(token);
	}
	return tokens;
}

function insideTree(tree: string, target: string): boolean {
	if (tree.trim() === "") return false;
	const rel = relative(resolve(tree), resolve(target));
	return rel === "" || rel.split(sep)[0] !== "..";
}

/** True when a token would send the agent outside its own tree. Resolved against
 *  the *agent's* cwd, never the supervisor's — the supervisor's cwd has nothing
 *  to do with the pane. */
function escapesTree(cwd: string, home: string | undefined, token: string): boolean {
	if (cwd.trim() === "") return true;
	let target = token;
	if (target.startsWith("~/")) {
		if (!home) return true;
		target = `${home}/${target.slice(2)}`;
	}
	return !insideTree(cwd, isAbsolute(target) ? target : resolve(cwd, target));
}

/** Every contested reason to hold this action. Empty means nothing is contested. */
export function detectFork(args: AskInput): Fork[] {
	const forks: Fork[] = [];

	// a. disagreement — the ladder escalated and the two models chose differently.
	const first = args.trail[0];
	const last = args.trail.length > 1 ? args.trail[args.trail.length - 1] : undefined;
	if (first !== undefined && last !== undefined && first.op !== last.op) {
		forks.push({ reason: `primary chose ${first.op}, escalator chose ${last.op}`, severity: "hard" });
	}

	// b. irreversible — a done claim tells a live agent to stop.
	if (args.op === "declare_done") {
		forks.push({ reason: "declare_done stops a live agent and cannot be silently undone", severity: "hard" });
	}

	// c. cross-agent — acting here is not only about this pane.
	for (const trigger of args.triggers) {
		if (trigger.kind !== "collision" && trigger.kind !== "churn") continue;
		if (!trigger.paneIds.includes(args.paneId)) continue;
		forks.push({ reason: `${trigger.kind} in ${trigger.group}: ${trigger.detail}`, severity: "hard" });
	}

	// d. scope-change — the nudge is a redirection rather than a nudge.
	if (args.op === "nudge") {
		if (args.argument.length > NUDGE_LENGTH_LIMIT) {
			forks.push({ reason: `nudge is ${args.argument.length} chars (limit ${NUDGE_LENGTH_LIMIT})`, severity: "soft" });
		}
		const outside = pathTokens(args.argument).filter((token) => escapesTree(args.cwd, args.home, token));
		if (outside.length > 0) {
			forks.push({ reason: `nudge names ${outside.join(", ")} outside ${args.cwd || "its cwd"}`, severity: "soft" });
		}
		// e. at-cap — one more prompt would exceed this tick's budget.
		if (args.promptsSent >= args.maxPromptsPerTick) {
			forks.push({
				reason: `${args.promptsSent} prompts already sent this tick (cap ${args.maxPromptsPerTick})`,
				severity: "soft",
			});
		}
	}

	return forks;
}

function list(forks: readonly Fork[]): string {
	return forks.map((fork) => fork.reason).join("; ");
}

/** The whole policy table. `leave` is never an action, so it is never asked
 *  about — including under `always`. */
export function shouldAsk(policy: AskPolicy, context: AskInput): AskDecision {
	const forks = detectFork(context);
	const hard = forks.filter((fork) => fork.severity === "hard");
	const soft = forks.filter((fork) => fork.severity === "soft");

	switch (normalizePolicy(policy)) {
		case "never":
			return { ask: false, why: "policy never: act, then report", forks };

		case "fork":
			if (hard.length > 0) return { ask: true, why: `hard fork: ${list(hard)}`, forks };
			return { ask: false, why: soft.length > 0 ? `policy fork ignores soft fork: ${list(soft)}` : "no fork", forks };

		case "often":
			if (hard.length > 0) return { ask: true, why: `hard fork: ${list(hard)}`, forks };
			if (soft.length > 0) return { ask: true, why: `soft fork: ${list(soft)}`, forks };
			return { ask: false, why: "no fork", forks };

		case "always":
			if (context.op === "leave") return { ask: false, why: "policy always, but leave is not an action", forks };
			return { ask: true, why: forks.length > 0 ? `policy always with fork: ${list(forks)}` : "policy always: every action", forks };
	}
}

function hash32(seed: string): string {
	let hash = 2166136261;
	for (let i = 0; i < seed.length; i += 1) {
		hash ^= seed.charCodeAt(i);
		hash = Math.imul(hash, 16777619);
	}
	return (hash >>> 0).toString(36).padStart(7, "0");
}

/** 8 characters, deterministic from the seed. The caller seeds with the timestamp
 *  of the ask, so two identical asks in different ticks never share an id. */
export function askId(seed: string): string {
	return `${hash32(seed)}${hash32(`#${seed}`)}`.slice(0, 8);
}

export type AskStatus = "pending" | "answered";

/** One line of `<state>/asks.jsonl`. That file is the source of truth: a pending
 *  record outlives the supervisor, and the last line for an id is that id's
 *  state — which is what makes answering an id twice impossible. */
export interface AskRecord {
	id: string;
	ts: string;
	paneId: string;
	group: string;
	op: Op;
	argument: string;
	why: string;
	forks: Fork[];
	/** The pane's tree at hold time, so a done claim can be answered after the
	 *  agent is gone. */
	cwd: string;
	status: AskStatus;
	answeredAt?: string;
	answer?: "yes" | "no";
	/** What answering actually did, for the audit trail. */
	applied?: string;
}
