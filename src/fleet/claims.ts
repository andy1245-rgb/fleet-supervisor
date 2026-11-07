// The claim registry as a screen needs it: entries with their filenames, plus the
// three verdicts that can be proved about a claim.
//
// `src/fleet/registry.ts` owns the claim file's shape and its write. This module only
// adds what a reader needs and the writer has no opinion about: which file a claim
// came from, which files could not be read, and the two predicates the page is allowed
// to state. Nothing here writes, and nothing here deletes: nothing in this tree has a
// delete, and pruning is the operator's verb.

import { readFileSync } from "node:fs";

import { toClaim } from "./registry.ts";
import { listJsonFiles, statFile } from "./fsio.ts";
import type { ClaimEntry, ClaimsRead } from "./types.ts";

export const VERDICTS = ["live", "stale", "orphaned", "never claimed"] as const;
export type Verdict = (typeof VERDICTS)[number];

/**
 * One directory, one file per pane. Non-recursive by construction: the claim dir has
 * no subdirectories, so a walk there would only ever be a mistake.
 *
 * A file that cannot be read or parsed is listed with its error and excluded from the
 * map, because a claim nobody can read is a fact about the file rather than a claim
 * about a pane.
 */
export function readClaimEntries(dir: string): ClaimsRead {
	const listed = listJsonFiles(dir);
	if (listed.error !== null) {
		return { dir, dirExists: false, dirError: listed.error, claims: new Map(), files: [] };
	}
	const claims = new Map<string, ClaimEntry>();
	const files: ClaimsRead["files"] = [];
	for (const { name, path } of listed.files) {
		const stat = statFile(path);
		let claim: ReturnType<typeof toClaim>;
		let error: string | null = null;
		try {
			claim = toClaim(JSON.parse(readFileSync(path, "utf8")) as unknown);
			if (claim === undefined) error = "no paneId in the file";
		} catch (failure) {
			claim = undefined;
			error = `unparseable JSON: ${failure instanceof Error ? failure.message : "syntax error"}`;
		}
		files.push({ name, path, bytes: stat.bytes, mtime: stat.mtime, mtimeMs: stat.mtimeMs, error });
		if (claim !== undefined) {
			claims.set(claim.paneId, { claim, name, path, mtimeMs: stat.mtimeMs, mtime: stat.mtime });
		}
	}
	return { dir, dirExists: true, dirError: null, claims, files };
}

/** `now - Date(claim.updated)` in milliseconds, or null when `updated` is not a
 *  timestamp. Null is not zero: an unparseable `updated` is one of the two ways a
 *  claim goes stale, and calling it fresh would be the opposite of the truth. */
export function claimAgeMs(claim: { updated?: string } | null | undefined, now: number): number | null {
	const parsed = Date.parse(claim?.updated ?? "");
	return Number.isFinite(parsed) ? now - parsed : null;
}

/**
 * The verdict for one pane, from the two facts available: is the pane in this load's
 * pane list, and how old is the claim file.
 *
 *   pane live, no claim            → never claimed
 *   pane live, claim old/unparsed  → stale
 *   pane live, claim fresh         → live
 *   pane gone, claim on disk       → orphaned
 */
export function verdictFor(args: { alive: boolean; claim: unknown; ageMs: number | null; staleAfterMs: number }): Verdict {
	if (!args.alive) return args.claim ? "orphaned" : "never claimed";
	if (!args.claim) return "never claimed";
	if (args.ageMs === null) return "stale";
	return args.ageMs > args.staleAfterMs ? "stale" : "live";
}

export function describeClaim(claim: { state?: string; phase?: string } | null | undefined, ageMs: number | null): string {
	if (!claim) return "no claim file on disk for this pane";
	const age = ageMs === null ? "updated is not a timestamp" : `${Math.round(ageMs / 1000)}s since updated`;
	return `${claim.state ?? "unknown"} · ${claim.phase ?? "unknown"} · ${age}`;
}
