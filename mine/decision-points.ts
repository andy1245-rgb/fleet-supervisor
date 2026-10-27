// Decision-point miner. A decision point is a completed agent turn that a human
// then answered: the state the agent left behind is the input, the human's next
// instruction is the label. That pairing is what a supervising manager has to
// reproduce, so every pair is one training example.
//
// A turn is the run of assistant/toolResult records between two user records.
// Synthetic user records (harness notifications, skill injections, empty
// payloads) are not human answers, so they neither end a turn nor label one.
//
// THIS CORPUS IS A PROXY, NOT OBSERVED FLEET STATE. Two of a decision input's
// fields are reconstructed downstream (bench/tasks/from-captures.ts): `status` is
// assumed `idle` because a human spoke, and `phase` is inferred from tool names.
// Nothing here was read off a pane. Treat a row as "this turn, then this human
// message", never as "the fleet was in this state".
//
// TWO OPS ARE STRUCTURALLY UNMINEABLE FROM TRANSCRIPTS, and that is a property of
// the population, not a gap to be filled with a weak predicate. A row exists only
// because a human spoke, so P(a human intervened) = 1 for every row:
//   leave         the correct answer "nothing was owed" has no human message, so
//                 it cannot appear here at all. The only `leave` rows are the
//                 `stop` ones (a human intervened in order to halt), which is a
//                 different event from a supervisor staying quiet.
//   declare_done  a human's next message is evidence of what they had to do, never
//                 of a delivery they accepted. No label produces this op.
//
// The label vocabulary is `continue | instruction | redirect | question | stop`,
// and each label is emitted for a named piece of evidence in the human's text:
//   continue     nothing in the message but an acknowledgement, so the human
//                added no content the agent lacked.
//   instruction  the human told the agent something: a directive ("make sure...",
//                "let's...", "i want...") or a statement carrying content. This is
//                what a supervisor should have typed instead of waiting.
//   redirect     the human corrected the course the agent was on ("actually",
//                "instead", "oops", "i meant").
//   question     the human asked the agent something rather than telling it.
//   stop         the message is *only* a halt ("cancel", "never mind").
// A message with no words at all (".", ",") carries no evidence either way and is
// dropped rather than labelled.
//
// There is no `new_task`. Both signals a transcript can actually test for an
// abandoned thread were measured over the 569 human-answered turns in these 117
// sessions, and neither finds one. Explicit abandonment phrasing ("forget it",
// "never mind", "drop this", "leave it", "not that") appears exactly once, and in
// that message "leave it as is" is a continuation. A path, filename or directory
// that appears nowhere earlier in the session matches 34; read one by one they are
// either tokeniser artefacts (prose slashes like `paused/corrupted`, a bare URL, a
// slash command) or ordinary instructions naming a file or folder inside the work
// in progress — always the same agent, on the same task, which is the population
// `new_task` was supposed to be the opposite of. The third signal, "a question that
// is not about the work in progress", needs a topic model this repo does not have,
// so it is not implemented rather than approximated.
//
// The bucket that used to stand in for all three was `text.length > 200`, and 10 of
// 10 sampled rows from it were instructions to the same agent on the same task — so
// `new_task → flag` was teaching the opposite of what it claimed, and it was the
// entire `flag` class. A missing label is honest; that one poisoned every
// downstream target. `flag` now has no mined support at all, which is the true state
// of the evidence (see src/labeling/label-to-op.ts).

import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import type { Label } from "../src/labeling/label-to-op.ts";

export interface ToolCallSummary {
	name: string;
	summary: string;
}

export interface DecisionPoint {
	sessionId: string;
	sessionPath: string;
	cwd: string;
	timestamp: string;
	assistantText: string;
	toolCalls: ToolCallSummary[];
	toolErrors: number;
	humanText: string;
	label: Label;
	labelReason: string;
}

const LABELS: readonly Label[] = ["continue", "instruction", "redirect", "question", "stop"];

// Only a message that is nothing but the halt counts. The `^wait` form this
// replaces fired on "wait so what does this mean?" — a question the pane had to
// answer, which is the opposite of a halt. `wait` stays out entirely: it opens
// questions far more often than it stops work.
const HALT_ONLY =
	/^(?:ok(?:ay)?\s+)?(?:stop|halt|cancel|abort|pause|hold on|hold up|never ?mind|nevermind|nvm)[\s.!,]*$/i;
// Correction-of-course wording. `instead of X` and `switch to X` propose work
// rather than repair a turn, so the bare `change`/`switch` markers are out and
// `instead of` is excluded by lookahead. `actually`/`rather` only count when they
// open a clause or close the message: mid-clause they are filler ("tbh actually we
// may...", "...too actually"), and reading that as a correction was a mistake this
// corpus made before the position was required.
const CORRECTION_PATTERN =
	/(?:^|[,.!?]\s*)(?:no|nope)\b|(?:^|[,.!?]\s*)(?:actually|rather)\b|\b(?:actually|rather)\b[\s.!?]*$|\binstead(?! of)\b|\bi meant\b|\boops\b|\bscratch that\b|\bnot that\b|\bforget that\b|\brevert(?:ing)?\b|\bscrap(?:ping)?\b|\bwrong\b/i;
// Interrogative form only. `did/does/do` are deliberately absent: bare `do` opens
// as many imperatives ("do the 3 commits") as questions, and a real question about
// the work almost always closes with a question mark.
const QUESTION_LEAD_PATTERN = /^(?:what|whats|what's|why|how|which|where|when|who|whose|is|are|was|were|have|has|any)\b/i;
// "can you X?" / "please X" are requests for work, not questions about it.
const REQUEST_LEAD_PATTERN = /^(?:can|could|would|will|please|pls)\b/i;
// An order is not a question even when it wears a question mark. Only the leading
// word decides this: `why is the build red` contains a directive verb ("build") and
// is still a question, while `check the pdfs?` opens with the order.
const IMPERATIVE_LEAD_PATTERN =
	/^(?:add|run|check|fix|write|update|remove|delete|create|build|test|push|commit|refactor|use|try|start|stop|keep|make|move|rename|install|open|read|review|verify|show|list|give|tell|send|explain|find|look|go|do|let'?s|let us|dont|don'?t)\b/i;
const DIRECTIVE_PATTERN =
	/\b(?:please|pls|make sure|don'?t|do not|let'?s|we should|i want|i need|need to|you (?:should|need|must|can)|can you|could you|go ahead|add|run|check|fix|write|update|remove|delete|create|build|test|push|commit|refactor|use|try|start|stop|keep|make|move|rename|install|open|read|look at|review|verify)\b/i;
// Words that acknowledge the agent's turn without adding anything to it. A message
// made of nothing else is a go-ahead; one that has any other word is content.
const ACK_WORDS: ReadonlySet<string> = new Set([
	"ok", "okay", "k", "kk", "y", "ya", "yeah", "yep", "yup", "yes", "yea", "sure", "please", "pls",
	"plz", "good", "great", "nice", "perfect", "cool", "right", "correct", "exactly", "indeed", "thanks",
	"thank", "you", "ty", "go", "ahead", "that", "this", "then", "and", "so", "continue", "proceed", "next",
	"on", "carry", "keep", "going", "lgtm", "alright", "all", "ight", "aight", "bet", "done", "now", "just",
	"js", "rq", "quick", "both", "do", "it", "the", "as", "well", "same", "again", "more", "but", "also",
]);

const CLIP_CHARS = 2000;
const SUMMARY_CHARS = 200;

// Verified against the corpus: bash carries `command`, file tools carry `path`,
// forge_run carries `task`, forge_result carries `runId`. Ordered by how much of
// the turn's intent each argument actually conveys.
const ARGUMENT_PRIORITY: readonly string[] = [
	"command",
	"path",
	"file_path",
	"task",
	"runId",
	"intent",
	"goal",
	"pattern",
	"query",
	"name",
	"argv",
	"params",
	"edits",
];

const SYNTHETIC_PREFIXES: readonly string[] = ["[SYSTEM NOTIFICATION", "<skill "];
const INVISIBLE_PATTERN = /[\u200b\u200c\u200d\u200e\u200f\u2060\ufeff]/g;

type JsonObject = Record<string, unknown>;

function isJsonObject(value: unknown): value is JsonObject {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asObject(value: unknown): JsonObject | undefined {
	return isJsonObject(value) ? value : undefined;
}

function asString(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

function asBlocks(value: unknown): JsonObject[] {
	return Array.isArray(value) ? value.filter(isJsonObject) : [];
}

function clip(text: string, max: number): string {
	return text.length <= max ? text : text.slice(0, max);
}

function stripInvisible(text: string): string {
	return text.replace(INVISIBLE_PATTERN, "").trim();
}

/** Concatenated `text` blocks of a content array. Thinking blocks are dropped. */
function textOf(blocks: JsonObject[]): string {
	const parts: string[] = [];
	for (const block of blocks) {
		if (block["type"] !== "text") continue;
		const text = asString(block["text"]);
		if (text) parts.push(text);
	}
	return parts.join("\n\n");
}

interface SessionMeta {
	sessionId: string;
	sessionPath: string;
	cwd: string;
}

interface Turn {
	texts: string[];
	calls: ToolCallSummary[];
	callIds: Set<string>;
	toolErrors: number;
	timestamp: string;
}

interface SessionScan {
	meta: SessionMeta;
	points: DecisionPoint[];
	skippedSynthetic: number;
	skippedUnlabelled: number;
	badLines: number;
}

function readJsonl(path: string): { records: JsonObject[]; badLines: number } {
	const records: JsonObject[] = [];
	let badLines = 0;
	for (const line of readFileSync(path, "utf8").split("\n")) {
		if (!line.trim()) continue;
		let parsed: unknown;
		try {
			parsed = JSON.parse(line);
		} catch {
			badLines += 1;
			continue;
		}
		if (isJsonObject(parsed)) records.push(parsed);
		else badLines += 1;
	}
	return { records, badLines };
}

/** A tool call argument rendered as text, or undefined if it carries no signal. */
function argumentText(value: unknown): string | undefined {
	if (typeof value === "string") {
		const trimmed = value.trim();
		return trimmed ? trimmed : undefined;
	}
	if (value === undefined || value === null) return undefined;
	if (typeof value === "number" || typeof value === "boolean") return undefined;
	const rendered = JSON.stringify(value);
	return rendered === undefined || rendered === "{}" || rendered === "[]" ? undefined : rendered;
}

function summarizeArguments(args: JsonObject): string {
	for (const key of ARGUMENT_PRIORITY) {
		const text = argumentText(args[key]);
		if (text !== undefined) return clip(text, SUMMARY_CHARS);
	}
	for (const value of Object.values(args)) {
		const text = argumentText(value);
		if (text !== undefined) return clip(text, SUMMARY_CHARS);
	}
	return "";
}

function mergeAssistant(turn: Turn, message: JsonObject, timestamp: string): void {
	if (timestamp) turn.timestamp = timestamp;
	const blocks = asBlocks(message["content"]);
	const prose = textOf(blocks);
	if (prose) turn.texts.push(prose);

	for (const block of blocks) {
		if (block["type"] !== "toolCall") continue;
		const id = asString(block["id"]);
		if (id) turn.callIds.add(id);
		turn.calls.push({
			name: asString(block["name"]) ?? "unknown",
			summary: summarizeArguments(asObject(block["arguments"]) ?? {}),
		});
	}
}

/** Counts failures only for tool calls this turn actually issued. */
function mergeToolResult(turn: Turn, message: JsonObject): void {
	if (message["isError"] !== true) return;
	const id = asString(message["toolCallId"]);
	if (id !== undefined && turn.callIds.has(id)) turn.toolErrors += 1;
}

function isHumanMessage(text: string): boolean {
	const trimmed = text.trim();
	if (!trimmed) return false;
	if (!stripInvisible(trimmed)) return false;
	for (const prefix of SYNTHETIC_PREFIXES) {
		if (trimmed.startsWith(prefix)) return false;
	}
	return true;
}

export interface Labelled {
	label: Label;
	labelReason: string;
}

/** Lowercase, punctuation folded to spaces: the form the ack-word test needs. */
function normalize(text: string): string {
	return text.toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
}

/** The span that made a regex match, for the labelReason a human audits. */
function matched(pattern: RegExp, text: string): string | undefined {
	const found = pattern.exec(text);
	return found === null ? undefined : found[0].trim();
}

/** Acknowledgements that can open a message without changing what it is. An order
 *  still counts as an order after them ("okay do the step 6 ... right?"), and so
 *  does a question ("okay whats next?"). Verb-ish ack words are excluded: "do" and
 *  "go" are orders more often than they are nods. */
const ACK_PREFIX_WORDS: ReadonlySet<string> = new Set([
	"ok", "okay", "k", "kk", "y", "ya", "yeah", "yep", "yup", "yes", "yea", "sure", "ah", "oh", "hm",
	"hmm", "mm", "mhmm", "right", "correct", "exactly", "indeed", "great", "cool", "nice", "perfect", "good",
	"alright", "aight", "thanks", "ty", "thx", "please", "pls", "plz",
]);

/** The clause a message opens with, and whether that clause was closed by a
 *  question mark. A question is decided on the opening clause: "okay yes please,
 *  and commit in steps?" opens with an acknowledgement and is not a question, while
 *  "whats next? lets continue" does ask one. */
function firstClause(text: string): { head: string; closedByQuestion: boolean } {
	const boundary = /[,.;!?\n]/.exec(text);
	if (boundary === null) return { head: text, closedByQuestion: false };
	return { head: text.slice(0, boundary.index), closedByQuestion: boundary[0] === "?" };
}

function stripAckPrefix(head: string): string {
	const parts = head.trim().split(/\s+/);
	let index = 0;
	while (index < parts.length && ACK_PREFIX_WORDS.has(normalize(parts[index] ?? ""))) index += 1;
	return parts.slice(index).join(" ");
}

/** A question is interrogative form with no request and no order in front of it:
 *  the human wanted an answer, not work. "can you ...?" is a request for work. */
function isQuestion(text: string): boolean {
	const { head, closedByQuestion } = firstClause(text);
	const opening = stripAckPrefix(head).toLowerCase();
	if (REQUEST_LEAD_PATTERN.test(opening)) return false;
	if (IMPERATIVE_LEAD_PATTERN.test(opening)) return false;
	return closedByQuestion || QUESTION_LEAD_PATTERN.test(opening);
}

/** Every label is emitted for a named piece of evidence in the human's text, or
 *  not at all. There is no fallback: a message that carries no evidence (no words)
 *  returns undefined so the row is dropped instead of guessed at. */
export function labelFor(raw: string): Labelled | undefined {
	const text = stripInvisible(raw);
	const lower = text.toLowerCase();
	const tokens = normalize(text).split(" ").filter(Boolean);

	if (tokens.length === 0) return undefined;
	if (HALT_ONLY.test(text)) return { label: "stop", labelReason: "the message is only a halt" };
	if (tokens.every((token) => ACK_WORDS.has(token))) {
		return { label: "continue", labelReason: "nothing but an acknowledgement" };
	}

	const correction = matched(CORRECTION_PATTERN, lower);
	if (correction !== undefined) {
		return { label: "redirect", labelReason: `corrects the course the agent was on ("${correction}")` };
	}
	if (isQuestion(text)) {
		return { label: "question", labelReason: "asks the agent something instead of telling it" };
	}

	const directive = matched(DIRECTIVE_PATTERN, lower);
	if (directive !== undefined) {
		return { label: "instruction", labelReason: `directive wording ("${directive}")` };
	}
	return { label: "instruction", labelReason: "content beyond an acknowledgement, no directive marker" };
}

function toDecisionPoint(
	turn: Turn,
	humanText: string,
	{ label, labelReason }: Labelled,
	meta: SessionMeta,
): DecisionPoint {
	return {
		sessionId: meta.sessionId,
		sessionPath: meta.sessionPath,
		cwd: meta.cwd,
		timestamp: turn.timestamp,
		assistantText: clip(turn.texts.join("\n\n"), CLIP_CHARS),
		toolCalls: turn.calls,
		toolErrors: turn.toolErrors,
		humanText: clip(humanText.trim(), CLIP_CHARS),
		label,
		labelReason,
	};
}

function scanSession(sessionPath: string): SessionScan {
	const { records, badLines } = readJsonl(sessionPath);
	const header = records.find((record) => record["type"] === "session");
	const meta: SessionMeta = {
		sessionId: asString(header?.["id"]) ?? basename(sessionPath, ".jsonl"),
		sessionPath,
		cwd: asString(header?.["cwd"]) ?? "",
	};

	const points: DecisionPoint[] = [];
	let turn: Turn | undefined;
	let skippedSynthetic = 0;
	let skippedUnlabelled = 0;

	for (const record of records) {
		if (record["type"] !== "message") continue;
		const message = asObject(record["message"]);
		if (!message) continue;
		const timestamp = asString(record["timestamp"]) ?? "";

		switch (asString(message["role"])) {
			case "assistant": {
				if (!turn) {
					turn = { texts: [], calls: [], callIds: new Set<string>(), toolErrors: 0, timestamp };
				}
				mergeAssistant(turn, message, timestamp);
				break;
			}
			case "toolResult": {
				if (turn) mergeToolResult(turn, message);
				break;
			}
			case "user": {
				const humanText = textOf(asBlocks(message["content"]));
				if (!isHumanMessage(humanText)) {
					// Not a human answer: the turn it interrupted is still the live one.
					skippedSynthetic += 1;
					break;
				}
				if (!turn) break;
				const labelled = labelFor(humanText);
				const completed = turn;
				turn = undefined;
				if (!labelled) {
					skippedUnlabelled += 1;
					break;
				}
				if (!completed.texts.length && completed.calls.length === 0) break;
				points.push(toDecisionPoint(completed, humanText, labelled, meta));
				break;
			}
			default:
				break;
		}
	}

	return { meta, points, skippedSynthetic, skippedUnlabelled, badLines };
}

function listSessionFiles(root: string): string[] {
	if (!existsSync(root)) return [];
	if (statSync(root).isFile()) return root.endsWith(".jsonl") ? [root] : [];

	const files: string[] = [];
	for (const entry of readdirSync(root, { withFileTypes: true })) {
		if (!entry.isDirectory()) continue;
		const dirPath = join(root, entry.name);
		for (const nested of readdirSync(dirPath, { withFileTypes: true })) {
			if (nested.isFile() && nested.name.endsWith(".jsonl")) files.push(join(dirPath, nested.name));
		}
	}
	return files.sort();
}

function countLabels(points: DecisionPoint[]): Map<Label, number> {
	const counts = new Map<Label, number>(LABELS.map((label) => [label, 0]));
	for (const point of points) counts.set(point.label, (counts.get(point.label) ?? 0) + 1);
	return counts;
}

function main(): void {
	const sessionsRoot = process.argv[2] ?? join(homedir(), ".pi", "agent", "sessions");
	const outPath = join(import.meta.dirname, "out", "decision-points.jsonl");

	const files = listSessionFiles(sessionsRoot);
	const points: DecisionPoint[] = [];
	let skippedSynthetic = 0;
	let skippedUnlabelled = 0;
	let badLines = 0;

	for (const file of files) {
		const scan = scanSession(file);
		points.push(...scan.points);
		skippedSynthetic += scan.skippedSynthetic;
		skippedUnlabelled += scan.skippedUnlabelled;
		badLines += scan.badLines;
	}

	mkdirSync(join(import.meta.dirname, "out"), { recursive: true });
	writeFileSync(outPath, points.length === 0 ? "" : `${points.map((p) => JSON.stringify(p)).join("\n")}\n`);

	const counts = countLabels(points);
	console.log(`sessions scanned: ${files.length}`);
	console.log(`decision points:  ${points.length}`);
	for (const label of LABELS) console.log(`  ${label.padEnd(9)} ${counts.get(label) ?? 0}`);
	console.log(`non-human user messages skipped: ${skippedSynthetic}`);
	console.log(`unlabelled human messages dropped: ${skippedUnlabelled}`);
	if (badLines > 0) console.log(`malformed lines skipped: ${badLines}`);
	console.log(`wrote ${outPath}`);
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) main();
