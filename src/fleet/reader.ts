// Reading a conversation: a bounded pane tail, and the fold that turns text into
// blocks. Plus the mount guard, because one of these paths can hang the process.
//
// There are two read paths and they are not the same thing, so they are not dressed
// the same way:
//
//   1. `fixtures/transcripts.json` — authored rows with a role and a timestamp. A
//      transcript. Fixture mode only, and the whole page says it is fixture data.
//   2. `herdr agent read <pane> --source recent-unwrapped --lines N` — what the pane
//      is rendering right now. **Not a transcript.** It has no roles, no timestamps,
//      no message boundaries, and it is bounded by the pane's scrollback. So the tail
//      is *segmented*, never *reconstructed*: a block whose first line starts with `$ `
//      is a command (kind `tool`), every other block is prose (kind `message`), and
//      every message from this path carries `role: null` because the tail does not
//      contain one. Inventing "user" and "assistant" for a rendered terminal puts a
//      claim on screen that nothing on disk supports.
//
// The chrome that gets dropped is dropped by five named rules with a count each, so
// the response can say exactly what was thrown away. Nothing is dropped silently.
//
// **The mount guard.** A transcript path under `~/mnt/` is an sshfs mount onto another
// machine, where a syscall can block in uninterruptible sleep for hours and neither a
// timeout nor a signal releases it. Nothing is read from there: the tail reports the
// refusal as a reason, which is the same channel a missing file uses.

import { homedir } from "node:os";
import { join } from "node:path";

import { readText } from "./fsio.ts";
import { toRow } from "../herdr/cli.ts";
import { herdrPort } from "../herdr/cli.ts";
import { fixturePaths } from "./where.ts";
import type { PaneList, Row } from "./types.ts";

export const DEFAULT_TURNS = 20;
export const MAX_TURNS = 200;
/** One page never exceeds this, however many turns were asked for: an unbounded body
 *  is a defect on a phone over a tailnet. */
export const MAX_MESSAGES = 400;
const LINES_PER_TURN = 26;
const MIN_LINES = 140;
const MAX_LINES = 2000;
const TAIL_TIMEOUT_MS = 4000;

const RULE_ONLY = /^[\s─━═▔▁▂▃▄▅▆▇█┄┅┈┉╌╍|·•▲▼]+$/u;
const SPINNER_BAR = /^\s*─{3,}.*(?:Working|Thinking|Compacting|Waiting|Starting).*─{2,}\s*$/u;
const TOKEN_BAR = /[↑↗]\s*[\d.,]+k?\s+[↓↘]\s*[\d.,]+/u;
const IDENTITY_BAR = /^\s*(?:default|plan|auto)\s*·/u;
const CAPTION_BAR = /^\s*[▰▱]/u;

/** The one path this process must never touch: an sshfs mount, where a read blocks in
 *  uninterruptible sleep and no timeout releases it. */
export function isMountPath(path: string): boolean {
	const mount = join(homedir(), "mnt");
	return path === mount || path.startsWith(`${mount}/`);
}

function isChrome(line: string): string | null {
	if (line.trim() === "") return null;
	if (RULE_ONLY.test(line)) return "rules";
	if (SPINNER_BAR.test(line)) return "spinner";
	if (TOKEN_BAR.test(line)) return "tokenbar";
	if (IDENTITY_BAR.test(line)) return "identity";
	if (CAPTION_BAR.test(line)) return "caption";
	return null;
}

/** The pane draws a border down the right edge of every content line. Strip one
 *  trailing `│`; the count is reported as `borders` so a markdown table losing its
 *  last pipe is visible rather than mysterious. */
function stripBorder(line: string): { line: string; stripped: boolean } {
	if (!line.endsWith("│")) return { line: line.replace(/\s+$/, ""), stripped: false };
	return { line: line.slice(0, -1).replace(/\s+$/, ""), stripped: true };
}

export interface Message {
	index: number;
	kind: "message" | "tool";
	role: "user" | "assistant" | "system" | null;
	text: string | null;
	command: string | null;
	ts: string | null;
	source: string;
	collapsed: boolean;
}

export interface ParsedTail {
	messages: Message[];
	dropped: { rules: number; spinner: number; tokenbar: number; identity: number; caption: number };
	borders: number;
	kept: number;
}

type OpenBlock =
	| { kind: "tool"; command: string[]; output: string[] }
	| { kind: "message"; lines: string[] };

/** Text from a pane tail → messages. Deterministic, and the only rule about meaning is
 *  the `$ ` one. */
export function parseTail(raw: unknown, options: { source?: string } = {}): ParsedTail {
	const source = options.source ?? "pane tail";
	const dropped = { rules: 0, spinner: 0, tokenbar: 0, identity: 0, caption: 0 };
	let borders = 0;
	const kept: string[] = [];

	for (const original of String(raw ?? "").split("\n")) {
		const { line, stripped } = stripBorder(original.replace(/\s+$/, ""));
		if (stripped) borders += 1;
		const chrome = isChrome(line);
		if (chrome !== null) {
			dropped[chrome as keyof typeof dropped] += 1;
			continue;
		}
		kept.push(line);
	}

	const blocks: string[][] = [];
	let current: string[] = [];
	for (const line of kept) {
		if (line.trim() === "") {
			if (current.length > 0) blocks.push(current);
			current = [];
			continue;
		}
		current.push(line);
	}
	if (current.length > 0) blocks.push(current);

	const messages: Message[] = [];
	let index = 0;
	for (const block of blocks) {
		let open: OpenBlock | null = null;
		const flush = (): void => {
			if (open === null) return;
			if (open.kind === "tool") {
				const output = open.output.join("\n").trim();
				messages.push({
					index: index++,
					kind: "tool",
					role: null,
					text: output === "" ? null : output,
					command: open.command
						.map((line, at) => (at === 0 ? line.trimStart().replace(/^\$ /, "") : line.replace(/^\s*\$/, "")))
						.join("\n")
						.replace(/\n{2,}/g, "\n")
						.trim(),
					ts: null,
					source,
					collapsed: true,
				});
			} else {
				messages.push({ index: index++, kind: "message", role: null, text: open.lines.join("\n").trim(), command: null, ts: null, source, collapsed: false });
			}
			open = null;
		};

		for (const line of block) {
			if (line.trimStart().startsWith("$")) {
				const continuesCommand = open !== null && open.kind === "tool" && open.output.length === 0;
				if (!continuesCommand) {
					flush();
					open = { kind: "tool", command: [], output: [] };
				}
				(open as { kind: "tool"; command: string[] }).command.push(line);
				continue;
			}
			if (open !== null && open.kind === "tool") {
				open.output.push(line);
				continue;
			}
			if (open === null) open = { kind: "message", lines: [] };
			(open as { kind: "message"; lines: string[] }).lines.push(line);
		}
		flush();
	}

	return { messages, dropped, borders, kept: kept.length };
}

const ROLES: ReadonlySet<string> = new Set(["user", "assistant", "system"]);

/** Authored rows → messages. A row with no `role` stays `null`: an unknown speaker
 *  stays unknown. */
function messagesFromRows(rows: unknown, source: string): Message[] {
	const messages: Message[] = [];
	let index = 0;
	if (!Array.isArray(rows)) return messages;
	for (const raw of rows) {
		if (typeof raw !== "object" || raw === null) continue;
		const row = raw as Record<string, unknown>;
		const text = typeof row.text === "string" ? row.text : "";
		const tool = typeof row.tool === "object" && row.tool !== null ? (row.tool as Record<string, unknown>) : null;
		if (text.trim() === "" && tool === null) continue;
		const role = typeof row.role === "string" && ROLES.has(row.role) ? (row.role as Message["role"]) : null;
		const ts = typeof row.ts === "string" && Number.isFinite(Date.parse(row.ts)) ? row.ts : null;
		if (tool !== null) {
			messages.push({
				index: index++,
				kind: "tool",
				role,
				text: typeof tool.result === "string" && tool.result.trim() !== "" ? tool.result.trim() : null,
				command: typeof tool.command === "string" ? tool.command : "",
				ts,
				source,
				collapsed: true,
			});
			continue;
		}
		messages.push({ index: index++, kind: "message", role, text: text.trim(), command: null, ts, source, collapsed: false });
	}
	return messages;
}

export interface Page {
	messages: Message[];
	total: number;
	shown: number;
	startIndex: number;
	hasEarlier: boolean;
	unit: "turn" | "block";
	turnsShown: number;
}

/** The last `turns` turns. A turn starts at a `user` message and runs to the line
 *  before the next one, so this never splits a prompt from its answer. A source with
 *  no user rows (the tail path) has no turn boundaries to find, so each block counts
 *  as its own turn and `unit` says which rule produced the window. */
export function pageMessages(messages: Message[], turns: number): Page {
	const total = messages.length;
	const limited = Math.max(1, Math.min(Number.isFinite(turns) ? turns : DEFAULT_TURNS, MAX_TURNS));
	const userStarts: number[] = [];
	for (let at = 0; at < total; at += 1) if (messages[at]?.role === "user") userStarts.push(at);

	const unit: "turn" | "block" = userStarts.length === 0 ? "block" : "turn";
	let start: number;
	if (unit === "block") start = Math.max(0, total - limited);
	else if (userStarts.length <= limited) start = 0;
	else start = userStarts[userStarts.length - limited] ?? 0;

	if (total - start > MAX_MESSAGES) start = total - MAX_MESSAGES;

	return {
		messages: messages.slice(start),
		total,
		shown: total - start,
		startIndex: start,
		hasEarlier: start > 0,
		unit,
		turnsShown: unit === "turn" ? Math.min(limited, userStarts.length) : total - start,
	};
}

export function linesForTurns(turns: number): number {
	const limited = Math.max(1, Math.min(Number.isFinite(turns) ? turns : DEFAULT_TURNS, MAX_TURNS));
	return Math.max(MIN_LINES, Math.min(MAX_LINES, limited * LINES_PER_TURN));
}

export interface TailRead {
	lines: string | null;
	reason: string | null;
	origin: string | null;
	ts: string | null;
}

/** The pane's rendered text, on demand and never in a poll loop. `lines: 0` is not an
 *  error: it is the default, and it means the screen shows a button instead of a
 *  background read. */
export async function tail(args: { paneId: string; lines: number; ctx: { fixtureDir: string | null; herdr: boolean; mode: string } }): Promise<TailRead> {
	const { paneId, lines } = args;
	if (args.ctx.mode === "fixture") {
		const dir = args.ctx.fixtureDir;
		if (dir === null) return { lines: null, reason: "no fixture dir on this load", origin: null, ts: null };
		const path = fixturePaths(dir).tails;
		if (isMountPath(path)) return { lines: null, reason: `${path} is on a mounted drive; nothing is read from there`, origin: null, ts: null };
		const file = readText(path);
		if (!file.exists) return { lines: null, reason: `no tail fixture at ${path}`, origin: null, ts: null };
		try {
			const parsed = JSON.parse(file.text) as Record<string, unknown>;
			const text = parsed[paneId];
			if (typeof text !== "string") return { lines: null, reason: `fixtures/tails.json has no entry for ${paneId}`, origin: null, ts: null };
			return { lines: text, reason: null, origin: "fixtures/tails.json", ts: null };
		} catch (error) {
			return { lines: null, reason: `fixtures/tails.json: ${error instanceof Error ? error.message : "unparseable"}`, origin: null, ts: null };
		}
	}
	if (!args.ctx.herdr) return { lines: null, reason: "--no-herdr: the terminal tail is not read", origin: null, ts: null };
	try {
		const text = await herdrPort().read(paneId, lines);
		if (text === "") return { lines: null, reason: `herdr agent read ${paneId} returned nothing`, origin: null, ts: null };
		return { lines: text, reason: null, origin: `herdr agent read ${paneId} --lines=${lines}`, ts: null };
	} catch (error) {
		return { lines: null, reason: `${error instanceof Error ? error.message : "herdr agent read failed"} (timeout ${TAIL_TIMEOUT_MS}ms)`, origin: null, ts: null };
	}
}

function readFixtureTranscript(dir: string, paneId: string):
	| { ok: true; kind: "transcript" | "tail"; origin: string; messages: Message[]; capturedAt: string | null; note: string | null; dropped: ParsedTail["dropped"] | null; borders: number }
	| { ok: false; origin: string; reason: string } {
	const path = join(dir, "transcripts.json");
	if (isMountPath(path)) return { ok: false, origin: "mounted", reason: `${path} is on a mounted drive; nothing is read from there` };
	const file = readText(path);
	if (!file.exists) return { ok: false, origin: "missing", reason: `no transcript fixture at ${path}` };
	let parsed: { panes?: Record<string, unknown> };
	try {
		parsed = JSON.parse(file.text) as { panes?: Record<string, unknown> };
	} catch (error) {
		return { ok: false, origin: "error", reason: `${path}: ${error instanceof Error ? error.message : "unparseable"}` };
	}
	const entry = parsed.panes?.[paneId];
	if (typeof entry !== "object" || entry === null) return { ok: false, origin: "missing", reason: `fixtures/transcripts.json has no entry for ${paneId}` };
	const row = entry as Record<string, unknown>;
	const capturedAt = typeof row.capturedAt === "string" ? row.capturedAt : null;
	const note = typeof row.note === "string" ? row.note : null;
	if (Array.isArray(row.messages)) {
		return {
			ok: true,
			kind: "transcript",
			origin: `fixtures/transcripts.json → ${paneId}`,
			messages: messagesFromRows(row.messages, `fixtures/transcripts.json → ${paneId}`),
			capturedAt,
			note,
			dropped: null,
			borders: 0,
		};
	}
	if (typeof row.tail === "string") {
		const parsedTail = parseTail(row.tail, { source: `fixtures/transcripts.json (tail) → ${paneId}` });
		return {
			ok: true,
			kind: "tail",
			origin: `fixtures/transcripts.json (tail) → ${paneId}`,
			messages: parsedTail.messages,
			capturedAt,
			note,
			dropped: parsedTail.dropped,
			borders: parsedTail.borders,
		};
	}
	return { ok: false, origin: "error", reason: `fixtures/transcripts.json → ${paneId} has neither a messages array nor a tail string` };
}

export interface TranscriptResult {
	ok: boolean;
	source: "fixture" | "tail";
	kind?: "transcript" | "tail";
	origin: string | null;
	reason?: string;
	capturedAt?: string | null;
	note?: string | null;
	dropped?: ParsedTail["dropped"] | null;
	borders?: number;
	messages: Message[];
	page: Page | null;
	earlier?: { available: boolean; reason: string };
	lines: number | null;
}

/** The transcript for one pane, paged. The two branches are deliberately different
 *  calls: neither falls back to the other, so a live pane with no readable tail never
 *  quietly shows fixture text. */
export async function readTranscript(args: {
	paneId: string;
	turns: number;
	ctx: { fixtureDir: string | null; herdr: boolean; mode: string };
}): Promise<TranscriptResult> {
	const { paneId, turns } = args;
	if (args.ctx.mode === "fixture") {
		if (args.ctx.fixtureDir === null) return { ok: false, source: "fixture", origin: null, reason: "no fixture dir on this load", messages: [], page: null, lines: null };
		const found = readFixtureTranscript(args.ctx.fixtureDir, paneId);
		if (!found.ok) return { ok: false, source: "fixture", origin: found.origin, reason: found.reason, messages: [], page: null, lines: null };
		const page = pageMessages(found.messages, turns);
		return {
			ok: true,
			source: "fixture",
			kind: found.kind,
			origin: found.origin,
			capturedAt: found.capturedAt,
			note: found.note,
			dropped: found.dropped,
			borders: found.borders,
			messages: page.messages,
			page,
			earlier: {
				available: page.hasEarlier,
				reason: page.hasEarlier ? `this fixture holds ${page.total} ${page.unit}s; the page shows the last ${page.shown}` : `the whole fixture is on screen: ${page.total} ${page.unit}s`,
			},
			lines: null,
		};
	}

	const lines = linesForTurns(turns);
	const read = await tail({ paneId, lines, ctx: { ...args.ctx, mode: "live" } });
	if (read.lines === null) return { ok: false, source: "tail", origin: read.origin, reason: read.reason ?? "the pane tail could not be read", messages: [], page: null, lines: null };
	const parsed = parseTail(read.lines, { source: read.origin ?? "pane tail" });
	const page = pageMessages(parsed.messages, turns);
	return {
		ok: true,
		source: "tail",
		kind: "tail",
		origin: read.origin,
		capturedAt: read.ts,
		note: null,
		dropped: parsed.dropped,
		borders: parsed.borders,
		messages: page.messages,
		page,
		earlier: {
			available: lines < MAX_LINES,
			reason:
				lines < MAX_LINES
					? `read ${lines} lines of the pane; "load earlier" reads ${Math.min(MAX_LINES, lines * 2)} instead. The pane's own scrollback is the real ceiling`
					: `read the maximum ${MAX_LINES} lines; the pane keeps no more than its scrollback`,
		},
		lines,
	};
}

/** Every pane the transcript fixture covers, with what the rail needs: what kind of
 *  source it is, how many messages it holds and when its last message was. One file
 *  read for the whole rail — the alternative is a process per row. */
export function readFixtureTranscriptIndex(dir: string): Map<string, { origin: string; kind: string; count: number; lastTs: string | null }> | null {
	const path = join(dir, "transcripts.json");
	if (isMountPath(path)) return null;
	const file = readText(path);
	if (!file.exists) return null;
	let parsed: { panes?: Record<string, unknown> };
	try {
		parsed = JSON.parse(file.text) as { panes?: Record<string, unknown> };
	} catch {
		return null;
	}
	const index = new Map<string, { origin: string; kind: string; count: number; lastTs: string | null }>();
	for (const [paneId, raw] of Object.entries(parsed.panes ?? {})) {
		if (typeof raw !== "object" || raw === null) continue;
		const entry = raw as Record<string, unknown>;
		let messages: Message[] | null = null;
		let kind: string | null = null;
		if (Array.isArray(entry.messages)) {
			messages = messagesFromRows(entry.messages, `fixtures/transcripts.json → ${paneId}`);
			kind = "transcript";
		} else if (typeof entry.tail === "string") {
			messages = parseTail(entry.tail, { source: `fixtures/transcripts.json (tail) → ${paneId}` }).messages;
			kind = "tail";
		}
		if (messages === null || kind === null) continue;
		const stamps = messages.map((message) => (message.ts === null ? Number.NaN : Date.parse(message.ts))).filter((at) => Number.isFinite(at));
		index.set(paneId, {
			origin: kind === "transcript" ? `fixtures/transcripts.json → ${paneId}` : `fixtures/transcripts.json (tail) → ${paneId}`,
			kind,
			count: messages.length,
			lastTs: stamps.length === 0 ? (typeof entry.capturedAt === "string" ? entry.capturedAt : null) : new Date(Math.max(...stamps)).toISOString(),
		});
	}
	return index;
}

/** `fixtures/panes.json` — the same row shape the snapshot produces, so every
 *  downstream reader is identical in both modes. */
export function fixturePanesOf(path: string): PaneList {
	if (isMountPath(path)) return { origin: "error", panes: [], reason: `${path} is on a mounted drive; nothing is read from there` };
	const file = readText(path);
	if (!file.exists) return { origin: "missing", panes: [], reason: `no pane fixture at ${path}` };
	try {
		const parsed = JSON.parse(file.text) as unknown;
		const list = Array.isArray(parsed) ? parsed : (parsed as { agents?: unknown }).agents;
		if (!Array.isArray(list)) return { origin: "error", panes: [], reason: `${path}: no agents array` };
		const panes = list.map((raw) => toRow(raw)).filter((row): row is Row => row !== undefined);
		return { origin: "fixture", panes, reason: null };
	} catch (error) {
		return { origin: "error", panes: [], reason: `${path}: ${error instanceof Error ? error.message : "unparseable"}` };
	}
}

/** What the page says a tail is, in one sentence, wherever a tail is on screen. */
export const TAIL_CAVEAT =
	"this is the pane's rendered text, not a transcript: the tail carries no roles, no timestamps and no message boundaries, so the blocks below are segmented by one rule — a block starting with $ is a command that was run, everything else is prose. Read straight from `herdr agent read`.";
