// Grants: the envelope's depth, budget and bin, and the arithmetic nobody but this
// file performs. `hi-orchestrator.md` §7 owns the semantics; this is the shape it
// takes when the counter cannot transit a model.
//
// The rule the whole file exists for: a node never emits a depth, a budget or a
// bin rank. `spawn`'s argument list has `binId`, `slotIds` and `k` — never `depth`
// — so the counter cannot be mis-stated, off-by-one'd, or argued with. Everything
// here is derived from the parent grant and the profile's own `CAPS`; the only
// model-supplied input is `k` and the child's bin name.
//
// The *predicate* half of the ceiling lives in `profiles/common.py:may_spawn`, and
// `ceilings.maySpawn` in `profiles.ts` calls it rather than re-deciding it. What is
// here is the arithmetic that feeds it (`child_budget = floor((parent − 1) / k)`)
// and the bin lattice, which the profile package does not carry.

import type { Role } from "./types.ts";

/** The bin lattice, ranked by how much decomposition the bin implies (HI §7.2).
 *  A child's rank may never exceed its parent's, so over-recursion into
 *  ever-more-elaborate decompositions is not representable. */
export const BIN_RANK: Readonly<Record<string, number>> = {
	"1tool": 0,
	deferred: 0,
	contextual: 0,
	multitool: 1,
	"confirm-loop": 1,
	sequence: 2,
	"deep-query": 2,
	combo: 3,
};

export function rankOf(bin: string): number | undefined {
	return Object.hasOwn(BIN_RANK, bin) ? BIN_RANK[bin] : undefined;
}

/** Wall clock, so a grant that outlives its dispatcher is not honoured by the next
 *  one (§3.3 property 4 — the chain then ends, which is the conservative failure). */
export const GRANT_TTL_MS = 10 * 60_000;

export interface Grant {
	grantId: string;
	/** The node this grant belongs to: `<chainId>/<nodeId>`. Claim holders use it. */
	agentId: string;
	profile: Role;
	chainId: string;
	parent: string | null;
	depth: number;
	/** Action calls for this node's whole subtree. */
	budget: number;
	remaining: number;
	binRank: number;
	/** Decided at mint time, not per call (HI §7.4): once false it stays false, so a
	 *  second `spawn` from the same grant is a ceiling refusal rather than a
	 *  re-decision. It is also what selects the orchestrator's catalogue. */
	maySpawn: boolean;
	expiresAt: number;
}

export interface MintInput {
	chainId: string;
	profile: Role;
	agentId: string;
	depth: number;
	budget: number;
	bin: string;
	/** From `profiles.caps(role)` — never a constant in this directory. */
	chainCeiling: number;
	parent?: Grant | null;
	now: number;
	ttlMs?: number;
}

/** The two ways a spawn is refused locally. The authoritative verdict is
 *  `may_spawn`'s; these name which ceiling a local refusal belongs to. */
export type SpawnRefusal = "chain_ceiling" | "bin_ceiling";

export type SpawnPlan =
	| {
			ok: true;
			k: number;
			childBudget: number;
			childBin: string;
			childRank: number;
			childDepth: number;
			/** Each child's own `maySpawn`, from depth and budget alone (HI §7.4). */
			childMaySpawn: boolean;
	  }
	| { ok: false; cause: SpawnRefusal; detail: string };

/** The local half of the ceiling: arithmetic and the lattice. The authoritative
 *  half is `may_spawn` in the profile package, called by the gate with the
 *  `childBudget` this returns; a disagreement between the two is a bug, which is
 *  what `swarm-profiles.test.ts` pins. */
export function planSpawn(
	grant: Grant,
	input: { k: number; childBin: string; chainCeiling: number; binCeiling: number },
): SpawnPlan {
	const { k, childBin, chainCeiling, binCeiling } = input;
	if (!Number.isInteger(k) || k < 1) {
		return { ok: false, cause: "bin_ceiling", detail: `k=${input.k} is not a positive integer` };
	}
	// `CAPS.bin_ceiling` is the width of a bin: how many children one `spawn` may create.
	// It is the profile's number, not a constant in this directory.
	if (k > binCeiling) {
		return { ok: false, cause: "bin_ceiling", detail: `bin ceiling: k=${k} > ${binCeiling} children` };
	}
	const childRank = rankOf(childBin);
	if (childRank === undefined) {
		return { ok: false, cause: "bin_ceiling", detail: `bin ${childBin} is not in the lattice` };
	}
	if (childRank > grant.binRank) {
		return {
			ok: false,
			cause: "bin_ceiling",
			detail: `bin ceiling: child ${childBin} (rank ${childRank}) > node rank ${grant.binRank}`,
		};
	}
	const childDepth = grant.depth + 1;
	if (childDepth > chainCeiling) {
		return { ok: false, cause: "chain_ceiling", detail: `chain ceiling: depth ${childDepth} > ${chainCeiling}` };
	}
	// `− 1` reserves this node's own dispatch/publish, so Σ child_budget + 1 ≤ parent
	// by construction of the floor (HI §7.3).
	const childBudget = Math.floor((grant.remaining - 1) / k);
	if (childBudget < 1) {
		return {
			ok: false,
			cause: "bin_ceiling",
			detail: `bin ceiling: k=${k} does not fit remaining ${grant.remaining} (child budget ${childBudget})`,
		};
	}
	return {
		ok: true,
		k,
		childBudget,
		childBin,
		childRank,
		childDepth,
		childMaySpawn: childDepth < chainCeiling && childBudget >= 2,
	};
}

/** The in-memory ledger of live grants. Mutated only by the gate: a grant is shared
 *  state, and I1 says one component mutates shared state. */
export class GrantBook {
	private readonly grants = new Map<string, Grant>();
	private seq = 0;
	private readonly ttlMs: number;

	constructor(ttlMs = GRANT_TTL_MS) {
		this.ttlMs = ttlMs;
	}

	mint(input: MintInput): Grant {
		this.seq += 1;
		const grant: Grant = {
			grantId: `G${this.seq}`,
			agentId: input.agentId,
			profile: input.profile,
			chainId: input.chainId,
			parent: input.parent ? input.parent.grantId : null,
			depth: input.depth,
			budget: input.budget,
			remaining: input.budget,
			binRank: rankOf(input.bin) ?? 0,
			maySpawn: input.depth < input.chainCeiling && input.budget >= 2,
			expiresAt: input.now + (input.ttlMs ?? this.ttlMs),
		};
		this.grants.set(grant.grantId, grant);
		return grant;
	}

	get(grantId: string): Grant | undefined {
		return this.grants.get(grantId);
	}

	/** One action call. `remaining = 0` revokes: every later call under it is refused
	 *  and no decode happens at all (§3.3 property 3). */
	spend(grantId: string, now: number): { grant: Grant; revoked: boolean } | undefined {
		const grant = this.grants.get(grantId);
		if (!grant) return undefined;
		if (grant.remaining > 0) grant.remaining -= 1;
		const revoked = grant.remaining <= 0;
		if (revoked) grant.maySpawn = false;
		grant.expiresAt = now + this.ttlMs;
		return { grant, revoked };
	}

	/** A node spawns once: after the allocation `maySpawn` is false for good (§3.3
	 *  property 2), so a second `spawn` from the same grant is a ceiling refusal rather
	 *  than a re-decision. */
	markSpawned(grantId: string): Grant | undefined {
		const grant = this.grants.get(grantId);
		if (!grant) return undefined;
		grant.maySpawn = false;
		return grant;
	}

	revoke(grantId: string): Grant | undefined {
		const grant = this.grants.get(grantId);
		if (!grant) return undefined;
		grant.remaining = 0;
		grant.maySpawn = false;
		return grant;
	}

	expired(now: number): readonly Grant[] {
		return [...this.grants.values()].filter((g) => g.expiresAt <= now && g.remaining > 0);
	}

	all(): readonly Grant[] {
		return [...this.grants.values()];
	}
}
