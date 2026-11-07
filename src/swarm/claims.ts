// Path claims: advisory, exclusive, TTL-bounded leases, and never on the write path.
//
// Mirrored from `~/swarmHarness/src/blackboard/claims.ts` — the same four-step
// protocol (`runtime-scaffold.md` §2.3):
//
//   * exclusive and deny-don't-block: a denied request is a fact the requester
//     reads and acts on, never a retry or a spin;
//   * release is explicit, on success or on abandonment;
//   * the sweep runs off the claim path, once per loop iteration, and it is the
//     only thing that makes a crashed holder's claim disappear;
//   * the holder is recorded so a state line can name it ("held by w4").
//
// Two extensions, both forced by the runtime rather than chosen:
//
//   * the TTL counts **milliseconds**, not steps. A real run has no global step
//     counter, and wall clock is the only monotone quantity a crashed dispatcher
//     shares with its successor.
//   * acquiring is `O_EXCL` on `claims/<path-slug>.<holder>.claim.json` (§2.3 step
//     1). Exclusion therefore rests on the single mutator: the dispatcher scans
//     before it creates, and the exclusive create catches a same-holder re-acquire.
//     That is the honest form of an advisory claim — the guard before the write is
//     what actually keeps an expired lease from stomping a file.
//
// This module is pure: it decides, given the claims already on disk. `store.ts`
// reads and writes the files.

export type ClaimState = "held" | "released" | "expired";

export interface ClaimRecord {
	claimId: string;
	path: string;
	holder: string;
	/** One line: what the holder intends to write. */
	intent: string;
	acquiredAt: number;
	expiresAt: number;
	state: ClaimState;
	releasedAt?: number;
}

export type ClaimDecision =
	| { granted: true; claimId: string; path: string; holder: string; expiresAt: number; renewed: boolean }
	| { granted: false; path: string; heldBy: string; claimId: string; expiresAt: number };

/** A write item is the default TTL; a fetch that has not landed in two minutes did
 *  not run slow, it failed. Both are floors, not ceilings: the TTL must exceed twice
 *  the profile's own decode timeout or the sweeper expires work that is still
 *  running (§2.3). */
export const CLAIM_TTL_MS = { write: 10 * 60_000, read: 2 * 60_000 } as const;

export function ttlFor(kind: "write" | "read"): number {
	return CLAIM_TTL_MS[kind];
}

/** Held and not yet expired. A released or expired record never blocks anybody. */
function isActive(record: ClaimRecord, now: number): boolean {
	return record.state === "held" && record.expiresAt > now;
}

export function activeOn(records: readonly ClaimRecord[], path: string, now: number): ClaimRecord | undefined {
	return records.find((record) => record.path === path && isActive(record, now));
}

export function nextClaimId(records: readonly ClaimRecord[]): string {
	return `C${records.length + 1}`;
}

/** The acquire decision. `now` is passed, never read: the caller owns the clock so a
 *  sweep and an acquire in one iteration cannot disagree about it. */
export function decideClaim(
	records: readonly ClaimRecord[],
	request: { path: string; holder: string; intent: string; now: number; ttlMs?: number },
): ClaimDecision {
	const active = activeOn(records, request.path, request.now);
	if (active) {
		if (active.holder === request.holder) {
			// The same node re-asking for the path it holds: idempotent, not a conflict.
			return {
				granted: true,
				claimId: active.claimId,
				path: active.path,
				holder: active.holder,
				expiresAt: active.expiresAt,
				renewed: true,
			};
		}
		return { granted: false, path: request.path, heldBy: active.holder, claimId: active.claimId, expiresAt: active.expiresAt };
	}
	const ttlMs = request.ttlMs ?? ttlFor("write");
	return {
		granted: true,
		claimId: nextClaimId(records),
		path: request.path,
		holder: request.holder,
		expiresAt: request.now + ttlMs,
		renewed: false,
	};
}

/** Held records past their expiry. The sweep is the crashed-holder path and must
 *  never run inside an action. */
export function sweepable(records: readonly ClaimRecord[], now: number): readonly ClaimRecord[] {
	return records.filter((record) => record.state === "held" && record.expiresAt <= now);
}

/** The state line a requester sees instead of an exception (§4.2 row 4): the holder
 *  and the deadline are the two facts a model can act on. */
export function claimLine(decision: ClaimDecision): string {
	if (decision.granted) return `held by ${decision.holder} until ${clock(decision.expiresAt)}`;
	return `held by ${decision.heldBy} until ${clock(decision.expiresAt)}`;
}

/** `HH:MM` in UTC. Display only, and deliberately not localised: two boxes in one
 *  run must print the same lease deadline. */
function clock(at: number): string {
	return new Date(at).toISOString().slice(11, 16);
}

/** A claims filename. Both parts are slugs because a path is not a filename and a
 *  holder id carries a `/` and a `.`. */
export function claimFile(path: string, holder: string): string {
	return `${slug(path)}.${slug(holder)}.claim.json`;
}

export function slug(value: string): string {
	return value.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
}
