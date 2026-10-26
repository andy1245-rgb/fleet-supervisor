// Decision-model benchmark. Prompt, task set and scoring are fixed so the only
// variable is the model. Records are written to bench/results and committed —
// a design decision that is not backed by a record here is not a decision.

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
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

/** Regret in arbitrary units: what a wrong op actually costs.
 *  The asymmetry is the point — a false "leave" strands a working agent, while a
 *  false "flag" only buys an escalator call. */
export const REGRET: Record<Op, Record<Exclude<Op, "leave">, number>> = {
	leave: { nudge: 5, declare_done: 4, flag: 2 },
	nudge: { nudge: 0, declare_done: 4, flag: 1 },
	declare_done: { nudge: 5, declare_done: 0, flag: 2 },
	flag: { nudge: 1, declare_done: 1, flag: 0 },
};

export function regretOf(expected: Op, predicted: Op): number {
	if (expected === predicted) return 0;
	if (expected === "leave") return (REGRET.leave as Record<string, number>)[predicted] ?? 0;
	const row = REGRET[expected] as Record<string, number>;
	return row[predicted] ?? 0;
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
	n: number;
	ops: { exactMatch: number; perOpRecall: Record<string, number> };
	selective: { coverageAtThreshold: Record<string, number>; accuracyAtCoverage: Record<string, number> };
	regret: { weights: Record<string, number>; total: number; perTask: number };
	latencyMs: { p50: number; p95: number };
	costUsd: { total: number; per1k: number };
	refusals: number;
	/** Rows behind each per-op number: a recall over 7 rows is not the same
	 *  claim as a recall over 200, and the record should say which it is. */
	coverage?: { sampledPerOp: Record<string, number>; corpusPerOp: Record<string, number> };
	notes?: string;
}

const THRESHOLDS = [0.3, 0.5, 0.7, 0.9];

export function score(model: string, tasks: Task[], decisions: Decision[], taskSetSha: string): BenchRecord {
	let correct = 0;
	let refusals = 0;
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
		n: tasks.length,
		ops: { exactMatch: Number((correct / Math.max(1, tasks.length)).toFixed(4)), perOpRecall },
		selective: { coverageAtThreshold, accuracyAtCoverage },
		regret: { weights: { leave: 5, declare_done: 4, flag: 2, nudge: 1 }, total: regretTotal, perTask: Number((regretTotal / Math.max(1, tasks.length)).toFixed(4)) },
		latencyMs: { p50: percentile(latency, 50), p95: percentile(latency, 95) },
		costUsd: { total: Number(cost.toFixed(6)), per1k: Number(((cost / Math.max(1, tasks.length)) * 1000).toFixed(4)) },
		refusals,
	};
}

export function loadTasks(path = join(ROOT, "tasks", "tasks.jsonl")): { tasks: Task[]; sha: string } {
	const raw = readFileSync(path, "utf8");
	const tasks = raw
		.split("\n")
		.filter((line) => line.trim())
		.map((line) => JSON.parse(line) as Task);
	return { tasks, sha: createHash("sha256").update(raw).digest("hex").slice(0, 16) };
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
		});
	}
	return traces.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

export function tracesToJsonl(traces: readonly TaskTrace[]): string {
	return traces.map((trace) => `${JSON.stringify(trace)}\n`).join("");
}

function buildModel(name: string): DecisionModel {
	if (name === "needle3" || name === "needle") return needleModel();
	const model = name.startsWith("openrouter:") ? name.slice("openrouter:".length) : name;
	return openRouterModel({ model });
}

export async function bench(modelName: string, limit?: number, tag = ""): Promise<BenchRecord> {
	const { tasks, sha } = loadTasks();
	// Stratified by expectedOp rather than strided: the file is ordered by session,
	// so a stride samples whatever the file order favours and can miss `leave`
	// entirely at any small limit.
	const sample = sampleStratified(tasks, limit ?? tasks.length);
	if (sample.note) console.error(`bench: ${sample.note}`);
	const model = buildModel(modelName);
	const decisions: Decision[] = [];
	for (const task of sample.tasks) {
		decisions.push(await model.decide(task.input));
	}
	const record = score(model.name, sample.tasks, decisions, sha);
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
	await bench(modelArg, limit, "cli");
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
	void main();
}
