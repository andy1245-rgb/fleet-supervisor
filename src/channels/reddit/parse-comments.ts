// Flat comment rows → `RawComment[]`. Shared by Arctic and the `.json` route because
// both speak Reddit's snake_case field names, and a thread's comment identity must not
// depend on which route fetched it: the same `commentId` from two channels is one
// comment (§7.6).
//
// Two of the three rules here exist because the alternative silently loses evidence.
// `_meta` is stripped by Arctic's `fields` selector, so most rows arrive without it and
// the honest answer is `live` + `removalChecked: false` — not `live`. And a body of
// `[deleted]` is a fact in the text, readable without any metadata, so it is read there
// too; reporting a deleted comment as an empty live one inflates `live_count` and deflates
// the removal ratio the record uses to decide the thread is unrepresentative (§10 case 10).

import type { RawComment, RemovalState } from "./types.ts";
import { asRecord, bool, num, str } from "./wire.ts";
import type { Json } from "./wire.ts";

export function removalOf(row: Json, fetchedAtUtc: number): RemovalState {
	const body = (str(row.body) ?? "").trim();
	const meta = asRecord(row._meta);
	// Reddit's own API reports moderator removal as a category on the comment; the archive
	// reports it in `_meta`. Either is authoritative when present.
	const category = str(row.removed_by_category);
	if (category !== null && category !== "") return { kind: "removed-by-moderator", detectedAtUtc: fetchedAtUtc };
	if (meta !== null) {
		const removalType = str(meta.removal_type);
		if (removalType !== null && removalType !== "" && removalType.toLowerCase() !== "none") return { kind: "removed-by-moderator", detectedAtUtc: fetchedAtUtc };
		if (bool(meta.was_deleted_later)) return { kind: "removed-by-moderator", detectedAtUtc: fetchedAtUtc };
		if (body === "[deleted]") return { kind: "deleted-by-author" };
		return { kind: "live", removalChecked: true };
	}
	if (body === "[deleted]") return { kind: "deleted-by-author" };
	if (body === "[removed]") return { kind: "removed-by-moderator", detectedAtUtc: fetchedAtUtc };
	return { kind: "live", removalChecked: false };
}

/** Depth from `parent_id`.
 *
 *  Needed because the cheapest body source (`comments/search` with `fields`) is a flat
 *  list and `fields` is rejected on `comments/tree`. A parent that is not in the row set
 *  (deleted, or past the page boundary) makes its child depth 0 rather than an error: the
 *  comment is still real and still citable, and only the projection's ordering uses depth.
 *  The `seen` set breaks cycles — an archive assembled from a live tree can contain one,
 *  and an infinite loop here would take the whole query down rather than one depth. */
export function depthsFromParentIds(rows: readonly Json[], postId: string): Map<string, number> {
	const byId = new Map<string, Json>();
	for (const row of rows) {
		const id = str(row.id);
		if (id !== null) byId.set(id, row);
	}
	const rootParent = `t3_${postId}`;
	const depths = new Map<string, number>();
	const depthOf = (id: string, seen: ReadonlySet<string>): number => {
		const cached = depths.get(id);
		if (cached !== undefined) return cached;
		if (seen.has(id)) return 0;
		const row = byId.get(id);
		if (row === undefined) return 0;
		const parent = str(row.parent_id);
		if (parent === null || parent === rootParent) {
			depths.set(id, 0);
			return 0;
		}
		const parentId = parent.replace(/^t[0-9]_/, "");
		const depth = byId.has(parentId) ? depthOf(parentId, new Set([...seen, id])) + 1 : 0;
		depths.set(id, depth);
		return depth;
	};
	for (const id of byId.keys()) depthOf(id, new Set());
	return depths;
}

export function isCommentRow(row: Json): boolean {
	const kind = str(row.kind);
	if (kind !== null) return kind === "t1";
	return str(row.id) !== null && str(row.body) !== null;
}

/** Rows → comments, filtered to real comment rows and sorted so two parses of one payload
 *  are byte-identical. Determinism is not cosmetic: the projection is keyed on the
 *  comment set, and a parser that reorders would miss the cache on every refetch. */
export function commentsFromRows(rows: readonly Json[], ctx: { readonly postId: string; readonly fetchedAtUtc: number }): RawComment[] {
	const kept = rows.filter(isCommentRow);
	const depths = depthsFromParentIds(kept, ctx.postId);
	const comments: RawComment[] = kept.map((row) => {
		const id = str(row.id) ?? "";
		const removal = removalOf(row, ctx.fetchedAtUtc);
		const gone = removal.kind === "deleted-by-author" || removal.kind === "removed-by-moderator";
		return {
			commentId: id,
			parentId: str(row.parent_id),
			author: str(row.author),
			// A removed comment keeps no body: showing "[removed]" as prose would let the
			// projection quote a moderation notice as if it were an opinion.
			body: gone ? "" : (str(row.body) ?? ""),
			score: num(row.score),
			createdUtc: num(row.created_utc) ?? 0,
			distinguished: str(row.distinguished),
			removal,
			depth: depths.get(id) ?? 0,
		};
	});
	comments.sort((a, b) => a.createdUtc - b.createdUtc || a.commentId.localeCompare(b.commentId));
	return comments;
}
