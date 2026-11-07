// The shape the two needle workers consume, and the only place their field budgets live.
//
// These caps are read out of the worker profiles, not chosen here:
// `profiles/fetch.py` — `field_chars = {source: 40, want: 200, text: 600}`, `total_chars` 1000;
// `profiles/search.py` — `field_chars = {want: 200, hit: 120}`. They are duplicated as
// constants rather than parsed out of Python because a projection has to be *built* to fit
// them: emitting 840 characters into a 600-character field is not a formatting bug, it is a
// projection whose counts line and strongest segment are cut off by `clip()`, which keeps the
// **end** of an over-long field. So the cap is an input to the algorithm, and the algorithm
// lives one file over (`projection.ts`), which is why the number is here and the slots are
// there.
//
// `tried` speaks the worker's own vocabulary on purpose: `profiles/fetch.py` `MODES` is
// `curl|js|cache`, a `retry` verdict comes back as one of those three, and the scaffold rejects
// a retry of a mode already in `tried`. A channel id in that list would never match anything.

import { toWorkerMode } from "./channel.ts";
import type { ChannelId } from "./types.ts";

/** `profiles/fetch.py` `CAPS.field_chars`. */
export const FETCH_FIELD_CHARS = { source: 40, want: 200, text: 600 } as const;

/** `profiles/fetch.py` `CAPS.field_chars["text"]`: the window a projection is built for. */
export const WORKER_TEXT_CAP = FETCH_FIELD_CHARS.text;

/** `profiles/search.py` `CAPS.field_chars`. */
export const SEARCH_FIELD_CHARS = { want: 200, hit: 120 } as const;

/** What `profiles/fetch.py` `render()` reads. Keys are exactly its `state` keys, so the
 *  worker needs no adapter between this record and its own `render`. */
export interface FetchState {
	readonly source: string;
	readonly url: string;
	readonly want: string;
	readonly tried: readonly string[];
	readonly text: string;
}

export function renderFetchState(args: { readonly text: string; readonly source: string; readonly url: string; readonly want: string; readonly tried: readonly ChannelId[] }): FetchState {
	return {
		source: args.source.slice(0, FETCH_FIELD_CHARS.source),
		url: args.url.slice(0, FETCH_FIELD_CHARS.source),
		want: args.want.slice(0, FETCH_FIELD_CHARS.want),
		tried: args.tried.map((channel) => toWorkerMode(channel)),
		text: args.text.slice(0, FETCH_FIELD_CHARS.text),
	};
}

/** What `profiles/search.py` `render()` reads: `item`, `want`, `searches`, and `hits` as
 *  `{id, detail}`. The detail line is `r01 MechanicalKeyboards 412c 88up Is expensive lube
 *  worth it?` (§7.13) — every number in it is copied from a hit record, so the needle is never
 *  asked to compute one. */
export interface SearchState {
	readonly item: string;
	readonly want: string;
	readonly searches: number;
	readonly hits: readonly { readonly id: string; readonly detail: string }[];
}

export function renderSearchState(args: {
	readonly item: string;
	readonly want: string;
	readonly searches: number;
	readonly hits: readonly { readonly hitId: string; readonly subreddit: string; readonly numComments: number; readonly score: number; readonly title: string }[];
}): SearchState {
	return {
		item: args.item,
		want: args.want.slice(0, SEARCH_FIELD_CHARS.want),
		searches: args.searches,
		hits: args.hits.map((hit) => ({ id: hit.hitId, detail: `${hit.subreddit} ${hit.numComments}c ${hit.score}up ${hit.title}`.slice(0, SEARCH_FIELD_CHARS.hit) })),
	};
}
