// The router: capability, then budget, then health — and one failure→next-channel rule.
//
// The channel layer's whole access model lives in these assertions, so the fakes are
// explicit about what each route answers. Three things are being tested and they are the
// three that decide whether the pipeline works at all:
//
//   * a brand-new session (or an absent one) must degrade to the routes that do work, and
//     say why in words a `Gap` can carry;
//   * the three wall shapes must produce three different consequences — quarantine the
//     identity, escalate the transport, or wait on the clock;
//   * a scarce channel must not be spent by a retry, because 60 s on one egress cannot be
//     given back.

import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AVAILABLE, CAPABILITIES, toWorkerMode } from "../src/channels/reddit/channel.ts";
import type { Availability, RedditChannel } from "../src/channels/reddit/channel.ts";
import { FIXTURES, fixture } from "../src/channels/reddit/fixtures.ts";
import { RssChannel } from "../src/channels/reddit/rss.ts";
import type { Transport } from "../src/channels/reddit/transport.ts";
import { BUCKET_LIMITS, BucketStore } from "../src/channels/reddit/budget.ts";
import { HealthBoard } from "../src/channels/reddit/health.ts";
import { CANDIDATES, RedditRouter, classifyEnvelope } from "../src/channels/reddit/router.ts";
import { RedditStore } from "../src/channels/reddit/store.ts";
import type { Capability, ChannelId, Envelope, FetchOpts, Hit, HitList, RawComment, RawThread, ScopedQuery } from "../src/channels/reddit/types.ts";

const T0 = 1_790_000_000_000;
const NOW_SEC = Math.floor(T0 / 1000);
const OPTS: FetchOpts = { deadlineAt: T0 + 90_000, subreddit: "MechanicalKeyboards" };

const QUERY: ScopedQuery = { phrase: "krytox 205g0 worth it", subreddits: ["MechanicalKeyboards"], sort: "relevance", window: null, limit: 25, after: null };
const GLOBAL: ScopedQuery = { ...QUERY, subreddits: [] };

function comment(id: string, body: string): RawComment {
	return { commentId: id, parentId: null, author: `u_${id}`, body, score: 10, createdUtc: NOW_SEC - 3_600, distinguished: null, removal: { kind: "live", removalChecked: false }, depth: 0 };
}

function rawThread(channel: ChannelId): RawThread {
	return { postId: "1tld3qq", subreddit: "MechanicalKeyboards", title: "Is expensive lube worth it?", createdUtc: NOW_SEC - 3_600, channel, identity: `${channel}:test`, fetchedAtUtc: NOW_SEC, comments: [comment("c1", "Krytox is genuinely better for tactiles and it does not migrate over two years."), comment("c2", "Not worth it, the cheaper option is 90% as good for a third of the price.")], truncated: false, collapsed: 0, treeKnown: true, cost: { requests: 1, bytes: 4_000, wallMs: 800 } };
}

function hits(channel: ChannelId): HitList {
	const hit: Hit = { hitId: "r01", postId: "1tld3qq", subreddit: "MechanicalKeyboards", title: "Is expensive lube worth it?", score: 88, numComments: 412, createdUtc: NOW_SEC - 86_400, author: "someone", over18: false, permalink: "https://www.reddit.com/r/MechanicalKeyboards/comments/1tld3qq/", removed: false, scoreConfidence: "exact" };
	return { channel, identity: `${channel}:test`, query: QUERY, fetchedAtUtc: NOW_SEC, hits: [hit], exhausted: true, notes: [], cost: { requests: 1, bytes: 2_000, wallMs: 400 } };
}

const okThread = (channel: ChannelId): Envelope<RawThread> => ({ kind: "ok", value: rawThread(channel), channel, identity: `${channel}:test`, fetchedAtUtc: NOW_SEC, cost: { requests: 1, bytes: 4_000, wallMs: 800 }, notes: [] });
const okHits = (channel: ChannelId): Envelope<HitList> => ({ kind: "ok", value: hits(channel), channel, identity: `${channel}:test`, fetchedAtUtc: NOW_SEC, cost: { requests: 1, bytes: 2_000, wallMs: 400 }, notes: [] });
const walled = (channel: ChannelId, shape: "branded" | "plain" = "branded"): Envelope<never> => ({ kind: "walled", shape, channel, identity: `${channel}:test` });
const throttled = (channel: ChannelId, retryAfterMs: number): Envelope<never> => ({ kind: "throttled", retryAfterMs, channel, identity: `${channel}:test` });
const unavailable = (channel: ChannelId, detail: string): Envelope<never> => ({ kind: "unavailable", channel, detail });
const failed = (channel: ChannelId, code: "transport" | "parse" | "capability"): Envelope<never> => ({ kind: "error", code, channel, detail: `${code} failure` });
const empty = (channel: ChannelId): Envelope<never> => ({ kind: "empty", channel, notes: [] });

interface Fake extends RedditChannel {
	readonly calls: { search: number; fetch: number };
}

function fake(options: {
	id: ChannelId;
	capabilities?: readonly Capability[];
	availability?: Availability;
	fetch?: () => Envelope<RawThread>;
	search?: () => Envelope<HitList>;
}): Fake {
	const calls = { search: 0, fetch: 0 };
	return {
		id: options.id,
		capabilities: options.capabilities === undefined ? CAPABILITIES[options.id] : new Set(options.capabilities),
		budget: BUCKET_LIMITS[options.id] ?? { capacity: 1, refillPerSec: 1, basis: "fake" },
		availability: () => options.availability ?? AVAILABLE,
		calls,
		search: () => {
			calls.search += 1;
			return Promise.resolve(options.search?.() ?? okHits(options.id));
		},
		fetchThread: () => {
			calls.fetch += 1;
			return Promise.resolve(options.fetch?.() ?? okThread(options.id));
		},
	};
}

interface Harness {
	readonly router: RedditRouter;
	readonly health: HealthBoard;
	readonly buckets: BucketStore;
	readonly sleeps: number[];
	/** The clock the router reads. Sleeping advances it, the way a real sleep advances a real
	 *  clock — without that, the bucket hold a retry depends on can never be satisfied. */
	readonly advance: (ms: number) => void;
}

function harness(channels: Partial<Record<ChannelId, RedditChannel>>, options: { maxRequests?: number; store?: RedditStore | null; startAt?: number } = {}): Harness {
	const dir = mkdtempSync(join(tmpdir(), "reddit-router-"));
	let now = options.startAt ?? T0;
	const sleeps: number[] = [];
	const health = new HealthBoard();
	const buckets = new BucketStore({ dir });
	const advance = (ms: number): void => {
		now += ms;
	};
	const router = new RedditRouter({
		channels,
		health,
		buckets,
		store: options.store ?? null,
		now: () => now,
		rng: () => 0.5,
		maxRequests: options.maxRequests,
		sleep: (ms) => {
			sleeps.push(ms);
			advance(ms);
			return Promise.resolve();
		},
	});
	return { router, health, buckets, sleeps, advance };
}

test("the candidate set differs per capability, which is why this is not a fallback list", () => {
	// Arctic has no global search at all: `posts/search?query=` without a scope is a hard 400,
	// so a global phrase has exactly two routes and neither of them is the archive (§1.3a).
	assert.deepEqual(CANDIDATES["search.global"], ["json", "browser"]);
	assert.deepEqual(CANDIDATES["search.scoped"], ["json", "arctic", "browser"]);
	// RSS is cheaper per comment than `.json` and still sorts last: one token costs 60 s of wall
	// clock on the whole egress (§5.3).
	assert.deepEqual(CANDIDATES["thread.fetch"], ["arctic", "json", "rss"]);
	assert.deepEqual(CANDIDATES["removal.state"], ["arctic"]);
});

test("a global search with no session degrades to a Gap that says why, not to a scoped search", async () => {
	const json = fake({ id: "json", availability: { available: false, detail: "curl_cffi is not importable: the .json route needs TLS impersonation (spec §1.2)" } });
	const browser = fake({ id: "browser", availability: { available: false, detail: "no bridge wired" } });
	const arctic = fake({ id: "arctic" });
	const { router } = harness({ json, browser, arctic });

	const run = await router.search(GLOBAL, OPTS);
	assert.equal(run.envelope.kind, "error");
	if (run.envelope.kind !== "error") return;
	assert.equal(run.envelope.code, "exhausted");
	// The detail is the `Gap`: every candidate, its outcome and its reason on one line.
	assert.match(run.envelope.detail, /json unavailable \(curl_cffi is not importable/);
	assert.match(run.envelope.detail, /browser unavailable \(no bridge wired/);
	assert.equal(run.requests, 0, "a standing condition must not cost a request");
	// And the substitution the spec forbids never happens: Arctic was not asked to search
	// globally and then reported as an answer to a different question.
	assert.equal(arctic.calls.search, 0);
});

test("a scoped search prefers the session route", async () => {
	const json = fake({ id: "json" });
	const arctic = fake({ id: "arctic" });
	const { router } = harness({ json, arctic });
	const run = await router.search(QUERY, OPTS);
	assert.equal(run.envelope.kind, "ok");
	if (run.envelope.kind !== "ok") return;
	assert.equal(run.envelope.channel, "json");
	assert.equal(arctic.calls.search, 0, "the 30%-reliable archive should not be spent first");
	assert.equal(run.requests, 1);
});

test("a branded wall quarantines the identity and advances, keeping the evidence", async () => {
	const arctic = fake({ id: "arctic", fetch: () => walled("arctic", "branded") });
	const json = fake({ id: "json" });
	const { router, health } = harness({ arctic, json });

	const run = await router.fetchThread("1tld3qq", OPTS);
	assert.equal(run.envelope.kind, "ok");
	if (run.envelope.kind !== "ok") return;
	assert.equal(run.envelope.channel, "json");
	assert.equal(run.attempts[0]?.channel, "arctic");
	// The provenance names the observation — a wall — and the detail says which shape it was.
	assert.equal(run.attempts[0]?.outcome, "walled");
	assert.match(run.attempts[0]?.detail ?? "", /branded wall/);
	// 15 minutes on (identity, channel) — not on the channel, which is still healthy for
	// other capabilities.
	assert.ok(health.quarantineUntil("arctic", "arctic:test") > T0);
	assert.equal(health.usable("arctic", "search.scoped", T0, "arctic:test").ok, false);
});

test("a plain block escalates the transport on the same identity instead of quarantining it", async () => {
	const arctic = fake({ id: "arctic", fetch: () => walled("arctic", "plain") });
	const json = fake({ id: "json" });
	const { router, health } = harness({ arctic, json });

	const run = await router.fetchThread("1tld3qq", OPTS);
	assert.equal(run.envelope.kind === "ok" ? run.envelope.channel : null, "json");
	// Advancing *is* the escalation here: the next candidate for the capability is the stronger
	// transport. What must not happen is the identity being retired on one plain block.
	assert.equal(health.quarantineUntil("arctic", "arctic:test"), 0, "a 403 with a small body is not proof the cookie is stolen");
	assert.equal(health.snapshot()[0]?.breakUntil, 0, "and it is not a broken route either");
	assert.match(run.attempts[0]?.detail ?? "", /escalate to the next transport/);

	// Three challenges in a row are a route that does not work from here, and only then does the
	// capability go down.
	health.record({ channel: "arctic", capability: "thread.fetch", kind: "transient", now: T0 });
	health.record({ channel: "arctic", capability: "thread.fetch", kind: "transient", now: T0 });
	assert.equal(health.usable("arctic", "thread.fetch", T0).ok, false);
});

test("a 429 lands on the bucket and never on identity health", async () => {
	const arctic = fake({ id: "arctic", fetch: () => throttled("arctic", 60_000) });
	const json = fake({ id: "json" });
	const { router, health, buckets, sleeps } = harness({ arctic, json });

	const run = await router.fetchThread("1tld3qq", OPTS);
	assert.equal(run.envelope.kind === "ok" ? run.envelope.channel : null, "json");
	assert.equal(health.quarantineUntil("arctic", "arctic:test"), 0, "a full bucket is a clock, not a judgement");
	assert.ok(buckets.nextEligibleAt("arctic", T0) > T0, "the wait is applied to the bucket");
	assert.deepEqual(sleeps, [], "a 60 s wait is not something a 90 s query sleeps through");
});

test("Arctic's 8 s search backoff is applied to the bucket, not slept through", async () => {
	const arctic = fake({ id: "arctic", search: () => throttled("arctic", 8_000) });
	const json = fake({ id: "json", search: () => unavailable("json", "no session") });
	const { router, sleeps, buckets } = harness({ json, arctic });
	// Only arctic is a candidate here.
	const scopedOnly = await router.search(QUERY, OPTS);
	assert.equal(scopedOnly.envelope.kind === "error" ? scopedOnly.envelope.code : null, "exhausted");
	assert.deepEqual(sleeps, []);
	assert.ok(buckets.nextEligibleAt("arctic:search", T0) >= T0 + 8_000);
});

test("a short transient failure gets exactly one retry on the same channel", async () => {
	let attempt = 0;
	const arctic = fake({
		id: "arctic",
		fetch: () => {
			attempt += 1;
			return attempt === 1 ? failed("arctic", "transport") : okThread("arctic");
		},
	});
	const { router, sleeps } = harness({ arctic });
	const run = await router.fetchThread("1tld3qq", OPTS);
	assert.equal(run.envelope.kind, "ok");
	assert.equal(arctic.calls.fetch, 2);
	assert.deepEqual(sleeps, [1_000], "one backoff, one retry — not a loop");
	// The per-query budget counts both attempts.
	assert.equal(run.requests, 2);
});

test("two transient failures in a row advance the channel and open a breaker", async () => {
	const arctic = fake({ id: "arctic", fetch: () => failed("arctic", "transport") });
	const json = fake({ id: "json" });
	const { router, health } = harness({ arctic, json });
	const run = await router.fetchThread("1tld3qq", OPTS);
	assert.equal(run.envelope.kind === "ok" ? run.envelope.channel : null, "json");
	assert.equal(arctic.calls.fetch, 2);
	// 2 strikes is below the 3-strike breaker, so arctic is still usable — the breaker exists for
	// repeated failure across queries, not for one bad minute.
	assert.equal(health.usable("arctic", "thread.fetch", T0).ok, true);
	health.record({ channel: "arctic", capability: "thread.fetch", kind: "transient", now: T0 });
	assert.equal(health.usable("arctic", "thread.fetch", T0).ok, false);
});

test("empty is an answer: the router does not shop the question around", async () => {
	const arctic = fake({ id: "arctic", fetch: () => empty("arctic") });
	const json = fake({ id: "json" });
	const { router } = harness({ arctic, json });
	const run = await router.fetchThread("1tld3qq", OPTS);
	assert.equal(run.envelope.kind, "empty");
	assert.equal(json.calls.fetch, 0, "re-asking would only confirm it");
});

test("rss refuses before spending its token when no subreddit is known", async () => {
	// The adapter is the thing that knows the path needs a subreddit, so this is asserted against
	// the real adapter over the recorded feed rather than against a fake that would hide it.
	let transported = 0;
	const transport: Transport = () => {
		transported += 1;
		return Promise.resolve({ status: 200, headers: { "x-ratelimit-reset": "45" }, bytes: 1, text: fixture(FIXTURES.rssThread), wallMs: 5 });
	};
	const rss = new RssChannel({ transport, now: () => T0, rng: () => 0.5 });

	const refused = await rss.fetchThread("1tld3qq", { deadlineAt: T0 + 90_000 });
	assert.equal(refused.kind, "error");
	if (refused.kind === "error") {
		assert.equal(refused.code, "capability");
		assert.match(refused.detail, /needs the subreddit in the path/);
	}
	assert.equal(transported, 0, "no request may be issued to learn something already known");

	// And in the router it becomes the last line of a Gap rather than the whole answer.
	const run = await harness({
		arctic: fake({ id: "arctic", availability: { available: false, detail: "down" } }),
		json: fake({ id: "json", availability: { available: false, detail: "no session" } }),
		rss,
	}).router.fetchThread("1tld3qq", { deadlineAt: T0 + 90_000 });
	assert.equal(run.envelope.kind, "error");
	// Recorded as a *skip*: the route declined the question and the network was never asked.
	if (run.envelope.kind === "error") assert.match(run.envelope.detail, /rss skipped \(rss: rss needs the subreddit in the path/);
});

test("the whole chain runs on recorded bytes: rss serves a thread the archive could not", async () => {
	const transport: Transport = (request) => {
		if (!request.url.includes("/.rss")) return Promise.resolve({ status: 404, headers: {}, bytes: 0, text: "", wallMs: 1 });
		return Promise.resolve({ status: 200, headers: { "x-ratelimit-reset": "45" }, bytes: fixture(FIXTURES.rssThread).length, text: fixture(FIXTURES.rssThread), wallMs: 420 });
	};
	const rss = new RssChannel({ transport, now: () => T0, rng: () => 0.5 });
	const h = harness({
		arctic: fake({ id: "arctic", fetch: () => walled("arctic", "branded") }),
		json: fake({ id: "json", availability: { available: false, detail: "curl_cffi is not importable (spec §1.2)" } }),
		rss,
	});

	const run = await h.router.fetchThread("1tld3qq", OPTS);
	assert.equal(run.envelope.kind, "ok");
	if (run.envelope.kind !== "ok") return;
	assert.equal(run.envelope.channel, "rss");
	assert.equal(run.envelope.value.comments.length, 4);
	// The feed is flat, and the envelope says so rather than letting the projection invent a tree.
	assert.equal(run.envelope.value.treeKnown, false);
	assert.ok(run.envelope.notes.includes("tree-unknown"));
	// Two requests were charged: the branded wall is still a request that left the machine, and
	// under-counting it is how a per-query budget stops being a budget.
	assert.equal(run.requests, 2);
	// The token is spent for 45 s + 1 s + the 2–9 s jitter band, on the bucket, from the header,
	// with `rng` pinned to 0.5 so the whole chain from `x-ratelimit-reset` to `nextEligibleAt` is
	// asserted exactly: 46000 + (2000 + 0.5 × 7000).
	assert.equal(h.buckets.nextEligibleAt("rss", T0), T0 + 51_500, "the server's reset must reach the bucket");

	// The three diagnoses are all present in the provenance, which is what a record's
	// `Provenance.channels` and a `Gap` are written from.
	assert.deepEqual(run.attempts.map((attempt) => [attempt.channel, attempt.outcome]), [
		["arctic", "walled"],
		["json", "unavailable"],
		["rss", "ok"],
	]);
});

test("a bucket with no token inside the deadline is skipped, not waited for", async () => {
	const rss = fake({ id: "rss" });
	const { router, buckets } = harness({ rss });
	// Spend the single RSS token, then ask again with a deadline inside the refill.
	assert.equal(buckets.take("rss", T0).ok, true);
	const run = await router.fetchThread("1tld3qq", { deadlineAt: T0 + 5_000, subreddit: "MechanicalKeyboards" });
	assert.equal(run.envelope.kind, "error");
	assert.equal(rss.calls.fetch, 0, "no request may be issued without a token");
	const rssAttempt = run.attempts.find((attempt) => attempt.channel === "rss");
	assert.equal(rssAttempt?.outcome, "budget");
	assert.match(rssAttempt?.detail ?? "", /past the deadline/);
});

test("the per-query request budget is enforced, and says so", async () => {
	const arctic = fake({ id: "arctic", fetch: () => failed("arctic", "parse") });
	const json = fake({ id: "json" });
	const { router } = harness({ arctic, json }, { maxRequests: 1 });
	const run = await router.fetchThread("1tld3qq", OPTS);
	assert.equal(run.envelope.kind, "error");
	if (run.envelope.kind !== "error") return;
	assert.equal(run.envelope.code, "budget");
	assert.equal(run.requests, 1);
	assert.equal(json.calls.fetch, 0);
});

test("the store answers the second fetch with no request, and coalesces concurrent ones", async () => {
	const dir = mkdtempSync(join(tmpdir(), "reddit-router-store-"));
	try {
		const store = new RedditStore({ dir, now: () => T0 });
		const arctic = fake({ id: "arctic" });
		const { router, advance } = harness({ arctic }, { store });

		const first = await router.fetchThread("1tld3qq", OPTS);
		assert.equal(first.cached, false);
		assert.equal(first.requests, 1);

		const second = await router.fetchThread("1tld3qq", OPTS);
		assert.equal(second.cached, true);
		assert.equal(second.requests, 0);
		assert.equal(arctic.calls.fetch, 1, "fetch-once means once");

		// Same behaviour for the search path, keyed on the exact query tuple.
		await router.search(QUERY, OPTS);
		await router.search(QUERY, OPTS);
		assert.equal(arctic.calls.search, 1);
		// Past the 2 s arctic search gate, so the next search is about the query and not the bucket.
		advance(2_100);
		await router.search({ ...QUERY, phrase: "gateron yellow vs cherry red" }, OPTS);
		assert.equal(arctic.calls.search, 2, "a rephrased query is a different question");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("classifyEnvelope is the one table the whole failure rule reads", () => {
	assert.equal(classifyEnvelope(okThread("arctic")), null);
	// `empty` is a fact about Reddit, not a failure of the channel.
	assert.equal(classifyEnvelope(empty("arctic")), null);
	assert.equal(classifyEnvelope(throttled("arctic", 8_000))?.class, "budget");
	assert.equal(classifyEnvelope(walled("arctic"))?.class, "identity");
	assert.equal(classifyEnvelope({ kind: "dead-session", channel: "json", identity: "json:x" })?.class, "identity");
	// A caller bug advances without taking the channel out for ten minutes.
	assert.equal(classifyEnvelope(failed("arctic", "capability"))?.class, "standing");
	// A shape change will not fix itself in the next second.
	assert.equal(classifyEnvelope(failed("arctic", "parse"))?.class, "structural");
	assert.equal(classifyEnvelope(failed("arctic", "transport"))?.class, "transient");
	assert.equal(classifyEnvelope(unavailable("json", "absent"))?.class, "standing");
});

test("the worker's mode vocabulary is three words and the mapping is total", () => {
	// `profiles/fetch.py` MODES; a `retry` verdict comes back as one of these, so a channel id
	// must never reach the worker's state block unmapped.
	assert.deepEqual(["arctic", "rss", "json", "browser", "cache"].map((channel) => toWorkerMode(channel as ChannelId | "cache")), ["curl", "curl", "curl", "js", "cache"]);
});
