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

function buildModel(name: string): DecisionModel {
	if (name === "needle3" || name === "needle") return needleModel();
	const model = name.startsWith("openrouter:") ? name.slice("openrouter:".length) : name;
	return openRouterModel({ model });
}

export async function bench(modelName: string, limit?: number, tag = ""): Promise<BenchRecord> {
	const { tasks, sha } = loadTasks();
	// Stride rather than slice: the task file is ordered by session, so taking the
	// head would sample one project and call it a benchmark.
	const subset = limit && limit < tasks.length ? tasks.filter((_, i) => i % Math.floor(tasks.length / limit) === 0).slice(0, limit) : tasks;
	const model = buildModel(modelName);
	const decisions: Decision[] = [];
	for (const task of subset) {
		decisions.push(await model.decide(task.input));
	}
	const record = score(model.name, subset, decisions, sha);
	if (tag) record.notes = tag;
	const out = join(ROOT, "results", `${record.recordedAt.replace(/[:.]/g, "-")}__${model.name.replace(/[^A-Za-z0-9._-]/g, "_")}.json`);
	mkdirSync(dirname(out), { recursive: true });
	writeFileSync(out, `${JSON.stringify(record, null, "\t")}\n`);
	console.log(JSON.stringify(record, null, "\t"));
	console.error(`bench: wrote ${out}`);
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
