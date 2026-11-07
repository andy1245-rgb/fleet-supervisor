// Replay: the ledger folded into run state. Pure — no files, no clock, no board.
//
// The property that makes replay cheap is that `chain` (chainId, depth, budget) is on
// every artifact and every grant, copied from the grant by the dispatcher rather than
// inferred from prose. Reconstruction is therefore a fold, not a search (§6.3):
//
//   1. group rows by chainId — one pass;
//   2. order by (depth, seq) — depth is on the row, never inferred;
//   3. the tree is the parent edges of `grant_minted` rows, and the depth cap bounds
//      the walk.
//
// The failure is as reconstructible as the success: a chain that stopped at
// `refused_by_ceiling` says so, at the same cost, instead of showing an absence of
// work that cannot be told from an absence of will.

import type {
	ArtifactPublishedEvent,
	ClaimEvent,
	EscalationEvent,
	GrantMintedEvent,
	ProfileDecisionEvent,
	SwarmEvent,
	TickEvent,
} from "./events.ts";
import type { FailureCause, Role } from "./types.ts";

export type StepKind = "grant" | "decision" | "artifact" | "refused";

export interface ChainStep {
	depth: number;
	seq: number;
	grant: string;
	profile: Role;
	node: string;
	kind: StepKind;
	detail: string;
}

export interface ChainFold {
	chainId: string;
	/** Ordered by (depth, seq). */
	steps: ChainStep[];
	grants: GrantMintedEvent[];
	/** The last refusal in the chain: where it stopped, in its own words. */
	stopped: ChainStep | null;
	maxDepth: number;
}

export interface RunFold {
	runId: string;
	decisions: number;
	byProfile: Record<string, number>;
	refused: number;
	suppressed: number;
	escalations: EscalationEvent[];
	artifacts: Map<string, ArtifactPublishedEvent>;
	claims: Map<string, ClaimEvent>;
	grants: Map<string, GrantMintedEvent>;
	chains: Map<string, ChainFold>;
	/** `decision_asked` rows with no `profile_decision`: a decision that was asked for
	 *  and never answered, which is a fact — unlike a missing row. */
	unanswered: string[];
	failures: Partial<Record<FailureCause, number>>;
	ticks: TickEvent[];
	/** Root grants' budgets: what the run was authorised to spend. */
	budgetGranted: number;
	grantsRevoked: number;
}

export function foldEvents(events: readonly SwarmEvent[]): RunFold {
	const ordered = [...events].sort((a, b) => a.seq - b.seq);
	const pending = new Map<string, number[]>();
	const fold: RunFold = {
		runId: ordered[0]?.runId ?? "",
		decisions: 0,
		byProfile: {},
		refused: 0,
		suppressed: 0,
		escalations: [],
		artifacts: new Map(),
		claims: new Map(),
		grants: new Map(),
		chains: new Map(),
		unanswered: [],
		failures: {},
		ticks: [],
		budgetGranted: 0,
		grantsRevoked: 0,
	};

	for (const event of ordered) {
		switch (event.t) {
			case "decision_asked": {
				const key = `${event.chainId}/${event.node}`;
				const asks = pending.get(key) ?? [];
				asks.push(event.seq);
				pending.set(key, asks);
				break;
			}
			case "profile_decision": {
				const key = `${event.chainId}/${event.node}`;
				pending.get(key)?.pop();
				fold.decisions += 1;
				fold.byProfile[event.profile] = (fold.byProfile[event.profile] ?? 0) + 1;
				if (event.refused) fold.refused += 1;
				fold.suppressed += event.suppressed;
				addStep(chainOf(fold, event.chainId), decisionStep(event));
				break;
			}
			case "grant_minted": {
				fold.grants.set(event.grant, event);
				if (event.parent === null) fold.budgetGranted += event.budget;
				const chain = chainOf(fold, event.chainId);
				chain.grants.push(event);
				chain.maxDepth = Math.max(chain.maxDepth, event.depth);
				addStep(chain, {
					depth: event.depth,
					seq: event.seq,
					grant: event.grant,
					profile: event.profile,
					node: `${event.chainId}/${event.grant}`,
					kind: "grant",
					detail: `depth ${event.depth} budget ${event.budget} bin ${event.binRank} maySpawn ${event.maySpawn}`,
				});
				break;
			}
			case "grant_revoked":
				fold.grantsRevoked += 1;
				break;
			case "action": {
				if (event.outcome !== "refused") break;
				const cause = event.cause;
				if (cause) fold.failures[cause] = (fold.failures[cause] ?? 0) + 1;
				const chain = chainOf(fold, event.chainId);
				const grant = fold.grants.get(event.grant);
				const step: ChainStep = {
					depth: grant?.depth ?? chain.maxDepth,
					seq: event.seq,
					grant: event.grant,
					profile: event.profile,
					node: event.node,
					kind: "refused",
					detail: `${event.op} refused: ${cause ?? "unknown"} — ${event.detail ?? ""}`,
				};
				addStep(chain, step);
				chain.stopped = step;
				break;
			}
			case "artifact_published":
				fold.artifacts.set(event.artifact, event);
				addStep(chainOf(fold, event.chain), {
					depth: event.depth,
					seq: event.seq,
					grant: "",
					profile: event.producer,
					node: "",
					kind: "artifact",
					detail: `${event.artifact} ${event.kind} ${event.summary}`,
				});
				break;
			case "claim_acquired":
			case "claim_denied":
			case "claim_released":
			case "claim_expired":
				fold.claims.set(event.claimId, event);
				break;
			case "escalation":
				fold.escalations.push(event);
				break;
			case "tick":
				fold.ticks.push(event);
				break;
			case "steer_queued":
			case "steer_delivered":
			case "profile_unhealthy":
				break;
		}
	}

	for (const [key, asks] of pending) {
		for (const seq of asks) fold.unanswered.push(`${key}#${seq}`);
	}
	for (const chain of fold.chains.values()) {
		chain.steps.sort((a, b) => (a.depth === b.depth ? a.seq - b.seq : a.depth - b.depth));
	}
	return fold;
}

function decisionStep(event: ProfileDecisionEvent): ChainStep {
	return {
		depth: event.depth,
		seq: event.seq,
		grant: event.grant,
		profile: event.profile,
		node: event.node,
		kind: "decision",
		detail: `${event.decidedBy} ${event.op ?? "refused"}${event.arg ? ` ${event.arg}` : ""}${event.refused ? " (refused)" : ""}`,
	};
}

function addStep(chain: ChainFold, step: ChainStep): void {
	chain.steps.push(step);
}

export function chainOf(fold: RunFold, chainId: string): ChainFold {
	const existing = fold.chains.get(chainId);
	if (existing) return existing;
	const chain: ChainFold = { chainId, steps: [], grants: [], stopped: null, maxDepth: 0 };
	fold.chains.set(chainId, chain);
	return chain;
}

/** The §6.3 block, as lines. Used by the run report and by tests that assert where a
 *  chain stopped. */
export function describeChain(chain: ChainFold): string[] {
	return chain.steps.map((step) => {
		const indent = "  ".repeat(step.depth);
		const grant = step.grant === "" ? "   " : step.grant.padEnd(3);
		return `${indent}${grant} ${step.profile.padEnd(6)} ${step.kind.padEnd(8)} ${step.detail}`.trimEnd();
	});
}
