// Decision-model benchmark. Prompt, task set and scoring are fixed so the only
// variable is the model. Records are written to bench/results and committed —
// a design decision that is not backed by a record here is not a decision.

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { commandcodeModel } from "../../src/decision/adapters/commandcode.ts";
import { needleModel } from "../../src/decision/needle.ts";
import { openRouterModel } from "../../src/decision/openrouter.ts";
import type { Decision, DecisionInput, DecisionModel, Op } from "../../src/decision/types.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");

export interface Task {
	id: string;
	input: DecisionInput;
	expectedOp: Op;
	/** The human's actual words, kept for inspection rather than scoring. */
	humanText: string;
}

/** Regret in arbitrary units: what a wrong op actually costs. Expected op picks
 *  the row, predicted op the column, so every row is square and every cell is
 *  priced — a prediction of `leave` against any other expectation is a cost like
 *  any other, not a free guess.
 *
 *  The asymmetry is the point. The `leave` column is the abandon column, and it
 *  is the most expensive thing in the matrix on the two rows that owed action:
 *  `nudge` and `flag` at 6, because the agent was mid-work and sat there instead,
 *  which loses the whole cycle it was running. `declare_done` abandoned is one
 *  cheaper at 5 — that turn had already reported itself finished, so the loss is
 *  a stale claim rather than a stalled pane. The `leave` row keeps its old
 *  weights (5/4/2): nudging or flagging a rested agent buys a wasted turn, and
 *  nudging one that had already finished is worse than flagging it because a
 *  nudge makes it work again. Correct pairs are 0 by construction and are the
 *  only free cells in the table. */
export const REGRET: Record<Op, Record<Op, number>> = {
	leave: { leave: 0, nudge: 5, declare_done: 4, flag: 2 },
	nudge: { leave: 6, nudge: 0, declare_done: 4, flag: 1 },
	declare_done: { leave: 5, nudge: 5, declare_done: 0, flag: 2 },
	flag: { leave: 6, nudge: 1, declare_done: 1, flag: 0 },
};

/** The matrix is total over `Op × Op`, so this reads a cell and nothing else:
 *  there is no pair without a price and no fallback that could turn an absent
 *  cell into a silent zero. */
export function regretOf(expected: Op, predicted: Op): number {
	return REGRET[expected][predicted];
}

export interface BaselineScore {
	exactMatch: number;
	regretPerTask: number;
}

/** The four constant policies on the same rows as the model. Accuracy without
 *  these is unanchored: a model that lands under `alwaysNudge` has measured
 *  nothing about the corpus, and the record should say so. */
export interface BaselineBlock {
	alwaysLeave: BaselineScore;
	alwaysNudge: BaselineScore;
	alwaysDeclareDone: BaselineScore;
	alwaysFlag: BaselineScore;
}

interface BaselinePolicy {
	name: string;
	op: Op;
	key: keyof BaselineBlock;
}

const BASELINES: readonly BaselinePolicy[] = [
	{ name: "baseline:always-leave", op: "leave", key: "alwaysLeave" },
	{ name: "baseline:always-nudge", op: "nudge", key: "alwaysNudge" },
	{ name: "baseline:always-declare_done", op: "declare_done", key: "alwaysDeclareDone" },
	{ name: "baseline:always-flag", op: "flag", key: "alwaysFlag" },
];

/** Confidence 1 because a constant has nothing to be unsure about; cost 0 because
 *  no model was called. `latencyMs` 0 for the same reason. */
function constantDecision(name: string, op: Op): Decision {
	return { op, argument: `constant baseline: always ${op}`, confidence: 1, model: name, costUsd: 0, latencyMs: 0, refused: false, raw: JSON.stringify({ op, argument: "", confidence: 1 }) };
}

/** The floors, as models: score them through `score()` and you get back exactly
 *  the `baselines` block a record carries. */
export function baselineModels(): DecisionModel[] {
	return BASELINES.map((policy) => ({
		name: policy.name,
		costPerCallUsd: 0,
		decide: async (): Promise<Decision> => constantDecision(policy.name, policy.op),
	}));
}

/** Same rows, same matrix, same rounding as `score()` — the block is that
 *  function's answer for each constant policy, computed in one pass so a record
 *  stays self-anchoring without a second read of the corpus. */
function baselineBlock(tasks: readonly Task[]): BaselineBlock {
	const block: BaselineBlock = {
		alwaysLeave: { exactMatch: 0, regretPerTask: 0 },
		alwaysNudge: { exactMatch: 0, regretPerTask: 0 },
		alwaysDeclareDone: { exactMatch: 0, regretPerTask: 0 },
		alwaysFlag: { exactMatch: 0, regretPerTask: 0 },
	};
	for (const policy of BASELINES) {
		const decision = constantDecision(policy.name, policy.op);
		let hits = 0;
		let regret = 0;
		for (const task of tasks) {
			if (task.expectedOp === decision.op) hits += 1;
			regret += regretOf(task.expectedOp, decision.op);
		}
		const n = Math.max(1, tasks.length);
		block[policy.key] = { exactMatch: Number((hits / n).toFixed(4)), regretPerTask: Number((regret / n).toFixed(4)) };
	}
	return block;
}

function percentile(values: number[], p: number): number {
	if (values.length === 0) return 0;
	const sorted = [...values].sort((a, b) => a - b);
	const index = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
	return sorted[Math.max(0, index)] ?? 0;
}

export interface BenchRecord {
	recordedAt: string;
	model: string;
	taskSetSha: string;
	/** The committed task file the sha names. A sha nothing can be loaded from is
	 *  not a citation, and a record that cannot be re-scored is not evidence. */
	taskSetPath?: string;
	n: number;
	ops: { exactMatch: number; perOpRecall: Record<string, number> };
	selective: { coverageAtThreshold: Record<string, number>; accuracyAtCoverage: Record<string, number> };
	/** The cost matrix itself, not a per-op price list: read `matrix[expected][predicted]`.
	 *  The former `weights` field was a mangled row of this matrix presented as
	 *  per-operation prices, under which always-flag read as 44 instead of its true 26. */
	regret: { matrix: Record<string, Record<string, number>>; total: number; perTask: number; weightsSwept: boolean };
	/** The constant policies on this record's own rows. Optional because every
	 *  record written before the block existed has no baselines to report. */
	baselines?: BaselineBlock;
	latencyMs: { p50: number; p95: number };
	costUsd: { total: number; per1k: number };
	refusals: number;
	/** Share of rows on which the model produced a decidable op. When this is 0 the
	 *  failure is upstream of scoring, and `ops.exactMatch` is not measuring judgement. */
	usableOutputRate?: number;
	/** Accuracy over the usable rows only. `value` is null when nothing was usable:
	 *  with no denominator there is no accuracy to report, and 0 would invent one. */
	accuracyGivenUsable?: { value: number | null; n: number };
	/** Rows behind each per-op number: a recall over 7 rows is not the same
	 *  claim as a recall over 200, and the record should say which it is. */
	coverage?: { sampledPerOp: Record<string, number>; corpusPerOp: Record<string, number> };
	notes?: string;
}

const THRESHOLDS = [0.3, 0.5, 0.7, 0.9];

export function score(model: string, tasks: Task[], decisions: Decision[], taskSetSha: string, taskSetPath?: string): BenchRecord {
	let correct = 0;
	let refusals = 0;
	let usable = 0;
	let usableCorrect = 0;
	let regretTotal = 0;
	const latency: number[] = [];
	const cost = decisions.reduce((sum, d) => sum + d.costUsd, 0);
	const expectedCounts = new Map<Op, number>();
	const expectedHit = new Map<Op, number>();

	for (const [index, task] of tasks.entries()) {
		const decision = decisions[index];
		if (!decision) continue;
		latency.push(decision.latencyMs);
		if (decision.refused) refusals += 1;
		else {
			usable += 1;
			if (decision.op === task.expectedOp) usableCorrect += 1;
		}
		if (decision.op === task.expectedOp) correct += 1;
		regretTotal += regretOf(task.expectedOp, decision.op);
		expectedCounts.set(task.expectedOp, (expectedCounts.get(task.expectedOp) ?? 0) + 1);
		if (decision.op === task.expectedOp) expectedHit.set(task.expectedOp, (expectedHit.get(task.expectedOp) ?? 0) + 1);
	}

	const perOpRecall: Record<string, number> = {};
	for (const [op, count] of expectedCounts) perOpRecall[op] = Number(((expectedHit.get(op) ?? 0) / count).toFixed(4));

	// Selective accuracy: what happens if everything below the threshold is
	// escalated instead of acted on. This is the ladder's real operating curve.
	const coverageAtThreshold: Record<string, number> = {};
	const accuracyAtCoverage: Record<string, number> = {};
	for (const threshold of THRESHOLDS) {
		let covered = 0;
		let coveredCorrect = 0;
		for (const [index, task] of tasks.entries()) {
			const decision = decisions[index];
			if (!decision || decision.refused || decision.confidence < threshold) continue;
			covered += 1;
			if (decision.op === task.expectedOp) coveredCorrect += 1;
		}
		coverageAtThreshold[String(threshold)] = Number((covered / Math.max(1, tasks.length)).toFixed(4));
		accuracyAtCoverage[String(threshold)] = covered === 0 ? 0 : Number((coveredCorrect / covered).toFixed(4));
	}

	return {
		recordedAt: new Date().toISOString(),
		model,
		taskSetSha,
		...(taskSetPath ? { taskSetPath } : {}),
		n: tasks.length,
		ops: { exactMatch: Number((correct / Math.max(1, tasks.length)).toFixed(4)), perOpRecall },
		selective: { coverageAtThreshold, accuracyAtCoverage },
		regret: { matrix: REGRET, total: regretTotal, perTask: Number((regretTotal / Math.max(1, tasks.length)).toFixed(4)), weightsSwept: false },
		usableOutputRate: Number((usable / Math.max(1, tasks.length)).toFixed(4)),
		accuracyGivenUsable: usable === 0 ? { value: null, n: 0 } : { value: Number((usableCorrect / usable).toFixed(4)), n: usable },
		baselines: baselineBlock(tasks),
		latencyMs: { p50: percentile(latency, 50), p95: percentile(latency, 95) },
		costUsd: { total: Number(cost.toFixed(6)), per1k: Number(((cost / Math.max(1, tasks.length)) * 1000).toFixed(4)) },
		refusals,
	};
}

export function loadTasks(path = join(ROOT, "tasks", "tasks.jsonl")): { tasks: Task[]; sha: string; path: string } {
	const raw = readFileSync(path, "utf8");
	const tasks = raw
		.split("\n")
		.filter((line) => line.trim())
		.map((line) => JSON.parse(line) as Task);
	return { tasks, sha: createHash("sha256").update(raw).digest("hex").slice(0, 16), path: relative(join(ROOT, ".."), path) };
}

/** Fixed order for stratification, most expensive mistake first. When seats are
 *  scarce `leave` gets the first one: it is 7 rows of 502 and costs 5 in the
 *  REGRET matrix, so a subset that omits it cannot price the worst decision. */
export const OP_PRIORITY: readonly Op[] = ["leave", "flag", "nudge", "declare_done"];

/** Sampling is deterministic — the same corpus and limit always select the same
 *  rows — so two records against one taskSetSha stay comparable. */
export const DEFAULT_SAMPLE_SEED = 1;

export interface BenchSample {
	/** Selected rows, in corpus order. */
	tasks: Task[];
	requested: number;
	/** False when the subset could not be exactly `requested` rows; `note` says why. */
	sizeMatchesRequest: boolean;
	note?: string;
	sampledPerOp: Record<string, number>;
	corpusPerOp: Record<string, number>;
}

function headroomOf(op: string, quota: ReadonlyMap<string, number>, counts: ReadonlyMap<string, number>): number {
	return (counts.get(op) ?? 0) - (quota.get(op) ?? 0);
}

function remainderOf(value: number): number {
	return value - Math.floor(value);
}

/** Ops present in the corpus, in the fixed priority order. An op the corpus
 *  invents that OP_PRIORITY does not name sorts after it, alphabetically. */
function opOrder(counts: Map<string, number>): string[] {
	const priority: readonly string[] = OP_PRIORITY;
	const known = OP_PRIORITY.filter((op) => counts.has(op));
	const rest = [...counts.keys()].filter((op) => !priority.includes(op)).sort();
	return [...known, ...rest];
}

/** Seeded rank per row, not a PRNG: the same id under the same seed always ranks
 *  the same, so a subset is reproducible without carrying generator state. */
function pickRanked(rows: readonly Task[], take: number, seed: number): Task[] {
	if (take >= rows.length) return [...rows];
	if (take <= 0) return [];
	const ranked = rows.map((task) => ({ task, order: createHash("sha256").update(`${seed}\u0000${task.id}`).digest() }));
	ranked.sort((a, b) => {
		const difference = Buffer.compare(a.order, b.order);
		if (difference !== 0) return difference;
		return a.task.id < b.task.id ? -1 : a.task.id > b.task.id ? 1 : 0;
	});
	return ranked.slice(0, take).map((entry) => entry.task);
}

/** Spend the remaining seats in proportion to the rows each op still has left.
 *  Largest remainder takes the seats that do not divide evenly, and ties break on
 *  the fixed op order so the allocation is reproducible. */
function fillProportionally(quota: Map<string, number>, counts: Map<string, number>, order: readonly string[], budget: number): void {
	if (budget <= 0) return;
	const open = order.filter((op) => headroomOf(op, quota, counts) > 0);
	const headroomTotal = open.reduce((sum, op) => sum + headroomOf(op, quota, counts), 0);
	if (headroomTotal === 0) return;
	const share = new Map<string, number>(open.map((op) => [op, (budget * headroomOf(op, quota, counts)) / headroomTotal]));
	let left = budget;
	for (const op of open) {
		const take = Math.min(headroomOf(op, quota, counts), Math.floor(share.get(op) ?? 0));
		quota.set(op, (quota.get(op) ?? 0) + take);
		left -= take;
	}
	const byRemainder = [...open].sort((a, b) => {
		const difference = remainderOf(share.get(b) ?? 0) - remainderOf(share.get(a) ?? 0);
		return difference !== 0 ? difference : order.indexOf(a) - order.indexOf(b);
	});
	for (const op of byRemainder) {
		if (left <= 0) break;
		if (headroomOf(op, quota, counts) <= 0) continue;
		quota.set(op, (quota.get(op) ?? 0) + 1);
		left -= 1;
	}
	let progressed = true;
	while (left > 0 && progressed) {
		progressed = false;
		for (const op of order) {
			if (left <= 0) break;
			if (headroomOf(op, quota, counts) <= 0) continue;
			quota.set(op, (quota.get(op) ?? 0) + 1);
			left -= 1;
			progressed = true;
		}
	}
}

export function coverageOf(sampled: readonly Task[], corpus: readonly Task[]): { sampledPerOp: Record<string, number>; corpusPerOp: Record<string, number> } {
	const sampledPerOp: Record<string, number> = {};
	const corpusPerOp: Record<string, number> = {};
	for (const task of corpus) corpusPerOp[task.expectedOp] = (corpusPerOp[task.expectedOp] ?? 0) + 1;
	for (const task of sampled) sampledPerOp[task.expectedOp] = (sampledPerOp[task.expectedOp] ?? 0) + 1;
	// Ops the corpus has and the subset does not report as 0 rather than vanishing:
	// a missing key reads as "not measured", a zero reads as "measured as none".
	for (const op of Object.keys(corpusPerOp)) sampledPerOp[op] = sampledPerOp[op] ?? 0;
	return { sampledPerOp, corpusPerOp };
}

/** Stratified sample of the task file, replacing the stride that could select
 *  zero `leave` rows at any small limit. Contract, in priority order:
 *   1. every op in the corpus appears at least once, so no per-op recall is
 *      computed on a subset that never saw the op;
 *   2. an op with fewer rows than an even split of the limit contributes all of
 *      them — `leave` is 7 rows, not 1, as soon as the limit can hold them;
 *   3. the subset is exactly `limit` rows; `sizeMatchesRequest` reports the two
 *      cases where it cannot be (limit above the corpus, limit below the op count);
 *   4. ceil-proportional per-op floors where they fit. On a skewed corpus the
 *      ceils usually sum to more than the limit — 40 rows over 406/89/7 wants
 *      1 + 8 + 33 — and then exact size and full rare-op coverage win, with the
 *      shortfall visible in the returned note and counts. */
export function sampleStratified(tasks: readonly Task[], limit: number, seed: number = DEFAULT_SAMPLE_SEED): BenchSample {
	const counts = new Map<string, number>();
	for (const task of tasks) counts.set(task.expectedOp, (counts.get(task.expectedOp) ?? 0) + 1);
	const order = opOrder(counts);
	const total = tasks.length;
	const quota = new Map<string, number>(order.map((op) => [op, 0]));
	let sizeMatchesRequest = true;
	let note: string | undefined;

	if (!(limit > 0) || total === 0) {
		return {
			tasks: [],
			requested: limit,
			sizeMatchesRequest: false,
			note: total === 0 ? "the corpus is empty" : `limit ${limit} selects no rows`,
			...coverageOf([], tasks),
		};
	}

	if (limit >= total) {
		for (const op of order) quota.set(op, counts.get(op) ?? 0);
		if (limit > total) {
			sizeMatchesRequest = false;
			note = `limit ${limit} exceeds the ${total}-row corpus; every row was selected`;
		}
	} else if (limit < order.length) {
		// Fewer seats than ops. One row each still leaves every per-op number
		// defined, which a strided subset does not.
		for (const op of order) quota.set(op, 1);
		sizeMatchesRequest = false;
		note = `limit ${limit} is below the ${order.length} ops present (${order.join(", ")}); took one row per op, so the subset is ${order.length} rows instead of ${limit}`;
	} else {
		const ceilQuotas = new Map<string, number>(
			order.map((op) => {
				const count = counts.get(op) ?? 0;
				return [op, Math.min(count, Math.max(1, Math.ceil((limit * count) / total)))];
			}),
		);
		const ceilTotal = [...ceilQuotas.values()].reduce((sum, rows) => sum + rows, 0);
		if (ceilTotal <= limit) {
			for (const [op, rows] of ceilQuotas) quota.set(op, rows);
			fillProportionally(quota, counts, order, limit - ceilTotal);
		} else {
			// The ceil shares do not fit inside the limit. Every op keeps one row and
			// an op with fewer rows than an even split gives all of them, so `leave`
			// is 7 rows rather than 0 or 1 once the limit can hold them.
			const evenShare = limit / order.length;
			for (const op of order) quota.set(op, 1);
			let budget = limit - order.length;
			for (const op of order) {
				if ((counts.get(op) ?? 0) >= evenShare) continue;
				const give = Math.min(headroomOf(op, quota, counts), budget);
				if (give <= 0) continue;
				quota.set(op, (quota.get(op) ?? 0) + give);
				budget -= give;
			}
			fillProportionally(quota, counts, order, budget);
			const rare = order.filter((op) => (counts.get(op) ?? 0) > 1 && (counts.get(op) ?? 0) < evenShare);
			note = `ceil-proportional floors for ${limit} rows sum to ${ceilTotal}, more than the limit; every op kept a seat${rare.length > 0 ? `, ${rare.join(", ")} contributed all its rows` : ""}, the rest went proportionally`;
		}
	}

	const byOp = new Map<string, Task[]>();
	for (const task of tasks) {
		const rows = byOp.get(task.expectedOp);
		if (rows) rows.push(task);
		else byOp.set(task.expectedOp, [task]);
	}
	const picked: Task[] = [];
	for (const op of order) {
		const rows = byOp.get(op) ?? [];
		picked.push(...pickRanked(rows, Math.min(rows.length, quota.get(op) ?? 0), seed));
	}
	const position = new Map<string, number>();
	for (const [index, task] of tasks.entries()) if (!position.has(task.id)) position.set(task.id, index);
	picked.sort((a, b) => {
		const left = position.get(a.id) ?? 0;
		const right = position.get(b.id) ?? 0;
		if (left !== right) return left - right;
		return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
	});
	return { tasks: picked, requested: limit, sizeMatchesRequest, note, ...coverageOf(picked, tasks) };
}

/** One line per task, enough to see which rows a model got wrong and what it
 *  answered instead. Aggregates alone cannot explain a 0.35. */
export interface TaskTrace {
	id: string;
	expectedOp: Op;
	predictedOp: Op;
	confidence: number;
	refused: boolean;
	latencyMs: number;
	costUsd: number;
	model: string;
	argument: string;
	/** Calls the engine withhold. This is the field that separates "the engine
	 *  considered a call and declined to commit it" from "decoding produced
	 *  nothing", and the two have opposite fixes: the first needs no fine-tune at
	 *  all. (It was documented as the grounding gate; measured, it is the confidence
	 *  bar — see docs/needle3-usage-review-2026-11-14.md.) */
	suppressed?: number;
	/** The withheld call, when there was one: which op the engine considered and at
	 *  what confidence. Present exactly when `suppressed > 0` on an engine that
	 *  reports it, so a refusal stops being indistinguishable from silence. */
	proposed?: { op: Op; argument: string };
	/** The sidecar's reply, verbatim. Without it a trace cannot be re-scored after
	 *  the scoring rules change, which is how a refusal became a `flag`. */
	raw?: string;
}

export function traceOf(tasks: readonly Task[], decisions: readonly Decision[]): TaskTrace[] {
	const traces: TaskTrace[] = [];
	for (const [index, task] of tasks.entries()) {
		const decision = decisions[index];
		if (!decision) continue;
		traces.push({
			id: task.id,
			expectedOp: task.expectedOp,
			predictedOp: decision.op,
			confidence: decision.confidence,
			refused: decision.refused,
			latencyMs: decision.latencyMs,
			costUsd: decision.costUsd,
			model: decision.model,
			argument: decision.argument,
			...(typeof decision.suppressed === "number" ? { suppressed: decision.suppressed } : {}),
			...(decision.proposed === undefined ? {} : { proposed: decision.proposed }),
			raw: decision.raw,
		});
	}
	return traces.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

export function tracesToJsonl(traces: readonly TaskTrace[]): string {
	return traces.map((trace) => `${JSON.stringify(trace)}\n`).join("");
}

function buildModel(name: string, timeoutMs?: number): DecisionModel {
	if (name === "needle3" || name === "needle") return needleModel(timeoutMs ? { timeoutMs } : {});
	// The same mapping the supervisor uses (`manager/tick.ts:buildModel`), so a bench
	// record can name the model the fleet actually runs. Without this branch a
	// `commandcode/...` name silently fell through to the chat-completions adapter,
	// which is a different wire and a different question.
	if (name.startsWith("commandcode/")) {
		return commandcodeModel({ model: name.slice("commandcode/".length), ...(timeoutMs === undefined ? {} : { timeoutMs }) });
	}
	const model = name.startsWith("openrouter:") ? name.slice("openrouter:".length) : name;
	return openRouterModel({ model });
}

/** Freeze the exact bytes a record is scored against, named by their sha. A record
 *  whose taskset is only a hash stops being re-scorable the moment the working
 *  file changes, which is how an unreproducible result gets committed and then
 *  cited. Writing the snapshot at measure time makes that impossible. */
/** Freeze the exact bytes a record is scored against, and return the repo-relative
 *  path of that snapshot. The record must cite the snapshot rather than the working
 *  file: the working copy is mutable, so citing it means the next corpus edit
 *  invalidates a record that was correct when it was written — the exact failure the
 *  provenance test exists to catch, reintroduced by the thing meant to prevent it. */
function freezeTaskSet(path: string, sha: string): string {
	const dir = join(ROOT, "tasks");
	const marker = `.${sha}.jsonl`;
	const existing = readdirSync(dir).find((name) => name.endsWith(marker));
	const name = existing ?? `${new Date().toISOString().slice(0, 10)}${marker}`;
	if (!existing) writeFileSync(join(dir, name), readFileSync(path));
	return relative(join(ROOT, ".."), join(dir, name));
}

export async function bench(modelName: string, limit?: number, tag = "", taskset?: string, timeoutMs?: number): Promise<BenchRecord> {
	const taskPath = taskset ? join(ROOT, "..", taskset) : join(ROOT, "tasks", "tasks.jsonl");
	const { tasks, sha } = loadTasks(taskPath);
	// Stratified by expectedOp rather than strided: the file is ordered by session,
	// so a stride samples whatever the file order favours and can miss `leave`
	// entirely at any small limit.
	const sample = sampleStratified(tasks, limit ?? tasks.length);
	if (sample.note) console.error(`bench: ${sample.note}`);
	const model = buildModel(modelName, timeoutMs);
	const decisions: Decision[] = [];
	for (const task of sample.tasks) {
		decisions.push(await model.decide(task.input));
	}
	// Frozen after the measurement, not before: a run that throws mid-loop must not
	// leave an uncited snapshot behind for the provenance test to trip over.
	const citedPath = freezeTaskSet(taskPath, sha);
	const record = score(model.name, sample.tasks, decisions, sha, citedPath);
	record.coverage = { sampledPerOp: sample.sampledPerOp, corpusPerOp: sample.corpusPerOp };
	if (tag) record.notes = tag;
	const stem = `${record.recordedAt.replace(/[:.]/g, "-")}__${model.name.replace(/[^A-Za-z0-9._-]/g, "_")}`;
	const out = join(ROOT, "results", `${stem}.json`);
	const tracePath = join(ROOT, "results", `${stem}.traces.jsonl`);
	mkdirSync(dirname(out), { recursive: true });
	writeFileSync(out, `${JSON.stringify(record, null, "\t")}\n`);
	writeFileSync(tracePath, tracesToJsonl(traceOf(sample.tasks, decisions)));
	console.log(JSON.stringify(record, null, "\t"));
	console.error(`bench: wrote ${out} and ${tracePath}`);
	return record;
}

async function main(): Promise<void> {
	const args = process.argv.slice(2);
	const modelArg = args.find((a) => !a.startsWith("--")) ?? process.env.AGENTFLEET_BENCH_MODEL ?? "needle3";
	const limitArg = args.find((a) => a.startsWith("--limit="));
	const limit = limitArg ? Number(limitArg.split("=")[1]) : undefined;
	const tasksetArg = args.find((a) => a.startsWith("--taskset="));
	const timeoutArg = args.find((a) => a.startsWith("--timeout-ms="));
	const timeoutMs = timeoutArg ? Number(timeoutArg.split("=")[1]) : undefined;
	// A raised cap is stated in the record: it makes the run answerable on a shared
	// box, and it makes the latency columns unusable, so the record has to say which.
	const note = timeoutMs
		? `cli; adapter timeout ${timeoutMs}ms, so latency here is not comparable to a default-cap run`
		: "cli";
	await bench(modelArg, limit, note, tasksetArg?.split("=")[1], timeoutMs);
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
	void main();
}
