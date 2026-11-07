// The failure matrix (`runtime-scaffold.md` §4.2), as a total function.
//
// The principle it encodes: **refusal is not an error — it is the escalation signal.**
// Every failure has a named next actor, and the failure a human sees is preferred to
// the one silence hides. Two rules that follow from that and are easy to get wrong:
//
//   * never substitute `leave` for a failure. In `tick.ts` the cheap default is
//     silence because a wrong nudge costs a notification; here a fabricated `leave`
//     ends an episode silently, and a silent end is indistinguishable from success.
//   * a crash means a profile is *unavailable*, not wrong. No decision is invented in
//     its place, and work that needs it is parked rather than rerouted blindly —
//     rerouting needs the same grammar that just failed.
//
// `escalate` is total by construction: every cause returns, and a test walks every
// (cause × role × consecutive) triple asserting a next actor exists. A refusal with
// no next actor is the one outcome this file may not produce.

import type { Escalation, FailureCause, NextActor, Role } from "./types.ts";
import type { EscalationAction } from "./types.ts";

export interface Failure {
	cause: FailureCause;
	role: Role;
	/** How many times this cause has fired for this node in this chain. 1 = first. */
	consecutive: number;
	/** True when the node's grant is the chain root: it has no parent to re-plan. */
	isRoot: boolean;
	detail: string;
}

export function escalate(failure: Failure): Escalation {
	const base = { cause: failure.cause, role: failure.role, detail: failure.detail };
	switch (failure.cause) {
		case "refusal":
			return { ...base, ...refusalFor(failure) };
		case "suppressed":
			// Runtime behaviour is the refusal's; the *fix* is the corpus owner's, because a
			// non-span argument is a train/serve defect the runtime can only report.
			return {
				...base,
				...refusalFor(failure),
				alsoNotifies: "corpus_owner",
				detail: `${failure.detail} (suppressed argument logged as suppressed_total for the corpus owner)`,
			};
		case "unparseable":
			// The requestor decides within its own grant: first a re-decision under its
			// remaining budget, then the grant goes and the case degrades to row 7.
			return {
				...base,
				nextActor: failure.consecutive >= 2 ? "dispatcher" : "requestor",
				action: failure.consecutive >= 2 ? "revoke_grant" : "reroute",
				detail: `${failure.detail}${failure.consecutive >= 2 ? `; second malformed return, grant revoked` : ""}`,
			};
		case "contested_claim":
			return failure.consecutive >= 2
				? {
						...base,
						nextActor: "human",
						action: "flag_human",
						detail: `${failure.detail}; second denial for this path in this chain — the human resolves it`,
					}
				: {
						...base,
						// Not an error and not retried: the denial becomes a field of the profile's
						// next state, because that is a fact a model can act on.
						nextActor: "profile",
						action: "reroute",
						detail: `${failure.detail}; re-decide with the holder visible`,
					};
		case "chain_ceiling":
			return failure.consecutive >= 2
				? {
						...base,
						nextActor: "human",
						action: "flag_human",
						detail: `${failure.detail}; second ceiling hit in this chain — askHuman(Q_SCOPE) narrows the scope`,
					}
				: {
						...base,
						// At this node the admissible set is dispatch/publish/abandon/wait.
						nextActor: "orchestrator",
						action: "reroute",
						detail: `${failure.detail}; the node continues without spawn`,
					};
		case "bin_ceiling":
			if (failure.isRoot || failure.consecutive >= 2) {
				return {
					...base,
					nextActor: "human",
					action: "flag_human",
					detail: `${failure.detail}; the ceiling is elastic on human authority only`,
				};
			}
			return {
				...base,
				nextActor: "parent",
				action: "reroute",
				detail: `${failure.detail}; the parent re-plans under the budget it created`,
			};
		case "budget":
			return failure.isRoot
				? {
						...base,
						nextActor: "human",
						action: "flag_human",
						detail: `${failure.detail}; the root's budget is spent — hi gets Q_SCOPE and the human gets the bill`,
					}
				: {
						...base,
						nextActor: "parent",
						action: "reroute",
						detail: `${failure.detail}; the parent decides with a remaining budget smaller than it planned`,
					};
		case "grant_expired":
			// A grant that outlives its dispatcher must not be honoured by the next one; the
			// chain then ends, which is the conservative and correct failure.
			return {
				...base,
				nextActor: "dispatcher",
				action: "revoke_grant",
				detail: `${failure.detail}; the chain ends rather than resuming unverifiably`,
			};
		case "unavailable":
			return failure.consecutive < 3
				? {
						...base,
						nextActor: "dispatcher",
						action: "respawn",
						detail: `${failure.detail}; the instance is respawned with backoff, work is parked`,
					}
				: {
						...base,
						nextActor: "hosted",
						action: "escalate_lane",
						detail: `${failure.detail}; three consecutive failures — same grammar, hosted decision source, run marked degraded`,
					};
	}
}

/** Per-role refusal dispositions, RG §13's "refusal is never a permissive op" row.
 *  A worker that refuses blocks; it must not quietly do nothing, because a worker
 *  that never blocks hides its failures. */
function refusalFor(failure: Failure): { nextActor: NextActor; action: EscalationAction } {
	switch (failure.role) {
		case "hi":
			// The front door cannot go silent: the 1B lane speaks, or a human is told.
			return { nextActor: "oneB", action: "escalate_lane" };
		case "orch":
			return failure.consecutive >= 2
				? { nextActor: "hosted", action: "escalate_lane" }
				: { nextActor: "ladder", action: "reask_once" };
		case "worker":
			return { nextActor: "parent", action: "synthesize_block" };
		case "fetch":
			return { nextActor: "parent", action: "synthesize_drop" };
		case "search":
			return { nextActor: "parent", action: "partial_result" };
	}
}

/** The corrective action an escalation asks the dispatcher to take on the profile's
 *  behalf, when it has one. Returning `undefined` is the honest answer for
 *  escalations that are a report (a human flag, a parked node, a lane swap): those are
 *  rows and messages, never a fabricated call. */
export function correctiveOp(escalation: Escalation): { op: string; args: Record<string, string> } | undefined {
	switch (escalation.action) {
		case "synthesize_block":
			return { op: "block", args: {} };
		case "synthesize_drop":
			return { op: "drop", args: {} };
		default:
			return undefined;
	}
}
