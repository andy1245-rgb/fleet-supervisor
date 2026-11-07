// The `.json` route, parsed.
//
// This is the only route that can search Reddit globally (`/search.json?q=`), which is
// what makes it worth a credential at all — measured, `posts/search` on Arctic requires
// `subreddit` or `author` and answers a bare `query=` with a 400 (§1.3a), so without this
// route the pipeline can only answer "what does subreddit S think", never "what does
// Reddit think".
//
// Two shape facts that a naive parser gets wrong:
//
// - `/comments/<id>.json` is an **array of two Listings** — `[post, comments]` — while
//   `/search.json` and `/api/info` are a **single Listing**. One unwrapper handles both,
//   so a caller never has to know which endpoint it called.
// - `kind:"more"` children are comments that were not returned. They are counted into
//   `collapsed` and never silently dropped: `coverage.windowComplete = false` is derived
//   from that count, and a parser that ignored them would report a complete window over a
//   thread it half-read.
//
// `.json` has no `fields` selector, so a comment costs ~570 tok against Arctic's ~129,
// and `limit=500` returns a payload 5× the size of what the pipeline can use (§4.3.6). The
// channel therefore asks for `limit=100`, which is what a thread is read at.

import type { HttpResponse } from "./transport.ts";
import type { Hit, ThreadParse } from "./types.ts";
import { permalinkFor } from "./types.ts";
import type { Json, Parsed } from "./wire.ts";
import { asArray, asRecord, bool, jsonParse, num, str } from "./wire.ts";
import { classify } from "./walls.ts";
import type { WallShape } from "./walls.ts";
import { commentsFromRows } from "./parse-comments.ts";

export type JsonFailure =
	| { readonly kind: "throttled"; readonly retryAfterMs: number; readonly detail: string }
	| { readonly kind: "walled"; readonly shape: WallShape; readonly detail: string }
	/** A 401 or a 302 to `/login`: the credential is gone, not the network (§4.3.3). */
	| { readonly kind: "dead-session"; readonly detail: string }
	| { readonly kind: "transient"; readonly detail: string }
	| { readonly kind: "error"; readonly code: "capability" | "http" | "parse"; readonly detail: string };

function parseRetryAfter(response: HttpResponse): number | null {
	const raw = response.headers["retry-after"] ?? response.headers["x-ratelimit-reset"];
	if (raw === undefined) return null;
	const parsed = Number.parseFloat(raw);
	return Number.isFinite(parsed) ? Math.round(parsed * 1000) : null;
}

/** One place where a `.json` status becomes a decision. `null` means "parse the body".
 *
 *  The 302 matters: it is what a dead web session produces, and following it lands on a
 *  wall while hiding the reason. `redirect: "manual"` in the transport is what makes this
 *  branch reachable at all. */
export function mapJsonFailure(response: HttpResponse): JsonFailure | null {
	const { status } = response;
	if (status >= 200 && status < 300) return null;
	const location = response.headers["location"] ?? "";

	if ((status === 301 || status === 302 || status === 303 || status === 307) && /\/login/i.test(location)) {
		return { kind: "dead-session", detail: `HTTP ${status} → ${location}: the web session is gone; do not follow it` };
	}

	if (status === 401) return { kind: "dead-session", detail: "HTTP 401: the token is not accepted — refresh once, then retire the credential" };

	if (status === 429) {
		const retryAfterMs = parseRetryAfter(response);
		return { kind: "throttled", retryAfterMs: retryAfterMs ?? 2_000, detail: `429 with retry hint ${retryAfterMs === null ? "absent" : `${retryAfterMs} ms`}` };
	}

	if (status === 403) {
		const verdict = classify(status, response.bytes);
		if (verdict.kind === "refused" || verdict.kind === "throttled") {
			return { kind: "walled", shape: verdict.kind === "refused" ? verdict.shape : "branded", detail: verdict.detail };
		}
	}

	if (status === 400 || status === 404) return { kind: "error", code: "capability", detail: `HTTP ${status}: ${response.text.trim().slice(0, 200)}` };
	if (status >= 500) return { kind: "transient", detail: `HTTP ${status}: ${response.text.trim().slice(0, 200)}` };
	return { kind: "error", code: "http", detail: `HTTP ${status}: ${response.text.trim().slice(0, 200)}` };
}

export interface Listing {
	readonly children: readonly Json[];
	readonly after: string | null;
}

/** A Listing child is `{kind, data}`; every reader wants `data` with the `kind` beside it.
 *  Flattening once here is what lets `commentsFromRows` serve both routes — Arctic sends
 *  flat rows and Reddit sends wrapped ones, so the unwrapping has to happen before the
 *  shared row logic, not inside it. */
function flattenChildren(children: readonly unknown[]): readonly Json[] {
	return children.flatMap((child) => {
		const record = asRecord(child);
		if (record === null) return [];
		const data = asRecord(record.data);
		if (data === null) return [];
		const kind = str(record.kind);
		return [kind === null ? data : { ...data, kind }];
	});
}

/** `[Listing, Listing]` and `Listing` both → the children worth looking at, in order.
 *  The `more` marker is preserved rather than expanded: only the caller knows whether it
 *  has a budget for `/api/morechildren`. */
export function unwrapListings(text: string): Parsed<{ readonly listings: readonly Listing[]; readonly more: number }> {
	const parsed = jsonParse(text);
	if (!parsed.ok) return { ok: false, code: "parse", detail: parsed.detail };

	const asListing = (value: unknown): Listing | null => {
		const record = asRecord(value);
		if (record === null) return null;
		const data = asRecord(record.data);
		if (data === null) return null;
		return { children: flattenChildren(asArray(data.children)), after: str(data.after) };
	};

	const roots = Array.isArray(parsed.value) ? asArray(parsed.value) : [parsed.value];
	const listings = roots.flatMap((root) => { const listing = asListing(root); return listing === null ? [] : [listing]; });
	if (listings.length === 0) return { ok: false, code: "parse", detail: "body is neither a Listing nor an array of Listings" };

	let more = 0;
	for (const listing of listings) {
		for (const child of listing.children) {
			if (str(child.kind) !== "more") continue;
			more += num(child.count) ?? 0;
		}
	}
	return { ok: true, value: { listings, more } };
}

export function parseJsonThread(text: string, ctx: { readonly postId: string; readonly fetchedAtUtc: number; readonly limit: number }): Parsed<ThreadParse> {
	const unwrapped = unwrapListings(text);
	if (!unwrapped.ok) return unwrapped;

	const { listings, more } = unwrapped.value;
	const children = listings.flatMap((listing) => listing.children);
	const post = children.find((child) => str(child.kind) === "t3") ?? null;
	const comments = commentsFromRows(children, ctx);

	return {
		ok: true,
		value: {
			postId: post === null ? ctx.postId : (str(post.id) ?? ctx.postId),
			subreddit: post === null ? null : str(post.subreddit),
			title: post === null ? null : str(post.title),
			createdUtc: post === null ? 0 : (num(post.created_utc) ?? 0),
			comments,
			truncated: comments.length >= ctx.limit,
			collapsed: more,
			// Real nesting and real `more` markers, so the tree is known even when it is
			// incomplete — which is what `collapsed` is for.
			treeKnown: true,
			notes: comments.some((comment) => comment.removal.kind === "live" && !comment.removal.removalChecked) ? ["unverified-removals"] : [],
		},
	};
}

/** `/search.json?q=` → hits, with the `after` cursor kept so pagination is the caller's
 *  decision and not a hidden second request. */
export function parseJsonHits(text: string): Parsed<{ readonly hits: readonly Hit[]; readonly exhausted: boolean; readonly after: string | null }> {
	const unwrapped = unwrapListings(text);
	if (!unwrapped.ok) return unwrapped;

	const first = unwrapped.value.listings[0];
	const children = first === undefined ? [] : first.children;
	const after = first?.after ?? null;

	const hits: Hit[] = [];
	children.forEach((post, index) => {
		if (str(post.kind) !== "t3") return;
		const postId = str(post.id);
		const subreddit = str(post.subreddit);
		const title = str(post.title);
		if (postId === null || subreddit === null || title === null) return;
		const score = num(post.score);
		const rawPermalink = str(post.permalink);
		hits.push({
			hitId: `r${String(index + 1).padStart(2, "0")}`,
			postId,
			subreddit,
			title,
			score: score ?? 0,
			numComments: num(post.num_comments) ?? 0,
			createdUtc: num(post.created_utc) ?? 0,
			author: str(post.author),
			over18: bool(post.over_18),
			permalink: rawPermalink === null ? permalinkFor(subreddit, postId) : `https://www.reddit.com${rawPermalink.startsWith("/") ? rawPermalink : `/${rawPermalink}`}`,
			removed: (str(post.removed_by_category) ?? "") !== "",
			scoreConfidence: score === null ? "absent" : "exact",
		});
	});
	return { ok: true, value: { hits, exhausted: after === null, after } };
}
