// The cache-first store: fetch-once, single-flight, content-addressed, with a staleness
// policy per resource class.
//
// **The measured hit rate is 1.7% and this design does not pretend otherwise.** Five
// queries against one subreddit, three of which succeeded, returned 59 distinct post ids
// across 60 hit slots with a pairwise overlap of 0, 0 and 1 (§6.4). Cross-query reuse is
// therefore ~zero: asking the same topic in different words is a different search. What
// this store is actually for, and what it is worth building for, is:
//
//   1. **Single-flight.** Five workers on one topic must not produce five fetches of the
//      same thread. That is 15 fetches → 3 on the first query, structurally, ~80% saved
//      (§6.4) — the only *large* saving in the design.
//   2. **One-time projection.** A thread's 840-character projection is recomputed never
//      after the first time. Content-addressed by its inputs, so a refetch of unchanged
//      bytes is free and a genuinely changed thread is a different key.
//   3. **Stale beats nothing.** A row past its TTL is served when the alternative is a
//      `Gap`: a record that says "this is three days old" is usable, one that pretends
//      otherwise is not, and one that is absent answers nothing (§6.3).
//
// Three storage decisions that are smaller than they look:
//
// - **Objects first, index second.** Raw bytes land at `objects/<sha>` before any row
//   points at them, so a crash between the two leaves a harmless orphan instead of a row
//   pointing at bytes that do not exist (§6.2 rule 5).
// - **The index is an append-only JSONL of thread rows, not SQLite.** One row per thread,
//   last write wins, loaded into memory at open. A live WAL database on a network
//   filesystem corrupts; this file cannot, and the row count is thousands, not millions.
// - **Content addressing is on `sha256(raw bytes)`**, so a 304-validated refetch that
//   returns the same bytes is detectable by a hash comparison before any parsing happens.

import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ChannelId, ChannelNote, Envelope, RawThread, ScopedQuery } from "./types.ts";
import { NO_COST } from "./types.ts";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/** §6.3, per resource class. One TTL is wrong: a subreddit's subscriber count and a
 *  two-year-old thread have nothing in common. */
export const TTL_MS = {
	/** Live thread, comments still arriving. */
	threadLive: 6 * HOUR,
	/** 48 h – 30 d: still occasionally edited or removed. */
	threadRecent: DAY,
	/** > 30 d: the comment set is effectively frozen; removals are the only change. */
	threadArchived: 7 * DAY,
	/** Multiplier once an archive channel has verified removals: there is less left to
	 *  change, so the row is worth keeping four times as long. */
	removalCheckedFactor: 4,
	/** Re-running a search is a different answer only if new posts arrived. */
	searchPage: 6 * HOUR,
} as const;

/** Which class a thread row belongs to, and therefore how long it lives. `createdUtc` is
 *  the *post's* age, not the row's: a thread fetched today that was posted in 2019 is
 *  still an archived thread. */
export function threadTtlMs(createdUtc: number, now: number, removalChecked: boolean): number {
	const age = now - createdUtc * 1000;
	const base = age < 48 * HOUR ? TTL_MS.threadLive : age < 30 * DAY ? TTL_MS.threadRecent : TTL_MS.threadArchived;
	return removalChecked ? base * TTL_MS.removalCheckedFactor : base;
}

export function sha256(text: string): string {
	return createHash("sha256").update(text, "utf8").digest("hex");
}

/** The identity of a thread row is its post id; the identity of a projection is its
 *  inputs. Two different keys for two different questions — "have we seen this thread"
 *  versus "have we already reduced exactly this comment set". */
export function projectionKey(postId: string, commentIds: readonly string[], algorithmVersion: number): string {
	return sha256(`${postId}|${commentIds.join(",")}|${algorithmVersion}`);
}

/** §6.1: the full query tuple, including the channel, because a `HitList` from Arctic and
 *  one from `.json` are different answers to a reader even when the ids agree. */
export function searchPageKey(query: ScopedQuery, channel: ChannelId): string {
	const window = query.window === null ? "none" : query.window.kind === "relative" ? `rel:${query.window.span}` : `abs:${query.window.afterUtc}-${query.window.beforeUtc}`;
	return sha256([channel, query.phrase, [...query.subreddits].sort().join(","), query.sort, window, query.after ?? "start", String(query.limit)].join("|"));
}

export interface StoredThread {
	readonly postId: string;
	readonly thread: RawThread;
	readonly fetchedAtMs: number;
	readonly expiresAtMs: number;
}

export interface ThreadLookup {
	readonly thread: RawThread;
	/** 0 while the row is fresh; positive once it is past its class TTL. */
	readonly staleByMs: number;
}

export interface SingleOutcome {
	readonly envelope: Envelope<RawThread>;
	/** True when the store answered and no request was made. */
	readonly cached: boolean;
	/** Milliseconds past the TTL, when a stale row was served because the network failed. */
	readonly staleByMs: number;
	/** True when this caller awaited another caller's in-flight fetch instead of starting
	 *  its own. The saving this store exists for. */
	readonly coalesced: boolean;
}

export interface StoreOptions {
	/** Local disk only. Nothing here may live on a network filesystem. */
	readonly dir: string;
	readonly now?: () => number;
}

export class RedditStore {
	private readonly dir: string;
	private readonly now: () => number;
	private readonly threads = new Map<string, StoredThread>();
	/** In-flight thread fetches, keyed on post id. */
	private readonly inFlight = new Map<string, Promise<Envelope<RawThread>>>();
	private readonly memo = new Map<string, unknown>();

	constructor(options: StoreOptions) {
		this.dir = options.dir;
		this.now = options.now ?? Date.now;
		this.loadIndex();
	}

	// ------------------------------------------------------------------ objects

	/** Content-addressed write. Returns the sha whether or not it already existed: the
	 *  caller's next question is "what are these bytes", not "did you store them". */
	putObject(text: string): string {
		const sha = sha256(text);
		const path = this.objectPath(sha);
		if (existsSync(path)) return sha;
		mkdirSync(dirname(path), { recursive: true });
		this.writeAtomic(path, text);
		return sha;
	}

	getObject(sha: string): string | null {
		const path = this.objectPath(sha);
		return existsSync(path) ? readFileSync(path, "utf8") : null;
	}

	private objectPath(sha: string): string {
		return join(this.dir, "objects", sha.slice(0, 2), sha);
	}

	// ------------------------------------------------------------------ threads

	/** A row, if there is one. `staleByMs` is the honesty field: the caller must be able to
	 *  say how old the answer is. */
	readThread(postId: string, now = this.now()): ThreadLookup | null {
		const row = this.threads.get(postId);
		if (row === undefined) return null;
		return { thread: row.thread, staleByMs: Math.max(0, now - row.expiresAtMs) };
	}

	writeThread(thread: RawThread, rawText?: string): StoredThread {
		const now = this.now();
		if (rawText !== undefined) this.putObject(rawText);
		const removalChecked = thread.comments.some((comment) => comment.removal.kind === "live" && comment.removal.removalChecked);
		const row: StoredThread = {
			postId: thread.postId,
			thread,
			fetchedAtMs: now,
			expiresAtMs: now + threadTtlMs(thread.createdUtc, now, removalChecked),
		};
		this.threads.set(thread.postId, row);
		this.appendIndex(row);
		return row;
	}

	threadCount(): number {
		return this.threads.size;
	}

	/** Fetch once, coalesced, and serve stale rather than nothing.
	 *
	 *  The order of the three behaviours is the design: a fresh row is returned without
	 *  touching the network; a stale row is *attempted* again, and only if that attempt
	 *  produces nothing usable is the stale row served with `staleByMs` set. Serving the
	 *  stale row first would mean never refreshing a thread that is still being read. */
	async single(postId: string, produce: () => Promise<Envelope<RawThread>>, options: { readonly allowStale?: boolean } = {}): Promise<SingleOutcome> {
		const fresh = this.readThread(postId);
		if (fresh !== null && fresh.staleByMs === 0) {
			return { envelope: this.cachedEnvelope(fresh.thread, []), cached: true, staleByMs: 0, coalesced: false };
		}

		const existing = this.inFlight.get(postId);
		if (existing !== undefined) {
			const envelope = await existing;
			return { envelope, cached: envelope.kind === "ok", staleByMs: 0, coalesced: true };
		}

		const attempt = produce()
			.then((envelope) => {
				if (envelope.kind === "ok") this.writeThread(envelope.value);
				return envelope;
			})
			.finally(() => {
				this.inFlight.delete(postId);
			});
		this.inFlight.set(postId, attempt);
		const envelope = await attempt;

		if (envelope.kind === "ok") return { envelope, cached: false, staleByMs: 0, coalesced: false };

		const stale = this.readThread(postId);
		if (stale !== null && options.allowStale !== false) {
			return { envelope: this.cachedEnvelope(stale.thread, ["stale"]), cached: true, staleByMs: stale.staleByMs, coalesced: false };
		}
		return { envelope, cached: false, staleByMs: 0, coalesced: false };
	}

	private cachedEnvelope(thread: RawThread, extra: readonly ChannelNote[]): Envelope<RawThread> {
		return {
			kind: "ok",
			value: thread,
			channel: thread.channel,
			identity: thread.identity,
			fetchedAtUtc: thread.fetchedAtUtc,
			// A cache hit costs no request and no byte on the wire. Reporting the original cost
			// here would make the router's ≤12-request budget count another query's work.
			cost: NO_COST,
			notes: [...extra, "cache-hit"],
		};
	}

	// ------------------------------------------------------------------ projections

	/** Paid once per (thread, algorithm). The `memo` is per-process and the file is per
	 *  store; both are checked, so a second process reuses the first one's work. */
	projection<T>(key: string, compute: () => T): T {
		const memoised = this.memo.get(key);
		if (memoised !== undefined) return memoised as T;
		const path = join(this.dir, "projections", `${key}.json`);
		if (existsSync(path)) {
			try {
				const parsed = JSON.parse(readFileSync(path, "utf8")) as T;
				this.memo.set(key, parsed);
				return parsed;
			} catch {
				// A corrupt projection is recomputed, never repaired: the compute is cheap and
				// deterministic, and a half-parsed projection is worse than none.
			}
		}
		const value = compute();
		this.memo.set(key, value);
		mkdirSync(dirname(path), { recursive: true });
		this.writeAtomic(path, `${JSON.stringify(value)}\n`);
		return value;
	}

	// ------------------------------------------------------------------ search pages

	/** Search pages are cached on the exact query tuple. Measured, this is worth ~2%: the
	 *  same topic asked in different words shares 1.7% of its ids (§6.4), so the only hit
	 *  this produces is a literal re-ask — which the pipeline does make, when a `refine`
	 *  fails and S3 re-runs the same phrase. It is here because a re-ask that costs a
	 *  request is a request the 12-request budget cannot spare, not because a high hit rate
	 *  is expected. */
	readSearchPage(key: string, now = this.now()): string | null {
		const path = join(this.dir, "search", `${key}.json`);
		if (!existsSync(path)) return null;
		try {
			const row = JSON.parse(readFileSync(path, "utf8")) as { objectSha?: unknown; expiresAtMs?: unknown };
			if (typeof row.objectSha !== "string" || typeof row.expiresAtMs !== "number") return null;
			if (row.expiresAtMs <= now) return null;
			return this.getObject(row.objectSha);
		} catch {
			return null;
		}
	}

	writeSearchPage(key: string, rawText: string): void {
		const objectSha = this.putObject(rawText);
		const path = join(this.dir, "search", `${key}.json`);
		mkdirSync(dirname(path), { recursive: true });
		this.writeAtomic(path, `${JSON.stringify({ objectSha, expiresAtMs: this.now() + TTL_MS.searchPage })}\n`);
	}

	// ------------------------------------------------------------------ index

	private loadIndex(): void {
		const path = this.indexPath();
		if (!existsSync(path)) return;
		for (const line of readFileSync(path, "utf8").split("\n")) {
			const trimmed = line.trim();
			if (trimmed === "") continue;
			try {
				const row = JSON.parse(trimmed) as StoredThread;
				if (typeof row.postId === "string" && row.thread !== undefined && typeof row.expiresAtMs === "number") this.threads.set(row.postId, row);
			} catch {
				// A torn final line from a crash mid-append. The row it described is simply not
				// in the cache, which costs a refetch and never a wrong answer.
				continue;
			}
		}
	}

	private indexPath(): string {
		return join(this.dir, "threads.jsonl");
	}

	private appendIndex(row: StoredThread): void {
		mkdirSync(dirname(this.indexPath()), { recursive: true });
		appendFileSync(this.indexPath(), `${JSON.stringify(row)}\n`);
	}

	private writeAtomic(path: string, text: string): void {
		const tmp = `${path}.tmp`;
		writeFileSync(tmp, text);
		renameSync(tmp, path);
	}
}

/** Where the store lives when the caller does not say. Local disk only: the same file on
 *  a network filesystem is a corruption waiting for a WAL, and there is no WAL here but
 *  there is no reason to find out. */
export function defaultStateDir(env: NodeJS.ProcessEnv = process.env): string {
	return env["REDDIT_STATE"] ?? join(process.env["HOME"] ?? "/tmp", ".cache", "reddit-pipeline");
}
