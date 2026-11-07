// C1 — Arctic Shift. The fetch channel, and the one that must be perfect: thread fetch
// measured 6/6 at 0.8 s where keyword search measured 3/10 (§1.3c), so this is the route
// the pipeline can actually rely on for bodies.
//
// What it cannot do is search globally, and that is asserted before the request rather
// than learned from it: `posts/search?query=` without `subreddit` or `author` is a hard
// 400 (`'query' query parameter requires one of: author, subreddit`), and `comments/search`
// does not accept `query` at all. A caller bug must cost zero requests.
//
// Two deliberate refusals to be clever:
//
// - `sort` is only sent when it means something. This is an archive scan, not a relevance
//   engine: it filters by subreddit/author and orders by time. Sending `sort=relevance`
//   would be inventing a parameter, and ranking belongs to S7 anyway (§7.7).
// - One subreddit per request. A scope set with three subreddits is three requests, and
//   deciding to spend them is the router's job (§5.6), not this adapter's.

import { AVAILABLE, CAPABILITIES } from "./channel.ts";
import type { Availability, RedditChannel } from "./channel.ts";
import { BUCKET_LIMITS } from "./budget.ts";
import type { HttpResponse, Transport } from "./transport.ts";
import type { Capability, ChannelNote, Envelope, FetchOpts, HitList, RawThread, ScopedQuery, TimeWindow } from "./types.ts";
import { ARCTIC_BASE, ARCTIC_COMMENT_FIELDS, ARCTIC_POST_FIELDS, arcticResetSeconds, mapArcticFailure, parseArcticComments, parseArcticPosts } from "./parse-arctic.ts";

/** Arctic has no account: it is one shared client, so the identity is the route class
 *  rather than a credential (§3.3). */
export const ARCTIC_IDENTITY = "arctic:anonymous";

export interface ArcticOptions {
	readonly transport: Transport;
	readonly base?: string;
	readonly now?: () => number;
}

function windowParams(window: TimeWindow | null, now: number): Record<string, string> {
	if (window === null) return {};
	// Arctic honours `after`/`before` (measured, §1.3), which is exactly the absolute form —
	// no client-side filtering is needed for this shape.
	if (window.kind === "absolute") return { after: String(Math.floor(window.afterUtc / 1000)), before: String(Math.floor(window.beforeUtc / 1000)) };
	const days = window.span === "1w" ? 7 : window.span === "1m" ? 30 : window.span === "3m" ? 90 : 365;
	return { after: String(Math.floor((now - days * 86_400_000) / 1000)) };
}

export class ArcticChannel implements RedditChannel {
	readonly id = "arctic" as const;
	readonly capabilities: ReadonlySet<Capability> = CAPABILITIES.arctic;
	readonly budget = BUCKET_LIMITS.arctic ?? { capacity: 4, refillPerSec: 1, basis: "unmeasured" };
	private readonly transport: Transport;
	private readonly base: string;
	private readonly now: () => number;

	constructor(options: ArcticOptions) {
		this.transport = options.transport;
		this.base = options.base ?? ARCTIC_BASE;
		this.now = options.now ?? Date.now;
	}

	/** No credential, no browser, no optional dependency: if a Transport exists, Arctic is
	 *  reachable. Failures arrive as envelopes and health is the router's record. */
	availability(): Availability {
		return AVAILABLE;
	}

	async search(query: ScopedQuery, opts: FetchOpts): Promise<Envelope<HitList>> {
		const subreddit = query.subreddits[0];
		if (subreddit === undefined) {
			return {
				kind: "error",
				code: "capability",
				channel: this.id,
				detail: "arctic cannot search globally: posts/search answers a bare query= with HTTP 400 \"'query' query parameter requires one of: author, subreddit\" (spec §1.3a). A global phrase has no candidate on this route.",
			};
		}

		const params = new URLSearchParams({ subreddit, query: query.phrase, limit: String(Math.min(query.limit, 100)), fields: ARCTIC_POST_FIELDS, ...windowParams(query.window, this.now()) });
		if (query.sort === "new") params.set("sort", "desc");

		const sent = await this.send(`${this.base}/posts/search?${params.toString()}`, opts.deadlineAt);
		if (!sent.ok) return sent.envelope;

		const { response, wallMs } = sent;
		const failure = mapArcticFailure(response);
		if (failure !== null) return this.failureEnvelope(failure);

		const parsed = parseArcticPosts(response.text, { limit: query.limit });
		if (!parsed.ok) return { kind: "error", code: parsed.code, channel: this.id, detail: parsed.detail };

		if (parsed.value.hits.length === 0) return { kind: "empty", channel: this.id, notes: [] };

		const notes: ChannelNote[] = [];
		// Arctic takes one subreddit per request. Reporting the first as if it were the whole
		// scope would silently narrow the question, so the narrowing is a note.
		if (query.subreddits.length > 1) notes.push("partial");

		const fetchedAtUtc = Math.floor(this.now() / 1000);
		const cost = { requests: 1, bytes: response.bytes, wallMs };
		const reset = arcticResetSeconds(response);
		return {
			kind: "ok",
			value: { channel: this.id, identity: ARCTIC_IDENTITY, query, fetchedAtUtc, hits: parsed.value.hits, exhausted: parsed.value.exhausted, notes, cost },
			channel: this.id,
			identity: ARCTIC_IDENTITY,
			fetchedAtUtc,
			cost,
			notes,
			...(reset === null ? {} : { resetsInMs: Math.round((reset + 1) * 1000) }),
		};
	}

	async fetchThread(postId: string, opts: FetchOpts): Promise<Envelope<RawThread>> {
		const limit = Math.min(opts.limit ?? 100, 100);
		const params = new URLSearchParams({ link_id: postId, limit: String(limit), fields: ARCTIC_COMMENT_FIELDS });

		const sent = await this.send(`${this.base}/comments/search?${params.toString()}`, opts.deadlineAt);
		if (!sent.ok) return sent.envelope;

		const { response, wallMs } = sent;
		const failure = mapArcticFailure(response);
		if (failure !== null) return this.failureEnvelope(failure);

		const fetchedAtUtc = Math.floor(this.now() / 1000);
		const parsed = parseArcticComments(response.text, { postId, fetchedAtUtc, limit });
		if (!parsed.ok) return { kind: "error", code: parsed.code, channel: this.id, detail: parsed.detail };

		if (parsed.value.comments.length === 0) return { kind: "empty", channel: this.id, notes: parsed.value.notes };

		const cost = { requests: 1, bytes: response.bytes, wallMs };
		const reset = arcticResetSeconds(response);
		return {
			kind: "ok",
			value: {
				postId,
				// `comments/search` does not echo the post, so the title and subreddit come from
				// the hit that named this id. Called without them the record keeps them empty
				// rather than inventing a subreddit from a guess.
				subreddit: opts.subreddit ?? "",
				title: parsed.value.title ?? "",
				createdUtc: parsed.value.createdUtc,
				channel: this.id,
				identity: ARCTIC_IDENTITY,
				fetchedAtUtc,
				comments: parsed.value.comments,
				truncated: parsed.value.truncated,
				collapsed: parsed.value.collapsed,
				treeKnown: parsed.value.treeKnown,
				cost,
			},
			channel: this.id,
			identity: ARCTIC_IDENTITY,
			fetchedAtUtc,
			cost,
			notes: parsed.value.notes,
			...(reset === null ? {} : { resetsInMs: Math.round((reset + 1) * 1000) }),
		};
	}

	private async send(url: string, deadlineAt: number): Promise<{ readonly ok: true; readonly response: HttpResponse; readonly wallMs: number } | { readonly ok: false; readonly envelope: Envelope<never> }> {
		const started = this.now();
		try {
			const response = await this.transport({ url, timeoutMs: Math.max(1_000, deadlineAt - started) });
			return { ok: true, response, wallMs: this.now() - started };
		} catch (error) {
			return { ok: false, envelope: { kind: "error", code: "transport", channel: this.id, detail: error instanceof Error ? error.message : String(error) } };
		}
	}

	private failureEnvelope(failure: ReturnType<typeof mapArcticFailure>): Envelope<never> {
		if (failure === null) return { kind: "error", code: "http", channel: this.id, detail: "unreachable" };
		switch (failure.kind) {
			case "throttled":
				return { kind: "throttled", retryAfterMs: failure.retryAfterMs, channel: this.id, identity: ARCTIC_IDENTITY };
			case "walled":
				return { kind: "walled", shape: failure.shape, channel: this.id, identity: ARCTIC_IDENTITY };
			case "transient":
				return { kind: "error", code: "transport", channel: this.id, detail: failure.detail };
			default:
				return { kind: "error", code: failure.code, channel: this.id, detail: failure.detail };
		}
	}
}
