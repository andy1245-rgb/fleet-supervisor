// S8's projection. Every assertion here is about one of the four things the stage can get
// wrong in a way that reads as success:
//
//   * the record exceeds the window it is read in (a 13-comment thread is 7,416 tokens =
//     7.2× the 1024-token window, so the bound is the point);
//   * the counts line is not first, so the numbers the needle reads are the numbers of
//     whatever happened to survive;
//   * dissent is silently dropped, or manufactured;
//   * the same thread projects to two different strings, so a bad projection cannot be
//     diffed and the content-addressed cache misses on every refetch.

import assert from "node:assert/strict";
import { test } from "node:test";
import { FIXTURES, fixture } from "../src/channels/reddit/fixtures.ts";
import { parseArcticComments } from "../src/channels/reddit/parse-arctic.ts";
import { parseRssThread } from "../src/channels/reddit/parse-rss.ts";
import { ALGORITHM_VERSION, isBot, project, rankComments, stanceOf, truncateAtSentence } from "../src/channels/reddit/projection.ts";
import { WORKER_TEXT_CAP, renderFetchState, renderSearchState } from "../src/channels/reddit/worker-state.ts";
import type { RawComment, RawThread } from "../src/channels/reddit/types.ts";

const NOW_SEC = 1_790_000_000;

function comment(id: string, body: string, overrides: Partial<RawComment> = {}): RawComment {
	return { commentId: id, parentId: null, author: `user_${id}`, body, score: 10, createdUtc: NOW_SEC - 3_600, distinguished: null, removal: { kind: "live", removalChecked: false }, depth: 0, ...overrides };
}

function thread(comments: readonly RawComment[], overrides: Partial<RawThread> = {}): RawThread {
	return { postId: "1tld3qq", subreddit: "MechanicalKeyboards", title: "Is expensive lube worth it?", createdUtc: NOW_SEC - 86_400, channel: "arctic", identity: "arctic:anonymous", fetchedAtUtc: NOW_SEC, comments, truncated: false, collapsed: 0, treeKnown: true, cost: { requests: 1, bytes: 6_005, wallMs: 800 }, ...overrides };
}

/** A thread with a real disagreement: three comments for, one against. Bodies are long
 *  enough to survive the 120-char slot floor, which is the constraint the slots exist for. */
function disputed(): readonly RawComment[] {
	return [
		comment("a1", "Krytox 205g0 is genuinely better for tactiles: it is thicker, it does not migrate, and after two years on the same board I have no regrets at all about paying for it.", { score: 388 }),
		comment("a2", "I recommend it without reservation. The difference against a cheap lube is obvious in the first week, and the tin lasts a year at two boards a month so the cost per board is trivial.", { score: 210 }),
		comment("a3", "Not worth it. Superlube is 90% as good for a third of the price, I cannot tell the difference blind, and calling it snake oil is unfair but it is close. I regret buying two tins.", { score: 44 }),
		comment("a4", "Switched to it from a generic silicone grease last month and the switches hold up much nicer; the tactility is crisper and nothing has migrated into the leaf yet.", { score: 90 }),
	];
}

// ------------------------------------------------------------------ the bound

test("a real recorded thread projects inside the worker's field cap", () => {
	const parsed = parseArcticComments(fixture(FIXTURES.arcticComments), { postId: "1tld3qq", fetchedAtUtc: NOW_SEC, limit: 100 });
	if (!parsed.ok) return assert.fail("fixture should parse");
	const projection = project(thread(parsed.value.comments), { want: "is the lofree flow 2 worth it for low profile switches" });

	assert.ok(projection.text.length <= WORKER_TEXT_CAP, `${projection.text.length} > ${WORKER_TEXT_CAP}`);
	// 7,416 tokens is 7.2× the window; the projection is ~150 tokens, which is the entire
	// reason this stage is deterministic scaffold and not a model call.
	assert.ok(projection.approxTokens <= 200, `${projection.approxTokens} tokens`);
	assert.ok(projection.segments.length >= 2);
	assert.equal(projection.renderMode, "quote");
	assert.equal(projection.algorithmVersion, ALGORITHM_VERSION);
});

test("the counts line is first, and its numbers are the thread's, not the survivors'", () => {
	const parsed = parseArcticComments(fixture(FIXTURES.arcticComments), { postId: "1tld3qq", fetchedAtUtc: NOW_SEC, limit: 100 });
	if (!parsed.ok) return assert.fail("fixture should parse");
	const projection = project(thread(parsed.value.comments));

	assert.ok(projection.text.startsWith(projection.countsLine));
	// 15 fetched, and none of them removed, so the live count is 15 even though the ranking
	// filters drop short comments. The difference is `dropped`, which is recorded.
	assert.equal(projection.counts.fetched, 15);
	assert.equal(projection.counts.live, 15);
	assert.match(projection.countsLine, /^15c \d+a \?rm 2top$/);
	assert.equal(projection.counts.topScore, 2);
	// `?rm` rather than `0rm`: no channel checked for archive removals, and the record must not
	// claim the thread had none (§7.5).
	assert.equal(projection.counts.unverifiedRemovals, 15);
});

test("a budget of 840 fills more slots than 600 and stays inside each", () => {
	const body = disputed();
	const narrow = project(thread(body), { want: "is krytox worth it", textBudget: 600 });
	const wide = project(thread(body), { want: "is krytox worth it", textBudget: 840 });
	assert.ok(narrow.text.length <= 600);
	assert.ok(wide.text.length <= 840);
	assert.ok(wide.text.length > narrow.text.length, "a larger window should not produce a shorter record");
	assert.ok(wide.segments.length >= narrow.segments.length);
});

test("projection is deterministic: the same thread and want produce the same bytes", () => {
	const body = disputed();
	const once = project(thread(body), { want: "is krytox worth it" });
	const twice = project(thread(body), { want: "is krytox worth it" });
	assert.equal(once.text, twice.text);
	assert.deepEqual(once.included, twice.included);
	// The `want` is part of the ranking, not decoration: a question about price lifts the comment
	// about price and costs the comment that answered a different question.
	const feel = rankComments(thread(body), "krytox tactility feel thicker");
	const price = rankComments(thread(body), "superlube price third cheaper");
	const indexIn = (ranked: typeof feel, id: string): number => ranked.kept.findIndex((scored) => scored.comment.commentId === id);
	const scoreIn = (ranked: typeof feel, id: string): number => ranked.kept.find((scored) => scored.comment.commentId === id)?.rank ?? 0;
	assert.ok(indexIn(price, "a3") < indexIn(feel, "a3"), "a question about price should lift the price comment above the feel comment");
	assert.ok(scoreIn(price, "a1") < scoreIn(feel, "a1"), "and the same comment should score lower against a question it does not answer");
});

// ------------------------------------------------------------------ dissent

test("a dissenting comment survives even when it is outvoted three to one", () => {
	const projection = project(thread(disputed()), { want: "is krytox worth it" });
	assert.equal(projection.dissentInWindow, true);
	const con = projection.segments.find((segment) => segment.stance === "con");
	assert.ok(con !== undefined, "the con stance should hold a slot");
	assert.match(con.text, /Not worth it/);
});

test("with no dissent the con slot is still filled, and dissentInWindow says false", () => {
	const unanimous = [
		comment("b1", "Krytox is genuinely better for tactiles and it does not migrate; I recommend it and I have no regrets after two years of use on the same board.", { score: 300 }),
		comment("b2", "Switched to it last year and the difference is obvious; the switches hold up much nicer and the tactility is crisper than with the cheaper grease.", { score: 120 }),
		comment("b3", "It is worth it. Two boards a month and a tin lasts a year, so the price per board is trivial compared with the value you get from the feel.", { score: 80 }),
	];
	const projection = project(thread(unanimous), { want: "is krytox worth it" });
	// §8.2 rule 2: an empty con slot means "the window could not show dissent", a different
	// fact from "the thread agreed" — and manufacturing dissent is the worse error.
	assert.equal(projection.dissentInWindow, false);
	assert.ok(projection.segments.some((segment) => segment.slot === "con"));
});

test("stance assignment is lexical, auditable, and flips on a nearby negation", () => {
	assert.equal(stanceOf("This is worth it and I recommend it."), "pro");
	assert.equal(stanceOf("Not worth it at all, overpriced for what it is."), "con");
	// A negation within 40 characters of a positive cue is the same clause, not two opinions.
	assert.equal(stanceOf("it is not worth the money honestly"), "con");
	assert.equal(stanceOf("the ping sound is a nuisance"), "neutral");
});

// ------------------------------------------------------------------ filters and slots

test("bots, one-liners and an author's second comment never take a slot", () => {
	const body = [
		comment("bot1", "If you are posting a Review, make sure you fully disclose any potential conflicts of interest. This boilerplate runs to a couple of hundred characters.", { author: "AutoModerator" }),
		comment("bot2", "Beep boop, this is a reminder about the rules of the subreddit and they are long enough to pass a character filter but it is still a bot.", { author: "reminder_bot" }),
		comment("tiny", "I agree.", { author: "quiet_one" }),
		comment("x1", "Krytox is genuinely better for tactiles and I recommend paying for it; it is thicker and does not migrate, and after two years nothing has gone wrong.", { author: "same_person", score: 200 }),
		comment("x2", "Not worth it in my experience: the cheaper lube is 90% as good, I cannot tell them apart blind, and the price difference is not justified by the feel.", { author: "same_person", score: 40 }),
		comment("x3", "The stabilizer ping on the spacebar is the real problem and no amount of expensive lubricant fixes a badly tuned wire, which took me a whole evening to sort out.", { author: "third_voice", score: 90 }),
	];
	const { kept } = rankComments(thread(body), "is krytox worth it");
	const keptIds = kept.map((scored) => scored.comment.commentId);
	assert.ok(!keptIds.includes("bot1"), "AutoModerator is 22% of a sampled subreddit; it is never evidence");
	assert.ok(!keptIds.includes("bot2"));
	assert.ok(!keptIds.includes("tiny"), "a 9-character body is not a statement");

	const projection = project(thread(body), { want: "is krytox worth it" });
	const authors = projection.segments.map((segment) => segment.author);
	// One comment per author in the slots: four slots going to one person is one opinion
	// rendered four times, and `distinctAuthors` is the denominator of every support verdict.
	assert.equal(new Set(authors).size, authors.length);
	assert.equal(authors.filter((author) => author === "same_person").length, 1);
});

test("a joke chain is dropped as a thread rather than projected over its survivors", () => {
	// Copypasta is *exactly* repeated, which is what a 5-gram Jaccard > 0.8 detects; a variant that
	// changes one word in thirty keeps ~0.68 and is correctly not treated as a duplicate.
	const joke = "this is the way and I will keep saying this is the way until it stops being funny";
	const jokes = [
		comment("j1", joke, { author: "j1" }),
		comment("j2", joke, { author: "j2" }),
		comment("j3", joke, { author: "j3" }),
		comment("j4", joke, { author: "j4" }),
		comment("j5", joke, { author: "j5" }),
		comment("real", "Krytox is genuinely better for tactiles and I recommend it, because it is thicker and does not migrate over two years of use.", { author: "real" }),
	];
	const projection = project(thread(jokes), { want: "is krytox worth it" });
	// Five of six top-level comments are the same joke: the survivors are not a sample of the
	// thread, so the thread is dropped with `code="jokes"` rather than projected (§10 case 12).
	assert.equal(projection.drop, "jokes");
});

test("a thread with nothing left is dropped as empty rather than projected as silence", () => {
	const projection = project(thread([comment("only", "I agree.", { author: "quiet" })]), { want: "anything" });
	assert.equal(projection.drop, "empty");
	// The counts line still appears, so the record can say the thread was read and yielded
	// nothing rather than look like a fetch that never happened.
	assert.equal(projection.text, projection.countsLine);
});

test("scores are tagged, and an absent score is `?` rather than a guess", () => {
	const parsed = parseRssThread(fixture(FIXTURES.rssThread), { postId: "1tld3qq", limit: 100 });
	if (!parsed.ok) return assert.fail("rss fixture should parse");
	const projection = project(thread(parsed.value.comments, { channel: "rss", treeKnown: false }), { want: "lofree flow review" });
	// The recorded feed carries no score span, and inventing a zero would bury every comment
	// from a channel that cannot report scores (§8.3).
	assert.ok(projection.text.includes("[?up]"), projection.text.slice(0, 200));
	assert.ok(!projection.text.includes("[0up]"));
	assert.equal(projection.counts.topScore, null);
	assert.match(projection.countsLine, /^\dc \da \?rm \?top$/);
});

// ------------------------------------------------------------------ truncation

test("truncation cuts at a sentence, then at a word, and never mid-word", () => {
	const text = "First sentence is here. Second sentence runs on for a while so that the window has to cut it somewhere sensible and it should not break a word in half.";
	const sentence = truncateAtSentence(text, 40);
	assert.equal(sentence.truncated, true);
	assert.ok(sentence.text.endsWith("."));
	assert.ok(sentence.text.length <= 40);

	// No sentence break in the second half: fall back to a word boundary and say so with an
	// ellipsis, never a partial word.
	const wordy = truncateAtSentence("alpha beta gamma delta epsilon zeta eta theta iota kappa lambda", 30);
	assert.equal(wordy.truncated, true);
	assert.ok(wordy.text.endsWith("…"));
	assert.ok(!wordy.text.includes("  "));

	const short = truncateAtSentence("short enough", 80);
	assert.deepEqual(short, { text: "short enough", truncated: false });
});

// ------------------------------------------------------------------ the worker's shape

test("the fetch state is exactly the keys profiles/fetch.py reads", () => {
	const projection = project(thread(disputed()), { want: "is krytox worth it" });
	const state = renderFetchState({ text: projection.text, source: "s3", url: "https://www.reddit.com/r/MechanicalKeyboards/comments/1tld3qq/x/", want: "is krytox worth it", tried: ["arctic", "browser"] });
	assert.deepEqual(Object.keys(state).sort(), ["source", "text", "tried", "url", "want"]);
	// `tried` is the worker's own `mode` vocabulary, because a `retry` verdict comes back as one
	// of curl|js|cache and the scaffold rejects a retry of something already tried.
	assert.deepEqual(state.tried, ["curl", "js"]);
	assert.ok(state.text.length <= WORKER_TEXT_CAP);
	assert.equal(state.text, projection.text);
});

test("the search state is exactly the keys profiles/search.py reads, with §7.13's hit line", () => {
	const state = renderSearchState({
		item: "w4",
		want: "is Krytox 205g0 worth it over cheaper lube for tactile switches",
		searches: 1,
		hits: [{ hitId: "r01", subreddit: "MechanicalKeyboards", numComments: 412, score: 88, title: "Is expensive lube worth it?" }],
	});
	assert.deepEqual(Object.keys(state).sort(), ["hits", "item", "searches", "want"]);
	assert.deepEqual(state.hits, [{ id: "r01", detail: "MechanicalKeyboards 412c 88up Is expensive lube worth it?" }]);

	// The hit detail is capped at the worker's field size, and a long title is cut rather than
	// pushed past it.
	const long = renderSearchState({ item: "w4", want: "x", searches: 1, hits: [{ hitId: "r02", subreddit: "AskReddit", numComments: 3_000, score: 90_000, title: "t".repeat(400) }] });
	assert.ok((long.hits[0]?.detail.length ?? 0) <= 120);
});

test("isBot is the filter §7.7 names, not a personality test", () => {
	assert.equal(isBot(comment("a", "x", { author: "AutoModerator" })), true);
	assert.equal(isBot(comment("b", "x", { author: "useful_bot" })), true);
	assert.equal(isBot(comment("c", "x", { author: "mod", distinguished: "moderator" })), true);
	assert.equal(isBot(comment("d", "x", { author: "a_person" })), false);
	assert.equal(isBot(comment("e", "x", { author: null })), false);
});
