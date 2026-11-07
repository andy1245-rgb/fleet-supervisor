// The buckets. Two properties matter and both are about not spending a token twice:
// the RSS bucket holds exactly one and refills in 60 s, and a bucket that is not persisted
// gets spent again after a restart — which is the most common way a pipeline like this gets
// itself refused (§5.1).

import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BUCKET_LIMITS, BucketStore, RSS_JITTER_MS, TokenBucket, bandJitter, bucketKeyFor, fullJitter } from "../src/channels/reddit/budget.ts";

function withDir(fn: (dir: string) => void): void {
	const dir = mkdtempSync(join(tmpdir(), "reddit-budget-"));
	try {
		fn(dir);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

const T0 = 1_790_000_000_000;

test("the rss bucket holds one token and cannot be talked out of it", () => {
	withDir((dir) => {
		const buckets = new BucketStore({ dir });
		const first = buckets.take("rss", T0);
		assert.equal(first.ok, true);

		// Measured: `x-ratelimit-remaining` reads 0.0 even on the 200 that just succeeded, so a
		// second request has nothing to draw on. The wait it reports is the refill, in full.
		const second = buckets.take("rss", T0 + 1_000);
		assert.equal(second.ok, false);
		if (second.ok) return;
		// 59 s of a 60 s refill: one token per minute is the whole budget, and one successful
		// request consumes all of it.
		assert.ok(second.waitMs >= 58_000, `expected a ~59 s wait, got ${second.waitMs}`);
	});
});

test("a restart must not refill a bucket", () => {
	withDir((dir) => {
		const first = new BucketStore({ dir });
		assert.equal(first.take("rss", T0).ok, true);

		// A fresh process reads the file the previous one wrote. If this returned ok, a crash
		// loop would turn one request per minute into one request per restart.
		const reopened = new BucketStore({ dir });
		const second = reopened.take("rss", T0 + 500);
		assert.equal(second.ok, false);

		// And the persisted row is real JSON on local disk, not an in-memory artefact.
		const persisted = JSON.parse(readFileSync(join(dir, "buckets.json"), "utf8")) as Record<string, { tokens: number }>;
		assert.ok((persisted["rss"]?.tokens ?? 1) < 1, "the spent token must be on disk");
	});
});

test("the server's reset header overrides the local clock", () => {
	// A fast-refilling bucket, so the only thing that can refuse the request is the header.
	const bucket = new TokenBucket("test", { capacity: 1, refillPerSec: 1, basis: "test" });
	bucket.take(T0);
	// §5.3: `nextEligibleAt = now + x-ratelimit-reset + 1`, from every response including the
	// 429s. The +1 s is because a reset of 0 means "the token is there now" and a request at
	// exactly the boundary races the refill.
	bucket.settle(T0, 45);

	// Tokens have refilled by now, and the bucket still refuses: the server's clock is the only
	// one that decides when a 429 becomes a 200.
	const blocked = bucket.take(T0 + 2_000);
	assert.equal(blocked.ok, false);
	if (!blocked.ok) {
		assert.equal(blocked.why, "next-eligible");
		assert.ok(blocked.waitMs >= 43_000 && blocked.waitMs <= 45_000, `expected ~44 s left, got ${blocked.waitMs}`);
	}
	assert.equal(bucket.take(T0 + 46_100).ok, true);
});

test("the rss wake-up is jittered past the server's boundary, inside the measured band", () => {
	// An exact 60.000 s period is a signature, and the extra seconds cost nothing because the
	// bucket is empty anyway (§5.3).
	const values = [0, 0.25, 0.5, 0.75, 0.999].map((r) => bandJitter(RSS_JITTER_MS, () => r));
	for (const value of values) {
		assert.ok(value >= RSS_JITTER_MS.lo && value <= RSS_JITTER_MS.hi, `${value} outside the band`);
	}
	assert.equal(RSS_JITTER_MS.lo, 2_000);
	assert.equal(RSS_JITTER_MS.hi, 9_000);
});

test("arctic search has its own gate: one at a time, two seconds apart", () => {
	withDir((dir) => {
		const buckets = new BucketStore({ dir });
		// §5.2: "1 concurrent, min gap 2 s", because search succeeded 3/10 and its throttle
		// answer is a queue rather than a fault.
		assert.equal(buckets.take("arctic:search", T0).ok, true);
		const again = buckets.take("arctic:search", T0 + 100);
		assert.equal(again.ok, false);
		if (!again.ok) assert.ok(again.waitMs > 1_800 && again.waitMs <= 2_000);
		assert.equal(buckets.take("arctic:search", T0 + 2_100).ok, true);
	});
});

test("arctic fetch is untouched by the search gate", () => {
	withDir((dir) => {
		const buckets = new BucketStore({ dir });
		buckets.take("arctic:search", T0);
		// The breaker and the gate are per capability: search can be closed while thread fetch
		// runs at full rate, which is exactly today's observed state (§5.2).
		assert.equal(buckets.take("arctic", T0).ok, true);
		assert.equal(buckets.take("arctic", T0 + 100).ok, true);
	});
});

test("every declared limit carries the source of its number", () => {
	// A rate limit that is a guess is indistinguishable from a rate limit that is a bug, so
	// every entry has to name where it came from.
	for (const [key, limit] of Object.entries(BUCKET_LIMITS)) {
		assert.ok(limit.basis.length > 20, `${key} has no documented basis`);
		assert.ok(limit.capacity >= 1, `${key} cannot hold a token`);
		assert.ok(limit.refillPerSec > 0, `${key} never refills`);
	}
	assert.deepEqual(Object.keys(BUCKET_LIMITS).filter((key) => key.includes(":")).sort(), ["arctic:search", "json:cookie"]);
});

test("bucket keys route search and cookie traffic to their own gates", () => {
	assert.equal(bucketKeyFor("arctic", "search"), "arctic:search");
	assert.equal(bucketKeyFor("arctic"), "arctic");
	assert.equal(bucketKeyFor("json", "cookie"), "json:cookie");
	assert.equal(bucketKeyFor("rss"), "rss");
	// A bucket with no declared limit is a bucket that would be spent freely, so asking for one
	// is a programming error rather than a default.
	withDir((dir) => {
		const buckets = new BucketStore({ dir, limits: BUCKET_LIMITS });
		assert.throws(() => buckets.bucket("nope"), /no limit declared/);
	});
});

test("full jitter stays inside the truncated band", () => {
	for (const r of [0, 0.5, 0.999]) {
		const waited = fullJitter(8_000, () => r);
		assert.ok(waited >= 4_000 && waited <= 12_000, `${waited} outside 0.5×–1.5×`);
	}
});
