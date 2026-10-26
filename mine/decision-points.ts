// Decision-point miner. A decision point is a completed agent turn that a human
// then answered: the state the agent left behind is the input, the human's next
// instruction is the label. That pairing is what a supervising manager has to
// reproduce, so every pair is one training example.
//
// A turn is the run of assistant/toolResult records between two user records.
// Synthetic user records (harness notifications, skill injections, empty
// payloads) are not human answers, so they neither end a turn nor label one.

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

const LABELS: readonly Label[] = ["continue", "nudge", "redirect", "stop", "new_task"];

const STOP_PATTERN = /^(?:stop|halt|cancel|wait|hold on|nevermind|never mind)\b/i;
const STOP_DOT_PATTERN = /^stop\./i;
const CONTINUE_PATTERN =
	/^(?:ok|okay|k|y|yes|yeah|yep|sure|continue|proceed|go|next|do it|carry on|keep going|whats next|what is next|perfect|great|lgtm|nice)\b/i;
const REDIRECT_PATTERN = /\b(instead|actually|no,|rather|change|switch|forget that|different approach|scrap)\b/i;

const CONTINUE_MAX_CHARS = 80;
const NEW_TASK_MIN_CHARS = 200;
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

interface Labelled {
	label: Label;
	labelReason: string;
}

function labelFor(raw: string): Labelled {
	const text = stripInvisible(raw);

	if (STOP_PATTERN.test(text) || STOP_DOT_PATTERN.test(text)) {
		return { label: "stop", labelReason: "opens with a halt word" };
	}
	if (CONTINUE_PATTERN.test(text) && text.length < CONTINUE_MAX_CHARS) {
		return { label: "continue", labelReason: "short affirmative acknowledgement" };
	}
	if (text.length > NEW_TASK_MIN_CHARS) {
		return { label: "new_task", labelReason: "long message, no carry-over marker" };
	}
	if (REDIRECT_PATTERN.test(text)) {
		return { label: "redirect", labelReason: "correction or redirection wording" };
	}
	return { label: "nudge", labelReason: "no explicit signal" };
}

function toDecisionPoint(turn: Turn, humanText: string, meta: SessionMeta): DecisionPoint | undefined {
	const assistantText = clip(turn.texts.join("\n\n"), CLIP_CHARS);
	if (!assistantText && turn.calls.length === 0) return undefined;
	const { label, labelReason } = labelFor(humanText);
	return {
		sessionId: meta.sessionId,
		sessionPath: meta.sessionPath,
		cwd: meta.cwd,
		timestamp: turn.timestamp,
		assistantText,
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
				const point = toDecisionPoint(turn, humanText, meta);
				turn = undefined;
				if (point) points.push(point);
				break;
			}
			default:
				break;
		}
	}

	return { meta, points, skippedSynthetic, badLines };
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
	let badLines = 0;

	for (const file of files) {
		const scan = scanSession(file);
		points.push(...scan.points);
		skippedSynthetic += scan.skippedSynthetic;
		badLines += scan.badLines;
	}

	mkdirSync(join(import.meta.dirname, "out"), { recursive: true });
	writeFileSync(outPath, points.length === 0 ? "" : `${points.map((p) => JSON.stringify(p)).join("\n")}\n`);

	const counts = countLabels(points);
	console.log(`sessions scanned: ${files.length}`);
	console.log(`decision points:  ${points.length}`);
	for (const label of LABELS) console.log(`  ${label.padEnd(9)} ${counts.get(label) ?? 0}`);
	console.log(`non-human user messages skipped: ${skippedSynthetic}`);
	if (badLines > 0) console.log(`malformed lines skipped: ${badLines}`);
	console.log(`wrote ${outPath}`);
}

main();
