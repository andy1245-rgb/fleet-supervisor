// Every channel is a bucket, and a bucket that is not persisted is a bucket that gets
// spent twice: a restart must not refill it, which is the most common way a pipeline
// like this gets itself refused (spec §5.1).
//
// Each number below is measured on this box and its source is named, because a rate
// limit that is a guess is indistinguishable from a rate limit that is a bug. The one
// number that is *not* a hard measurement is flagged as such.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ChannelId } from "./types.ts";

export interface Limit {
	/** Tokens the bucket holds at rest. */
	readonly capacity: number;
	/** Fractional refill, tokens per second. */
	readonly refillPerSec: number;
	/** Where the number comes from. Printed in diagnostics, never parsed. */
	readonly basis: string;
}

/** `<channel>` for ordinary requests, `<channel>:<capability>` where a capability has
 *  its own gate — Arctic's search queue is the one that does (§5.2): a closed search
 *  queue must not slow thread fetch, which is 100% reliable. */
export type BucketKey = string;

export const BUCKET_LIMITS: Readonly<Record<BucketKey, Limit>> = {
	// Measured: thread fetch 6/6 at 0.7–0.9 s (spec §1.3c). 1 req/s with burst 4 keeps
	// concurrency at 1 while still letting a 6-thread query finish inside its deadline.
	// Arctic sends x-ratelimit-reset and no x-ratelimit-remaining, so there is a clock to
	// read and no budget — the schedule has to be client-side and conservative (§1.3).
	arctic: { capacity: 4, refillPerSec: 1, basis: "spec §5.2 — 0.7–0.9 s/thread measured 6/6; x-ratelimit-reset only, no remaining" },
	// Measured by driving one bucket to exhaustion: `x-ratelimit-remaining` is 0.0 even
	// on the 200 that succeeded, `x-ratelimit-reset` counts down to the next token, and
	// the window is 60 s — so the bucket is capacity 1, refill 1/60, and one successful
	// request consumes all of it (§1.4). It is shared across every www `.rss` path and
	// is not keyed on User-Agent, so a second UA buys nothing (§1.4).
	rss: { capacity: 1, refillPerSec: 1 / 60, basis: "spec §1.4 — one request per 60 s per egress, remaining 0.0 on success" },
	// Arctic's search queue, gated separately and harder: search succeeded 3/10 where
	// fetch succeeded 6/6, and the 7 failures were `422 {"error":"Timeout. Maybe slow
	// down a bit"}`, which is a *throttle returned in under a second*, not a validation
	// error (§1.3c). Capacity 1 with a 2 s refill is the "1 concurrent, min gap 2 s" of
	// §5.2 expressed as a bucket.
	"arctic:search": { capacity: 1, refillPerSec: 0.5, basis: "spec §5.2/§1.3c — 3/10 keyword searches succeeded; 422 Timeout is the queue closing" },
	// OAuth is 100 requests / 600 s per client-id with burst 10 (§4.3.1). The limit is
	// per client-id, not per egress, which is why adding an account is cheaper than
	// adding an egress on this channel.
	json: { capacity: 10, refillPerSec: 100 / 600, basis: "spec §4.3.1 — 100 req / 600 s / client-id, burst 10" },
	// Cookie mode's limit is undocumented; 60/min is the conservative assumption of §5.4,
	// to be adapted upward after 30 min of clean 200s and never downward without cause.
	"json:cookie": { capacity: 5, refillPerSec: 1, basis: "spec §5.4 — undocumented; 60/min assumed, adapt up only after 30 min clean" },
	// One navigation per 4–9 s, lognormal (§4.4). 6.5 s is the midpoint; a browser that
	// loads 20 pages in 4 s is not a browser.
	browser: { capacity: 1, refillPerSec: 1 / 6.5, basis: "spec §4.4 — 1 navigation / 4–9 s, midpoint 6.5 s" },
};

/** Wake this much past `nextEligibleAt` for `rss`. An exact 60.000 s period is a
 *  signature and the extra seconds cost nothing when the bucket is empty anyway (§5.3). */
export const RSS_JITTER_MS = { lo: 2_000, hi: 9_000 } as const;

export interface BucketState {
	readonly tokens: number;
	readonly capacity: number;
	readonly refillPerSec: number;
	readonly nextEligibleAt: number;
	readonly updatedAtUtc: number;
}

export type TakeResult = { readonly ok: true; readonly tokens: number } | { readonly ok: false; readonly waitMs: number; readonly why: "tokens" | "next-eligible" };

/** A fractional leaky bucket with an authority override.
 *
 *  `nextEligibleAt` wins over `tokens` whenever the server has spoken — the server's
 *  clock is the only one that decides when a 429 becomes a 200, and a local bucket that
 *  thinks it has a token after a `reset: 45` is wrong about the one thing it exists to
 *  be right about. */
export class TokenBucket {
	readonly key: BucketKey;
	readonly limit: Limit;
	private tokens: number;
	private nextEligibleAt: number;
	private updatedAtUtc: number;

	constructor(key: BucketKey, limit: Limit, state?: BucketState) {
		this.key = key;
		this.limit = limit;
		this.tokens = state ? Math.min(state.tokens, limit.capacity) : limit.capacity;
		this.nextEligibleAt = state?.nextEligibleAt ?? 0;
		this.updatedAtUtc = state?.updatedAtUtc ?? 0;
	}

	/** Refill by elapsed wall clock, clamped to capacity. Idempotent for a given `now`. */
	refill(now: number): void {
		if (this.updatedAtUtc === 0) {
			this.updatedAtUtc = now;
			return;
		}
		const elapsedSec = Math.max(0, now - this.updatedAtUtc) / 1000;
		this.tokens = Math.min(this.limit.capacity, this.tokens + elapsedSec * this.limit.refillPerSec);
		this.updatedAtUtc = now;
	}

	peek(now: number): { readonly tokens: number; readonly nextEligibleAt: number } {
		this.refill(now);
		return { tokens: this.tokens, nextEligibleAt: this.nextEligibleAt };
	}

	/** Take one token, or say how long to wait. No request is issued without this. */
	take(now: number): TakeResult {
		this.refill(now);
		if (now < this.nextEligibleAt) {
			return { ok: false, waitMs: this.nextEligibleAt - now, why: "next-eligible" };
		}
		if (this.tokens < 1) {
			const deficit = 1 - this.tokens;
			return { ok: false, waitMs: Math.ceil((deficit / this.limit.refillPerSec) * 1000), why: "tokens" };
		}
		this.tokens -= 1;
		return { ok: true, tokens: this.tokens };
	}

	/** Make the bucket wait, without pretending the wait refills it. Used for a 429 that
	 *  carried `Retry-After`, and for the arctic search breaker. */
	hold(now: number, waitMs: number): void {
		this.refill(now);
		this.nextEligibleAt = Math.max(this.nextEligibleAt, now + Math.max(0, Math.round(waitMs)));
	}

	/** Set the wait from a response header, which is authoritative. `reset` is an
	 *  integer countdown in seconds; the +1 s is because a reset of 0 means "the token
	 *  is there now" and a request at exactly the boundary races the refill (§1.4, §5.3). */
	settle(now: number, resetSeconds: number, jitterMs = 0): void {
		this.refill(now);
		const extra = Math.round(jitterMs);
		this.nextEligibleAt = Math.max(this.nextEligibleAt, now + Math.max(0, Math.round(resetSeconds * 1000)) + 1_000 + extra);
	}

	state(): BucketState {
		return { tokens: this.tokens, capacity: this.limit.capacity, refillPerSec: this.limit.refillPerSec, nextEligibleAt: this.nextEligibleAt, updatedAtUtc: this.updatedAtUtc };
	}
}

/** Full jitter, truncated: `wait × U(0.5, 1.5)` (§5.5). */
export function fullJitter(waitMs: number, rng: () => number): number {
	return Math.max(0, Math.round(waitMs * (0.5 + rng())));
}

/** Full jitter inside a closed band, for the RSS wake-up. */
export function bandJitter(band: { readonly lo: number; readonly hi: number }, rng: () => number): number {
	return Math.round(band.lo + rng() * (band.hi - band.lo));
}

export interface BucketStoreOptions {
	/** Local disk only. A WAL-less JSON file is safe here; a live SQLite on sshfs is not. */
	readonly dir: string;
	readonly limits?: Readonly<Record<BucketKey, Limit>>;
}

/** Buckets on disk, one file, rewritten on every take.
 *
 *  Rewriting the whole file per take is deliberate: the file is a handful of rows, and
 *  the alternative — batching the write — reintroduces exactly the crash window that
 *  makes a restart refill a 60 s bucket. */
export class BucketStore {
	private readonly path: string;
	private readonly limits: Readonly<Record<BucketKey, Limit>>;
	private readonly buckets = new Map<BucketKey, TokenBucket>();

	constructor(options: BucketStoreOptions) {
		this.path = join(options.dir, "buckets.json");
		this.limits = options.limits ?? BUCKET_LIMITS;
		const loaded = this.read();
		for (const [key, state] of loaded) {
			const limit = this.limitOf(key);
			if (limit) this.buckets.set(key, new TokenBucket(key, limit, state));
		}
	}

	limitOf(key: BucketKey): Limit | null {
		return this.limits[key] ?? null;
	}

	bucket(key: BucketKey): TokenBucket {
		const existing = this.buckets.get(key);
		if (existing) return existing;
		const limit = this.limitOf(key);
		if (!limit) throw new Error(`no limit declared for bucket ${key}: a bucket without a measured limit is a bucket that will be spent`);
		const made = new TokenBucket(key, limit);
		this.buckets.set(key, made);
		return made;
	}

	take(key: BucketKey, now: number): TakeResult {
		const result = this.bucket(key).take(now);
		if (result.ok) this.save();
		return result;
	}

	settle(key: BucketKey, now: number, resetSeconds: number, jitterMs = 0): void {
		this.bucket(key).settle(now, resetSeconds, jitterMs);
		this.save();
	}

	hold(key: BucketKey, now: number, waitMs: number): void {
		this.bucket(key).hold(now, waitMs);
		this.save();
	}

	/** When the bucket would next issue, without taking. Used by the router to decide
	 *  "wait or advance" against a deadline (§2.2). */
	nextEligibleAt(key: BucketKey, now: number): number {
		const bucket = this.bucket(key);
		const peek = bucket.peek(now);
		if (peek.nextEligibleAt > now) return peek.nextEligibleAt;
		if (peek.tokens >= 1) return now;
		return now + Math.ceil(((1 - peek.tokens) / bucket.limit.refillPerSec) * 1000);
	}

	snapshot(): Readonly<Record<BucketKey, BucketState>> {
		const out: Record<BucketKey, BucketState> = {};
		for (const [key, bucket] of this.buckets) out[key] = bucket.state();
		return out;
	}

	private read(): Map<BucketKey, BucketState> {
		const out = new Map<BucketKey, BucketState>();
		if (!existsSync(this.path)) return out;
		let parsed: unknown;
		try {
			parsed = JSON.parse(readFileSync(this.path, "utf8"));
		} catch {
			// A truncated buckets file must not be repaired into a full bucket: an
			// unreadable budget is treated as an absent one, which spends nothing.
			return out;
		}
		if (typeof parsed !== "object" || parsed === null) return out;
		for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
			if (!isBucketState(value)) continue;
			out.set(key, value);
		}
		return out;
	}

	private save(): void {
		mkdirSync(dirname(this.path), { recursive: true });
		const tmp = `${this.path}.tmp`;
		writeFileSync(tmp, `${JSON.stringify(this.snapshot(), null, "\t")}\n`);
		renameSync(tmp, this.path);
	}
}

function isBucketState(value: unknown): value is BucketState {
	if (typeof value !== "object" || value === null) return false;
	const r = value as Record<string, unknown>;
	return typeof r.tokens === "number" && typeof r.capacity === "number" && typeof r.refillPerSec === "number" && typeof r.nextEligibleAt === "number" && typeof r.updatedAtUtc === "number";
}

/** The bucket keys a channel spends on a capability. Two keys for `arctic` because
 *  search has its own gate; one for everything else. */
export function bucketKeyFor(channel: ChannelId, capability?: "search" | "cookie"): BucketKey {
	if (channel === "arctic" && capability === "search") return "arctic:search";
	if (channel === "json" && capability === "cookie") return "json:cookie";
	return channel;
}
