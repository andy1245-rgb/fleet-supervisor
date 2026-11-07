// S8 — projection. The whole reason this stage exists is one measurement: a 13-comment
// thread is **7,416 tokens = 7.2× the 1024-token window** the needle reads (§8), so what
// the needle sees is ~0.8% of a thread. Everything that requires reading the thread
// therefore has to happen here, deterministically, with no model involved — the model gets
// 600 characters and one decision, and a projection it cannot reproduce is a projection
// nobody can debug.
//
// Fixed slots, not greedy ranking (§8.2):
//
//   countsLine                      "<n>c <a>a <r>rm <top>top", always first
//   slot "strong"  ≤ 300 ch         highest relevance × revival
//   slot "pro"     ≤ 210 ch         highest-scoring pro-stance comment
//   slot "con"     ≤ 210 ch         highest-scoring con-stance comment
//   tail                            next by score while ≥ 120 ch remain
//
// Three rules in that layout are load-bearing and each fixes a specific way this stage
// could lie:
//
// 1. **The `con` slot is filled even when there is no dissent**, by the next-best comment,
//    and `dissentInWindow` records false. An empty `con` slot means "the window could not
//    show dissent", which is a different fact from "the thread agreed" — and manufacturing
//    dissent by promoting a mild remark into the slot would be the worse error.
// 2. **A slot is only filled if the comment reaches 120 ch after truncation.** Spending
//    210 of 600 characters on "I agree" is the failure this stage exists to prevent;
//    unused budget rolls to the tail.
// 3. **One comment per author in the slots.** Four slots going to one person is one
//    opinion rendered four times, and `distinctAuthors` is the denominator every support
//    verdict is computed from (§7.9).
//
// The budget default is the *worker's* field cap (600), not §7.13's 840, and that is a
// deliberate reading of an existing behaviour rather than an oversight: `profiles/common.py:clip`
// keeps the **end** of an over-long field and prepends a marker, so an 840-character
// projection handed to a 600-character field would lose the counts line and the strong slot
// and keep the tail — the exact inverse of what this stage produces. `SPEC_TEXT_TARGET` is
// kept here for the day the worker's cap moves; the cap itself and the record shapes the
// workers read live in `worker-state.ts`, because they change when the worker changes and
// this file changes when the algorithm does.

import { createHash } from "node:crypto";
import type { RawComment, RawThread } from "./types.ts";
import { WORKER_TEXT_CAP } from "./worker-state.ts";

/** §8.2's window, kept as the reference the slot ratios are stated against. */
export const SPEC_TEXT_TARGET = 840;

/** Bumping this invalidates every cached projection, which is what should happen when the
 *  slots, the cues or the ranking change: a projection keyed on identical inputs but
 *  produced by different code is a different projection. */
export const ALGORITHM_VERSION = 1;

/** §8.2's slot caps, stated for 840 ch, as ratios of the space left after the counts line.
 *  Scaling them is what keeps three slots filled at the worker's 600-char cap instead of
 *  spending the whole window on two: 300 + 210 + 210 + 60 counts is 780, and 780/840 is the
 *  scale factor. */
const SLOT_RATIO = { strong: 300 / 780, pro: 210 / 780, con: 210 / 780 } as const;

/** A comment shorter than this is an interjection, not a statement (§8.2 rule 1). */
export const MIN_SEGMENT_CHARS = 120;

/** Bodiless comments below this are filtered before ranking (§7.7 filter 2). */
export const MIN_BODY_CHARS = 80;

/** Below 3.5 ch/token a projection is under-budget for the wrong reason; above it the slot
 *  text is being padded. Only used for the diagnostic line. */
const CHARS_PER_TOKEN = 3.8;

/** §8.5's cue sets, deterministic and auditable. ~200 entries in the specification; these
 *  are the ones it prints, and a change to them must not change `contested` on a labelled
 *  set of threads (§8.5) — which is why they live in one place and nothing else invents a
 *  stance. */
export const PRO_CUES: readonly RegExp[] = [/\bworth (it|the)\b/i, /\bbetter than\b/i, /\brecommend/i, /\bswitched to\b/i, /\bno regrets?\b/i, /\bholds? up\b/i, /\bmuch (nicer|crisper|smoother)\b/i];
export const CON_CUES: readonly RegExp[] = [/\bnot worth\b/i, /\boverpriced\b/i, /\bsnake oil\b/i, /\bplacebo\b/i, /\bwaste of money\b/i, /\bcheaper .* (same|as good)\b/i, /\bregret/i];
export const NEG_CUES: readonly RegExp[] = [/\bnot\b/i, /\bnever\b/i, /\bcan'?t tell\b/i, /\bno difference\b/i];

/** How far a negation has to be from a positive cue to flip it. 40 ch is the distance at
 *  which "not" and "worth it" are still the same clause in ordinary prose. */
const NEGATION_WINDOW = 40;

export type Stance = "pro" | "con" | "neutral";

export function stanceOf(body: string): Stance {
	const pro = countCueHits(PRO_CUES, body);
	const con = countCueHits(CON_CUES, body);
	const negated = NEG_CUES.some((cue) => {
		const match = cue.exec(body);
		if (match === null) return false;
		return PRO_CUES.some((positive) => {
			const hit = positive.exec(body);
			if (hit === null) return false;
			return Math.abs(hit.index - match.index) <= NEGATION_WINDOW;
		});
	});
	const effectivePro = negated ? 0 : pro;
	if (effectivePro === con) return "neutral";
	return effectivePro > con ? "pro" : "con";
}

function countCueHits(cues: readonly RegExp[], body: string): number {
	let hits = 0;
	for (const cue of cues) {
		const flags = cue.flags.includes("g") ? cue : new RegExp(cue.source, `${cue.flags}g`);
		for (const _ of body.matchAll(flags)) hits += 1;
	}
	return hits;
}

export interface ThreadCounts {
	readonly fetched: number;
	/** Comments that survive the filters and are not deleted or removed. */
	readonly live: number;
	readonly deleted: number;
	readonly removed: number;
	/** Live comments whose removal no channel has checked (§7.5). */
	readonly unverifiedRemovals: number;
	readonly distinctAuthors: number;
	readonly topLevel: number;
	readonly medianScore: number | null;
	readonly topScore: number | null;
}

export interface Segment {
	readonly commentId: string;
	readonly author: string | null;
	readonly score: number | null;
	readonly stance: Stance;
	/** Verbatim, sentence-truncated, `[<score>up]` prefix included. */
	readonly text: string;
	readonly slot: "strong" | "pro" | "con" | "tail";
	readonly truncated: boolean;
}

export type DropReason = "jokes" | "empty" | "removed";

export interface Projection {
	/** `sha256(postId)[0:16]` (§7.6) — a stable handle that is not the thread's address. */
	readonly threadId: string;
	readonly postId: string;
	readonly text: string;
	readonly segments: readonly Segment[];
	readonly countsLine: string;
	readonly included: readonly string[];
	readonly dropped: number;
	/** `quote` today: the slot algorithm, no model, so a citable span always exists. */
	readonly renderMode: "quote";
	readonly dissentInWindow: boolean;
	readonly algorithmVersion: number;
	readonly counts: ThreadCounts;
	/** Set when the thread as a whole is unusable, so the caller can emit a `DropCode`
	 *  instead of a projection over survivors that are not representative (§10 case 10/12). */
	readonly drop: DropReason | null;
	/** Diagnostic only: the projection's size against the window it is read in. */
	readonly approxTokens: number;
}

export interface ProjectOptions {
	/** The `want` line. Ranking is relative to it, so the same thread projects
	 *  differently for a different question — which is why the key includes the want. */
	readonly want?: string;
	readonly textBudget?: number;
}

const STOPWORDS = new Set(["the", "a", "an", "is", "are", "was", "were", "be", "been", "it", "its", "this", "that", "these", "those", "to", "of", "for", "on", "in", "and", "or", "but", "if", "than", "then", "so", "as", "at", "by", "with", "from", "i", "you", "we", "they", "he", "she", "my", "your", "our", "their", "me", "us", "them", "do", "does", "did", "have", "has", "had", "can", "could", "would", "should", "will", "just", "very", "really", "about", "into", "over", "more", "most", "any", "all", "no", "not"]);

export function contentTokens(text: string): readonly string[] {
	return text
		.toLowerCase()
		.replace(/[^a-z0-9\s'-]/g, " ")
		.split(/\s+/)
		.filter((token) => token.length >= 2 && !STOPWORDS.has(token));
}

/** idf-weighted overlap between the comment and the `want`, with the document frequency
 *  measured **within this thread** — the only corpus available at projection time. A token
 *  that appears in every comment ("switch") discriminates nothing and should not make a
 *  comment relevant; one that appears once does. */
function relevanceOf(bodyTokens: ReadonlySet<string>, wantTokens: readonly string[], df: ReadonlyMap<string, number>, total: number): number {
	if (wantTokens.length === 0 || total === 0) return 0;
	let matched = 0;
	let possible = 0;
	for (const token of wantTokens) {
		const idf = Math.log(1 + total / Math.max(1, df.get(token) ?? 0));
		possible += idf;
		if (bodyTokens.has(token)) matched += idf;
	}
	return possible === 0 ? 0 : matched / possible;
}

function lengthFit(chars: number): number {
	if (chars >= 150 && chars <= 900) return 1;
	if (chars < 150) return Math.max(0.4, 1 - ((150 - chars) * 0.6) / 110);
	return Math.max(0.6, 1 - ((chars - 900) * 0.4) / 1100);
}

function median(values: readonly number[]): number | null {
	if (values.length === 0) return null;
	const sorted = [...values].sort((a, b) => a - b);
	const middle = Math.floor(sorted.length / 2);
	if (sorted.length % 2 === 1) return sorted[middle] ?? null;
	const lower = sorted[middle - 1];
	const upper = sorted[middle];
	return lower === undefined || upper === undefined ? null : (lower + upper) / 2;
}

export function isBot(comment: RawComment): boolean {
	const author = comment.author ?? "";
	if (author === "AutoModerator") return true;
	if (comment.distinguished !== null) return true;
	return /bot$/i.test(author);
}

function shingles(body: string): ReadonlySet<string> {
	const tokens = body.toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter((token) => token !== "");
	const out = new Set<string>();
	for (let index = 0; index + 5 <= tokens.length; index += 1) out.add(tokens.slice(index, index + 5).join(" "));
	return out;
}

function jaccard(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
	if (a.size === 0 || b.size === 0) return 0;
	let shared = 0;
	for (const item of a) if (b.has(item)) shared += 1;
	return shared / (a.size + b.size - shared);
}

export function threadIdOf(postId: string): string {
	return createHash("sha256").update(postId, "utf8").digest("hex").slice(0, 16);
}

/** Counts over the canonical thread — the comments that survived removal, *not* the ones
 *  that survived ranking. The two numbers are deliberately different: `§7.6`'s `ThreadCounts`
 *  describes what was fetched, and the effect of the ranking filters is the projection's own
 *  `dropped`/`included`. A counts line that said "12c" for a 15-comment thread would tell the
 *  needle the thread is smaller than it is. */
function countsOf(thread: RawThread): ThreadCounts {
	const live = thread.comments.filter((comment) => comment.removal.kind === "live");
	const scores: number[] = [];
	for (const comment of live) if (comment.score !== null) scores.push(comment.score);
	return {
		fetched: thread.comments.length,
		live: live.length,
		deleted: thread.comments.filter((comment) => comment.removal.kind === "deleted-by-author").length,
		removed: thread.comments.filter((comment) => comment.removal.kind === "removed-by-moderator").length,
		unverifiedRemovals: live.filter((comment) => comment.removal.kind === "live" && !comment.removal.removalChecked).length,
		distinctAuthors: new Set(live.map((comment) => comment.author).filter((author): author is string => author !== null && author !== "")).size,
		topLevel: live.filter((comment) => comment.depth === 0).length,
		medianScore: median(scores),
		topScore: scores.length === 0 ? null : Math.max(...scores),
	};
}

interface Scored {
	readonly comment: RawComment;
	readonly stance: Stance;
	readonly rank: number;
}

/** §8.3's ranking, with the weights as named constants so a bad order is debuggable by
 *  printing four numbers rather than diffing a latent space. */
export function rankComments(thread: RawThread, want: string): { readonly kept: readonly Scored[]; readonly droppedByRepetition: number; readonly dropped: number } {
	const body = want === "" ? [] : contentTokens(want);
	const df = new Map<string, number>();
	const candidates = thread.comments.filter((comment) => comment.removal.kind === "live" && !isBot(comment) && comment.body.trim().length >= MIN_BODY_CHARS);

	const tokenSets = new Map<string, ReadonlySet<string>>();
	for (const comment of candidates) {
		const tokens = new Set(contentTokens(comment.body));
		tokenSets.set(comment.commentId, tokens);
		for (const token of body) if (tokens.has(token)) df.set(token, (df.get(token) ?? 0) + 1);
	}

	// Repetition: keep the higher-scored copy of a near-duplicate. This is what catches joke
	// chains and copypasta, and its count is the joke-ratio numerator below.
	let droppedByRepetition = 0;
	const keptShingles: { readonly shingles: ReadonlySet<string>; readonly score: number; readonly id: string; readonly comment: RawComment }[] = [];
	const survivors: RawComment[] = [];
	for (const comment of candidates) {
		const shingle = shingles(comment.body);
		const twin = keptShingles.find((other) => jaccard(shingle, other.shingles) > 0.8);
		if (twin === undefined) {
			keptShingles.push({ shingles: shingle, score: comment.score ?? 0, id: comment.commentId, comment });
			survivors.push(comment);
			continue;
		}
		droppedByRepetition += 1;
		// Replace the earlier copy when this one scored better, so the survivor is the one the
		// thread actually endorsed rather than the one that arrived first.
		if ((comment.score ?? 0) > twin.score) {
			const index = keptShingles.indexOf(twin);
			keptShingles[index] = { shingles: shingle, score: comment.score ?? 0, id: comment.commentId, comment };
			const survivorIndex = survivors.findIndex((item) => item.commentId === twin.id);
			if (survivorIndex !== -1) survivors[survivorIndex] = comment;
		}
	}

	const scores = survivors.map((comment) => comment.score).filter((score): score is number => score !== null);
	const topScore = scores.length === 0 ? null : Math.max(...scores);
	const threadMedian = median(scores);

	const kept: Scored[] = survivors.map((comment) => {
		const normalizedScore = topScore === null || topScore <= 0 ? 0.5 : Math.max(0, comment.score ?? 0) / topScore;
		// Revival: score ÷ the thread's median. Null scores are 0.5, never 0: treating absence as
		// zero would systematically bury every comment from a channel that cannot report scores
		// (`.rss`), which is a channel choice and not a quality signal (§8.3).
		const revival = threadMedian === null || threadMedian <= 0 || comment.score === null ? null : Math.min(1, comment.score / threadMedian / 10);
		const relevance = relevanceOf(tokenSets.get(comment.commentId) ?? new Set(), body, df, survivors.length);
		return {
			comment,
			stance: stanceOf(comment.body),
			rank: 0.4 * normalizedScore + 0.25 * relevance + 0.2 * (revival ?? 0.5) + 0.15 * lengthFit(comment.body.length),
		};
	});
	kept.sort((a, b) => b.rank - a.rank || a.comment.commentId.localeCompare(b.comment.commentId));

	return { kept, droppedByRepetition, dropped: thread.comments.length - kept.length };
}

/** Sentence-boundary truncation (§8.2 rule 4): never mid-word, never mid-quote, and
 *  `truncated` recorded so a citation cannot claim to be the whole comment. */
export function truncateAtSentence(body: string, limit: number): { readonly text: string; readonly truncated: boolean } {
	const flat = body.replace(/\s+/g, " ").trim();
	if (flat.length <= limit) return { text: flat, truncated: false };
	const window = flat.slice(0, limit);
	const sentenceEnd = Math.max(window.lastIndexOf(". "), window.lastIndexOf("! "), window.lastIndexOf("? "), window.lastIndexOf("\n"));
	// A sentence break in the first half of the window is not a better cut than a word break
	// near the end: it would throw away half the budget to keep a punctuation mark.
	if (sentenceEnd >= Math.floor(limit / 2)) return { text: window.slice(0, sentenceEnd + 1).trim(), truncated: true };
	const wordEnd = window.lastIndexOf(" ");
	if (wordEnd <= 0) return { text: `${window.trim()}…`, truncated: true };
	return { text: `${window.slice(0, wordEnd).trim()}…`, truncated: true };
}

function scoreTag(score: number | null): string {
	return score === null ? "[?up]" : `[${score}up]`;
}

function countsLineOf(counts: ThreadCounts): string {
	const removed = counts.unverifiedRemovals > 0 ? "?rm" : `${counts.removed}rm`;
	const top = counts.topScore === null ? "?" : String(counts.topScore);
	return `${counts.live}c ${counts.distinctAuthors}a ${removed} ${top}top`;
}

/** Thread → bounded record. Deterministic: the same thread and the same `want` produce the
 *  same bytes, which is what makes the projection cacheable by its inputs and a bad
 *  projection diffable. */
export function project(thread: RawThread, options: ProjectOptions = {}): Projection {
	const want = options.want ?? "";
	const budget = options.textBudget ?? WORKER_TEXT_CAP;
	const { kept, droppedByRepetition, dropped } = rankComments(thread, want);
	const counts = countsOf(thread);
	const countsLine = countsLineOf(counts);

	const topLevel = Math.max(1, counts.topLevel);
	// §7.7 filter 4 / §10 case 12: a thread that is mostly a joke chain is dropped rather
	// than projected, because its survivors are not a sample of the thread.
	const jokeRatio = droppedByRepetition / topLevel;
	const drop: DropReason | null = kept.length === 0 ? "empty" : jokeRatio > 0.6 ? "jokes" : counts.live > 0 && counts.removed / Math.max(1, counts.fetched) > 0.5 ? "removed" : null;

	const segments: Segment[] = [];
	const usedAuthors = new Set<string>();
	let dissentInWindow = false;

	const available = Math.max(0, budget - countsLine.length - 3);
	const slotCap = {
		strong: Math.floor(available * SLOT_RATIO.strong),
		pro: Math.floor(available * SLOT_RATIO.pro),
		con: Math.floor(available * SLOT_RATIO.con),
	};
	let remaining = available;

	const take = (slot: Segment["slot"], cap: number, filter: (candidate: Scored) => boolean): boolean => {
		for (const candidate of kept) {
			if (segments.some((segment) => segment.commentId === candidate.comment.commentId)) continue;
			if (!filter(candidate)) continue;
			const author = candidate.comment.author;
			if (author !== null && usedAuthors.has(author)) continue;
			const tag = scoreTag(candidate.comment.score);
			const bodyLimit = Math.max(0, Math.min(cap, remaining) - tag.length - 1);
			if (bodyLimit < MIN_SEGMENT_CHARS) continue;
			const cut = truncateAtSentence(candidate.comment.body, bodyLimit);
			if (cut.text.length < MIN_SEGMENT_CHARS) continue;
			const text = `${tag} ${cut.text}`;
			if (text.length > remaining) continue;
			segments.push({ commentId: candidate.comment.commentId, author, score: candidate.comment.score, stance: candidate.stance, text, slot, truncated: cut.truncated });
			if (author !== null) usedAuthors.add(author);
			remaining -= text.length + 3;
			return true;
		}
		return false;
	};

	for (const slot of ["strong", "pro", "con"] as const) {
		const stance: Stance = slot === "pro" ? "pro" : slot === "con" ? "con" : "neutral";
		const firstTry = take(slot, slotCap[slot], (candidate) => slot === "strong" || candidate.stance === stance);
		if (firstTry && slot === "con") dissentInWindow = true;
		if (firstTry) continue;
		// Rule 2: the `con` slot is filled even with no dissent, and `dissentInWindow` stays
		// false so the record can say "the window could not show dissent".
		if (slot !== "strong") take(slot, slotCap[slot], () => true);
	}

	// Tail: everything left, in rank order, while a comment can still reach 120 ch.
	while (remaining > MIN_SEGMENT_CHARS + 8) {
		if (!take("tail", remaining, () => true)) break;
	}

	const text = segments.length === 0 ? countsLine : [countsLine, ...segments.map((segment) => segment.text)].join(" || ");

	return {
		threadId: threadIdOf(thread.postId),
		postId: thread.postId,
		text: text.slice(0, budget),
		segments,
		countsLine,
		included: segments.map((segment) => segment.commentId),
		dropped,
		renderMode: "quote",
		dissentInWindow,
		algorithmVersion: ALGORITHM_VERSION,
		counts,
		drop,
		approxTokens: Math.ceil(text.length / CHARS_PER_TOKEN),
	};
}
