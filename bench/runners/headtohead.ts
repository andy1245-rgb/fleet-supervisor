// Two supervisors, one evidence base, one event stream.
//
// Arm 1 is the decision model: stage 0 picks the moment, the model picks the word.
// Arm 2 is a bag of cheap anomaly detectors — per-task-type duration baselines from
// the corpus, repeated identical calls, an edit with no test run, a turn that ended
// on a question — which need no labels at all.
//
// They are scored here on the *same rows*, with the *same label definition*, from the
// *same* fit/holdout split, so the comparison is not a matter of taste. The label is
// the one every other measurement in this repository uses: did a human eventually
// have to say something after this turn (owed a word), or did nobody ever come back.
//
//   node bench/runners/headtohead.ts
//
// Reads only gitignored corpus (`mine/out/`), one committed record, and the observe
// log. Writes nothing.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { loadCorpus } from "../../mine/session-cache.ts";
import type { Message } from "../../mine/session-cli.ts";
import type { TimePoint } from "../../mine/time-sampled-points.ts";
import type { Op } from "../../src/decision/types.ts";

const ROOT = join(import.meta.dirname, "..", "..");
const POINTS = join(ROOT, "mine", "out", "points-time-sampled.jsonl");
const TRACES = join(ROOT, "bench", "results", "2026-11-15T09-52-19-800Z__needle3.traces.jsonl");
const OBSERVE = join(process.env.HOME ?? "", ".pi", "agent", "fleet-observe", "events.jsonl");

const pct = (part: number, whole: number): string => `${whole === 0 ? "0.0" : ((part / whole) * 100).toFixed(1)}%`;

function readJsonl<T>(path: string): T[] {
	return readFileSync(path, "utf8")
		.split("\n")
		.filter((line) => line.trim() !== "")
		.map((line) => JSON.parse(line) as T);
}

/** The session-hash split every other measurement here uses, so a row sits on the
 *  same side of every table. */
function inFit(sessionId: string): boolean {
	let hash = 2166136261;
	for (let i = 0; i < sessionId.length; i += 1) {
		hash ^= sessionId.charCodeAt(i);
		hash = Math.imul(hash, 16777619) >>> 0;
	}
	return hash % 2 === 0;
}

/** The label at the moment of decision. Same definition the idle rule, the residue
 *  and the closing record were all measured with. */
function content(point: TimePoint): "nudge" | "flag" | "leave" {
	if (point.nextLabel === "instruction" || point.nextLabel === "redirect" || point.nextLabel === "question" || point.nextLabel === "continue") return "nudge";
	if (point.nextLabel === "stop") return "flag";
	return "leave";
}

const TEST_OUTPUT = /\b(\d+ (passing|failing)|PASS|FAIL|Tests:|\d+ tests? (passed|failed))\b/;

/** A tool call's task type. A transcript records what a call *printed*, not what was
 *  typed, so a bash call is classified by the shape of its output — which is also
 *  what makes the baseline honest: it is a baseline over the evidence a supervisor
 *  can actually see, not over an argv the supervisor never gets. */
function bucketOf(message: Message): string {
	const tool = message.tool ?? "tool";
	if (tool === "bash" && TEST_OUTPUT.test(message.text)) return "bash/test";
	return tool;
}

interface Turn {
	calls: Message[];
	lastText: string;
}

/** Every completed turn, keyed by the seq of its last tool result — the same seq a
 *  mined decision point records for the turn it ended. */
function turnsOf(messages: readonly Message[]): Map<number, Turn> {
	const turns = new Map<number, Turn>();
	let calls: Message[] = [];
	let lastSeq: number | undefined;
	let lastText = "";
	for (const message of messages) {
		if (message.role === "toolResult") {
			calls.push(message);
			lastSeq = message.seq;
		} else if (message.role === "assistant") {
			if (message.text.trim()) lastText = message.text;
		} else if (message.role === "user") {
			if (calls.length > 0 && lastSeq !== undefined) turns.set(lastSeq, { calls, lastText });
			calls = [];
			lastText = "";
		}
	}
	if (calls.length > 0 && lastSeq !== undefined) turns.set(lastSeq, { calls, lastText });
	return turns;
}

function percentile(values: readonly number[], at: number): number {
	if (values.length === 0) return 0;
	const sorted = [...values].sort((a, b) => a - b);
	return sorted[Math.min(sorted.length - 1, Math.floor(at * sorted.length))]?.valueOf() ?? 0;
}

interface Detector {
	name: string;
	/** True when this turn carries evidence a supervisor should look at. */
	fires: (turn: Turn | undefined) => boolean;
}

function main(): void {
	const points = readJsonl<TimePoint>(POINTS);
	const corpus = loadCorpus({});

	// (sessionId, seq) → the turn that ended there.
	const turns = new Map<string, Turn>();
	for (const entry of corpus) {
		for (const [seq, turn] of turnsOf(entry.messages)) turns.set(`${entry.session.sessionId}:${seq}`, turn);
	}
	const turnOf = (point: TimePoint): Turn | undefined => turns.get(`${point.sessionId}:${point.seq}`);

	// Baselines from the fit half only, so every holdout number is a prediction.
	const durations = new Map<string, number[]>();
	for (const [key, turn] of turns) {
		const sessionId = key.slice(0, key.indexOf(":"));
		if (!inFit(sessionId)) continue;
		for (const call of turn.calls) {
			const bucket = bucketOf(call);
			const list = durations.get(bucket) ?? [];
			list.push(call.durMs ?? 0);
			durations.set(bucket, list);
		}
	}
	const base = new Map<string, { p95: number; p99: number }>();
	for (const [bucket, values] of durations) {
		// A p99 over a dozen calls is that dozen calls, not a baseline.
		if (values.length < 30) continue;
		base.set(bucket, { p95: percentile(values, 0.95), p99: percentile(values, 0.99) });
	}

	const detectors: Detector[] = [];
	for (const [mult, floor, label] of [
		[1, 60_000, "duration > max(p99, 60s)"],
		[1, 300_000, "duration > max(p99, 5min)"],
		[3, 60_000, "duration > 3 x p99"],
	] as const) {
		detectors.push({
			name: label,
			fires: (turn) => {
				if (!turn) return false;
				return turn.calls.some((call) => {
					const found = base.get(bucketOf(call));
					return found !== undefined && (call.durMs ?? 0) > Math.max(floor, found.p99 * mult);
				});
			},
		});
	}
	detectors.push({
		name: "repeat: 3 identical calls",
		fires: (turn) => {
			if (!turn) return false;
			const seen = new Map<string, number>();
			for (const call of turn.calls) {
				const key = `${call.tool ?? "?"}\u0000${call.text.slice(0, 80)}`;
				const next = (seen.get(key) ?? 0) + 1;
				if (next >= 3) return true;
				seen.set(key, next);
			}
			return false;
		},
	});
	detectors.push({
		name: "edit with no test run",
		fires: (turn) => {
			if (!turn) return false;
			const edited = turn.calls.some((call) => ["write", "edit", "edit2", "edit3"].includes(call.tool ?? ""));
			const tested = turn.calls.some((call) => bucketOf(call) === "bash/test");
			return edited && !tested;
		},
	});
	detectors.push({
		name: "turn ended on a question",
		fires: (turn) => (turn?.lastText ?? "").trimEnd().endsWith("?"),
	});

	const holdout = points.filter((point) => !inFit(point.sessionId));
	const owedRows = holdout.filter((point) => content(point) !== "leave");
	const notOwed = holdout.filter((point) => content(point) === "leave");

	console.log(`corpus      ${points.length} points · holdout ${holdout.length} (owed ${owedRows.length}, not owed ${notOwed.length})`);
	console.log(`baselines   ${base.size} task types with >= 30 calls in the fit half`);
	console.log("");
	console.log("arm 2 — anomalous evidence, no labels needed");
	console.log("  detector                          fired   share  precision   recall  FP rate");
	for (const detector of detectors) {
		const fired = holdout.filter((point) => detector.fires(turnOf(point)));
		const hit = fired.filter((point) => content(point) !== "leave").length;
		const miss = fired.length - hit;
		console.log(
			`  ${detector.name.padEnd(32)} ${String(fired.length).padStart(5)} ${pct(fired.length, holdout.length).padStart(7)} ${pct(hit, fired.length).padStart(9)} ${pct(hit, owedRows.length).padStart(8)} ${pct(miss, notOwed.length).padStart(8)}`,
		);
	}
	const union = holdout.filter((point) => detectors.slice(0, 5).some((detector) => detector.fires(turnOf(point))));
	const unionHit = union.filter((point) => content(point) !== "leave").length;
	console.log(
		`  ${"union of the five".padEnd(32)} ${String(union.length).padStart(5)} ${pct(union.length, holdout.length).padStart(7)} ${pct(unionHit, union.length).padStart(9)} ${pct(unionHit, owedRows.length).padStart(8)} ${pct(union.length - unionHit, notOwed.length).padStart(8)}`,
	);

	// Arm 1, on the residue those detectors hand it, scored straight off the record:
	// its own `expectedOp` is the same content label, so no join is needed. Two
	// questions are separated here because the arms answer different ones: whether it
	// was right to *speak* (comparable with arm 2) and whether it said the right
	// *word* (arm 1's own job, which arm 2 does not attempt).
	if (existsSync(TRACES)) {
		const traces = readJsonl<{ id: string; expectedOp: Op; refused: boolean; proposed?: { op: Op } }>(TRACES);
		const proposed = traces.filter((trace) => trace.proposed !== undefined);
		const spoke = proposed.filter((trace) => trace.proposed?.op !== "leave");
		const owed = traces.filter((trace) => trace.expectedOp !== "leave");
		const notOwedResidue = traces.length - owed.length;
		// Right to speak: it proposed a word on a row where a word was owed.
		const spokeOnOwed = spoke.filter((trace) => trace.expectedOp !== "leave").length;
		// Crying wolf: it proposed a word where nothing was owed.
		const spokeOnQuiet = spoke.length - spokeOnOwed;
		// Right word: among what it proposed, the op matched the expected one.
		const rightWord = proposed.filter((trace) => trace.proposed?.op === trace.expectedOp).length;
		console.log("");
		console.log(`arm 1 — the model on the residue (${traces.length} rows, stage 0 already fired on all of them)`);
		console.log(`  committed an op                  ${String(traces.filter((trace) => !trace.refused).length).padStart(5)} ${pct(traces.filter((trace) => !trace.refused).length, traces.length).padStart(7)}`);
		console.log(`  proposed a word (non-leave)      ${String(spoke.length).padStart(5)} ${pct(spoke.length, traces.length).padStart(7)} ${pct(spokeOnOwed, spoke.length).padStart(9)} ${pct(spokeOnOwed, owed.length).padStart(8)} ${pct(spokeOnQuiet, notOwedResidue).padStart(8)}`);
		console.log(`  right word when it spoke         ${String(rightWord).padStart(5)} of ${proposed.length} proposals (${pct(rightWord, proposed.length)})`);
	}

	if (existsSync(OBSERVE)) {
		const rows = readJsonl<{ kind?: string; schema?: number; refused?: boolean; op?: Op; costUsd?: number; outcomeKind?: string; speak?: boolean }>(OBSERVE);
		const decisions = rows.filter((row) => row.kind === "decision" && row.schema !== undefined);
		const outcomes = rows.filter((row) => row.kind === "outcome");
		const stage0 = rows.filter((row) => row.kind === "stage0");
		const cost = rows.filter((row) => row.kind === "tick").reduce((sum, row) => sum + (row.costUsd ?? 0), 0);
		console.log("");
		console.log("the live stream (the observation run, read-only)");
		console.log(`  ticks with stage-0 verdicts       ${String(rows.filter((row) => row.kind === "tick").length).padStart(5)}   speaking ${pct(stage0.filter((row) => row.speak === true).length, stage0.length)} of ${stage0.length} verdicts`);
		console.log(`  decisions                         ${String(decisions.length).padStart(5)}   refused ${pct(decisions.filter((row) => row.refused === true).length, decisions.length)}`);
		console.log(`  outcomes joined                   ${String(outcomes.length).padStart(5)}   ${JSON.stringify(outcomes.reduce<Record<string, number>>((acc, row) => ({ ...acc, [row.outcomeKind ?? "?"]: (acc[row.outcomeKind ?? "?"] ?? 0) + 1 }), {}))}`);
		console.log(`  total model spend                 $${cost.toFixed(6)}`);
	}

	console.log("");
	console.log("What each arm needs to be validated");
	console.log("  arm 2, offline: duration / repeat / edit-without-test are transcript facts — computed above.");
	console.log("  arm 2, live only: a pane waiting on an unanswered ask, and a process that vanished,");
	console.log("    are pane-state facts that exist only in a running fleet's observe rows.");
	console.log("  arm 2, blocked today: the observe log carries no tool timings, so the live stream");
	console.log("    cannot validate the duration detector — only a transcript can.");
	console.log("  arm 1: offline-scorable on the residue, but its decisive question (finished versus");
	console.log("    stuck) has no label in any transcript; that one needs the live stream's outcomes.");
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) main();
