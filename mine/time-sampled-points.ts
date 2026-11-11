// Time-sampled decision points: the miner that can produce `leave`.
//
// `mine/decision-points.ts` defines a decision point as *a completed agent turn
// that a human then answered*, and its own header states the consequence: `leave`
// and `declare_done` cannot be mined from it, because "nothing was owed" has no
// human message to bound it. That is a property of the definition, not of the data.
// Every transcript records when the agent stopped, so the class the supervisor most
// needs is observable as the *absence* of a human message over a window.
//
// So this miner takes every point where the agent finished a turn, whether or not a
// human replied, and labels it from what happened inside one decision window:
//
//   a human message inside the window   → continue | instruction | redirect | question | stop
//                                          (labelFor, imported from decision-points.ts,
//                                          so the vocabulary has one definition)
//   no human message inside the window   → leave
//   the window runs past the session end → censored, counted, and not a row
//
// THREE THINGS THIS DEFINITION DOES NOT MEASURE, stated here because a reader who
// assumes otherwise will read the leave rate as fleet behaviour:
//
//   1. It samples turn ends, not supervisor ticks. A live supervisor ticks on a
//      timer and mostly sees panes that have not moved; the leave rate here is the
//      share of *completed turns* after which nothing came back, which is a
//      different denominator. It is the closest thing a transcript can answer.
//   2. `idleTicks` is 0 on every row and `status` is `idle` on every row. Those
//      fields could carry the window, and the label is decided by the window, so
//      filling them would hand the model the answer. The window is the sampling
//      rule, not an observation the supervisor would have.
//   3. The window decides the label mechanically, so part of what a model must
//      learn here is the operator's session rhythm rather than supervision need.
//      The constant baselines are the floor that rhythm sets, and they are scored
//      before any model.
//
// The corpus is read through the session-insights CLI (mine/session-cli.ts) and
// cached under mine/out/cli-cache/, so a change to label logic does not pay the
// fetch again. The rows land in mine/out/points-time-sampled.jsonl and the task set
// in bench/tasks/tasks-time-sampled.jsonl; both paths are gitignored, because they
// carry session text.

import { mkdirSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { createHash } from "node:crypto";
import { labelFor } from "./decision-points.ts";
import { credentialHits } from "../src/corpus/credentials.ts";
import { DEFAULT_ROOT, loadCorpus, type Session } from "./session-cache.ts";
import type { Root } from "./session-cli.ts";
import { toTask, type Task } from "../bench/tasks/from-captures.ts";
import type { ToolCallSummary } from "./decision-points.ts";
import { LABEL_TO_OP, type Label } from "../src/labeling/label-to-op.ts";
import type { Op } from "../src/decision/types.ts";

const HERE = import.meta.dirname;
const POINTS_PATH = join(HERE, "out", "points-time-sampled.jsonl");
// The task set stays under `mine/out` too. It is the same rows as the points file
// with the fields `bench/tasks/from-captures.ts` reads, and docs/CORPUS-POLICY.md is
// unambiguous about where mined text may be written: an ignored path, never a tracked
// one. `bench/tasks` holds the frozen snapshot the bench runner writes when a record
// needs a citable sha; that is the runner's own file, not this miner's.
const TASKS_PATH = join(HERE, "out", "tasks-time-sampled.jsonl");

/** The fleet's own tick interval (`AGENTFLEET_INTERVAL_MS`, default 60 000). The
 *  window is the horizon a supervisor actually decides over: it looks at a pane,
 *  acts or not, and looks again one tick later. A human who spoke inside that tick
 *  was not waiting on a nudge. */
const DEFAULT_WINDOW_MS = 60_000;

const CLIP_CHARS = 2000;
const SUMMARY_CHARS = 200;

/** The same two prefixes `decision-points.ts:isHumanMessage` rejects, restated
 *  rather than imported: that file's corpus has to stay reproducible, so this
 *  miner does not add exports to it. A harness notification or a skill injection
 *  is not a human answering, and treating one as a label would put machine text in
 *  the human's mouth. */
const SYNTHETIC_PREFIXES: readonly string[] = ["[SYSTEM NOTIFICATION", "<skill "];
const INVISIBLE_PATTERN = /[\u200b\u200c\u200d\u200e\u200f\u2060\ufeff]/g;

/** Windows reported by `--sweep`, in the order the doc table reads them. */
const SWEEP_MS: readonly number[] = [15_000, 30_000, 60_000, 120_000, 300_000, 600_000, 1_800_000];

export interface TimePoint {
	// The capture shape `bench/tasks/from-captures.ts:toTask` consumes.
	sessionId: string;
	sessionPath: string;
	cwd: string;
	timestamp: string;
	assistantText: string;
	toolCalls: ToolCallSummary[];
	toolErrors: number;
	humanText: string;
	label: Label | null;
	labelReason: string;
	// Provenance of the sampling decision.
	seq: number;
	fromSeq: number;
	windowMs: number;
	/** Milliseconds from the turn's last message to the next human message.
	 *  `null` when no human message follows in the session. */
	gapMs: number | null;
	/** The label the human's next message carries, or `null` if they never spoke.
	 *  Kept beside `label` so a window sweep re-derives without a second scan. */
	nextLabel: Label | null;
	censored: boolean;
	midCall: boolean;
	root: string;
	terminalStopReason: string | null;
}

interface Turn {
	texts: string[];
	calls: ToolCallSummary[];
	toolErrors: number;
	timestamp: string;
	seq: number;
	/** The seq this turn started at: the first assistant or tool message after the
	 *  last human one. A consumer that needs the turn's whole shape — the stage-0
	 *  measurement needs each tool call's duration — can slice the transcript without
	 *  re-deriving the boundary. */
	fromSeq: number;
	lastRole: string;
}

function clip(text: string, max: number): string {
	return text.length <= max ? text : text.slice(0, max);
}

function isHumanText(text: string): boolean {
	const trimmed = text.trim();
	if (!trimmed) return false;
	if (!trimmed.replace(INVISIBLE_PATTERN, "").trim()) return false;
	for (const prefix of SYNTHETIC_PREFIXES) {
		if (trimmed.startsWith(prefix)) return false;
	}
	return true;
}

/** The first non-empty line of a tool result, which is what the index carries in
 *  place of the call's arguments. The CLI's index mode surfaces `tool` + the
 *  result's head; the arguments live in the JSONL, and `evidence` returns 20 of the
 *  148,212 calls, so a per-session read of them is not on the table. Reading the
 *  result instead of the request is a real difference from the message-bounded
 *  corpus and is stated in the docs rather than papered over. */
function firstLine(text: string): string {
	for (const line of text.split("\n")) {
		const trimmed = line.trim();
		if (trimmed) return clip(trimmed, SUMMARY_CHARS);
	}
	return "";
}

function startTurn(seq: number, timestamp: string, role: string): Turn {
	return { texts: [], calls: [], toolErrors: 0, timestamp, seq, fromSeq: seq, lastRole: role };
}

/** `derive` is the whole labelling rule: one function, so the sweep and the written
 *  row cannot disagree about what a window means. */
function derive(gapMs: number | null, nextLabel: Label | null, windowMs: number): { label: Label | null; reason: string; censored: boolean } {
	if (nextLabel === null) return { label: null, reason: "the session ended with no human message to answer into", censored: true };
	if (gapMs !== null && gapMs <= windowMs) {
		return { label: nextLabel, reason: `the human's next message arrived ${Math.round((gapMs ?? 0) / 1000)}s later`, censored: false };
	}
	const seconds = Math.round((gapMs ?? 0) / 1000);
	return { label: "quiet", reason: `no human message for ${seconds}s, past the ${Math.round(windowMs / 1000)}s window`, censored: false };
}

export interface ScanCounters {
	skippedSynthetic: number;
	skippedUnlabelled: number;
	skippedEmptyTurn: number;
	skippedMidCall: number;
	censored: number;
}

export interface ScanReport extends ScanCounters {
	points: TimePoint[];
	sessions: number;
	turns: number;
	/** Sessions dropped at mine time because their text carried a credential shape.
	 *  Excluded, not sanitised: docs/CORPUS-POLICY.md. Reportable as a count and as
	 *  the shape that fired — never as the text, and never as the session id. */
	excludedSessions: number;
	excludedPoints: number;
	excludedByShape: Map<string, number>;
}

/** The exclusion decision, as a pure function so it can be tested and so `main`
 *  cannot decide it differently: a session whose own text carries a credential shape
 *  is dropped whole, not edited. Returns shape names only, never the matched text and
 *  never the session id — the count is publishable, the content is not. */
export function sessionExclusion(shown: Session): string[] {
	return credentialHits(shown.messages.map((message) => message.text).join("\n")).map((hit) => hit.name);
}

/** One session → its time-sampled points. */
export function scanSession(shown: Session, windowMs: number): { points: TimePoint[]; counters: ScanCounters } {
	const { session, messages } = shown;
	const points: TimePoint[] = [];
	let skippedSynthetic = 0;
	let skippedUnlabelled = 0;
	let skippedEmptyTurn = 0;
	let skippedMidCall = 0;
	let censored = 0;

	const emit = (turn: Turn, gapMs: number | null, nextLabel: Label | null, humanText: string, midCall: boolean): void => {
		if (!turn.texts.length && turn.calls.length === 0) {
			skippedEmptyTurn += 1;
			return;
		}
		if (midCall) {
			// The agent was waiting on a tool result when the session stopped. That is
			// a dead pane, not a quiet one, and no reply is missing because nothing was
			// asked: it is neither a `leave` nor a censored observation.
			skippedMidCall += 1;
			return;
		}
		const { label, reason, censored: cut } = derive(gapMs, nextLabel, windowMs);
		if (cut) censored += 1;
		points.push({
			sessionId: session.sessionId,
			sessionPath: session.path,
			cwd: session.cwd,
			timestamp: turn.timestamp,
			assistantText: clip(turn.texts.join("\n\n"), CLIP_CHARS),
			toolCalls: turn.calls,
			toolErrors: turn.toolErrors,
			humanText: clip(humanText, CLIP_CHARS),
			label,
			labelReason: reason,
			seq: turn.seq,
			fromSeq: turn.fromSeq,
			windowMs,
			gapMs,
			nextLabel,
			censored: cut,
			midCall,
			root: session.root,
			terminalStopReason: session.terminalStopReason,
		});
	};

	let turn: Turn | undefined;
	let previous: Turn | undefined;

	for (const message of messages) {
		switch (message.role) {
			case "assistant": {
				if (!turn) turn = startTurn(message.seq, message.ts, "assistant");
				if (message.text.trim()) turn.texts.push(message.text);
				turn.timestamp = message.ts;
				turn.seq = message.seq;
				turn.lastRole = "assistant";
				break;
			}
			case "toolResult": {
				if (!turn) turn = startTurn(message.seq, message.ts, "toolResult");
				turn.calls.push({ name: message.tool ?? "unknown", summary: firstLine(message.text) });
				if (message.isError) turn.toolErrors += 1;
				turn.timestamp = message.ts;
				turn.seq = message.seq;
				turn.lastRole = "toolResult";
				break;
			}
			case "user": {
				if (!isHumanText(message.text)) {
					skippedSynthetic += 1;
					break;
				}
				if (!turn) break;
				const labelled = labelFor(message.text);
				const gapMs = Date.parse(message.ts) - Date.parse(turn.timestamp);
				emit(turn, Number.isFinite(gapMs) ? Math.max(0, gapMs) : null, labelled?.label ?? null, message.text, false);
				if (!labelled) skippedUnlabelled += 1;
				previous = turn;
				turn = undefined;
				break;
			}
			default:
				break;
		}
	}

	// The last turn has no human message after it. Whether that is a censored
	// observation or a dead pane turns on what the last record was: an assistant
	// message is a turn that finished, a tool result is an agent still waiting.
	if (turn) {
		const midCall = turn.lastRole === "toolResult";
		emit(turn, null, null, "", midCall);
	}
	void previous;

	return {
		points,
		counters: { skippedSynthetic, skippedUnlabelled, skippedEmptyTurn, skippedMidCall, censored },
	};
}

/** Writes the file and returns the sha of **the bytes it wrote**. The bench cites a
 *  task set by hashing the file (`bench/runners/run.ts:loadTasks`), so a miner that
 *  hashed its rows instead of its output printed a sha no record could ever match. */
function writeJsonl(path: string, rows: readonly unknown[]): string {
	mkdirSync(join(path, ".."), { recursive: true });
	const body = rows.length === 0 ? "" : `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`;
	writeFileSync(path, body);
	return createHash("sha256").update(body).digest("hex").slice(0, 16);
}

function countLabels(points: readonly TimePoint[]): Map<Label | "censored", number> {
	const counts = new Map<Label | "censored", number>();
	for (const label of Object.keys(LABEL_TO_OP) as Label[]) counts.set(label, 0);
	counts.set("censored", 0);
	for (const point of points) {
		const key = point.censored ? "censored" : (point.label ?? "censored");
		counts.set(key, (counts.get(key) ?? 0) + 1);
	}
	return counts;
}

function countOps(points: readonly TimePoint[]): Map<Op, number> {
	const counts = new Map<Op, number>([["leave", 0], ["nudge", 0], ["declare_done", 0], ["flag", 0]]);
	for (const point of points) {
		if (point.label === null) continue;
		const op = LABEL_TO_OP[point.label];
		counts.set(op, (counts.get(op) ?? 0) + 1);
	}
	return counts;
}

const pct = (part: number, whole: number): string => `${whole === 0 ? "0.0" : ((part / whole) * 100).toFixed(1)}%`;

function sweep(points: readonly TimePoint[], windows: readonly number[]): void {
	const scored = points.filter((point) => !point.censored);
	console.log("");
	console.log("window sweep — label distribution by decision window (censored rows excluded)");
	console.log("  window   rows     leave    nudge    other-human  censored");
	for (const windowMs of windows) {
		let leave = 0;
		let nudge = 0;
		let other = 0;
		let censored = 0;
		for (const point of points) {
			const { label, censored: cut } = derive(point.gapMs, point.nextLabel, windowMs);
			if (cut) {
				censored += 1;
				continue;
			}
			if (label === "quiet") leave += 1;
			else if (label === null) continue;
			else if (LABEL_TO_OP[label] === "nudge") nudge += 1;
			else other += 1;
		}
		const rows = leave + nudge + other;
		console.log(
			`  ${String(windowMs / 1000).padStart(5)}s  ${String(rows).padStart(6)}  ` +
				`${pct(leave, rows).padStart(6)}  ${pct(nudge, rows).padStart(6)}  ${pct(other, rows).padStart(10)}  ` +
				`${String(censored).padStart(8)}`,
		);
	}
	void scored;
}

/** Reply-latency distribution: the measurement that decides the window. Every gap
 *  here is turn-end → next human message, so the quantiles are the answer to "how
 *  long does this operator take to answer a stopped agent". */
function latencyReport(points: readonly TimePoint[]): void {
	const gaps = points.map((point) => point.gapMs).filter((gap): gap is number => gap !== null).sort((a, b) => a - b);
	if (gaps.length === 0) return;
	const at = (q: number): number => gaps[Math.min(gaps.length - 1, Math.floor(q * gaps.length))] ?? 0;
	const bands: Array<[string, number]> = [["<=15s", 15_000], ["<=30s", 30_000], ["<=60s", 60_000], ["<=2m", 120_000], ["<=5m", 300_000], ["<=10m", 600_000], ["<=1h", 3_600_000]];
	console.log("");
	console.log(`reply latency (turn end → next human message), n = ${gaps.length} with a reply`);
	console.log(
		`  p10 ${(at(0.1) / 1000).toFixed(1)}s  p25 ${(at(0.25) / 1000).toFixed(1)}s  p50 ${(at(0.5) / 1000).toFixed(1)}s  ` +
			`p75 ${(at(0.75) / 1000).toFixed(1)}s  p90 ${(at(0.9) / 1000).toFixed(1)}s  p99 ${(at(0.99) / 1000).toFixed(1)}s`,
	);
	for (const [name, bound] of bands) {
		const n = gaps.filter((gap) => gap <= bound).length;
		console.log(`  ${name.padStart(6)} ${pct(n, gaps.length).padStart(6)}`);
	}
}

function main(argv: readonly string[]): void {
	const windowArg = argv.find((arg) => arg.startsWith("--window-ms="));
	const windowMs = windowArg ? Number(windowArg.split("=")[1]) : DEFAULT_WINDOW_MS;
	if (!Number.isFinite(windowMs) || windowMs <= 0) throw new Error("--window-ms must be a positive number of milliseconds");
	const limitArg = argv.find((arg) => arg.startsWith("--limit-sessions="));
	const limit = limitArg ? Number(limitArg.split("=")[1]) : 0;
	const refresh = argv.includes("--refresh");
	const rootArg = argv.find((arg) => arg.startsWith("--root="));
	const root = (rootArg?.split("=")[1] ?? DEFAULT_ROOT) as Root;

	const sessions = loadCorpus({ refresh, limit, root });
	const report: ScanReport = {
		points: [],
		sessions: sessions.length,
		turns: 0,
		skippedSynthetic: 0,
		skippedUnlabelled: 0,
		skippedEmptyTurn: 0,
		skippedMidCall: 0,
		censored: 0,
		excludedSessions: 0,
		excludedPoints: 0,
		excludedByShape: new Map<string, number>(),
	};
	for (const shown of sessions) {
		const scan = scanSession(shown, windowMs);
		// The exclusion runs over the session's whole text, not the rows that survive
		// sampling: a secret in a tool result the tail clipped off is still in the
		// session, and the policy excludes the session rather than editing it.
		const excluded = sessionExclusion(shown);
		if (excluded.length > 0) {
			report.excludedSessions += 1;
			report.excludedPoints += scan.points.length;
			for (const name of excluded) report.excludedByShape.set(name, (report.excludedByShape.get(name) ?? 0) + 1);
			continue;
		}
		report.points.push(...scan.points);
		report.turns += scan.points.length + scan.counters.skippedEmptyTurn + scan.counters.skippedMidCall;
		report.skippedSynthetic += scan.counters.skippedSynthetic;
		report.skippedUnlabelled += scan.counters.skippedUnlabelled;
		report.skippedEmptyTurn += scan.counters.skippedEmptyTurn;
		report.skippedMidCall += scan.counters.skippedMidCall;
		report.censored += scan.counters.censored;
	}

	const pointsSha = writeJsonl(POINTS_PATH, report.points);
	const scorable = report.points.filter((point): point is TimePoint & { label: Label } => point.label !== null);
	const tasks: Task[] = scorable.map((point, index) => toTask(point, index));
	const tasksSha = writeJsonl(TASKS_PATH, tasks);

	const labels = countLabels(report.points);
	const ops = countOps(report.points);
	const rows = scorable.length;

	console.log(`sessions scanned: ${report.sessions}  (root ${root})`);
	console.log(`turns ending cleanly: ${report.turns}`);
	console.log(`points written:   ${report.points.length}  (${rows} scorable, ${report.censored} censored)`);
	console.log(`window:           ${windowMs} ms`);
	for (const [label, n] of labels) console.log(`  ${label.padEnd(12)} ${String(n).padStart(7)}  ${pct(n, report.points.length).padStart(6)}`);
	console.log(`ops (scorable rows only):`);
	for (const [op, n] of ops) console.log(`  ${op.padEnd(12)} ${String(n).padStart(7)}  ${pct(n, rows).padStart(6)}`);
	if (report.excludedSessions > 0) {
		const shapes = [...report.excludedByShape].map(([name, n]) => `${name} ${n}`).join(", ");
		console.log(`excluded: ${report.excludedSessions} sessions (${report.excludedPoints} points) carried a credential shape — ${shapes}`);
	}
	console.log(`skipped: ${report.skippedSynthetic} synthetic user messages, ${report.skippedUnlabelled} unlabelled human messages, ${report.skippedEmptyTurn} empty turns, ${report.skippedMidCall} turns that ended mid-tool-call`);
	console.log(`wrote ${POINTS_PATH}  sha ${pointsSha}`);
	console.log(`wrote ${TASKS_PATH}  sha ${tasksSha}  (${tasks.length} tasks)`);

	latencyReport(report.points);
	if (argv.includes("--sweep")) sweep(report.points, SWEEP_MS);
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) main(process.argv.slice(2));
