// C2 — `www.reddit.com/r/<sub>/<...>/.rss`. One request returns an entire thread; the
// bucket holds exactly one token and refills in 60 s per egress.
//
// The measured economics that decide its place in the order (spec §1.4, §2.2):
// 15 comments in **one** request cost 31,994 B — 1,764 B/comment stripped, 4.4× Arctic's
// raw cost — and one successful request consumes the whole bucket (`remaining` reads 0.0
// even on the 200). So it is a *request*-scarcity route, not a token-scarcity route: on one
// egress it can serve at most one thread inside the default 90 s deadline, which is why the
// router sorts it last for `thread.fetch` and why the corpus (§6) matters more than this
// adapter does.
//
// Three properties that are asserted here rather than hoped for:
//
// - `old.reddit.com` is not a route — it 302s to `/login/` — so the host is fixed.
// - The path needs the subreddit, and a post id does not name one. Asking for a thread by
//   id alone is a capability error *before* a token is spent, because a spent token here
//   costs 60 s of wall clock on the whole egress.
// - The feed is flat: `parent_id` is not in the payload, so the thread is
//   `treeKnown: false` and the projection must fall back to flat score ordering instead of
//   inventing structure.

import { AVAILABLE, CAPABILITIES } from "./channel.ts";
import type { Availability, RedditChannel } from "./channel.ts";
import type { HttpResponse, Transport } from "./transport.ts";
import { RSS_JITTER_MS, BUCKET_LIMITS, bandJitter } from "./budget.ts";
import type { Capability, Envelope, FetchOpts, HitList, RawThread } from "./types.ts";
import { classify } from "./walls.ts";
import { isRssLoginRedirect, parseRssThread, rssResetSeconds } from "./parse-rss.ts";

export const RSS_BASE = "https://www.reddit.com";
export const RSS_IDENTITY = "rss:anonymous";

export interface RssOptions {
	readonly transport: Transport;
	readonly base?: string;
	readonly now?: () => number;
	/** Injected so the wake-up jitter is deterministic in a test. */
	readonly rng?: () => number;
}

export class RssChannel implements RedditChannel {
	readonly id = "rss" as const;
	readonly capabilities: ReadonlySet<Capability> = CAPABILITIES.rss;
	readonly budget = BUCKET_LIMITS.rss ?? { capacity: 1, refillPerSec: 1 / 60, basis: "unmeasured" };
	private readonly transport: Transport;
	private readonly base: string;
	private readonly now: () => number;
	private readonly rng: () => number;

	constructor(options: RssOptions) {
		this.transport = options.transport;
		this.base = options.base ?? RSS_BASE;
		this.now = options.now ?? Date.now;
		this.rng = options.rng ?? Math.random;
	}

	/** Served anonymously and measured to be UA-independent: rotating the User-Agent does
	 *  not create a second bucket, so N identities means N egresses and nothing else
	 *  (§1.4, §3.2). */
	availability(): Availability {
		return AVAILABLE;
	}

	search(): Promise<Envelope<HitList>> {
		return Promise.resolve({
			kind: "error",
			code: "capability",
			channel: this.id,
			detail: "rss cannot search: the feed routes take a subreddit or a post id and no query parameter. A search routed here would be a silently different question.",
		});
	}

	async fetchThread(postId: string, opts: FetchOpts): Promise<Envelope<RawThread>> {
		const subreddit = (opts.subreddit ?? "").replace(/^\/?r\//i, "").trim();
		if (subreddit === "") {
			// Asserted before the transport so a missing hint never spends the 60 s token.
			return {
				kind: "error",
				code: "capability",
				channel: this.id,
				detail: "rss needs the subreddit in the path (r/<sub>/comments/<id>/.rss?limit=100) and a post id does not name one. Pass FetchOpts.subreddit; spending a token to learn this costs 60 s on the whole egress.",
			};
		}

		const limit = Math.min(opts.limit ?? 100, 100);
		const url = `${this.base}/r/${encodeURIComponent(subreddit)}/comments/${encodeURIComponent(postId)}/.rss?limit=${limit}`;
		const started = this.now();
		let response: HttpResponse;
		try {
			response = await this.transport({ url, timeoutMs: Math.max(1_000, opts.deadlineAt - started) });
		} catch (error) {
			return { kind: "error", code: "transport", channel: this.id, detail: error instanceof Error ? error.message : String(error) };
		}
		const wallMs = this.now() - started;

		if (isRssLoginRedirect(response)) {
			const verdict = classify(response.status, response.bytes, response.headers["location"] ?? null);
			return { kind: "walled", shape: verdict.kind === "refused" ? verdict.shape : "login-redirect", channel: this.id, identity: RSS_IDENTITY };
		}

		if (response.status === 429) {
			const reset = rssResetSeconds(response);
			return { kind: "throttled", retryAfterMs: reset === null ? 60_000 : Math.round((reset + 1) * 1000), channel: this.id, identity: RSS_IDENTITY };
		}

		if (response.status === 403) {
			const verdict = classify(response.status, response.bytes);
			if (verdict.kind === "refused") return { kind: "walled", shape: verdict.shape, channel: this.id, identity: RSS_IDENTITY };
		}

		if (response.status < 200 || response.status >= 300) {
			return { kind: "error", code: "http", channel: this.id, detail: `HTTP ${response.status} on ${url}: ${response.text.trim().slice(0, 200)}` };
		}

		const parsed = parseRssThread(response.text, { postId, limit });
		if (!parsed.ok) return { kind: "error", code: parsed.code, channel: this.id, detail: parsed.detail };

		const fetchedAtUtc = Math.floor(this.now() / 1000);
		const reset = rssResetSeconds(response);
		// The wake-up is `nextEligibleAt + U(2,9)s` (§5.3): an exact 60.000 s period is a
		// signature, and the extra seconds cost nothing because the bucket is empty anyway.
		const resetsInMs = Math.round(((reset ?? 60) + 1) * 1000) + bandJitter(RSS_JITTER_MS, this.rng);

		if (parsed.value.comments.length === 0) return { kind: "empty", channel: this.id, notes: parsed.value.notes };

		const cost = { requests: 1, bytes: response.bytes, wallMs };
		return {
			kind: "ok",
			value: {
				postId: parsed.value.postId ?? postId,
				subreddit: parsed.value.subreddit ?? subreddit,
				title: parsed.value.title ?? "",
				createdUtc: parsed.value.createdUtc,
				channel: this.id,
				identity: RSS_IDENTITY,
				fetchedAtUtc,
				comments: parsed.value.comments,
				truncated: parsed.value.truncated,
				collapsed: parsed.value.collapsed,
				treeKnown: parsed.value.treeKnown,
				cost,
			},
			channel: this.id,
			identity: RSS_IDENTITY,
			fetchedAtUtc,
			cost,
			notes: parsed.value.notes,
			resetsInMs,
		};
	}
}
