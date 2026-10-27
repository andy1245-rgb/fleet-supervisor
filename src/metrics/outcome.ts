// Judging a decision by what happened next, instead of by what a human typed.
//
// Every label the miner can produce comes from a transcript, and a transcript
// only records the moments a human spoke. That makes `P(human intervened) = 1`
// for every mined row by construction: the corpus is 524 `nudge`, 3 `leave`, 0
// `flag`, 0 `declare_done`, and `always nudge` scores 0.9943 exact on it. The two
// ops that are actually worth anything to an operator — staying out of the way,
// and calling a finished job finished — are precisely the ones where nobody
// types, so they are structurally unmineable.
//
// The *outcome* is observable without a human. A pane carries two counters, and
// the tick already lists every agent, so one turn's silence can be judged on the
// next tick for free:
//
//   completion_seq advanced since the decision → the pane moved.
//   it did not, and the pane is resting, and the window has elapsed → it did not.
//
// The asymmetry is what makes this worth doing. A silent decision followed by
// stillness is a *counterexample*: the supervisor said nothing and lost whatever
// the pane was waiting for. Such a row exists with no human in it at all, which
// is exactly the kind of row a transcript cannot produce.
//
// What this is not: causal. An agent may move after a nudge because the nudge
// worked, because it finished the turn it was already in, because a test runner
// returned, or because a human typed into the pane. Nothing here observes the
// reason, so no row produced by this module distinguishes "the nudge helped" from
// "it moved anyway" — a nudge followed by movement can never become a positive
// label. Only the one direction is defensible: silence plus a still pane. Every
// consumer that turns these rows into labels must say so, and ./export-observed.ts
// does.
//
// This file is pure: one function that judges an observation, the pending record
// it judges, and the pure parse/serialise pair the store needs. No clock, no file
// system, no herdr. `tick.ts` reads and writes `pending.json`; the rule that
// decides what a pane's stillness means is here, where a test can pin it.

import { dirname, join } from "node:path";
import { isOp, type Op } from "../decision/types.ts";
import type { AgentStatus } from "../herdr/types.ts";

/** What a decision turned out to be, as far as the supervisor can see. */
export type OutcomeKind = "progressed" | "stalled" | "satisfied" | "reopened" | "unobserved";

/** One decision the supervisor made, waiting to be judged. `decidedAtSeq` is the
 *  pane's `completion_seq` at the moment of the decision: any later completion is
 *  the pane moving, and a sequence that is equal or lower is not. */
export interface PendingDecision {
	paneId: string;
	group: string;
	op: Op;
	argument: string;
	decidedAtSeq: number;
	/** Ticks already spent waiting. `judge` counts the current one on top. */
	ticksObserved: number;
}

/** The verdict on one decision. `movedSinceDecision` is false for `unobserved`:
 *  a pane that left the snapshot was not seen moving or seen still. */
export interface Outcome {
	paneId: string;
	op: Op;
	kind: OutcomeKind;
	ticksObserved: number;
	movedSinceDecision: boolean;
}

/** What the snapshot says about the pane this tick. `present: false` is the pane
 *  that is no longer in `agent list` — closed, or renamed out of the fleet. */
export interface Observation {
	completionSeq: number;
	status: AgentStatus;
	present?: boolean;
}

/** Ticks a silent decision is given before its stillness counts as a verdict.
 *  At the default one-minute interval that is three minutes of a parked agent,
 *  which is long enough that a slow model call does not read as a hang. */
export const DEFAULT_WINDOW_TICKS = 3;

/** Ops that send nothing to the pane. `leave` does nothing and `flag` only tells
 *  a human, so from the agent's side both are silence — which is why both are the
 *  ops whose outcome is worth judging. */
export function isSilent(op: Op): boolean {
	return op === "leave" || op === "flag";
}

/** The three states in which an agent is not working. Same set `detect.ts` counts
 *  `idleTicks` against, for the same reason: these are the states in which a pane
 *  can sit still because nobody told it what to do next. */
function resting(status: AgentStatus): boolean {
	return status === "idle" || status === "done" || status === "blocked";
}

/** Ticks observed once this observation is taken into account. Exported because
 *  the caller persists it on the decisions that are still waiting, and the two
 *  places must not disagree about whether the current tick counts. */
export function observedTicks(pending: PendingDecision): number {
	return pending.ticksObserved + 1;
}

/** The judgement, or undefined while the question is still open.
 *
 *  The rules, in the order they are applied — the first that matches decides:
 *
 *    * the pane is gone from the snapshot          → `unobserved`.
 *    * its sequence counter went backwards          → `unobserved`. A counter that
 *      shrank is an agent that restarted, and "did not move" is not something a
 *      rewritten counter can tell us. Judging it `stalled` would manufacture a
 *      counterexample out of a restart.
 *    * `completion_seq` advanced since the decision → `reopened` when the op was
 *      `declare_done` (it was stopped and then carried on: a premature stop), else
 *      `progressed`.
 *    * no advance, the pane is still working, or the window has not elapsed yet
 *      → undefined. Nothing has happened yet; a verdict now would be a guess.
 *    * no advance, resting, window elapsed, op was `declare_done` → `satisfied`.
 *    * no advance, resting, window elapsed, op was silent → `stalled`. This is the
 *      row the whole module exists for.
 *    * no advance, resting, window elapsed, op was `nudge` → undefined. A nudge
 *      that produced no movement is a repair rate, not a label; `stalled` is
 *      reserved for the decisions that asked for nothing.
 */
export function judge(pending: PendingDecision, now: Observation, windowTicks: number): Outcome | undefined {
	const ticksObserved = observedTicks(pending);
	const verdict = (kind: OutcomeKind, movedSinceDecision: boolean): Outcome => ({
		paneId: pending.paneId,
		op: pending.op,
		kind,
		ticksObserved,
		movedSinceDecision,
	});

	if (now.present === false) return verdict("unobserved", false);
	if (now.completionSeq < pending.decidedAtSeq) return verdict("unobserved", false);

	if (now.completionSeq > pending.decidedAtSeq) {
		return verdict(pending.op === "declare_done" ? "reopened" : "progressed", true);
	}

	if (!resting(now.status)) return undefined;
	if (ticksObserved < windowTicks) return undefined;

	if (pending.op === "declare_done") return verdict("satisfied", false);
	if (isSilent(pending.op)) return verdict("stalled", false);
	return undefined;
}

// -------------------------------------------------------------- persistence
//
// `pending.json` is a map, not a log: there is exactly one open question per pane
// (the newest decision wins, because that is the one whose consequences the
// operator is about to live with), and a judged decision leaves the file. The
// parse and serialise halves are here and pure so the shape of the state has one
// owner even though `tick.ts` is what touches the disk.

export type PendingFile = Record<string, PendingDecision>;

/** `<dir>/events.jsonl` → `<dir>/pending.json`: the state file sits beside the
 *  log it explains, so a state dir is moved or backed up as one thing. */
export function pendingPath(eventsPath: string): string {
	return join(dirname(eventsPath), "pending.json");
}

function text(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

function count(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

/** One record, from a hand-editable file. The key is the pane id, so an entry
 *  whose body disagrees with its key is read under the key: the map is the index. */
function toPending(paneId: string, raw: unknown): PendingDecision | undefined {
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return undefined;
	const bag = raw as Record<string, unknown>;
	const op = bag.op;
	if (!isOp(op)) return undefined;
	const group = text(bag.group);
	const argument = text(bag.argument);
	const decidedAtSeq = count(bag.decidedAtSeq);
	const ticksObserved = count(bag.ticksObserved);
	if (group === undefined || argument === undefined) return undefined;
	if (decidedAtSeq === undefined || ticksObserved === undefined) return undefined;
	return { paneId, group, op, argument, decidedAtSeq, ticksObserved };
}

/** Every usable record in the file. A malformed entry is dropped, not fatal: this
 *  state is bookkeeping, and one hand-edited line must not stop a tick. */
export function parsePending(source: string): Map<string, PendingDecision> {
	const out = new Map<string, PendingDecision>();
	if (source.trim() === "") return out;
	let raw: unknown;
	try {
		raw = JSON.parse(source) as unknown;
	} catch {
		return out;
	}
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return out;
	for (const [paneId, value] of Object.entries(raw as Record<string, unknown>)) {
		const record = toPending(paneId, value);
		if (record) out.set(paneId, record);
	}
	return out;
}

/** What is written back. Sorted by pane id so a rewrite that changed nothing
 *  produces the same bytes — a state file that churns is a state file that cannot
 *  be diffed against yesterday's. */
export function pendingJson(pending: ReadonlyMap<string, PendingDecision>): PendingFile {
	const out: PendingFile = {};
	for (const paneId of [...pending.keys()].sort((a, b) => a.localeCompare(b))) {
		const record = pending.get(paneId);
		if (record) out[paneId] = record;
	}
	return out;
}

/** Records a decision, replacing whatever was open for that pane. The newest
 *  decision wins because the older one's window has been superseded — judging
 *  both would attribute the same stillness to two different ops. */
export function recordPending(pending: ReadonlyMap<string, PendingDecision>, decision: PendingDecision): Map<string, PendingDecision> {
	const out = new Map(pending);
	out.set(decision.paneId, decision);
	return out;
}

/** A decision taken now, with an empty window. Callers pass the pane's
 *  `completion_seq` as it stood *after* the move that triggered the decision, so
 *  the tick's own movement is never counted as an answer to the decision. */
export function decidedAt(decision: { paneId: string; group: string; op: Op; argument: string }, completionSeq: number): PendingDecision {
	return { paneId: decision.paneId, group: decision.group, op: decision.op, argument: decision.argument, decidedAtSeq: completionSeq, ticksObserved: 0 };
}
