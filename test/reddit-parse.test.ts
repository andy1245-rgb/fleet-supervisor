// The three parsers, against recorded response shapes.
//
// The fixtures are real responses where a real response could be recorded without spending
// a scarce budget (see `src/channels/reddit/fixtures.ts` for the provenance of each). What
// is asserted is the part a shape change would break: entry counting, tree depth, removal
// state, the `more` count, and the error taxonomy that decides whether the router retries,
// waits, or advances.

import assert from "node:assert/strict";
import { test } from "node:test";
import { FIXTURES, fixture } from "../src/channels/reddit/fixtures.ts";
import { mapArcticFailure, parseArcticComments, parseArcticPosts } from "../src/channels/reddit/parse-arctic.ts";
import { mapJsonFailure, parseJsonHits, parseJsonThread } from "../src/channels/reddit/parse-json.ts";
import { parseRssThread, scoreFromContent } from "../src/channels/reddit/parse-rss.ts";
import type { HttpResponse } from "../src/channels/reddit/transport.ts";

function response(init: { status: number; body: string; headers?: Record<string, string> }): HttpResponse {
	return { status: init.status, headers: init.headers ?? {}, bytes: Buffer.byteLength(init.body, "utf8"), text: init.body, wallMs: 1 };
}

// ------------------------------------------------------------------ Arctic: comments

test("arctic comments/search: the whole recorded thread, with real depths", () => {
	const parsed = parseArcticComments(fixture(FIXTURES.arcticComments), { postId: "1tld3qq", fetchedAtUtc: 1_790_000_000, limit: 100 });
	assert.equal(parsed.ok, true);
	if (!parsed.ok) return;

	// Measured: 15 rows for a 13-comment thread (§1.3d). The archive's count is the count at
	// post time, so `truncated` is inferred from the requested limit and not from it.
	assert.equal(parsed.value.comments.length, 15);
	assert.equal(parsed.value.truncated, false);
	assert.equal(parsed.value.treeKnown, true);

	const byId = new Map(parsed.value.comments.map((comment) => [comment.commentId, comment]));
	const topLevel = parsed.value.comments.filter((comment) => comment.depth === 0);
	assert.equal(topLevel.length, 6, "six rows point at t3_1tld3qq");

	// The recorded thread contains a real depth-5 chain, which is the only thing that makes
	// rebuilding the tree from parent_id worth doing at all.
	const deepest = Math.max(...parsed.value.comments.map((comment) => comment.depth));
	assert.equal(deepest, 5);
	assert.equal(byId.get("onfui9h")?.depth, 2);
	assert.equal(byId.get("onfu81o")?.parentId, "t1_onfu1fn");

	// Determinism: the projection is keyed on the comment set, so a parser that reordered
	// would miss the cache on every refetch.
	const second = parseArcticComments(fixture(FIXTURES.arcticComments), { postId: "1tld3qq", fetchedAtUtc: 1_790_000_000, limit: 100 });
	assert.deepEqual(second.ok ? second.value.comments.map((c) => c.commentId) : null, parsed.value.comments.map((c) => c.commentId));
});

test("arctic comments/search: no _meta means live-but-unverified, never 'no removals'", () => {
	const parsed = parseArcticComments(fixture(FIXTURES.arcticComments), { postId: "1tld3qq", fetchedAtUtc: 1_790_000_000, limit: 100 });
	if (!parsed.ok) return assert.fail("fixture should parse");
	for (const comment of parsed.value.comments) {
		assert.equal(comment.removal.kind, "live");
		// The `fields` selector strips `_meta`, so absence of evidence is recorded as such.
		assert.equal(comment.removal.kind === "live" ? comment.removal.removalChecked : true, false);
	}
	assert.ok(parsed.value.notes.includes("unverified-removals"));
});

test("arctic comments/search: a bracketed body is a removal even without _meta", () => {
	const body = JSON.stringify({ data: [{ id: "c1", parent_id: "t3_x", author: "a", body: "[deleted]", score: 1, created_utc: 5 }, { id: "c2", parent_id: "t3_x", author: "b", body: "[removed]", score: 1, created_utc: 6 }] });
	const parsed = parseArcticComments(body, { postId: "x", fetchedAtUtc: 1, limit: 100 });
	if (!parsed.ok) return assert.fail("should parse");
	assert.equal(parsed.value.comments[0]?.removal.kind, "deleted-by-author");
	assert.equal(parsed.value.comments[1]?.removal.kind, "removed-by-moderator");
	// A removed body is not prose: keeping "[removed]" would let the projection quote a
	// moderation notice as if it were an opinion.
	assert.equal(parsed.value.comments[1]?.body, "");
});

// ------------------------------------------------------------------ Arctic: posts

test("arctic posts/search: hits with constructed permalinks and stable hit ids", () => {
	const parsed = parseArcticPosts(fixture(FIXTURES.arcticPosts), { limit: 3 });
	assert.equal(parsed.ok, true);
	if (!parsed.ok) return;
	assert.equal(parsed.value.hits.length, 3);
	assert.deepEqual(parsed.value.hits.map((hit) => hit.hitId), ["r01", "r02", "r03"]);
	const first = parsed.value.hits[0];
	assert.equal(first?.subreddit, "MechanicalKeyboards");
	// `permalink` is not a valid archive field (measured 400), so it is constructed.
	assert.equal(first?.permalink, `https://www.reddit.com/r/MechanicalKeyboards/comments/${first?.postId}/`);
	assert.equal(first?.scoreConfidence, "exact");
});

test("arctic errors: a 422 Timeout is a throttle, an invalid field is a caller bug", () => {
	const timeout = mapArcticFailure(response({ status: 422, body: fixture(FIXTURES.arcticTimeout422) }));
	assert.equal(timeout?.kind, "throttled");
	if (timeout?.kind === "throttled") assert.equal(timeout.retryAfterMs, 8_000);

	// The distinction the whole taxonomy exists for: 422 must never be read as "bad request".
	const scope = mapArcticFailure(response({ status: 400, body: fixture(FIXTURES.arcticQueryScope400) }));
	assert.equal(scope?.kind, "error");
	if (scope?.kind === "error") assert.equal(scope.code, "capability");

	const field = mapArcticFailure(response({ status: 400, body: fixture(FIXTURES.arcticInvalidField400) }));
	assert.equal(field?.kind, "error");
	if (field?.kind === "error") assert.equal(field.code, "capability");

	// A 200 is worth parsing; the taxonomy says nothing about it.
	assert.equal(mapArcticFailure(response({ status: 200, body: fixture(FIXTURES.arcticPosts) })), null);

	const throttled = mapArcticFailure(response({ status: 429, body: "", headers: { "x-ratelimit-reset": "45" } }));
	assert.equal(throttled?.kind, "throttled");
	if (throttled?.kind === "throttled") assert.equal(throttled.retryAfterMs, 46_000);

	const walled = mapArcticFailure(response({ status: 403, body: "x".repeat(189_908) }));
	assert.equal(walled?.kind, "walled");
});

test("arctic 200 with data:null is an error with the archive's own reason", () => {
	const parsed = parseArcticPosts(JSON.stringify({ data: null, error: "'query' query parameter requires one of: author, subreddit" }), { limit: 10 });
	assert.equal(parsed.ok, false);
	if (parsed.ok) return;
	assert.match(parsed.detail, /requires one of/);
});

// ------------------------------------------------------------------ RSS

test("rss: the whole thread, flat, with the post entry not counted as a comment", () => {
	const parsed = parseRssThread(fixture(FIXTURES.rssThread), { postId: "1tld3qq", limit: 100 });
	assert.equal(parsed.ok, true);
	if (!parsed.ok) return;

	// Four comment entries kept in the fixture, plus the post entry which shares the element
	// shape and must not become a fifth comment.
	assert.equal(parsed.value.comments.length, 4);
	assert.equal(parsed.value.postId, "1tld3qq");
	assert.equal(parsed.value.subreddit, "MechanicalKeyboards");
	assert.equal(parsed.value.title, "Lofree Flow 2 84 review | low-profile mechanical done in metal");
	assert.equal(parsed.value.createdUtc, 1779533168);
	assert.equal(parsed.value.treeKnown, false);
	assert.equal(parsed.value.collapsed, 0);

	const first = parsed.value.comments.find((comment) => comment.commentId === "oneop6a");
	assert.equal(first?.author, "rajvir_03");
	// The recorded feed carries no score span in any comment, and a guess here would poison
	// the ranking it feeds.
	assert.equal(first?.score, null);
	assert.equal(first?.depth, 0);
	// HTML is gone, prose survives, and the `&#39;` inside a `<p>` is only visible after both
	// decode passes.
	assert.ok(first?.body.includes("I've used stock"));
	assert.ok(!(first?.body ?? "").includes("<"));
	assert.ok(parsed.value.notes.includes("tree-unknown"));
	assert.ok(parsed.value.notes.includes("unverified-removals"));
});

test("rss: score recovery from the rendered span, and null when the span is absent", () => {
	assert.equal(scoreFromContent('<div class="md"><p>x</p> <span class="score unvoted">388</span></div>'), 388);
	assert.equal(scoreFromContent('<span class="score dislikes">-4</span>'), -4);
	assert.equal(scoreFromContent('<span class="score-hidden">hidden</span>'), null);
	assert.equal(scoreFromContent('<div class="md"><p>no score here</p></div>'), null);
});

test("rss: hitting the requested limit is what truncation means", () => {
	const parsed = parseRssThread(fixture(FIXTURES.rssThread), { postId: "1tld3qq", limit: 4 });
	if (!parsed.ok) return assert.fail("should parse");
	assert.equal(parsed.value.truncated, true);
	assert.ok(parsed.value.notes.includes("truncated"));
});

test("rss: a feed with no entries is a parse error, not an empty thread", () => {
	const parsed = parseRssThread('<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom"></feed>', { postId: "x", limit: 100 });
	assert.equal(parsed.ok, false);
});

// ------------------------------------------------------------------ .json

test(".json: the [post, comments] Listing pair, with `more` counted and nesting kept", () => {
	const parsed = parseJsonThread(fixture(FIXTURES.jsonThread), { postId: "1tld3qq", fetchedAtUtc: 1_790_000_000, limit: 100 });
	assert.equal(parsed.ok, true);
	if (!parsed.ok) return;

	assert.equal(parsed.value.postId, "1tld3qq");
	assert.equal(parsed.value.subreddit, "MechanicalKeyboards");
	assert.equal(parsed.value.title, "Lofree Flow 2 84 review | low-profile mechanical done in metal");
	assert.equal(parsed.value.treeKnown, true);
	// Five `t1` children; the `t3` post and the `kind:"more"` marker are not comments.
	assert.equal(parsed.value.comments.length, 5);
	// `more` children were not returned, and a parser that dropped that count would report a
	// complete window over a thread it half-read.
	assert.equal(parsed.value.collapsed, 10);

	const byId = new Map(parsed.value.comments.map((comment) => [comment.commentId, comment]));
	assert.equal(byId.get("oneos2b")?.depth, 1);
	assert.equal(byId.get("oneos2b")?.parentId, "t1_oneop6a");
	// `removed_by_category` is Reddit's own word for a moderator removal.
	assert.equal(byId.get("oneqo0c")?.removal.kind, "removed-by-moderator");
	assert.equal(byId.get("oneqo0c")?.body, "");
	// A null score is a fact, not a zero.
	assert.equal(byId.get("oneqk1x")?.score, null);
});

test(".json: search hits keep the real permalink and the cursor", () => {
	const listing = {
		kind: "Listing",
		data: {
			after: "t3_abc",
			children: [
				{ kind: "t3", data: { id: "abc", subreddit: "MechanicalKeyboards", title: "Is expensive lube worth it?", score: 88, num_comments: 412, created_utc: 1_700_000_000, author: "someone", permalink: "/r/MechanicalKeyboards/comments/abc/is_expensive_lube_worth_it/", over_18: false, removed_by_category: null } },
				{ kind: "t3", data: { id: "def", subreddit: "olkb", title: "Cheaper alternatives", score: 22, num_comments: 31, created_utc: 1_700_000_100, author: "other", permalink: "/r/olkb/comments/def/cheaper/", over_18: true, removed_by_category: "moderator" } },
			],
		},
	};
	const parsed = parseJsonHits(JSON.stringify(listing));
	if (!parsed.ok) return assert.fail("should parse");
	assert.equal(parsed.value.hits.length, 2);
	assert.equal(parsed.value.hits[0]?.permalink, "https://www.reddit.com/r/MechanicalKeyboards/comments/abc/is_expensive_lube_worth_it/");
	assert.equal(parsed.value.hits[1]?.removed, true);
	assert.equal(parsed.value.hits[1]?.over18, true);
	assert.equal(parsed.value.after, "t3_abc");
	assert.equal(parsed.value.exhausted, false);
});

test(".json failures: 401 and a login redirect are dead sessions, not walls", () => {
	const unauthorized = mapJsonFailure(response({ status: 401, body: "" }));
	assert.equal(unauthorized?.kind, "dead-session");

	const redirect = mapJsonFailure(response({ status: 302, body: "", headers: { location: "https://www.reddit.com/login/?reason=lor2" } }));
	assert.equal(redirect?.kind, "dead-session");

	const walled = mapJsonFailure(response({ status: 403, body: "x".repeat(1_522) }));
	assert.equal(walled?.kind, "walled");
	if (walled?.kind === "walled") assert.equal(walled.shape, "plain");

	const throttled = mapJsonFailure(response({ status: 429, body: "", headers: { "retry-after": "2" } }));
	assert.equal(throttled?.kind, "throttled");
	if (throttled?.kind === "throttled") assert.equal(throttled.retryAfterMs, 2_000);

	assert.equal(mapJsonFailure(response({ status: 200, body: "{}" })), null);
});

test(".json: a body that is neither a Listing nor an array of them is a parse failure", () => {
	const parsed = parseJsonThread('{"nope":true}', { postId: "x", fetchedAtUtc: 1, limit: 100 });
	assert.equal(parsed.ok, false);
	if (!parsed.ok) assert.equal(parsed.code, "parse");
});
