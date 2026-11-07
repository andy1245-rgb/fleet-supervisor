// The one gate: the only path by which anything in this runtime mutates shared state.
//
// `src/manager/tick.ts` holds the same invariant for the fleet supervisor — exactly one
// component mutates, and `leave` is never gated — and this file mirrors that shape:
//
//   I1. Every mutation (a published artifact, a claim, a steer, a grant, a ledger row)
//       happens through this module, which owns the only handle on the run root. Three
//       methods mutate and no others: `dispatch` (an action), `intake` (the instruction
//       boundary, which is not an action), and `sweep` (the loop's own housekeeping); the
//       loop records its decision rows through `store.log`, never through a second handle.
//       `store.ts` is the only module that writes a file, so the invariant is checkable
//       by inspection and by test. The mutations themselves live in `effects.ts`.
//   I2. The cheap correct answer is free. `wait`, `done`, `drop` and every report are
//       ungated: never queued, never retried, never refused, one ledger row. In `tick.ts`
//       the ungated op is `leave`; here the grammars spell the same idea `orch.wait` /
//       `hi.done` / `fetch.drop`, and gating any of them would turn the majority of the
//       traffic into a queue.
//
// What the gate enforces, in this order and for this reason:
//
//   * **the licence** — the op must be in the catalogue of *the process that answered*.
//     A leaf orchestrator has no `spawn` production at all, so a `spawn` arriving from one
//     is a bug (a stale grant, a bypassed verifier), not a decision to weigh.
//   * **the grant** — present, in this chain, not expired, not spent. A grant that
//     outlives its dispatcher is not honoured; the chain ends, which is conservative and
//     correct.
//   * **the ceilings** — in `planSpawn` (arithmetic, lattice) and `may_spawn` (verdict).
//   * **the claim** — a path another node holds is refused, and the denial is a fact handed
//     back (holder + deadline), never an exception and never a retry.
//
// Every refusal leaves with an `Escalation`. That is not a convenience: a refusal with no
// next actor is exactly how a run dies silently, and silence is indistinguishable from
// success.

import { escalate } from "./escalate.ts";
import { Refusal, perform, revokeGrant, type EffectContext, type EffectKind } from "./effects.ts";
import type { Grant, GrantBook } from "./grant.ts";
import { catalogueOf, type Ceilings, type ProfileTable } from "./profiles.ts";
import type { SteerEnvelope } from "./records.ts";
import type { SwarmStore } from "./store.ts";
import {
	licenceOf,
	type Action,
	type DispatchOutcome,
	type FailureCause,
	type Role,
} from "./types.ts";

export interface OpPolicy {
	/** Refusable: the licence, grant, ceiling and claim checks apply. */
	gated: boolean;
	/** The shared mutation the gate performs, if any. An effect is not a gate: `block`
	 *  publishes a return record and is still never refused. */
	effect: EffectKind;
	/** Consumes one unit of the node's budget. `spawn` does not: the allocation is its
	 *  cost, and the `− 1` in `floor((budget − 1) / k)` is this node's own reserve. */
	spends: boolean;
}

/** The ops that create work are gated; the ops that report are not (§3.5). Anything in a
 *  catalogue but not in this table is a gate that has not been taught a new action, and it
 *  is refused loudly rather than allowed through unchecked. */
export const OP_POLICY: Readonly<Record<string, OpPolicy>> = {
	spawn: { gated: true, effect: "spawn", spends: false },
	dispatch: { gated: true, effect: "work", spends: true },
	publish: { gated: true, effect: "artifact", spends: true },
	submit: { gated: true, effect: "artifact", spends: true },
	keep: { gated: true, effect: "artifact", spends: true },
	pick: { gated: true, effect: "artifact", spends: true },

	// Reports, and the returns that are refusals in record form. Never gated.
	done: { gated: false, effect: "artifact", spends: false },
	block: { gated: false, effect: "artifact", spends: false },
	drop: { gated: false, effect: "artifact", spends: false },
	cite: { gated: false, effect: "none", spends: false },
	ask: { gated: false, effect: "none", spends: false },
	wait: { gated: false, effect: "none", spends: false },
	verify: { gated: false, effect: "none", spends: false },
	step: { gated: false, effect: "none", spends: false },
	retry: { gated: false, effect: "none", spends: false },
	refine: { gated: false, effect: "none", spends: false },
	need: { gated: false, effect: "none", spends: false },
	askHuman: { gated: false, effect: "none", spends: false },
	abandon: { gated: false, effect: "revoke", spends: false },
	steer: { gated: false, effect: "steer", spends: false },
};

export interface GateDeps {
	store: SwarmStore;
	grants: GrantBook;
	profiles: ProfileTable;
	ceilings: Ceilings;
	now?: () => number;
}

export class Gate {
	/** Public because the loop must not hold a second handle on the run root: one gate,
	 *  one store, one writer. */
	readonly store: SwarmStore;
	private readonly grants: GrantBook;
	/** Everything an effect needs, assembled once. */
	private readonly context: EffectContext;
	/** Consecutive failures per (chain, node, cause): the second one escalates differently
	 *  from the first, and nothing else in the system counts them. */
	private readonly failures = new Map<string, number>();

	constructor(deps: GateDeps) {
		this.store = deps.store;
		this.grants = deps.grants;
		this.context = {
			store: deps.store,
			grants: deps.grants,
			profiles: deps.profiles,
			ceilings: deps.ceilings,
			now: deps.now ?? Date.now,
		};
	}

	async dispatch(action: Action): Promise<DispatchOutcome> {
		// The licence: the catalogue of the process that answered, not a table in this file.
		const catalogue = catalogueOf(this.context.profiles, action.profile, licenceOf(action.instance));
		if (!catalogue.some((tool) => tool.name === action.op)) {
			return this.fail(action, "unparseable", `op ${action.op} is not in the ${action.instance} catalogue`);
		}
		const policy = OP_POLICY[action.op];
		if (!policy) {
			return this.fail(action, "unparseable", `no gate policy for ${action.op}: this table has to learn it`);
		}

		const grant = this.grants.get(action.grantId);
		if (!policy.gated) {
			// Ungated: no grant check, no ceiling, no claim. It still may not mutate anything
			// the profile invented — a `block` publishes a record the dispatcher built, and a
			// `steer` points at an artifact already on the board.
			try {
				const effect = await perform(policy.effect, action, grant, this.context);
				this.row(action, effect ? "performed" : "ungated");
				return effect
					? { kind: "performed", nodeId: action.nodeId, op: action.op, gated: false, effect }
					: { kind: "ungated", nodeId: action.nodeId, op: action.op };
			} catch (error) {
				if (error instanceof Refusal) return this.fail(action, error.cause, error.message, grant);
				throw error;
			}
		}

		if (!grant) return this.fail(action, "grant_expired", `grant ${action.grantId} is not in the book`);
		if (grant.chainId !== action.chainId) {
			return this.fail(action, "unparseable", `grant ${grant.grantId} belongs to chain ${grant.chainId}`, grant);
		}
		if (grant.expiresAt <= this.context.now()) {
			this.revoke(grant, "expired");
			return this.fail(
				action,
				"grant_expired",
				`grant ${grant.grantId} expired at ${new Date(grant.expiresAt).toISOString()}`,
				grant,
			);
		}
		if (grant.remaining <= 0) {
			return this.fail(action, "budget", `grant ${grant.grantId} has no budget left`, grant);
		}

		try {
			const effect = await perform(policy.effect, action, grant, this.context);
			if (policy.spends) this.spend(grant);
			this.row(action, "performed");
			return { kind: "performed", nodeId: action.nodeId, op: action.op, gated: true, effect: effect ?? {} };
		} catch (error) {
			if (error instanceof Refusal) return this.fail(action, error.cause, error.message, grant);
			throw error;
		}
	}

	/** Stage 1 of the loop: the instruction boundary. A steer is released here and nowhere
	 *  else — no mid-tool, no delta steers (§2.4 step 6). Not an action, which is why it is
	 *  not `dispatch`: nothing is decided here and nothing can be refused. */
	intake(role: Role, boundary: string): readonly SteerEnvelope[] {
		return this.store.drainSteers(role, boundary);
	}

	/** The once-per-loop sweeper (§2.3 step 4): expired claims and expired grants become
	 *  rows, off the claim path. Running it inside an action would make one action's
	 *  duration decide whether somebody else's lease survives. */
	sweep(now = this.context.now()): { claims: number; grants: string[] } {
		const claims = this.store.sweep();
		const revoked: string[] = [];
		for (const grant of this.grants.expired(now)) {
			this.revoke(grant, "expired");
			revoked.push(grant.grantId);
		}
		return { claims: claims.length, grants: revoked };
	}

	/** A failure detected before an action could exist — a call that did not verify, an
	 *  instance that never answered. It goes through the same fail() as a gate refusal so
	 *  that "every failure has a named next actor" is one place, not two. */
	reject(input: {
		chainId: string;
		grantId: string;
		nodeId: string;
		profile: Role;
		instance: Action["instance"];
		op: string;
		cause: FailureCause;
		detail: string;
	}): DispatchOutcome {
		const action: Action = {
			chainId: input.chainId,
			grantId: input.grantId,
			nodeId: input.nodeId,
			profile: input.profile,
			instance: input.instance,
			op: input.op,
			args: {},
		};
		return this.fail(action, input.cause, input.detail, this.grants.get(input.grantId));
	}

	/** The failure path, and the only place an `Escalation` is minted. */
	private fail(action: Action, cause: FailureCause, detail: string, grant?: Grant): DispatchOutcome {
		const key = `${action.chainId}/${action.nodeId}/${cause}`;
		const consecutive = (this.failures.get(key) ?? 0) + 1;
		this.failures.set(key, consecutive);
		const escalation = escalate({
			cause,
			role: action.profile,
			consecutive,
			isRoot: grant ? grant.parent === null : false,
			detail,
		});
		this.row(action, "refused", cause, detail);
		this.store.log.append({
			t: "escalation",
			chainId: action.chainId,
			profile: action.profile,
			from: action.instance,
			to: escalation.nextActor,
			cause,
			action: escalation.action,
			detail: escalation.detail,
		});
		return { kind: "refused", nodeId: action.nodeId, op: action.op, cause, detail, escalation };
	}

	private spend(grant: Grant): void {
		const spent = this.grants.spend(grant.grantId, this.context.now());
		if (spent?.revoked) this.revoke(grant, "exhausted");
	}

	private revoke(grant: Grant, reason: "abandoned" | "exhausted" | "expired" | "ceiling" | "profile_degraded"): void {
		revokeGrant(grant, reason, this.context);
	}

	private row(action: Action, outcome: "performed" | "ungated" | "refused", cause?: FailureCause, detail?: string): void {
		const row: Parameters<SwarmStore["log"]["append"]>[0] = {
			t: "action",
			chainId: action.chainId,
			grant: action.grantId,
			node: action.nodeId,
			profile: action.profile,
			op: action.op,
			outcome,
		};
		if (cause) row.cause = cause;
		if (detail) row.detail = detail;
		this.store.log.append(row);
	}
}
