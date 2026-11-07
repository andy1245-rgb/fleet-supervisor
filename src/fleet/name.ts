// A pane's human name, and where that name came from.
//
// Ported from the GUI's `lib/pane-name.mjs` verbatim — the rung order, the machine-text
// classes, the conduct rule and the marked cut are that file's decisions, not this
// one's — because five surfaces used to derive a name and all five had to agree. Four
// panes on this box read `π - andrew` on the CLI while the page read `unnamed`; the
// copies agreed on 38 of 42 rows by accident, and agreement by accident is what this
// file replaces.
//
// Three rungs, first usable one wins:
//
//   1. the pane label     — what herdr's own sidebar shows, written from the first
//                           prompt (or refined, or typed by hand)
//   2. the note's intent  — the sentence the worker wrote about its own work
//   3. `unnamed`          — one word in the name position, and line 2 says which end
//                           is missing
//
// Three rungs are deleted, and each deletion is why a test exists:
//
//   * `lastPrompt` is rewritten every turn, so it renamed a row every time the
//     operator replied.
//   * the session title and the terminal title are pi's chrome (`π - andrew`) rather
//     than a piece of work, and the label already carries that text when it carries
//     anything.
//   * the pane id in guillemets is an identifier in the one place a rail is liked for
//     keeping identifiers out of. The live form of that rung survives as a refusal:
//     a label that *is* the pane id is not a name either.
//
// A candidate that fails a test falls through to the next rung rather than being
// printed with a warning, and `rejected` records what refused it so line 2 can say so
// in words. Everything here is pure: no filesystem, no clock, no herdr.

export const NAME_MAX = 60;

/** The only three sources a name may have. No fourth exists. */
export const RUNGS = Object.freeze(["pane label", "note intent", "unnamed"] as const);

const DASHES = ["\u2014", "\u2013"];
const SENTENCE_END = /[.!?](?=\s|$)/;

// --------------------------------------------------------------- the conduct rule
//
// The case is `Lab 3 Preparation and Cheating`: a faithful paraphrase of a first
// prompt, tripping no secret shape, and a claim about the operator's conduct in a
// position that gets screenshotted. The rule, in one sentence: a name describes work,
// so a name that contains an allegation term is not used.
//
// It is kept narrow on purpose: allegation vocabulary only, no adjective, no generic
// word. `Debugging Terminal Pane`, `Lab 3 Preparation Strategy` and `Make the metrics
// schema the only writer of measurement rows` all survive it. The cost of being narrow
// is that "Cheating at cards" is withheld too — a fall-through to the next rung, which
// loses a name and asserts nothing.

const CONDUCT_PATTERNS: readonly RegExp[] = [
	/(?<!\p{L})cheat(?:s|ed|er|ers|ing)?(?!\p{L})/iu,
	/(?<!\p{L})plagiar\p{L}*(?!\p{L})/iu,
	/(?<!\p{L})collud\p{L}*(?!\p{L})/iu,
	/(?<!\p{L})collusion(?!\p{L})/iu,
	/(?<!\p{L})ghost[- ]?writ(?:e|es|er|ers|ing|ten|tten)(?!\p{L})/iu,
	/(?<!\p{L})impersonat\p{L}*(?!\p{L})/iu,
	/(?<!\p{L})academic\s+misconduct(?!\p{L})/iu,
];

/** True when the string asserts what a person did rather than what the work is. */
export function isConductClaim(text: unknown): boolean {
	if (typeof text !== "string" || text.trim() === "") return false;
	return CONDUCT_PATTERNS.some((pattern) => pattern.test(text));
}

// -------------------------------------------------------------------- the clauses

/** The first clause of a sentence: up to the first sentence end, the first spaced
 *  dash, or the first semicolon. Colons are kept because they carry the subject
 *  ("Lab 3: finish part B" reads better than "Lab 3"). */
export function firstClause(text: unknown): string | null {
	const raw = typeof text === "string" ? text.trim().replace(/\s+/g, " ") : "";
	if (raw === "") return null;
	let cut = raw.length;
	const sentence = SENTENCE_END.exec(raw);
	if (sentence !== null) cut = Math.min(cut, sentence.index);
	for (const dash of DASHES) {
		const at = raw.indexOf(` ${dash} `);
		if (at > 0) cut = Math.min(cut, at);
	}
	const spaced = raw.indexOf(" - ");
	if (spaced > 0) cut = Math.min(cut, spaced);
	const semi = raw.indexOf(";");
	if (semi > 0) cut = Math.min(cut, semi);
	const clause = raw
		.slice(0, cut)
		.trim()
		.replace(/[,:.\u2014\u2013-]+$/, "")
		.trim();
	return clause === "" ? null : clause;
}

/** Shorten to `NAME_MAX` on a word boundary, and mark the cut with an ellipsis. An
 *  unmarked cut that reads as a complete name is the artefact this function bans:
 *  `Migrate Solana MLH Hackathon to` is 30 characters, a writer's cap, and no mark of
 *  having been cut. */
export function shorten(text: unknown, max = NAME_MAX): string | null {
	if (typeof text !== "string") return null;
	if (text.length <= max) return text;
	const slice = text.slice(0, max - 1);
	const space = slice.lastIndexOf(" ");
	return `${(space > max * 0.5 ? slice.slice(0, space) : slice).trimEnd()}\u2026`;
}

const BARE_DIR = /^(?:~|-|\/)$/;
const HOME_DIR = /^\/(?:home|Users)\/[^/]+\/?$/;
const FILENAME = /^[\w.-]+\.(?:json|jsonl|md|ts|mts|mjs|js|txt|log|png|pdf)$/i;
const SLUG = /^[\w.-]+\/[\w.-]+$/;
const STATUS_WORDS = /^(?:working|idle|blocked|done|unknown|paused)$/i;
/** `π - andrew` is pi's default terminal title, and it is not a name. */
const PI_CHROME = /^π\s*(-\s*\S*)?$/i;

/** Machine text: the named classes and only those — a name is never rejected for
 *  being merely odd. */
export function isMachineText(text: unknown): boolean {
	const value = typeof text === "string" ? text.trim() : "";
	if (value === "") return true;
	if (BARE_DIR.test(value)) return true;
	if (HOME_DIR.test(value)) return true;
	if (PI_CHROME.test(value)) return true;
	if (FILENAME.test(value)) return true;
	if (SLUG.test(value)) return true;
	if (STATUS_WORDS.test(value)) return true;
	if (/^(?:\/|~\/)/.test(value)) return true;
	return false;
}

/** A candidate whose last token is a function word or a bare numeral was cut
 *  mid-phrase, and the reader is being shown a preposition that lost its object. */
const FUNCTION_WORDS: ReadonlySet<string> = new Set([
	"to", "for", "and", "of", "with", "the", "a", "an", "in", "on", "at", "by", "from",
	"into", "onto", "about", "via", "per", "as", "or", "but", "if", "than", "then", "that",
]);

export function cutMidPhrase(clause: unknown): boolean {
	if (typeof clause !== "string") return false;
	const words = clause.trim().split(/\s+/);
	const last = (words[words.length - 1] ?? "").replace(/[,:;]+$/, "");
	if (FUNCTION_WORDS.has(last.toLowerCase())) return true;
	if (/^[\d.,]+$/.test(last) && words.length > 1) return true;
	return false;
}

// ------------------------------------------------------------- the reason vocabulary

/** Line 2's reason vocabulary: a closed set in which every entry declares which end
 *  of the row it is about, so a reason cannot be a shrug. */
export const REASONS: Readonly<Record<string, { about: string; detail: string }>> = Object.freeze({
	"no session report yet": { about: "session", detail: "nothing has reported a session for this pane" },
	"no pi agent in this pane": { about: "session", detail: "herdr does not say pi is running here" },
	"label is terminal chrome": { about: "label", detail: "the label is pi's default terminal title" },
	"label is not a word": { about: "label", detail: "the label is a single character or punctuation, not a word" },
	"label ends mid-phrase": { about: "label", detail: "the label's last token is a function word or a bare numeral" },
	"label withheld": { about: "label", detail: "the label asserted something about a person" },
	"made-up conversation": { about: "fixture", detail: "this row is sample data, not a conversation" },
	"no note yet": { about: "note", detail: "the row is named, but its session has written no note" },
});

export function reasonAbout(reason: string | null | undefined): string | null {
	if (typeof reason !== "string") return null;
	return Object.prototype.hasOwnProperty.call(REASONS, reason) ? (REASONS[reason]?.about ?? null) : null;
}

const REJECTION_REASONS: Readonly<Record<string, string>> = {
	"machine text": "label is terminal chrome",
	"one character": "label is not a word",
	empty: "label is not a word",
	"cut mid-phrase": "label ends mid-phrase",
	conduct: "label withheld",
	"pane id": "label is terminal chrome",
};

/** The rejection worth printing, if any. The pane label's outranks the note's,
 *  because the reader can see the label in herdr's sidebar and not the note. */
export function rejectionReason(rejected: readonly NameRejection[]): string | null {
	const entry = rejected.find((row) => row.source === "pane label") ?? rejected[0] ?? null;
	return entry === null ? null : (REJECTION_REASONS[entry.reason] ?? null);
}

// -------------------------------------------------------------------------- the name

export interface NameNote {
	intent?: string;
	present?: boolean;
	author?: string;
}

export interface NameRejection {
	source: string;
	reason: string;
	detail: string;
}

export interface NameRecord {
	text: string;
	source: string;
	origin: string;
	raw: string | null;
	derived: boolean;
	detail: string;
	rejected: NameRejection[];
}

/** The note as this chain wants it: the worker's own sentence, or null. A note the
 *  supervisor wrote is marked, because it is not the worker's words about its own
 *  work (`reports_written_by_supervisor`). */
export function noteOf(claim: { intent?: unknown } | null | undefined, author = "agent"): NameNote | null {
	if (claim === null || claim === undefined) return null;
	return { present: true, intent: typeof claim.intent === "string" ? claim.intent : "", author };
}

/** How many characters a person sees. A single glyph is not a name, whatever it is. */
function glyphs(text: string): number {
	return [...text.trim()].length;
}

function judgeField(raw: string, paneId: string | null): { reason: string; detail: string } | null {
	if (paneId !== null && raw.trim() === paneId) {
		return { reason: "pane id", detail: "it is the pane's own identifier, and an identifier is not a name" };
	}
	if (isMachineText(raw)) return { reason: "machine text", detail: "it is machine text rather than a name" };
	if (isConductClaim(raw)) return { reason: "conduct", detail: "it states what a person did rather than what the work is" };
	if (glyphs(raw) < 2) return { reason: "one character", detail: "it is a single character, so it is not a word" };
	return null;
}

function judgeClause(clause: string | null): { reason: string; detail: string } | null {
	if (clause === null) return { reason: "empty", detail: "there is nothing in the field to read" };
	if (glyphs(clause) < 2) return { reason: "one character", detail: "the clause before the first dash or stop is a single character" };
	if (cutMidPhrase(clause)) return { reason: "cut mid-phrase", detail: "its last token is a function word or a bare numeral, so it was cut mid-phrase" };
	return null;
}

/** The full record, for the surfaces that print where a name came from. */
export function paneName(args: { label?: string | null; note?: NameNote | null; paneId?: string | null } = {}): NameRecord {
	const label = args.label ?? null;
	const note = args.note ?? null;
	const paneId = args.paneId ?? null;
	const rejected: NameRejection[] = [];
	const candidates: { source: string; raw: string; origin: string }[] = [];

	const labelText = typeof label === "string" ? label : "";
	if (labelText.trim() !== "") {
		candidates.push({ source: "pane label", raw: labelText, origin: "herdr's pane title, which is what herdr's sidebar shows" });
	}

	const notePresent = note !== null && typeof note === "object" && note.present !== false;
	const intent = notePresent && typeof note.intent === "string" ? note.intent : "";
	if (notePresent && note.author !== "supervisor" && intent.trim() !== "") {
		candidates.push({ source: "note intent", raw: intent, origin: "the claim file: the worker's own intent" });
	}

	for (const candidate of candidates) {
		const refused = judgeField(candidate.raw, paneId) ?? judgeClause(firstClause(candidate.raw));
		if (refused !== null) {
			rejected.push({ source: candidate.source, reason: refused.reason, detail: refused.detail });
			continue;
		}
		const clause = firstClause(candidate.raw);
		const text = shorten(clause) ?? "unnamed";
		const cut = text !== candidate.raw.trim();
		return {
			text,
			source: candidate.source,
			origin: candidate.origin,
			raw: candidate.raw,
			derived: cut,
			detail: cut
				? `${candidate.source} from ${candidate.origin}, shortened with a marked cut: ${candidate.raw}`
				: `${candidate.source}, verbatim: ${candidate.raw}`,
			rejected,
		};
	}

	const why =
		rejected.length === 0
			? "this pane has no label and its session has written no note"
			: `nothing usable to name it: ${rejected.map((row) => `${row.source} — ${row.detail}`).join("; ")}`;
	return {
		text: "unnamed",
		source: "unnamed",
		origin: "no usable label and no usable note",
		raw: null,
		derived: false,
		detail: `no name yet: ${why}.`,
		rejected,
	};
}

/**
 * The frozen entry point (PLAN-v1 §2.0). Same chain, one flat argument object:
 * `{label, noteIntent, paneId}` → `{text, source, rejected}` plus the raw record.
 *
 * `noteIntent` is either the worker's sentence or its note object; both mean the
 * second rung, because a caller holding the sentence has already decided it is the
 * worker's.
 */
export function nameOf(args: {
	label?: string | null;
	noteIntent?: string | NameNote | null;
	paneId?: string | null;
}): NameRecord {
	const intent = args.noteIntent ?? null;
	const note: NameNote | null =
		typeof intent === "string" ? { present: true, intent, author: "agent" } : (intent as NameNote | null);
	return paneName({ label: args.label ?? null, note, paneId: args.paneId ?? null });
}
