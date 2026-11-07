// The router: capability, then budget, then health, with one failure→next-channel rule
// applied here rather than inside the adapters.
//
// It is deliberately not a ranked list with a fallback chain, because the candidate set
// differs per capability (spec §2.2). `search.global` has no Arctic candidate at all —
// Arctic answers a bare `query=` with HTTP 400 — and `thread.fetch` has no `json`
// candidate ordering that can be written as "the best channel", because the three routes
// differ on three independent axes: 129 / 570 / 460 tokens per comment, and requests
// versus 60 seconds of wall clock.
//
// The `thread.fetch` order is worth stating because it looks wrong: RSS is *cheaper* per
// comment than `.json` (460 vs 570) and still sorts last. One RSS request costs a token
// from a bucket of capacity 1, so three threads on one egress cost three minutes of wall
// clock where Arctic costs 2.4 seconds (§5.3). The pipeline optimises wall clock inside a
// query and tokens across the corpus, and the corpus makes the token difference amortise
// to nothing.
//
// Three wall shapes, three diagnoses, three consequences: blocked → quarantine the
// identity for that channel; challenged → escalate the transport (and when the stronger
// transport does not exist, say so instead of napping the channel); rate-limited → wait on
// the clock and leave identity health alone. A 429 that quarantined the identity would take
// a healthy 60 s channel out of service for 15 minutes.

import type { Availability, RedditChannel } from "./channel.ts";
import { BucketStore, bucketKeyFor, fullJitter } from "./budget.ts";
import { DEFAULT_HEALTH_POLICY, HealthBoard } from "./health.ts";
import type { FailureClass, OutcomeKind } from "./health.ts";
import { RedditStore, searchPageKey } from "./store.ts";import type { Capability, ChannelId, Envelope, FetchOpts, HitList, RawThread, ScopedQuery } from "./types.ts";

/** §2.2's matrix, as code. Order within a row is preference; the router then filters by
 *  budget and health, so a row that starts with `json` still degrades to `browser` when the
 *  session is missing. */
export const CANDIDATES: Readonly<Record<Capability, readonly ChannelId[]>> = {
	// No Arctic candidate exists, and that is the finding this whole layer exists for: the
	// archive cannot search globally, so a global phrase has exactly two routes.
	"search.global": ["json", "browser"],
	// `.json` first: 100 req / 600 s per client-id against Arctic's 30% success rate.
	"search.scoped": ["json", "arctic", "browser"],
	// 129 → 570 → 460 tokens/comment, but RSS costs a 60 s token and sorts last on latency.
	"thread.fetch": ["arctic", "json", "rss"],
	// Only the routes that return real nesting can be candidates.
	"thread.tree": ["json", "browser"],
	// Only the archive reports `_meta.removal_type`.
	"removal.state": ["arctic"],
};

/** §5.5's ladder, reduced to the two things the router needs: how long to hold the bucket,
 *  and whether the same channel is worth one more attempt. */
export interface RetryPolicy {
	/** A failure waits no longer than this before the router advances instead of sleeping:
	 *  the 8 s Arctic search backoff is applied to the bucket, not slept through, because a
	 *  sleeping thread blocks the query that is paying for it (§5.5). */
	readonly maxInlineWaitMs: number;
	/** Same-channel attempts including the first. 2 means one retry. */
	readonly attempts: number;
	/** Initial wait for a transient failure; doubled per attempt and jittered. */
	readonly transientInitialMs: number;
	readonly transientCapMs: number;
}

export const DEFAULT_RETRY_POLICY: RetryPolicy = {
	maxInlineWaitMs: 2_000,
	attempts: 2,
	transientInitialMs: 1_000,
	transientCapMs: 30_000,
};

export interface AttemptRecord {
	readonly channel: ChannelId;
	/** `walled` is called out separately because the two wall shapes have different
	 *  consequences and a reader of the provenance needs to see which one happened. */
	readonly outcome: OutcomeKind | "skipped" | "budget" | "walled";
	readonly detail: string;
	/** Present when the channel was skipped or held rather than attempted. */
	readonly waitMs?: number;
}

export interface RouterRun<T> {
	readonly envelope: Envelope<T>;
	/** Every channel touched, in order, with the reason it was or was not used. This is the
	 *  provenance a record needs: "advance" must never silently drop a channel's evidence. */
	readonly attempts: readonly AttemptRecord[];
	readonly requests: number;
	readonly cached: boolean;
	readonly staleByMs: number;
	readonly coalesced: boolean;
}

export interface RouterOptions {
	readonly channels: Partial<Readonly<Record<ChannelId, RedditChannel>>>;
	readonly health?: HealthBoard;
	readonly buckets?: BucketStore;
	readonly store?: RedditStore | null;
	readonly now?: () => number;
	readonly rng?: () => number;
	/** §5.6: ≤12 HTTP requests per query; the 13th returns `budget` and the record is
	 *  answered with what exists. */
	readonly maxRequests?: number;
	readonly retry?: RetryPolicy;
	/** Injected so a test never waits. */
	readonly sleep?: (ms: number) => Promise<void>;
}

/** `escalate` is the plain 403's class, and it exists because that shape must **not** cost the
 *  identity: the request was seen and rejected on credential/fingerprint grounds, so the first
 *  move is the stronger transport on the same identity and only a repeat is a dead end (§5.5
 *  case 5). Nothing else maps to it. */
export interface Classified {
	readonly class: FailureClass | "standing" | "escalate";
	readonly retryAfterMs: number;
	readonly detail: string;
}

/** What an envelope means. `null` means "this is an answer": `empty` is a fact about
 *  Reddit, not a failure of the channel, and re-asking it elsewhere would only confirm it. */
export function classifyEnvelope(envelope: Envelope<unknown>): Classified | null {
	switch (envelope.kind) {
		case "ok":
			return null;
		case "empty":
			return null;
		case "throttled":
			return { class: "budget", retryAfterMs: envelope.retryAfterMs, detail: `${envelope.channel}: rate limited` };
		case "walled":
			if (envelope.shape === "plain") {
				return { class: "escalate", retryAfterMs: 0, detail: `${envelope.channel}: plain-block wall — the request was seen and rejected, so escalate to the next transport on this identity before retiring it` };
			}
			return { class: "identity", retryAfterMs: 0, detail: `${envelope.channel}: ${envelope.shape} wall — this identity/route class is refused; quarantine the identity, not the clock` };
		case "dead-session":
			return { class: "identity", retryAfterMs: 0, detail: `${envelope.channel}: session is dead — the credential needs refreshing where it was minted` };
		case "unavailable":
			return { class: "standing", retryAfterMs: 0, detail: `${envelope.channel}: ${envelope.detail}` };
		case "error":
			switch (envelope.code) {
				case "transport":
					return { class: "transient", retryAfterMs: 0, detail: `${envelope.channel}: ${envelope.detail}` };
				case "parse":
					// A shape change is not going to fix itself in the next second.
					return { class: "structural", retryAfterMs: 0, detail: `${envelope.channel}: ${envelope.detail}` };
				case "http":
					return { class: "transient", retryAfterMs: 0, detail: `${envelope.channel}: ${envelope.detail}` };
				case "budget":
					return { class: "budget", retryAfterMs: 0, detail: `${envelope.channel}: ${envelope.detail}` };
				case "capability":
					// A caller bug. Advancing is right; taking the channel out for 10 minutes
					// because a caller asked for something impossible is not.
					return { class: "standing", retryAfterMs: 0, detail: `${envelope.channel}: ${envelope.detail}` };
				case "exhausted":
					return { class: "standing", retryAfterMs: 0, detail: `${envelope.channel}: ${envelope.detail}` };
				case "unavailable":
					return { class: "standing", retryAfterMs: 0, detail: `${envelope.channel}: ${envelope.detail}` };
			}
	}
}

export class RedditRouter {
	private readonly channels: Partial<Readonly<Record<ChannelId, RedditChannel>>>;
	private readonly health: HealthBoard;
	private readonly buckets: BucketStore;
	private readonly store: RedditStore | null;
	private readonly now: () => number;
	private readonly rng: () => number;
	private readonly maxRequests: number;
	private readonly retry: RetryPolicy;
	private readonly sleep: (ms: number) => Promise<void>;

	constructor(options: RouterOptions) {
		this.channels = options.channels;
		this.health = options.health ?? new HealthBoard(DEFAULT_HEALTH_POLICY);
		this.buckets = options.buckets ?? new BucketStore({ dir: "/tmp/reddit-buckets-unconfigured" });
		this.store = options.store ?? null;
		this.now = options.now ?? Date.now;
		this.rng = options.rng ?? Math.random;
		this.maxRequests = options.maxRequests ?? 12;
		this.retry = options.retry ?? DEFAULT_RETRY_POLICY;
		this.sleep = options.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
	}

	// ------------------------------------------------------------------ public API

	async search(query: ScopedQuery, opts: FetchOpts): Promise<RouterRun<HitList>> {
		const capability: Capability = query.subreddits.length === 0 ? "search.global" : "search.scoped";

		// Cache first, per candidate, because the key includes the channel: an answer from
		// Arctic and one from `.json` are different answers and must not replace each other.
		if (this.store !== null) {
			for (const channel of CANDIDATES[capability]) {
				const cached = this.store.readSearchPage(searchPageKey(query, channel));
				if (cached === null) continue;
				const envelope = this.cachedHitList(cached, query, channel);
				if (envelope !== null) return { envelope, attempts: [{ channel, outcome: "ok", detail: "search page served from the store; no request made" }], requests: 0, cached: true, staleByMs: 0, coalesced: false };
			}
		}

		const routed = await this.route(capability, opts, (channel) => channel.search(query, opts), (channel, envelope) => {
			if (this.store !== null && envelope.kind === "ok") this.store.writeSearchPage(searchPageKey(query, channel), JSON.stringify(envelope.value));
		});
		return { ...routed, cached: false, staleByMs: 0, coalesced: false };
	}

	async fetchThread(postId: string, opts: FetchOpts): Promise<RouterRun<RawThread>> {
		if (this.store === null) {
			const single = await this.route("thread.fetch", opts, (channel) => channel.fetchThread(postId, opts));
			return { ...single, cached: false, staleByMs: 0, coalesced: false };
		}
		// The store owns fetch-once: a fresh row answers with no request, a concurrent caller
		// awaits this one, and a failed network attempt serves a stale row rather than a Gap.
		// The run is held in a holder rather than a local so the attempts survive the closure.
		const holder: { run: Omit<RouterRun<RawThread>, "cached" | "staleByMs" | "coalesced"> | null } = { run: null };
		const outcome = await this.store.single(postId, async () => {
			const run = await this.route("thread.fetch", opts, (channel) => channel.fetchThread(postId, opts));
			holder.run = run;
			return run.envelope;
		});
		const run = holder.run;
		return {
			envelope: outcome.envelope,
			attempts:
				run === null
					? [
							{
								channel: outcome.envelope.kind === "ok" ? outcome.envelope.channel : (CANDIDATES["thread.fetch"][0] ?? "arctic"),
								outcome: "ok",
								detail: outcome.coalesced
									? "awaited another caller's in-flight fetch of this thread; this run made no request"
									: outcome.staleByMs > 0
										? `store: stale by ${Math.round(outcome.staleByMs / 60_000)} min`
										: "store: fresh, no request",
							},
						]
					: run.attempts,
			requests: run === null ? 0 : run.requests,
			cached: outcome.cached,
			staleByMs: outcome.staleByMs,
			coalesced: outcome.coalesced,
		};
	}

	// ------------------------------------------------------------------ the loop

	private async route<T>(capability: Capability, opts: FetchOpts, run: (channel: RedditChannel) => Promise<Envelope<T>>, onSuccess?: (channel: ChannelId, envelope: Envelope<T>) => void): Promise<Omit<RouterRun<T>, "cached" | "staleByMs" | "coalesced">> {
		const attempts: AttemptRecord[] = [];
		let requests = 0;

		for (const channelId of CANDIDATES[capability]) {
			const channel = this.channels[channelId];
			const now = this.now();

			if (channel === undefined) {
				attempts.push({ channel: channelId, outcome: "skipped", detail: "not configured" });
				continue;
			}
			if (!channel.capabilities.has(capability)) {
				attempts.push({ channel: channelId, outcome: "skipped", detail: `declares no ${capability}` });
				continue;
			}

			const standing: Availability = channel.availability(now);
			if (!standing.available) {
				attempts.push({ channel: channelId, outcome: "unavailable", detail: standing.detail });
				continue;
			}

			const usable = this.health.usable(channelId, capability, now);
			if (!usable.ok) {
				attempts.push({ channel: channelId, outcome: "skipped", detail: usable.why, ...(usable.until === undefined ? {} : { waitMs: Math.max(0, usable.until - now) }) });
				continue;
			}

			if (requests >= this.maxRequests) {
				return {
					envelope: { kind: "error", code: "budget", channel: channelId, detail: `per-query request budget (${this.maxRequests}) exhausted before ${channelId}; answering with what exists (§5.6)` },
					attempts,
					requests,
				};
			}

			const key = bucketKeyFor(channelId, capability.startsWith("search") ? "search" : undefined);
			const acquired = await this.acquire(key, opts);
			if (!acquired.ok) {
				attempts.push({ channel: channelId, outcome: "budget", detail: acquired.detail, waitMs: acquired.waitMs });
				continue;
			}

			const outcome = await this.attempt(channel, capability, key, opts, run, attempts);
			requests += outcome.requests;
			if (outcome.envelope !== null) {
				onSuccess?.(channelId, outcome.envelope);
				return { envelope: outcome.envelope, attempts, requests };
			}
		}

		return {
			envelope: {
				kind: "error",
				code: "exhausted",
				channel: CANDIDATES[capability][0] ?? "arctic",
				// The detail is the Gap: one line per channel, each naming why. A reader should
				// not have to consult the log to find out that the session was missing.
				detail: `no channel could serve ${capability}: ${attempts.map((attempt) => `${attempt.channel} ${attempt.outcome} (${attempt.detail})`).join("; ")}`,
			},
			attempts,
			requests,
		};
	}

	/** One channel, up to `attempts` tries. Returns the envelope when the channel produced
	 *  an answer (including `empty`), or `null` when the router should advance. */
	private async attempt<T>(channel: RedditChannel, capability: Capability, key: string, opts: FetchOpts, run: (channel: RedditChannel) => Promise<Envelope<T>>, attempts: AttemptRecord[]): Promise<{ readonly envelope: Envelope<T> | null; readonly requests: number }> {
		let requests = 0;
		for (let tries = 1; tries <= this.retry.attempts; tries += 1) {
			const now = this.now();
			let envelope: Envelope<T>;
			try {
				envelope = await run(channel);
			} catch (error) {
				envelope = { kind: "error", code: "transport", channel: channel.id, detail: error instanceof Error ? error.message : String(error) };
			}
			requests += envelopeHasRequest(envelope) ? 1 : 0;

			const verdict = classifyEnvelope(envelope);
			if (verdict === null) {
				// The server's own countdown, applied on **every** response including the 200s: the RSS
				// bucket's `remaining` reads 0.0 on the success that just consumed it, so `reset` is the
				// only authority on when the next token exists (§1.4, §5.3).
				if (envelope.kind === "ok" && envelope.resetsInMs !== undefined) this.buckets.hold(key, now, envelope.resetsInMs);
				attempts.push({ channel: channel.id, outcome: envelope.kind === "empty" ? "empty" : "ok", detail: envelope.kind === "empty" ? "empty answer — an answer, not a failure" : "served" });
				this.health.record({ channel: channel.id, capability, kind: envelope.kind === "empty" ? "empty" : "ok", now: this.now(), identity: identityOf(envelope) });
				return { envelope, requests };
			}

			const kind = outcomeKindOf(verdict.class);
			this.health.record({ channel: channel.id, capability, kind, now, identity: identityOf(envelope), detail: verdict.detail });
			// The wait always lands on the bucket: the next caller for this channel sees it even
			// if this query moves on.
			const waitMs = verdict.class === "budget" ? verdict.retryAfterMs : verdict.class === "transient" ? Math.min(this.retry.transientCapMs, this.retry.transientInitialMs * 2 ** (tries - 1)) : 0;
			if (waitMs > 0) this.buckets.hold(key, now, fullJitter(waitMs, this.rng));

			const retryable = verdict.class === "transient" || verdict.class === "budget";
			const inlineBound = Math.min(this.retry.maxInlineWaitMs, Math.max(0, opts.deadlineAt - now));
			if (retryable && tries < this.retry.attempts && waitMs <= inlineBound) {
				attempts.push({ channel: channel.id, outcome: "throttled", detail: `${verdict.detail} — retrying the same channel once after ${waitMs} ms`, waitMs });
				await this.sleep(waitMs);
				const again = this.buckets.take(key, this.now());
				if (!again.ok) {
					attempts.push({ channel: channel.id, outcome: "budget", detail: `bucket refused the retry (${again.why}); advancing`, waitMs: again.waitMs });
					return { envelope: null, requests };
				}
				continue;
			}

			// A capability error means no request left the machine, so it is recorded as a skip rather
			// than as an attempt: the route declined the question, the network was never asked.
			const attemptOutcome: AttemptRecord["outcome"] = envelope.kind === "unavailable" ? "unavailable" : envelope.kind === "walled" ? "walled" : verdict.class === "standing" ? "skipped" : kind;
			attempts.push({ channel: channel.id, outcome: attemptOutcome, detail: verdict.detail, ...(waitMs === 0 ? {} : { waitMs }) });
			return { envelope: null, requests };
		}
		return { envelope: null, requests };
	}

	/** Take a token, or say why not against the deadline. Never busy-waits: a wait that fits
	 *  inside the deadline and inside `maxInlineWaitMs` is slept, anything longer advances. */
	private async acquire(key: string, opts: FetchOpts): Promise<{ readonly ok: true } | { readonly ok: false; readonly detail: string; readonly waitMs: number }> {
		const now = this.now();
		const first = this.buckets.take(key, now);
		if (first.ok) return { ok: true };

		const until = now + first.waitMs;
		if (until > opts.deadlineAt) {
			return { ok: false, waitMs: first.waitMs, detail: `${key} has no token for ${Math.round(first.waitMs / 1000)} s, past the deadline by ${Math.round((until - opts.deadlineAt) / 1000)} s: advance rather than wait (§5.6)` };
		}
		if (first.waitMs > this.retry.maxInlineWaitMs) {
			return { ok: false, waitMs: first.waitMs, detail: `${key} needs ${Math.round(first.waitMs / 1000)} s (${first.why}) — longer than this query may sleep; the wait is on the bucket, so the next query inherits it` };
		}
		await this.sleep(first.waitMs);
		const second = this.buckets.take(key, this.now());
		if (second.ok) return { ok: true };
		return { ok: false, waitMs: second.waitMs, detail: `${key} still refused after waiting ${first.waitMs} ms` };
	}

	private cachedHitList(raw: string, query: ScopedQuery, channel: ChannelId): Envelope<HitList> | null {
		try {
			const value = JSON.parse(raw) as HitList;
			if (!Array.isArray(value.hits)) return null;
			// The query in the returned list is the current one, not the stored copy: the key
			// matched, so they are the same question, and the caller gets the object it asked for.
			return { kind: "ok", value: { ...value, query }, channel, identity: value.identity, fetchedAtUtc: value.fetchedAtUtc, cost: { requests: 0, bytes: 0, wallMs: 0 }, notes: ["cache-hit"] };
		} catch {
			return null;
		}
	}
}

function outcomeKindOf(failureClass: FailureClass | "standing" | "escalate"): OutcomeKind {
	switch (failureClass) {
		// A challenged request is a strike, not a verdict: one plain block must not take the identity
		// out, but three in a row is a route that does not work from here.
		case "escalate":
			return "transient";
		case "budget":
			return "throttled";
		case "identity":
			return "identity";
		case "transient":
			return "transient";
		case "structural":
			return "structural";
		case "standing":
			return "unavailable";
	}
}

function identityOf(envelope: Envelope<unknown>): string | null {
	return "identity" in envelope ? envelope.identity : null;
}

/** Whether the attempt actually left the machine. A capability error did not. */
function envelopeHasRequest(envelope: Envelope<unknown>): boolean {
	if (envelope.kind === "ok") return envelope.cost.requests > 0;
	return envelope.kind !== "unavailable" && !(envelope.kind === "error" && (envelope.code === "capability" || envelope.code === "unavailable"));
}

