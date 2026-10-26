// Claim writes. Two rules decide this file: a turn must never wait on a claim,
// and the file the supervisor reads must always be a whole claim.
//
// The write itself is the registry's own `writeClaim` — same `<target>.<pid>.tmp`
// then rename, same filename sanitising — so the extension cannot drift from the
// shape the supervisor parses. What lives here is only the pacing and the
// carry-forward of fields the extension does not own.

import { readClaim, registryDir, writeClaim, type Claim } from "../../../src/fleet/registry.ts";

/** At most one write per this window; bursts of tool calls coalesce into one. */
const COALESCE_MS = 2000;

export class ClaimWriter {
	#pending: Claim | undefined;
	#timer: ReturnType<typeof setTimeout> | undefined;
	#lastWriteAt = 0;

	/** Queue the newest claim. The first one lands at once; later ones wait out the window. */
	schedule(claim: Claim): void {
		this.#pending = claim;
		if (this.#timer) return;
		const wait = COALESCE_MS - (Date.now() - this.#lastWriteAt);
		if (wait <= 0) {
			this.#write();
			return;
		}
		this.#timer = setTimeout(() => {
			this.#timer = undefined;
			this.#write();
		}, wait);
		// A pending claim must not keep the process alive by itself.
		this.#timer.unref();
	}

	/** Write whatever is queued, now. */
	flush(): void {
		if (this.#timer) {
			clearTimeout(this.#timer);
			this.#timer = undefined;
		}
		this.#write();
	}

	#write(): void {
		const claim = this.#pending;
		this.#pending = undefined;
		if (!claim) return;
		// Charged before the attempt, so a write that keeps failing cannot spin.
		this.#lastWriteAt = Date.now();
		try {
			const dir = registryDir();
			const existing = readClaim(claim.paneId, dir);
			// `group` and `acceptance` belong to the human who declared them: a
			// session rewriting its own claim must not erase another's declaration.
			if (existing?.group && !claim.group) claim.group = existing.group;
			if (existing?.acceptance && !claim.acceptance) claim.acceptance = existing.acceptance;
			writeClaim(claim, dir);
		} catch {
			// A claim that could not be written is a stale claim, not a broken
			// turn; the next schedule tries again.
		}
	}
}
