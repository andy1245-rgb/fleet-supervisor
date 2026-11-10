// The constant baselines, scored against any task set before any model is.
//
// A corpus's majority class is the floor a decision model has to clear, and in a
// corpus whose label is partly decided by a clock it is the first thing to read: if
// always-`leave` scores 0.64 then a model at 0.60 has measured nothing about
// supervision, and a reader who sees only the model's number would not know that.
//
// This prints the four constant policies through `score()`, so the numbers here and
// the `baselines` block inside a `bench/results/` record are the same arithmetic
// rather than two implementations that agree by inspection.
//
//   node bench/runners/baselines.ts bench/tasks/tasks-time-sampled.jsonl

import { existsSync } from "node:fs";
import { join } from "node:path";
import { loadTasks, score, type Task } from "./run.ts";
import type { Op } from "../../src/decision/types.ts";

const ROOT = join(import.meta.dirname, "..");
const OPS: readonly Op[] = ["leave", "nudge", "declare_done", "flag"];

const pct = (value: number): string => `${(value * 100).toFixed(1)}%`;

function main(): void {
	const arg = process.argv[2];
	const path = arg ? (arg.startsWith("/") ? arg : join(process.cwd(), arg)) : join(ROOT, "tasks", "tasks.jsonl");
	if (!existsSync(path)) throw new Error(`no task set at ${path}`);

	const { tasks, sha } = loadTasks(path);
	const counts = new Map<Op, number>(OPS.map((op) => [op, 0]));
	for (const task of tasks) counts.set(task.expectedOp, (counts.get(task.expectedOp) ?? 0) + 1);
	const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1]);
	const majority = ranked[0];

	// A record's `baselines` block is this function's answer for each constant, and
	// it is computed from the tasks alone — the empty decision list is not a model
	// with no answers, it is how the block is reached without pretending otherwise.
	const record = score("baseline-only", tasks as Task[], [], sha, path);

	console.log(`task set   ${path}`);
	console.log(`sha        ${sha}`);
	console.log(`rows       ${tasks.length}`);
	for (const [op, n] of ranked) console.log(`  ${op.padEnd(12)} ${String(n).padStart(7)}  ${pct(n / tasks.length).padStart(6)}`);
	console.log("");
	console.log("constant   exactMatch  regretPerTask");
	for (const [key, value] of Object.entries(record.baselines ?? {})) {
		console.log(`  ${key.padEnd(16)} ${pct(value.exactMatch).padStart(8)}  ${value.regretPerTask.toFixed(4).padStart(13)}`);
	}
	console.log("");
	console.log(`majority class: ${majority?.[0] ?? "none"} at ${pct((majority?.[1] ?? 0) / Math.max(1, tasks.length))}`);
	console.log(`a model must beat ${pct((majority?.[1] ?? 0) / Math.max(1, tasks.length))} to have measured anything about this corpus`);
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) main();
