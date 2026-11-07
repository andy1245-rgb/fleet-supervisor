// Recorded response shapes, loaded by the tests. Provenance per file, because a fixture
// whose origin is unstated is a fixture nobody can decide whether to believe:
//
// REAL — recorded from this box on 2026-10-27 with the documented UA (§1.7):
//   arctic-comments-search.json   200, 6,005 B, `comments/search?link_id=1tld3qq`
//                                 `&limit=100&fields=id,body,parent_id,score,created_utc,author`
//                                 — 15 rows, which is the whole 13-comment thread (the archive's
//                                 count is the count at post time; §1.3d).
//   arctic-posts-search.json     200, 778 B, `posts/search?subreddit=MechanicalKeyboards&query=krysh`
//                                 `&limit=3&fields=id,title,score,num_comments,created_utc,`
//                                 `subreddit,author,url`. Recording it is how the `permalink` field
//                                 was found to be invalid (the 400 fixture below).
//   rss-thread.xml               200, 31,999 B recorded, `r/MechanicalKeyboards/comments/1tld3qq`
//                                 `/.rss?limit=100` — 15 entries, `x-ratelimit-used: 1`,
//                                 `x-ratelimit-remaining: 0.0`, `x-ratelimit-reset: 30`.
//                                 Trimmed for size only: the post entry's body is shortened and four
//                                 comment entries are kept verbatim. The shape is untouched, and the
//                                 trimming is marked inside the body itself.
//
// CONSTRUCTED, from a measured body:
//   arctic-422-timeout.json       the throttle body quoted in §1.3c. Not re-recorded because the
//                                 failure mode requires driving the search queue to closure.
//   arctic-400-query-scope.json   the 400 body quoted in §1.3a.
//   arctic-400-invalid-field.json the 400 body measured today when `permalink` was requested.
//   reddit-json-thread.json       the `[post, comments]` Listing pair. Structurally faithful —
//                                 including a nested reply, an AutoModerator comment, a
//                                 `removed_by_category` comment, a `null` score and a `kind:"more"`
//                                 child — but **not recorded**, because this egress is walled out of
//                                 the `.json` route (§1.2) and re-testing that wall would spend a
//                                 request to learn what is already measured.

import { readFileSync } from "node:fs";

export const FIXTURES = {
	arcticComments: "arctic-comments-search.json",
	arcticPosts: "arctic-posts-search.json",
	arcticTimeout422: "arctic-422-timeout.json",
	arcticQueryScope400: "arctic-400-query-scope.json",
	arcticInvalidField400: "arctic-400-invalid-field.json",
	rssThread: "rss-thread.xml",
	jsonThread: "reddit-json-thread.json",
} as const;

export type FixtureName = (typeof FIXTURES)[keyof typeof FIXTURES];

const cache = new Map<FixtureName, string>();

/** Lazy, cached per process: a fixture is read once and every test gets the same string. */
export function fixture(name: FixtureName): string {
	const hit = cache.get(name);
	if (hit !== undefined) return hit;
	const text = readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");
	cache.set(name, text);
	return text;
}
