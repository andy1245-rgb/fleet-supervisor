// @live — the handful of tests that touch the network.
//
// Skipped by default. Run with `REDDIT_LIVE=1 node --test test/reddit-live.test.ts` and be
// aware of what each one spends:
//
//   * arctic: 2 requests on a bucket of 4 tokens refilling at 1/s. Thread fetch measured 6/6
//     at 0.8 s, so this is the cheap one.
//   * rss: **one** request, which consumes the entire 60-second egress bucket — after this
//     test the operator's own tooling cannot use `.rss` for a minute. It is last in the file
//     so an earlier failure cannot double-spend it.
//
// Nothing here asserts on Reddit's content, only on the shapes the parsers depend on: an
// assertion about a thread's text would fail the first time somebody edited a comment.

import assert from "node:assert/strict";
import { test } from "node:test";
import { ArcticChannel } from "../src/channels/reddit/arctic.ts";
import { RssChannel } from "../src/channels/reddit/rss.ts";
import { MEASURED_UA, nodeTransport } from "../src/channels/reddit/transport.ts";

const LIVE = process.env["REDDIT_LIVE"] === "1";
const OPTS = { deadlineAt: Date.now() + 90_000, subreddit: "MechanicalKeyboards" };

/** A thread from the specification's own measurement table (§1.3d), so a failure points at a
 *  shape change rather than at a thread somebody deleted. */
const THREAD = "1tld3qq";

test("@live arctic thread fetch returns comments with ids, bodies and depths", { skip: !LIVE }, async () => {
	const channel = new ArcticChannel({ transport: nodeTransport({ userAgent: MEASURED_UA }) });
	const run = await channel.fetchThread(THREAD, OPTS);
	assert.equal(run.kind, "ok", run.kind === "error" ? run.detail : String(run.kind));
	if (run.kind !== "ok") return;
	assert.ok(run.value.comments.length > 0);
	assert.ok(run.value.comments.every((comment) => comment.commentId.length > 0));
	assert.ok(run.value.comments.some((comment) => comment.depth > 0), "the archive returns a flat list with parent ids, not a tree");
	assert.ok(run.cost.bytes > 0);
});

test("@live arctic scoped search either answers or reports the throttle as a throttle", { skip: !LIVE }, async () => {
	const channel = new ArcticChannel({ transport: nodeTransport({ userAgent: MEASURED_UA }) });
	const run = await channel.search({ phrase: "krytox", subreddits: ["MechanicalKeyboards"], sort: "relevance", window: null, limit: 3, after: null }, OPTS);
	// Measured 3/10: a 422 whose body is "Timeout. Maybe slow down a bit" must arrive as
	// `throttled`, because an error handler that maps 422 to "bad request" retries forever.
	assert.ok(["ok", "empty", "throttled"].includes(run.kind), `unexpected ${run.kind}`);
	if (run.kind === "throttled") assert.equal(run.retryAfterMs, 8_000);
	if (run.kind === "ok") assert.ok(run.value.hits.every((hit) => hit.hitId.startsWith("r")));
});

test("@live rss cooldown reset header reaches the parser", { skip: !LIVE }, async () => {
	// One request, for the header shape only. This spends the whole 60 s bucket.
	const transport = nodeTransport({ userAgent: MEASURED_UA });
	const response = await transport({ url: `https://www.reddit.com/r/MechanicalKeyboards/comments/${THREAD}/.rss?limit=5` });
	assert.ok([200, 429].includes(response.status), `unexpected status ${response.status}`);
	if (response.status === 200) {
		assert.match(response.headers["content-type"] ?? "", /atom\+xml/);
		assert.ok(Number.parseInt(response.headers["x-ratelimit-reset"] ?? "", 10) >= 0);
		const channel = new RssChannel({ transport: () => Promise.resolve(response) });
		const run = await channel.fetchThread(THREAD, { ...OPTS, limit: 5 });
		assert.equal(run.kind, "ok");
		if (run.kind === "ok") {
			assert.equal(run.value.treeKnown, false);
			assert.ok(run.value.comments.length > 0);
		}
	}
});
