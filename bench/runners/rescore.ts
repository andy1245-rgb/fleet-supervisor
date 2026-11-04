// Re-score a committed trace against a frozen taskset. Zero model calls: the trace
// already holds every decision that was made, so the only thing that changes is how
// those decisions are scored.
//
// This is what keeps a record reproducible when the scoring rules move — the
// `baselines` block, the usable-output fields and the regret matrix can all be
// added to an existing run without pretending to re-measure it, because no number
// here depends on the model. It is also how the n=22 record gets the baselines it
// was published without.
//
// Aligns by task id, not position: a trace is written sorted by id while the
// record was scored in stratified order, so zipping the two files would pair a
// decision with the wrong expected op and silently invent accuracy.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadTasks, score, type BenchRecord, type Task } from "./run.ts";
import type { Decision, Op } from "../../src/decision/types.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const RESULTS = join(HERE, "..", "results");

interface TraceRow {
	id: string;
	expectedOp: Op;
	predictedOp: Op;
	confidence: number;
	refused: boolean;
	latencyMs: number;
	costUsd: number;
	model: string;
	argument: string;
	suppressed?: number;
	raw?: string;
}

export interface RescoreResult {
	record: BenchRecord;
	rows: number;
	missing: string[];
	/** Aggregate fields the original record already carried. A rescore must
	 *  reproduce these exactly, or it is re-measuring something rather than
	 *  re-scoring it and the output must not be trusted as the same run. */
	diff: Record<string, { before: unknown; after: unknown }>;
}

function readTrace(path: string): TraceRow[] {
	return readFileSync(path, "utf8")
		.split("\n")
		.filter((line) => line.trim())
		.map((line) => JSON.parse(line) as TraceRow);
}

export function rescore(tracePath: string, taskSetPath: string): RescoreResult {
	const { tasks, sha, path } = loadTasks(taskSetPath);
	const byId = new Map<string, Task>();
	for (const task of tasks) byId.set(task.id, task);

	const rows = readTrace(tracePath);
	const alignedTasks: Task[] = [];
	const decisions: Decision[] = [];
	const missing: string[] = [];

	for (const row of rows) {
		const task = byId.get(row.id);
		if (!task) {
			missing.push(row.id);
			continue;
		}
		if (task.expectedOp !== row.expectedOp) {
			throw new Error(
				`${row.id}: the trace expected ${row.expectedOp} but ${path} labels it ${task.expectedOp} — this trace was taken against a different taskset`,
			);
		}
		alignedTasks.push(task);
		decisions.push({
			op: row.predictedOp,
			argument: row.argument,
			confidence: row.confidence,
			model: row.model,
			costUsd: row.costUsd,
			latencyMs: row.latencyMs,
			refused: row.refused,
			raw: row.raw ?? "",
			...(typeof row.suppressed === "number" ? { suppressed: row.suppressed } : {}),
		});
	}

	const record = score(rows[0]?.model ?? "needle3", alignedTasks, decisions, sha, path);
	record.coverage = {
		sampledPerOp: countOps(alignedTasks),
		corpusPerOp: countOps(tasks),
	};
	return { record, rows: alignedTasks.length, missing, diff: {} };
}

function countOps(tasks: readonly Task[]): Record<string, number> {
	const counts: Record<string, number> = {};
	for (const task of tasks) counts[task.expectedOp] = (counts[task.expectedOp] ?? 0) + 1;
	return counts;
}

/** Stable stringify: key order must not read as a divergence. `perOpRecall` is built
 *  from a Map populated in row order, so a corpus whose rows are not id-sorted
 *  produces the same numbers in a different key order, and `JSON.stringify` would
 *  refuse a rescore that is in fact identical. */
function stable(value: unknown): string {
	if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "undefined";
	if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
	const record = value as Record<string, unknown>;
	return `{${Object.keys(record)
		.sort()
		.map((key) => `${JSON.stringify(key)}:${stable(record[key])}`)
		.join(",")}}`;
}

/** The fields a rescore must land on exactly. Anything outside this set is allowed
 *  to differ because it is new; these are what make it the same run.
 *
 *  `taskSetSha` is compared first and hardest: without it, a rescore against a
 *  corpus that agrees on labels but not on bytes emits a record claiming to be the
 *  original measurement while citing different data, and every other field matches. */
export function compare(original: BenchRecord, rescored: BenchRecord): RescoreResult["diff"] {
	const diff: RescoreResult["diff"] = {};
	const pairs: Array<[string, unknown, unknown]> = [
		["taskSetSha", original.taskSetSha, rescored.taskSetSha],
		["n", original.n, rescored.n],
		["ops", original.ops, rescored.ops],
		["selective", original.selective, rescored.selective],
		["regret.total", original.regret.total, rescored.regret.total],
		["regret.perTask", original.regret.perTask, rescored.regret.perTask],
		["refusals", original.refusals, rescored.refusals],
		["latencyMs", original.latencyMs, rescored.latencyMs],
		["costUsd", original.costUsd, rescored.costUsd],
		["coverage", original.coverage, rescored.coverage],
	];
	for (const [key, before, after] of pairs) {
		// A field the original never carried cannot disagree with a value that is new.
		if (before === undefined) continue;
		if (stable(before) !== stable(after)) diff[key] = { before, after };
	}
	return diff;
}

function main(): void {
	const [tracePath, taskSetPath, outPath] = process.argv.slice(2);
	if (!tracePath || !taskSetPath || !outPath) {
		console.error("usage: node bench/runners/rescore.ts <trace.jsonl> <taskset.jsonl> <out.json>");
		process.exit(2);
	}
	const result = rescore(tracePath, taskSetPath);
	if (result.missing.length > 0) {
		console.error(`rescore: ${result.missing.length} traced row(s) are not in ${taskSetPath}: ${result.missing.slice(0, 5).join(", ")}`);
		process.exit(1);
	}

	// The measurement timestamp is the original run's: rescoring does not re-measure,
	// and a fresh timestamp would claim it did.
	const originalPath = join(RESULTS, basename(tracePath).replace(/\.traces\.jsonl$/, ".json"));
	if (!existsSync(originalPath)) {
		console.error(`rescore: no original record at ${originalPath}; the baselines gate needs it to compare against`);
		process.exit(1);
	}
	const original = JSON.parse(readFileSync(originalPath, "utf8")) as BenchRecord;
	const diff = compare(original, result.record);
	if (Object.keys(diff).length > 0) {
		console.error("rescore: the aggregate fields do not match the original record, so this is not the same run:");
		for (const [key, value] of Object.entries(diff)) console.error(`  ${key}: ${String(value.before)} -> ${String(value.after)}`);
		process.exit(1);
	}

	// Append rather than replace: the original `notes` records how the run was invoked,
	// and overwriting it drops the only trace of that.
	const appended = `rescored from ${basename(tracePath)} at ${new Date().toISOString()}; decisions unchanged, baselines and usable-output fields added. Aggregate fields reproduce the original exactly.`;
	const record: BenchRecord = {
		...result.record,
		recordedAt: original.recordedAt,
		notes: original.notes ? `${original.notes}; ${appended}` : appended,
	};
	writeFileSync(outPath, `${JSON.stringify(record, null, "\t")}\n`);
	console.log(JSON.stringify(record, null, "\t"));
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) main();
