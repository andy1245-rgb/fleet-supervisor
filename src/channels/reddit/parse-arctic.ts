// Arctic Shift, parsed and its failures named.
//
// The parser and the error taxonomy are one file because they are one thing: knowing
// what Arctic said. Three measured behaviours are load-bearing here and each is a trap
// for a reader who assumes a conventional API (spec §1.3):
//
// 1. `422 {"error":"Timeout. Maybe slow down a bit"}` is a **throttle**, returned in well
//    under a second when the search queue is closed. An error handler that maps 422 to
//    "bad request" retries forever. It maps to `throttled` with an 8 s wait.
// 2. There is no global keyword search. `posts/search?query=` without `subreddit` or
//    `author` is a hard 400, and `comments/search` rejects `query` outright — so a search
//    without a scope is a caller bug, reported as `capability` instead of spending a
//    request to learn what the 400 already says.
// 3. `fields` is the cost lever (~490 B ≈ 129 tok/comment, measured over six threads) and
//    it is rejected on `comments/tree` while accepted on `comments/search`. So thread
//    bodies come from `comments/search?link_id=` and the tree is rebuilt from
//    `parent_id` (parse-comments.ts) rather than asked for.
//
// `permalink` is not a valid field on `posts/search` (measured 400: `'permalink' is not a
// valid field`), so it is constructed from the subreddit and post id.

import type { HttpResponse } from "./transport.ts";
import type { ChannelNote, Hit } from "./types.ts";
import { permalinkFor } from "./types.ts";
import type { Json, Parsed } from "./wire.ts";
import { asArray, asRecord, bool, jsonParse, num, str } from "./wire.ts";
import type { WallShape } from "./walls.ts";
import { classify } from "./walls.ts";
import type { ThreadParse } from "./types.ts";
import { commentsFromRows } from "./parse-comments.ts";

export const ARCTIC_BASE = "https://arctic-shift.photon-reddit.com/api";

/** The measured selector. `body` is most of the payload and no selector shrinks it. */
export const ARCTIC_COMMENT_FIELDS = "id,body,parent_id,score,created_utc,author";

/** Measured-valid post fields. `url` is the post's outbound target, not a permalink. */
export const ARCTIC_POST_FIELDS = "id,title,score,num_comments,created_utc,subreddit,author,url";

/** §5.2: on `422 Timeout`, wait 8 s and retry once, then open the search breaker. */
export const ARCTIC_TIMEOUT_RETRY_MS = 8_000;

/** §4.1: Arctic sends `x-ratelimit-reset` (seconds) and `x-ratelimit-reset-at` (epoch ms)
 *  and **no** `x-ratelimit-remaining`, so there is no budget to read, only a clock. */
export function arcticResetSeconds(response: HttpResponse): number | null {
	const reset = response.headers["x-ratelimit-reset"];
	if (reset === undefined) return null;
	const parsed = Number.parseFloat(reset);
	return Number.isFinite(parsed) ? parsed : null;
}

export type ArcticFailure =
	| { readonly kind: "throttled"; readonly retryAfterMs: number; readonly detail: string }
	| { readonly kind: "walled"; readonly shape: WallShape; readonly detail: string }
	| { readonly kind: "transient"; readonly detail: string }
	| { readonly kind: "error"; readonly code: "capability" | "http" | "parse"; readonly detail: string };

/** One place where an Arctic status becomes a decision. `null` means "parse the body". */
export function mapArcticFailure(response: HttpResponse): ArcticFailure | null {
	const { status, text } = response;
	if (status >= 200 && status < 300) return null;

	const body = text.trim().slice(0, 300);

	// Before any generic 4xx handling: this body is a closed queue, not a bad argument.
	if (status === 422 && /Timeout\.?\s*Maybe slow down/i.test(body)) {
		return {
			kind: "throttled",
			retryAfterMs: ARCTIC_TIMEOUT_RETRY_MS,
			detail: "422 Timeout. Maybe slow down — Arctic's search queue is closed; back off, do not treat it as a validation error",
		};
	}

	if (status === 429) {
		const reset = arcticResetSeconds(response);
		return { kind: "throttled", retryAfterMs: reset === null ? 2_000 : Math.round((reset + 1) * 1000), detail: `429 with reset=${reset === null ? "absent" : String(reset)}` };
	}

	if (status === 403) {
		const verdict = classify(status, response.bytes);
		if (verdict.kind === "refused") return { kind: "walled", shape: verdict.shape, detail: verdict.detail };
	}

	if (status === 400 && /(Unknown query parameter|is not a valid field|requires one of)/i.test(body)) {
		// A rejected parameter is a caller bug: retrying costs a request and returns the same
		// answer. `posts/search?query=` with no scope lands exactly here.
		return { kind: "error", code: "capability", detail: `400 from the archive: ${body}` };
	}

	if (status >= 500) return { kind: "transient", detail: `HTTP ${status} from the archive: ${body}` };

	return { kind: "error", code: "http", detail: `HTTP ${status} from the archive: ${body}` };
}

function arcticRows(text: string): Parsed<readonly Json[]> {
	const parsed = jsonParse(text);
	if (!parsed.ok) return { ok: false, code: "parse", detail: parsed.detail };
	const root = asRecord(parsed.value);
	if (root === null) return { ok: false, code: "parse", detail: "archive body is not an object" };
	const error = str(root.error);
	const data = root.data;
	if (data === null || data === undefined) {
		// A 200 with `data: null` and an `error` string is how this API reports a rejected
		// query without a status to match it.
		return { ok: false, code: "http", detail: `archive returned no data${error === null ? "" : `: ${error}`}` };
	}
	if (!Array.isArray(data)) return { ok: false, code: "parse", detail: "archive `data` is not an array" };
	return { ok: true, value: asArray(data).flatMap((row) => {
		const record = asRecord(row);
		return record === null ? [] : [record];
	}) };
}

/** `comments/search?link_id=` → a flat thread.
 *
 *  Truncation is inferred from hitting the requested limit, not from `num_comments`: the
 *  archive's count is the count *at post time* and it was already wrong (returned
 *  exceeded `num_comments` in all six measured threads). */
export function parseArcticComments(text: string, ctx: { readonly postId: string; readonly fetchedAtUtc: number; readonly limit: number }): Parsed<ThreadParse> {
	const rows = arcticRows(text);
	if (!rows.ok) return rows;
	const comments = commentsFromRows(rows.value, ctx);
	const truncated = comments.length >= ctx.limit;

	const notes: ChannelNote[] = [];
	if (truncated) notes.push("truncated");
	// `_meta` is absent under a `fields` selector, so most rows are live-but-unchecked and
	// the record must be able to say that rather than report zero removals (§7.5).
	if (comments.some((comment) => comment.removal.kind === "live" && !comment.removal.removalChecked)) notes.push("unverified-removals");

	const post = asRecord(rows.value.find((row) => str(row.kind) === "t3") ?? null);
	return {
		ok: true,
		value: {
			// `comments/search` does not echo the post, so the caller's id and whatever the
			// rows said about their subreddit is all there is.
			postId: ctx.postId,
			subreddit: null,
			title: post === null ? null : str(post.title),
			createdUtc: post === null ? 0 : (num(post.created_utc) ?? 0),
			comments,
			truncated,
			collapsed: 0,
			treeKnown: true,
			notes,
		},
	};
}

/** `posts/search` → hits. `hitId` is assigned here so the needle's handle is stable for a
 *  given payload and cannot be invented by a caller (§7.3). */
export function parseArcticPosts(text: string, ctx: { readonly limit: number }): Parsed<{ readonly hits: readonly Hit[]; readonly exhausted: boolean }> {
	const rows = arcticRows(text);
	if (!rows.ok) return rows;

	const hits: Hit[] = [];
	rows.value.forEach((row, index) => {
		const postId = str(row.id);
		const subreddit = str(row.subreddit);
		const title = str(row.title);
		if (postId === null || subreddit === null || title === null) return;
		const score = num(row.score);
		const meta = asRecord(row._meta);
		const removalType = meta === null ? null : str(meta.removal_type);
		hits.push({
			hitId: `r${String(index + 1).padStart(2, "0")}`,
			postId,
			subreddit,
			title,
			score: score ?? 0,
			numComments: num(row.num_comments) ?? 0,
			createdUtc: num(row.created_utc) ?? 0,
			author: str(row.author),
			over18: bool(row.over_18),
			permalink: permalinkFor(subreddit, postId),
			removed: removalType !== null && removalType !== "" && removalType.toLowerCase() !== "none",
			// The archive always has the number; absence is recorded rather than smoothed.
			scoreConfidence: score === null ? "absent" : "exact",
		});
	});
	return { ok: true, value: { hits, exhausted: hits.length < ctx.limit } };
}
