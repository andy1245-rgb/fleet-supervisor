// Stage 0 measured against the mined corpus — the baseline the model has to beat,
// and the residue the model is then tested on.
//
// The architecture is: rules decide silence, the model is consulted only on what
// survives them. That raises two questions no record in this repository answered,
// and this runner answers both from the mined corpus rather than from opinion:
//
//   1. How good are the rules alone? Precision and recall of "a word was owed",
//      against the corpus's own labels, with no model in the loop.
//   2. What is left for the model, and what does the best constant score on it?
//
// **The translation this runner makes, stated because it is not obvious and it
// bounds every number below.** A rule watches a *process*: its class, its age, and
// whether a second sample showed progress. A transcript records a *tool call*: the
// tool's name, its duration, and its result. So:
//
//   process age      ←  the tool call's `dur_ms`
//   the command line ←  the tool name and the first line of the result. The argv is
//                       not in a transcript; the result is. A build is therefore
//                       recognised by what it printed, not by what was typed.
//   the process tree ←  `["pi"]`, because every tool call the miner kept belongs to
//                       an agent's turn by construction.
//   CPU progress     ←  not available. So `stalled` is unknown here and the verdict
//                       falls back to age alone, which is what the per-tick scan does
//                       too. The live watchdog's second sample is strictly better
//                       evidence than this, and nothing below can see it.
//
// Five of the seven rules — `inference-server`, `idle-shell`, `background-service`,
// `infrastructure`, `agent-tui` — are suppression rules over the process table. A
// transcript cannot evaluate any of them, so they are applied to the synthetic
// sample exactly as the live table would apply them, which means they can only ever
// *reduce* a firing. The firing rate below is therefore an upper bound on what the
// live rules would do, and the measured precision a lower bound.
//
// Everything this writes goes to `mine/out/` (docs/CORPUS-POLICY.md): the residue
// task set carries session text and never leaves the machine.
//
//   node bench/runners/stage0.ts [--window=60000]

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { toTask } from "../tasks/from-captures.ts";
import { classify, RULES, type CommandSample } from "../../src/watchdog/rules.ts";
import { IDLE_RULE, IDLE_TICKS, IDLE_WHY } from "../../src/watchdog/needs-a-word.ts";
import { RESIDUE_LABEL_TO_OP, type Label } from "../../src/labeling/label-to-op.ts";
import { score, type Task } from "./run.ts";
import { loadCorpus } from "../../mine/session-cache.ts";
import type { TimePoint } from "../../mine/time-sampled-points.ts";
import type { Op } from "../../src/decision/types.ts";

const ROOT = join(import.meta.dirname, "..");
const POINTS_PATH = join(ROOT, "..", "mine", "out", "points-time-sampled.jsonl");
const TASKS_PATH = join(ROOT, "..", "mine", "out", "tasks-time-sampled.jsonl");
const RESIDUE_PATH = join(ROOT, "..", "mine", "out", "tasks-residue.jsonl");

const OPS: readonly Op[] = ["leave", "nudge", "declare_done", "flag"];
const pct = (part: number, whole: number): string => `${whole === 0 ? "0.0" : ((part / whole) * 100).toFixed(1)}%`;

function readJsonl<T>(path: string): T[] {
	return readFileSync(path, "utf8")
		.split("\n")
		.filter((line) => line.trim() !== "")
		.map((line) => JSON.parse(line) as T);
}

function sha(body: string): string {
	return createHash("sha256").update(body).digest("hex").slice(0, 16);
}

/** One tool call as the rules would have seen it while it ran. */
function sampleOfCall(tool: string, durationMs: number, resultText: string): CommandSample {
	const firstLine = resultText.split("\n").map((line) => line.trim()).find((line) => line !== "") ?? "";
	return {
		pid: 0,
		ppid: 1,
		cpuMs: 0,
		elapsedMs: durationMs,
		// The tool name and what it printed. `isCommand` needs an agent ancestor and
		// `isBareShell` needs a single token, so the tool name alone would classify as
		// an idle shell and never fire — the result text is what makes this a command.
		command: `${tool} ${firstLine}`.slice(0, 200),
		ancestors: ["pi"],
		foreground: false,
	};
}

interface TurnFiring {
	point: TimePoint;
	/** Rule ids that fired at any instant inside this turn, in first-seen order. */
	rules: string[];
	/** The longest call that fired, for the report's shape. */
	worstMs: number;
}

/** The idle-turn rule, measured the way the brief asked: N derived from the
 *  distribution on one half of the sessions, everything else reported on the other.
 *
 *  Two label definitions appear below and they are not interchangeable, which is the
 *  whole point of this measurement:
 *
 *    * **pass 1's label** — "did a human speak inside the 60 s window after the turn
 *      ended". The idle rule fires only on turns whose window expired with nobody
 *      speaking, so scored this way the rule is 0 % precise and 0 % recall *by
 *      construction*: its evidence is the complement of the label's, one tick later.
 *      It is printed because the brief asked for the same definitions, and because a
 *      reader deserves to see the tautology rather than be told about it.
 *    * **the label at the firing instant** — the rule fires at T0 + N ticks, and the
 *      question there is "was this pane actually blocked?". The corpus answers with
 *      content rather than timing: the human's eventual message. An intervention
 *      (`instruction`/`redirect`/`question`/`continue`) means the pane was blocked and
 *      a supervisor speaking at N would have anticipated them; a `stop` means a human
 *      was needed to end it; no message at all means nobody ever came back, which is
 *      the pane finishing rather than being stuck. Timing selects, content judges — so
 *      this is the one that can measure the rule.
 */
function idleReport(points: readonly TimePoint[], processFired: ReadonlySet<string>, tickMs: number): void {
	// Split by a hash of the session id rather than a shuffle: deterministic without a
	// seed, independent of file order, and stable if the corpus grows.
	const inFit = (sessionId: string): boolean => {
		let hash = 2166136261;
		for (let i = 0; i < sessionId.length; i += 1) {
			hash ^= sessionId.charCodeAt(i);
			hash = Math.imul(hash, 16777619) >>> 0;
		}
		return hash % 2 === 0;
	};
	const fit = points.filter((point) => inFit(point.sessionId));
	const hold = points.filter((point) => !inFit(point.sessionId));
	const key = (point: TimePoint): string => point.sessionId + ":" + point.seq;

	const content = (point: TimePoint): "nudge" | "flag" | "leave" => {
		if (point.nextLabel === "instruction" || point.nextLabel === "redirect" || point.nextLabel === "question" || point.nextLabel === "continue") return "nudge";
		if (point.nextLabel === "stop") return "flag";
		return "leave";
	};
	const fired = (rows: readonly TimePoint[], n: number): TimePoint[] => rows.filter((point) => point.gapMs === null || point.gapMs > n * tickMs);

	// N, from the fit half only, and without looking at a single label.
	const replies = fit
		.map((point) => point.gapMs)
		.filter((gap): gap is number => gap !== null)
		.sort((a, b) => a - b);
	const at = (q: number): number => replies[Math.min(replies.length - 1, Math.floor(q * replies.length))] ?? 0;
	const derived = Math.max(1, Math.ceil(at(0.5) / tickMs));

	console.log("");
	console.log("=== the idle-turn rule ===");
	console.log(`fit half     ${fit.length} points, ${replies.length} with a reply`);
	console.log(
		`reply latency (fit half only): p25 ${(at(0.25) / 60_000).toFixed(2)}  p50 ${(at(0.5) / 60_000).toFixed(2)}  p75 ${(at(0.75) / 60_000).toFixed(2)}  p90 ${(at(0.9) / 60_000).toFixed(2)} min`,
	);
	console.log(`N            ${derived} ticks (${(derived * tickMs) / 60_000} min) — the first whole tick past the median reply, where a reply has stopped being the likely next event`);
	console.log(`the built rule is ${IDLE_TICKS} ticks: ${IDLE_TICKS === derived ? "the same" : "DIFFERENT — the constant needs updating"}`);
	console.log(`rule         ${IDLE_RULE}: ${IDLE_WHY}`);

	for (const [name, rows] of [
		["fit", fit],
		["held out", hold],
	] as const) {
		const fire = fired(rows, derived);
		const labels = fire.map(content);
		const owedAll = rows.map(content).filter((label) => label !== "leave").length;
		const owedFired = labels.filter((label) => label !== "leave").length;
		console.log("");
		console.log(`${name} — ${rows.length} points`);
		console.log(`  fire rate   ${pct(fire.length, rows.length)}  (${fire.length}/${rows.length})`);
		console.log(`  label mix   nudge ${labels.filter((l) => l === "nudge").length}  flag ${labels.filter((l) => l === "flag").length}  leave ${labels.filter((l) => l === "leave").length}`);
		console.log(`  precision   ${pct(owedFired, fire.length)}  (${owedFired}/${fire.length}) — was the pane actually blocked?`);
		console.log(`  coverage    ${pct(owedFired, owedAll)}  (${owedFired}/${owedAll}) — of every turn that owed a word, how many the rule sees`);
		const p1Owed = rows.filter((point) => point.label !== null && point.label !== "quiet").length;
		const p1Hit = fire.filter((point) => point.label !== null && point.label !== "quiet").length;
		console.log(`  pass-1 def  precision ${pct(p1Hit, fire.length)}  coverage ${pct(p1Hit, p1Owed)} — and it can only be 0: the label's window expired on every row this rule fires on`);
	}

	// The residue the union leaves: a running command, or a pane that stopped.
	const union = points.filter((point) => processFired.has(key(point)) || point.gapMs === null || point.gapMs > derived * tickMs);
	const unionLabels = union.map(content);
	const unionOwed = unionLabels.filter((label) => label !== "leave").length;
	console.log("");
	console.log("=== the residue, stage 0 as a whole (process rules ∪ idle rule) ===");
	console.log(`  size        ${union.length} of ${points.length} points (${pct(union.length, points.length)})`);
	console.log(
		`  balance     nudge ${unionLabels.filter((l) => l === "nudge").length}  flag ${unionLabels.filter((l) => l === "flag").length}  leave ${unionLabels.filter((l) => l === "leave").length}`,
	);
	console.log(
		`  precision   ${pct(unionOwed, union.length)} — the residue is ${unionOwed > union.length - unionOwed ? "mostly word-owed, so the rules select what the model should see" : "mostly leave, so they select badly"}`,
	);
	console.log("  not written as a task set: the content label above is not a label-to-op mapping, and inventing a third one to score models on would be a different job");
}

function main(): void {
	const windowArg = process.argv.find((arg) => arg.startsWith("--window="));
	const windowMs = windowArg ? Number(windowArg.split("=")[1]) : 60_000;

	const points = readJsonl<TimePoint>(POINTS_PATH);
	const tasks = readJsonl<Task>(TASKS_PATH);
	// The task set is the scorable points, in order: `mine/time-sampled-points.ts`
	// writes both from one pass and filters the same way for both.
	const scorable = points.filter((point) => point.label !== null);
	if (scorable.length !== tasks.length) {
		throw new Error(`points and tasks disagree: ${scorable.length} scorable points vs ${tasks.length} tasks — re-run the miner`);
	}

	const corpus = new Map(loadCorpus({}).map((entry) => [entry.session.sessionId, entry.messages]));

	const firings: TurnFiring[] = [];
	for (const point of points) {
		const messages = corpus.get(point.sessionId);
		if (!messages) continue;
		const turn = messages.filter((message) => message.seq >= point.fromSeq && message.seq <= point.seq);
		const rules: string[] = [];
		let worstMs = 0;
		for (const message of turn) {
			if (message.role !== "toolResult") continue;
			const duration = message.durMs ?? 0;
			if (duration <= 0) continue;
			const verdict = classify(sampleOfCall(message.tool ?? "tool", duration, message.text));
			if (!verdict.flagged) continue;
			if (!rules.includes(verdict.rule)) rules.push(verdict.rule);
			worstMs = Math.max(worstMs, duration);
		}
		if (rules.length > 0) firings.push({ point, rules, worstMs });
	}

	const byId = new Map(firings.map((firing) => [firing.point.sessionId + ":" + firing.point.seq, firing]));
	if (process.argv.includes("--idle")) idleReport(points, new Set(byId.keys()), windowMs);
	const firedScorable = scorable.filter((point) => byId.has(point.sessionId + ":" + point.seq));
	const firedKeys = new Set(firings.map((firing) => firing.point.sessionId + ":" + firing.point.seq));

	// The label × firing cross-tab, over the scorable rows.
	const owed = (label: Label): boolean => RESIDUE_LABEL_TO_OP[label] !== "leave";
	const cross = new Map<string, { fired: number; silent: number }>();
	for (const point of scorable) {
		const label = point.label as Label;
		const entry = cross.get(label) ?? { fired: 0, silent: 0 };
		if (byId.has(point.sessionId + ":" + point.seq)) entry.fired += 1;
		else entry.silent += 1;
		cross.set(label, entry);
	}

	const firedOwed = firedScorable.filter((point) => owed(point.label as Label)).length;
	const allOwed = scorable.filter((point) => owed(point.label as Label)).length;

	console.log(`corpus       ${points.length} points, ${scorable.length} scorable (window ${windowMs} ms)`);
	console.log(`rule firings ${firings.length} turns contained a call past its rule's allowance`);
	console.log("");
	console.log("rule            turns fired");
	const ruleCounts = new Map<string, number>();
	for (const firing of firings) for (const rule of firing.rules) ruleCounts.set(rule, (ruleCounts.get(rule) ?? 0) + 1);
	for (const [rule, n] of [...ruleCounts].sort((a, b) => b[1] - a[1])) {
		const sentence = RULES.find((entry) => entry.id === rule)?.why ?? "";
		console.log(`  ${rule.padEnd(14)} ${String(n).padStart(4)}   ${sentence}`);
	}
	console.log("");
	console.log("label × stage 0 (scorable rows)");
	console.log("  label        fired  silent   fired share");
	for (const [label, entry] of [...cross].sort((a, b) => b[1].fired + b[1].silent - (a[1].fired + a[1].silent))) {
		const total = entry.fired + entry.silent;
		console.log(`  ${label.padEnd(12)} ${String(entry.fired).padStart(5)} ${String(entry.silent).padStart(7)}   ${pct(entry.fired, total).padStart(6)}`);
	}
	console.log("");
	console.log(`a word was owed on ${allOwed} of ${scorable.length} scorable rows under the residue mapping`);
	console.log(`  precision  P(word owed | stage 0 fired) = ${pct(firedOwed, firedScorable.length)}  (${firedOwed}/${firedScorable.length})`);
	console.log(`  recall     P(stage 0 fired | word owed) = ${pct(firedOwed, allOwed)}  (${firedOwed}/${allOwed})`);
	if (firedScorable.length > 0) {
		const longest = firings.reduce((max, firing) => Math.max(max, firing.worstMs), 0);
		console.log(`  the longest call any of them fired on: ${(longest / 60_000).toFixed(1)} min`);
	}

	// The residue: the fired rows, relabelled with the residue mapping, as a task set
	// the ordinary bench runners can score. Written under mine/out for the corpus
	// policy's sake; the bench runner freezes its own snapshot for the sha.
	const residue: Task[] = [];
	for (const [index, task] of tasks.entries()) {
		const point = scorable[index];
		if (point === undefined) continue;
		if (!byId.has(point.sessionId + ":" + point.seq)) continue;
		const relabelled: Task = { ...toTask(point as TimePoint & { label: Label }, residue.length), id: task.id, input: task.input, humanText: task.humanText };
		relabelled.expectedOp = RESIDUE_LABEL_TO_OP[point.label as Label];
		residue.push(relabelled);
	}
	mkdirSync(join(RESIDUE_PATH, ".."), { recursive: true });
	const body = residue.length === 0 ? "" : `${residue.map((task) => JSON.stringify(task)).join("\n")}\n`;
	writeFileSync(RESIDUE_PATH, body);

	console.log("");
	console.log(`residue      ${residue.length} rows → ${RESIDUE_PATH}  sha ${sha(body)}`);
	const counts = new Map<Op, number>(OPS.map((op) => [op, 0]));
	for (const task of residue) counts.set(task.expectedOp, (counts.get(task.expectedOp) ?? 0) + 1);
	for (const [op, n] of counts) console.log(`  ${op.padEnd(12)} ${String(n).padStart(4)}  ${pct(n, residue.length).padStart(6)}`);
	if (residue.length > 0) {
		const record = score("baseline-only", residue, [], sha(body), RESIDUE_PATH);
		console.log("");
		console.log("constant      exactMatch  regret/task");
		for (const [key, value] of Object.entries(record.baselines ?? {})) {
			console.log(`  ${key.padEnd(16)} ${`${(value.exactMatch * 100).toFixed(1)}%`.padStart(8)}  ${value.regretPerTask.toFixed(4).padStart(11)}`);
		}
		console.log("");
		console.log("a model has to beat the best constant on these rows, and there are only " + residue.length + " of them");
	}
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) main();
