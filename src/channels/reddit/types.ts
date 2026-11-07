// The vocabulary the four routes, the router, the store and the projection all share.
//
// Two naming decisions worth stating once, because they are the places this layer
// meets something that already exists:
//
// - `ChannelId` is `arctic | rss | json | browser`. The specification calls the last
//   two C3 and C4 and the session channel "C3"; the id here is `json` because that is
//   what the route fetches, and `session` would name the credential rather than the
//   transport.
// - Nothing here returns a thrown error for an HTTP outcome. `throttled`, `walled`,
//   `empty` and `dead-session` are decision inputs for the router, not transport
//   failures — an adapter that threw would make the router's failure→next-channel
//   rule impossible to write.

import type { WallShape } from "./walls.ts";

export type ChannelId = "arctic" | "rss" | "json" | "browser";

/** What a route can actually do. Not a ranking — the four routes differ on three
 *  independent axes (requests/time, tokens/comment, credential dependency), which is the
 *  whole reason the router is not a fallback list (spec §0 item 7, §2.1).
 *
 *  The spec's matrix also names `discover.subreddit`, `batch.info` and a separate `more`
 *  expansion. They are **not** in this union: this layer's contract is `search` +
 *  `fetchThread`, and a capability no method serves is a capability the router could select
 *  and then fail to call. The three that remain are all served through those two methods —
 *  `thread.tree` and `removal.state` are contracts on the *quality* of a fetch
 *  (`treeKnown`, `collapsed`, `removalChecked`), which is precisely what a caller chooses
 *  between routes on. */
export type Capability =
	/** `/search.json?q=` with no subreddit. `json`/`browser` only: Arctic answers a bare
	 *  `query=` with HTTP 400 (§1.3a). */
	| "search.global"
	| "search.scoped"
	| "thread.fetch"
	/** A fetch with real nesting: `treeKnown: true` and `collapsed` a real count. */
	| "thread.tree"
	/** A fetch whose comments carry archive removal state: `arctic` only (§2.1). */
	| "removal.state";

/** Facts about how a value was obtained that change how it may be used. */
export type ChannelNote =
	/** Served from the store; no request was made. */
	| "cache-hit"
	/** Served from the store past its class TTL. Usable, and says so (§6.3). */
	| "stale"
	/** Fewer comments than the thread has. */
	| "truncated"
	/** `kind:"more"` children left unexpanded; only `json`/`browser` can expand them. */
	| "collapsed"
	/** The channel refused a `fields` selector and the full payload was paid for. */
	| "fields-rejected"
	/** Part of the answer came from a different channel than the envelope names. */
	| "partial"
	/** The feed is flat (`rss`): `parentId` is unknown, so `depth` is 0 everywhere. */
	| "tree-unknown"
	/** Live comments that no channel has checked for later removal (§7.5). */
	| "unverified-removals";

export interface Cost {
	readonly requests: number;
	readonly bytes: number;
	readonly wallMs: number;
}

export const NO_COST: Cost = { requests: 0, bytes: 0, wallMs: 0 };

/** Only `arctic` reports `_meta.removal_type`. A comment from any other channel is
 *  `live` with `removalChecked: false` — absence of evidence, recorded as such, so a
 *  record can never claim a thread had no removals when no channel looked (§7.5). */
export type RemovalState =
	| { readonly kind: "live"; readonly removalChecked: boolean }
	| { readonly kind: "deleted-by-author" }
	| { readonly kind: "removed-by-moderator"; readonly detectedAtUtc: number }
	| { readonly kind: "unknown" };

export interface RawComment {
	readonly commentId: string;
	readonly parentId: string | null;
	readonly author: string | null;
	/** Markdown, verbatim. `""` for a body that is only `[deleted]`. */
	readonly body: string;
	/** `null` when the channel cannot say. Never guessed: a fabricated score poisons
	 *  the projection's ranking, and `rss` usually has none (§4.2). */
	readonly score: number | null;
	readonly createdUtc: number;
	readonly distinguished: string | null;
	readonly removal: RemovalState;
	/** 0 for every comment when `treeKnown` is false. */
	readonly depth: number;
}

export interface RawThread {
	readonly postId: string;
	readonly subreddit: string;
	readonly title: string;
	readonly createdUtc: number;
	readonly channel: ChannelId;
	readonly identity: string;
	readonly fetchedAtUtc: number;
	readonly comments: readonly RawComment[];
	readonly truncated: boolean;
	readonly collapsed: number;
	readonly treeKnown: boolean;
	readonly cost: Cost;
}

/** What every channel's thread parser produces before the channel wraps it in a
 *  `RawThread`. The three routes disagree about almost everything else, but a caller that
 *  has to handle three shapes for the same fact is a caller that will get one wrong. */
export interface ThreadParse {
	/** From the payload when it says so; the feed and the listing both can disagree with
	 *  the id that was asked for, and the payload is the one that answered. */
	readonly postId: string | null;
	readonly subreddit: string | null;
	readonly title: string | null;
	readonly createdUtc: number;
	readonly comments: readonly RawComment[];
	readonly truncated: boolean;
	/** `kind:"more"` children left unexpanded. Only `json`/`browser` can expand them. */
	readonly collapsed: number;
	readonly treeKnown: boolean;
	readonly notes: readonly ChannelNote[];
}

export interface ScopedQuery {
	readonly phrase: string;
	/** Empty means global, which only `json`/`browser` can serve: Arctic's `posts/search`
	 *  answers a bare `query=` with HTTP 400 `'query' query parameter requires one of:
	 *  author, subreddit` (spec §1.3a). */
	readonly subreddits: readonly string[];
	readonly sort: "relevance" | "new" | "top" | "comments";
	readonly window: TimeWindow | null;
	readonly limit: number;
	/** `json` only: `/search.json` cursor. */
	readonly after: string | null;
}

export type TimeWindow = { readonly kind: "relative"; readonly span: "1w" | "1m" | "3m" | "1y" } | { readonly kind: "absolute"; readonly afterUtc: number; readonly beforeUtc: number };

export interface Hit {
	/** The only handle a needle may name (`r01`). */
	readonly hitId: string;
	/** `t3_` stripped. */
	readonly postId: string;
	readonly subreddit: string;
	readonly title: string;
	readonly score: number;
	readonly numComments: number;
	readonly createdUtc: number;
	readonly author: string | null;
	readonly over18: boolean;
	readonly permalink: string;
	readonly removed: boolean;
	/** `rss` cannot produce a list at all; `json` sometimes omits the score. */
	readonly scoreConfidence: "exact" | "absent";
}

export interface HitList {
	readonly channel: ChannelId;
	readonly identity: string;
	readonly query: ScopedQuery;
	readonly fetchedAtUtc: number;
	readonly hits: readonly Hit[];
	readonly exhausted: boolean;
	readonly notes: readonly ChannelNote[];
	readonly cost: Cost;
}

export interface FetchOpts {
	/** ms epoch. A channel whose `nextEligibleAt` exceeds this is skipped, not waited for (§5.6). */
	readonly deadlineAt: number;
	/** Known by the caller whenever the request came from a hit. `rss` needs it in the
	 *  path and cannot derive it from a post id, so its absence is a capability error
	 *  there rather than a wasted token. */
	readonly subreddit?: string | null;
	readonly limit?: number;
}

export type ErrorCode =
	/** The caller asked for something this route cannot do. A bug in the caller. */
	| "capability"
	/** The request never left: no transport, no credential, no bridge. Standing
	 *  condition, not a per-request failure. */
	| "unavailable"
	/** Network-level failure: connection, timeout, DNS. */
	| "transport"
	/** A 200 whose body is not the shape it claims to be. */
	| "parse"
	/** Any status not covered by walls.ts. */
	| "http"
	/** The per-query request budget (§5.6: ≤12) was exhausted. */
	| "budget"
	/** Every candidate channel declined. `detail` lists why, one per channel, so a
	 *  `Gap` can be written straight from it. */
	| "exhausted";

export type Envelope<T> =
	| { readonly kind: "ok"; readonly value: T; readonly channel: ChannelId; readonly identity: string; readonly fetchedAtUtc: number; readonly cost: Cost; readonly notes: readonly ChannelNote[];
			/** The server's own countdown to its next token, when it sent one. The `.rss`
			 *  bucket needs this from *every* response including the 200s: `remaining` reads 0.0
			 *  on success and `reset` is the only authority on when a token returns (§1.4). */
			readonly resetsInMs?: number }
	| { readonly kind: "empty"; readonly channel: ChannelId; readonly notes: readonly ChannelNote[] }
	| { readonly kind: "throttled"; readonly retryAfterMs: number; readonly channel: ChannelId; readonly identity: string }
	| { readonly kind: "walled"; readonly shape: WallShape; readonly channel: ChannelId; readonly identity: string }
	| { readonly kind: "dead-session"; readonly channel: ChannelId; readonly identity: string }
	/** Distinct from `error` on purpose: the router logs an `unavailable` route once and
	 *  drops it from the candidate list, where an `error` is one attempt's outcome. That
	 *  is what makes "curl_cffi is not installed" a quiet degradation instead of a
	 *  failure that consumes the query's retry budget. */
	| { readonly kind: "unavailable"; readonly channel: ChannelId; readonly detail: string }
	| { readonly kind: "error"; readonly code: ErrorCode; readonly detail: string; readonly channel: ChannelId };

/** A permalink is constructed rather than fetched: Arctic rejects `permalink` in
 *  `fields` (`'permalink' is not a valid field`, measured), and every channel except
 *  `json` has to build it. The slug is omitted because a slug that disagrees with the
 *  title is worse than no slug at all. */
export function permalinkFor(subreddit: string, postId: string): string {
	return `https://www.reddit.com/r/${subreddit}/comments/${postId}/`;
}
