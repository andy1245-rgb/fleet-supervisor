// The cache-first store. What is asserted here is the three things the store is actually
// for, and one thing it deliberately is not:
//
//   * fetch-once, incl. single-flight coalescing — the ~80% saving on the first query;
//   * one-time projection — content-addressed, so the second use is free;
//   * stale beats nothing — a row past its TTL is served, with `staleByMs` said out loud;
//   * NOT a high hit rate. Cross-query reuse measured 1.7% (§6.4), so nothing here pretends
//     that asking a different question finds the same threads.

import assert from "node:assert/strict";
import { test } from "node:test";
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RedditStore, TTL_MS, projectionKey, searchPageKey, sha256, threadTtlMs } from "../src/channels/reddit/store.ts";
import type { Envelope, RawComment, RawThread, ScopedQuery } from "../src/channels/reddit/types.ts";

const T0 = 1_790_000_000_000;
const NOW_SEC = Math.floor(T0 / 1000);

function comment(id: string, body: string, overrides: Partial<RawComment> = {}): RawComment {
	return { commentId: id, parentId: null, author: `u_${id}`, body, score: 10, createdUtc: NOW_SEC - 3_600, distinguished: null, removal: { kind: "live", removalChecked: false }, depth: 0, ...overrides };
}

function thread(postId: string, overrides: Partial<RawThread> = {}): RawThread {
	return {
		postId,
		subreddit: "MechanicalKeyboards",
		title: "Is expensive lube worth it?",
		createdUtc: NOW_SEC - 3_600,
		channel: "arctic",
		identity: "arctic:anonymous",
		fetchedAtUtc: NOW_SEC,
		comments: [comment("c1", "Krytox is genuinely better for tactiles and it does not migrate."), comment("c2", "Not worth it, Superlube is 90% as good for a third of the price.")],
		truncated: false,
		collapsed: 0,
		treeKnown: true,
		cost: { requests: 1, bytes: 4_000, wallMs: 800 },
		...overrides,
	};
}

function okEnvelope(value: RawThread): Envelope<RawThread> {
	return { kind: "ok", value, channel: value.channel, identity: value.identity, fetchedAtUtc: value.fetchedAtUtc, cost: value.cost, notes: [] };
}

function withStore(fn: (store: RedditStore, dir: string, advance: (ms: number) => void) => Promise<void> | void): () => Promise<void> {
	return async () => {
		const dir = mkdtempSync(join(tmpdir(), "reddit-store-"));
		let now = T0;
		const store = new RedditStore({ dir, now: () => now });
		try {
			await fn(store, dir, (ms) => {
				now += ms;
			});
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	};
}

test("objects are content-addressed: the same bytes are one object, different bytes are two", withStore(async (store) => {
	const a = store.putObject('{"data":[]}');
	const b = store.putObject('{"data":[]}');
	const c = store.putObject('{"data":[1]}');
	assert.equal(a, b);
	assert.notEqual(a, c);
	assert.equal(store.getObject(a), '{"data":[]}');
	// A duplicated fetch is detectable by a cheap hash comparison before any parsing happens.
	assert.equal(sha256('{"data":[]}'), a);
}));

test("a fresh row answers without touching the network", withStore(async (store) => {
	let produced = 0;
	const first = await store.single("abc123", () => {
		produced += 1;
		return Promise.resolve(okEnvelope(thread("abc123")));
	});
	assert.equal(first.cached, false);
	assert.equal(produced, 1);

	const second = await store.single("abc123", () => {
		produced += 1;
		return Promise.resolve(okEnvelope(thread("abc123")));
	});
	assert.equal(second.cached, true);
	assert.equal(produced, 1, "a fresh row must not produce a second fetch");
	assert.equal(second.envelope.kind, "ok");
	if (second.envelope.kind === "ok") {
		assert.ok(second.envelope.notes.includes("cache-hit"));
		// A cache hit costs no request, so the router's 12-request budget must not be charged
		// for work another query already paid for.
		assert.deepEqual(second.envelope.cost, { requests: 0, bytes: 0, wallMs: 0 });
	}
}));

test("five concurrent callers of one thread make one fetch, which is the point", withStore(async (store) => {
	let produced = 0;
	let release: () => void = () => {};
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	const produce = async (): Promise<Envelope<RawThread>> => {
		produced += 1;
		await gate;
		return okEnvelope(thread("t3shared"));
	};
	const calls = Array.from({ length: 5 }, () => store.single("t3shared", produce));
	// Let all five reach the in-flight map before the first one resolves.
	await new Promise((resolve) => setTimeout(resolve, 5));
	release();
	const results = await Promise.all(calls);

	assert.equal(produced, 1, "five callers, one request — 15 fetches become 3 across 5 workers");
	assert.equal(results.filter((result) => result.coalesced).length, 4);
	assert.ok(results.every((result) => result.envelope.kind === "ok"));
}));

test("TTLs are per resource class, and age is the thread's, not the row's", () => {
	const now = T0;
	// Live, recent, archived: the three bands of §6.3, measured against the *post's* age.
	assert.equal(threadTtlMs(now / 1000 - 3_600, now, false), TTL_MS.threadLive);
	assert.equal(threadTtlMs(now / 1000 - 3 * 86_400, now, false), TTL_MS.threadRecent);
	assert.equal(threadTtlMs(now / 1000 - 60 * 86_400, now, false), TTL_MS.threadArchived);
	// An archive channel has already told us what was removed, so the row is worth keeping
	// four times as long.
	assert.equal(threadTtlMs(now / 1000 - 60 * 86_400, now, true), TTL_MS.threadArchived * TTL_MS.removalCheckedFactor);
});

test("a row past its TTL is refetched; a failed refetch serves the stale row, not a Gap", withStore(async (store, _dir, advance) => {
	await store.single("stale1", () => Promise.resolve(okEnvelope(thread("stale1"))));
	// Past the 6 h live-thread TTL.
	advance(TTL_MS.threadLive + 60_000);

	let produced = 0;
	const outcome = await store.single("stale1", () => {
		produced += 1;
		return Promise.resolve({ kind: "throttled", retryAfterMs: 60_000, channel: "arctic", identity: "arctic:anonymous" } as Envelope<RawThread>);
	});
	assert.equal(produced, 1, "a stale row is attempted again — otherwise a thread under continuous read would never refresh");
	assert.equal(outcome.cached, true);
	assert.ok(outcome.staleByMs > 0);
	assert.equal(outcome.envelope.kind, "ok");
	if (outcome.envelope.kind === "ok") {
		// "This is an hour old" is usable; pretending it is fresh is not.
		assert.ok(outcome.envelope.notes.includes("stale"));
		assert.ok(outcome.envelope.notes.includes("cache-hit"));
	}
}));

test("stale serving can be refused, and then the failure is the answer", withStore(async (store, _dir, advance) => {
	await store.single("stale2", () => Promise.resolve(okEnvelope(thread("stale2"))));
	advance(TTL_MS.threadLive + 60_000);
	const outcome = await store.single("stale2", () => Promise.resolve({ kind: "empty", channel: "arctic", notes: [] } as Envelope<RawThread>), { allowStale: false });
	assert.equal(outcome.cached, false);
	assert.equal(outcome.envelope.kind, "empty");
}));

test("a projection is computed once per input set, and survives a restart", withStore(async (store, dir) => {
	const key = projectionKey("abc123", ["c1", "c2"], 1);
	let computed = 0;
	const first = store.projection(key, () => {
		computed += 1;
		return { text: "2c 2a ?rm 10top || hello" };
	});
	const second = store.projection(key, () => {
		computed += 1;
		return { text: "should not happen" };
	});
	assert.equal(computed, 1);
	assert.deepEqual(first, second);

	// A projection costs minutes of local inference in the `lede` mode and is deterministic in
	// `quote`; either way it is paid once, ever, which is what makes the second use free.
	const reopened = new RedditStore({ dir, now: () => T0 });
	assert.deepEqual(reopened.projection(key, () => ({ text: "recomputed" })), first);

	// A changed comment set is a different key, so a refetched thread is a different projection
	// rather than a silently stale one.
	assert.notEqual(projectionKey("abc123", ["c1"], 1), key);
	assert.notEqual(projectionKey("abc123", ["c1", "c2"], 2), key);
}));

test("the thread index survives a restart", withStore(async (store, dir) => {
	store.writeThread(thread("persist1"), "raw-bytes");
	const reopened = new RedditStore({ dir, now: () => T0 });
	const found = reopened.readThread("persist1");
	assert.notEqual(found, null);
	assert.equal(found?.staleByMs, 0);
	assert.equal(reopened.threadCount(), 1);
	assert.ok(existsSync(join(dir, "threads.jsonl")));
}));

test("a torn index line costs a refetch, never a wrong answer", withStore(async (store, dir) => {
	store.writeThread(thread("torn1"));
	// Simulate a crash mid-append.
	writeFileSync(join(dir, "threads.jsonl"), `${JSON.stringify({ postId: "torn1", thread: thread("torn1"), fetchedAtMs: T0, expiresAtMs: T0 + 1000 })}\n{"postId":"trunc`);
	const reopened = new RedditStore({ dir, now: () => T0 });
	assert.equal(reopened.readThread("torn1")?.thread.postId, "torn1");
	assert.equal(reopened.readThread("trunc"), null);
}));

test("search pages are keyed on the whole query tuple and expire on their own clock", withStore(async (store, _dir, advance) => {
	const query: ScopedQuery = { phrase: "krytox 205g0 worth it", subreddits: ["MechanicalKeyboards"], sort: "relevance", window: { kind: "relative", span: "1y" }, limit: 25, after: null };
	const key = searchPageKey(query, "json");
	store.writeSearchPage(key, '{"hits":[]}');
	assert.equal(store.readSearchPage(key), '{"hits":[]}');
	advance(TTL_MS.searchPage + 1_000);
	assert.equal(store.readSearchPage(key), null);

	// The channel is part of the key: an answer from `.json` and one from `arctic` are different
	// answers even when the ids agree, and overwriting one with the other would misreport
	// provenance.
	assert.notEqual(searchPageKey(query, "arctic"), key);
	// So is the window and the sort order.
	assert.notEqual(searchPageKey({ ...query, sort: "new" }, "json"), key);
	assert.notEqual(searchPageKey({ ...query, window: null }, "json"), key);
}));

test("a store leaves no stray temp files behind", withStore(async (store, dir) => {
	store.writeThread(thread("tidy1"), "raw");
	store.writeSearchPage("k", "{}");
	const strays = readdirSync(dir).filter((name) => name.endsWith(".tmp"));
	assert.deepEqual(strays, []);
}));
