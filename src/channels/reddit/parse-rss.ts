// The `.rss` route, parsed.
//
// Measured (spec §1.4, re-recorded for the fixture in this directory): a thread feed at
// `?limit=100` returned **15 entries for a 15-comment thread in one request, 31,994 B,
// 0.47 s** — the whole thread for one token of a bucket that holds exactly one. The same
// payload stripped of markup costs 1,764 B/comment against Arctic's 490, which is why
// this route is kept for *request* scarcity and not for token cost.
//
// Four properties of the feed decide every line below:
//
// - It is **flat**. `parent_id` is not in the payload, so `depth` is 0 for every comment
//   and the thread is `treeKnown: false`. The projection falls back to flat score order
//   rather than inventing structure it does not have.
// - **Score is embedded in rendered HTML**, not a field, and it is frequently absent
//   entirely: the recorded thread's 15 comments carry no score span at all. Absent is
//   recorded as `null`, never as 0 — a fabricated score poisons the ranking, and a
//   `null` still renders honestly as `[?up]`.
// - The first entry is the **post**, not a comment (`id` is `t3_<postId>`), so a parser
//   that treats every entry as a comment reports one comment too many and a body that is
//   the author's self-post.
// - The body is **HTML-escaped markdown rendered into `<p>` tags**, wrapped in
//   `<!-- SC_OFF -->` markers.

import type { HttpResponse } from "./transport.ts";
import type { ChannelNote, RawComment, RemovalState, ThreadParse } from "./types.ts";
import type { Parsed } from "./wire.ts";
import { stripHtml, xmlAttr, xmlBlocks, xmlContentBody, xmlText } from "./wire.ts";

/** `x-ratelimit-reset` on a `.rss` response is an integer countdown to the next token,
 *  and it is authoritative; `remaining` reads 0.0 even on the 200 that just succeeded,
 *  so it is not a budget (§1.4). */
export function rssResetSeconds(response: HttpResponse): number | null {
	const reset = response.headers["x-ratelimit-reset"];
	if (reset === undefined) return null;
	const parsed = Number.parseInt(reset, 10);
	return Number.isFinite(parsed) ? parsed : null;
}

export function isRssLoginRedirect(response: HttpResponse): boolean {
	const location = response.headers["location"];
	return (response.status === 302 || response.status === 301) && location !== undefined && /\/login/i.test(location);
}

const SCORE_SPAN = /<span class="score[^"]*">\s*(-?\d+)?\s*<\/span>/i;

/** Score out of the rendered comment HTML. `null` is the common case and is not an
 *  error: the recorded 15-comment feed has no score span anywhere. */
export function scoreFromContent(html: string): number | null {
	const match = SCORE_SPAN.exec(html);
	const digits = match?.[1];
	if (digits === undefined) return null;
	const parsed = Number.parseInt(digits, 10);
	return Number.isFinite(parsed) ? parsed : null;
}

function authorOf(entry: string): string | null {
	const name = xmlText(entry, "name");
	if (name === null || name === "") return null;
	return name.replace(/^\/u\//i, "").replace(/^u\//i, "");
}

function timeOf(entry: string): number {
	const raw = xmlText(entry, "published") ?? xmlText(entry, "updated");
	if (raw === null) return 0;
	const parsed = Date.parse(raw);
	return Number.isFinite(parsed) ? Math.floor(parsed / 1000) : 0;
}

function removalOfBody(body: string): RemovalState {
	const trimmed = body.trim();
	if (trimmed === "[deleted]") return { kind: "deleted-by-author" };
	if (trimmed === "[removed]") return { kind: "removed-by-moderator", detectedAtUtc: 0 };
	// `.rss` cannot report archive removal state at all: it is a live feed with no `_meta`.
	return { kind: "live", removalChecked: false };
}

/** A thread feed → the thread, flat.
 *
 *  `ctx.postId` is the id the caller asked for; the feed's own `t3_` entry is preferred
 *  when it disagrees, because a redirect through a share link is the feed telling the
 *  truth about which post it answered. */
export function parseRssThread(text: string, ctx: { readonly postId: string; readonly limit: number }): Parsed<ThreadParse> {
	const entries = xmlBlocks(text, "entry");
	if (entries.length === 0) return { ok: false, code: "parse", detail: "Atom feed contains no <entry> elements" };

	const feedSubreddit = xmlAttr(text, "category", "term");
	const feedUpdated = xmlText(text, "updated");
	const feedCreated = feedUpdated === null ? 0 : Math.floor((Date.parse(feedUpdated) || 0) / 1000);

	let subreddit: string | null = feedSubreddit;
	let title: string | null = null;
	let createdUtc = feedCreated;
	let postId: string | null = null;
	const comments: RawComment[] = [];

	for (const entry of entries) {
		const id = xmlText(entry, "id");
		const content = xmlContentBody(entry);
		const html = content ?? "";

		if (id !== null && id.startsWith("t3_")) {
			postId = id.slice(3);
			title = xmlText(entry, "title");
			createdUtc = timeOf(entry);
			subreddit = xmlAttr(entry, "category", "term") ?? subreddit;
			continue;
		}

		const commentId = id !== null && id.startsWith("t1_") ? id.slice(3) : (id ?? "").replace(/[?#].*$/, "").split("/").filter(Boolean).pop() ?? "";
		if (commentId === "") continue;
		const body = stripHtml(html);
		comments.push({
			commentId,
			parentId: null,
			author: authorOf(entry),
			body,
			score: scoreFromContent(html),
			createdUtc: timeOf(entry),
			distinguished: null,
			removal: removalOfBody(body),
			depth: 0,
		});
	}

	comments.sort((a, b) => a.createdUtc - b.createdUtc || a.commentId.localeCompare(b.commentId));

	if (title === null) title = xmlText(text, "title");
	if (subreddit !== null) subreddit = subreddit.replace(/^r\//i, "").replace(/^\//, "");

	const truncated = comments.length >= ctx.limit;
	const notes: ChannelNote[] = ["tree-unknown", "unverified-removals"];
	if (truncated) notes.push("truncated");

	return { ok: true, value: { subreddit, title, createdUtc, postId: postId ?? ctx.postId, comments, truncated, collapsed: 0, treeKnown: false, notes } };
}
