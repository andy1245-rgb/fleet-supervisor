// One shape every route implements, plus the capability matrix that says which of the
// four can be a candidate for a given request.
//
// `capabilities` and `budget` are declared rather than discovered: the router has to
// know that `rss` cannot search before it builds a candidate list, and a route that
// answered "can I?" by trying would spend the token it is trying to conserve.

import type { Capability, ChannelId, Envelope, FetchOpts, HitList, RawThread, ScopedQuery } from "./types.ts";
import type { Limit } from "./budget.ts";

/** A standing reason a route cannot run at all right now — a missing transport, a
 *  missing credential, a missing bridge. Distinct from an attempt's outcome, and it is
 *  what makes a missing optional dependency a diagnostic instead of a retry loop. */
export interface Availability {
	readonly available: boolean;
	/** Always populated when `available` is false, and phrased so it can be printed
	 *  into a `Gap.detail` unchanged. */
	readonly detail: string;
}

export const AVAILABLE: Availability = { available: true, detail: "ready" };

export interface RedditChannel {
	readonly id: ChannelId;
	readonly capabilities: ReadonlySet<Capability>;
	/** What this route may spend. Declared on the route so a route cannot exist without a
	 *  measured limit to go with it; the numbers and their sources live in budget.ts. */
	readonly budget: Limit;
	/** Checked before a token is taken. Cheap by construction — it reads state the
	 *  channel already holds, it does not probe the network. Probing is §2.4's job and
	 *  is scheduled, not per request. */
	availability(now?: number): Availability;
	search(query: ScopedQuery, opts: FetchOpts): Promise<Envelope<HitList>>;
	fetchThread(postId: string, opts: FetchOpts): Promise<Envelope<RawThread>>;
}

const CAPS: Readonly<Record<ChannelId, readonly Capability[]>> = {
	// Arctic Shift is the fetch channel and the only route with archive removal metadata. It
	// has no global search: `posts/search?query=` without `subreddit`/`author` is a hard 400
	// (spec §1.3a), and its scoped search succeeded 3/10 where thread fetch succeeded 6/6
	// (§1.3c). `comments/search` is a flat list, so the tree is rebuilt from `parent_id` and
	// `thread.tree` is claimed only because the depth is real once rebuilt.
	arctic: ["search.scoped", "thread.fetch", "thread.tree", "removal.state"],
	// One request returns a whole thread at 4.4× the tokens per comment (§1.4). It cannot
	// search, and the feed is flat — `parent_id` is not in the payload — so it does not claim
	// `thread.tree`.
	rss: ["thread.fetch"],
	// The only global search, real nesting, and `kind:"more"` counts (§2.1).
	json: ["search.global", "search.scoped", "thread.fetch", "thread.tree"],
	// Renders what only a browser renders, and holds the session that mints a cookie (§4.4).
	browser: ["search.global", "search.scoped", "thread.fetch", "thread.tree"],
};

export function capabilitiesOf(channel: ChannelId): ReadonlySet<Capability> {
	return new Set(CAPS[channel]);
}

/** The capability matrix as a set per channel, for implementations to declare. */
export const CAPABILITIES: Readonly<Record<ChannelId, ReadonlySet<Capability>>> = {
	arctic: capabilitiesOf("arctic"),
	rss: capabilitiesOf("rss"),
	json: capabilitiesOf("json"),
	browser: capabilitiesOf("browser"),
};

/** The `fetch` worker's `mode` argument is `curl|js|cache` (`profiles/fetch.py` MODES),
 *  and a `retry.mode` the worker emits has to be one of those three. So the mapping
 *  lives here, once, rather than being re-derived by whoever renders a state block:
 *  `js` is reserved for the route that actually runs a browser, and `cache` is not a
 *  channel at all — it is the store answering without a request. */
export function toWorkerMode(channel: ChannelId | "cache"): "curl" | "js" | "cache" {
	return channel === "browser" ? "js" : channel === "cache" ? "cache" : "curl";
}
