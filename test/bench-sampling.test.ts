import assert from "node:assert/strict";
import { test } from "node:test";
import { coverageOf, DEFAULT_SAMPLE_SEED, sampleStratified, traceOf, tracesToJsonl } from "../bench/runners/run.ts";
import type { Task } from "../bench/runners/run.ts";
import type { Decision, DecisionInput, Op } from "../src/decision/types.ts";

function input(id: string): DecisionInput {
	return {
		paneId: `pane-${id}`,
		cwd: "/home/andrew/agentFleet",
		status: "idle",
		title: "pinned the sampler",
		intent: "make the subset measurable",
		phase: "implement",
		claimState: "working",
		last: "wrote test/bench-sampling.test.ts",
		idleTicks: 0,
		tail: "> write: test/bench-sampling.test.ts",
	};
}

function task(id: string, expectedOp: Op): Task {
	return { id, input: input(id), expectedOp, humanText: "" };
}

/** Skewed like the real corpus — heavy nudge, thin flag, rarest leave — so the
 *  tests exercise the case that broke the stride rather than an even split. */
const SKEWED: Array<[Op, number]> = [
	["nudge", 60],
	["flag", 13],
	["leave", 3],
];

function corpus(shape: Array<[Op, number]>): Task[] {
	const tasks: Task[] = [];
	for (const [op, count] of shape) {
		for (let index = 0; index < count; index += 1) tasks.push(task(`${op}-${String(index).padStart(3, "0")}`, op));
	}
	return tasks;
}

function perOp(tasks: readonly Task[]): Record<string, number> {
	const counts: Record<string, number> = {};
	for (const theTask of tasks) counts[theTask.expectedOp] = (counts[theTask.expectedOp] ?? 0) + 1;
	return counts;
}

function decision(op: Op, argument: string): Decision {
	return { op, argument, confidence: 0.4, model: "test-model", costUsd: 0.0001, latencyMs: 12, refused: false, raw: "{}" };
}

test("every op in the corpus survives the subset at every limit", () => {
	const tasks = corpus(SKEWED);
	const present = Object.keys(perOp(tasks)).sort();
	for (let limit = 1; limit <= 40; limit += 1) {
		assert.deepEqual(Object.keys(perOp(sampleStratified(tasks, limit).tasks)).sort(), present, `limit ${limit}`);
	}
});

test("an op with a single row is never sampled out", () => {
	const tasks = corpus([
		["nudge", 20],
		["flag", 5],
		["leave", 1],
	]);
	assert.equal(perOp(sampleStratified(tasks, 2).tasks).leave, 1);
	assert.equal(perOp(sampleStratified(tasks, 3).tasks).leave, 1);
	assert.equal(perOp(sampleStratified(tasks, 7).tasks).leave, 1);
});

test("a rare op contributes all its rows once the limit can hold them", () => {
	const tasks = corpus(SKEWED);
	const at20 = sampleStratified(tasks, 20);
	assert.equal(perOp(at20.tasks).leave, 3);
	assert.equal(at20.tasks.length, 20);
	const at40 = sampleStratified(tasks, 40);
	assert.equal(perOp(at40.tasks).leave, 3);
	assert.equal(at40.tasks.length, 40);
});

test("the subset is exactly the requested size once the limit covers every op", () => {
	const tasks = corpus(SKEWED);
	for (let limit = 3; limit <= tasks.length; limit += 1) {
		assert.equal(sampleStratified(tasks, limit).tasks.length, limit, `limit ${limit}`);
	}
});

test("sampling is deterministic across calls and seeds by default", () => {
	const tasks = corpus(SKEWED);
	const first = sampleStratified(tasks, 16).tasks.map((task) => task.id);
	assert.deepEqual(first, sampleStratified(tasks, 16).tasks.map((task) => task.id));
	assert.deepEqual(first, sampleStratified([...tasks], 16).tasks.map((task) => task.id));
	assert.deepEqual(first, sampleStratified(tasks, 16, DEFAULT_SAMPLE_SEED).tasks.map((task) => task.id));
});

test("a limit below the op count takes one row per op and reports the shortfall", () => {
	const tasks = corpus(SKEWED);
	const sample = sampleStratified(tasks, 2);
	assert.deepEqual(perOp(sample.tasks), { nudge: 1, flag: 1, leave: 1 });
	assert.equal(sample.tasks.length, 3);
	assert.equal(sample.requested, 2);
	assert.equal(sample.sizeMatchesRequest, false);
	assert.match(sample.note ?? "", /below the 3 ops present/);
});

test("a limit above the corpus selects every row once", () => {
	const tasks = corpus(SKEWED);
	const sample = sampleStratified(tasks, 500);
	assert.deepEqual(sample.tasks.map((task) => task.id), tasks.map((task) => task.id));
	assert.deepEqual(sample.sampledPerOp, sample.corpusPerOp);
	assert.equal(sample.sizeMatchesRequest, false);
	const exact = sampleStratified(tasks, tasks.length);
	assert.equal(exact.tasks.length, tasks.length);
	assert.equal(exact.sizeMatchesRequest, true);
	assert.equal(exact.note, undefined);
});

test("per-op counts meet the ceil-proportional floor when the limit can afford it", () => {
	const tasks = corpus([
		["nudge", 20],
		["flag", 10],
		["leave", 10],
	]);
	const sample = sampleStratified(tasks, 20);
	assert.deepEqual(perOp(sample.tasks), { nudge: 10, flag: 5, leave: 5 });
	assert.equal(sample.tasks.length, 20);
	assert.equal(sample.note, undefined);
});

test("the floor holds at every limit whose ceils fit inside it", () => {
	// 20/10/10 makes the ceil shares land exactly on multiples of 4, so this is the
	// corpus where the floor is satisfiable at all. On a lopsided corpus the ceils
	// always overshoot the limit and the sampler spends the seats differently.
	const tasks = corpus([
		["nudge", 20],
		["flag", 10],
		["leave", 10],
	]);
	const counts = perOp(tasks);
	let checked = 0;
	for (let limit = 3; limit < tasks.length; limit += 1) {
		const floor = Object.fromEntries(
			Object.entries(counts).map(([op, count]) => [op, Math.min(count, Math.max(1, Math.ceil((limit * count) / tasks.length)))]),
		);
		const ceilTotal = Object.values(floor).reduce((sum, rows) => sum + rows, 0);
		if (ceilTotal > limit) continue;
		checked += 1;
		const sampled = perOp(sampleStratified(tasks, limit).tasks);
		for (const [op, rows] of Object.entries(floor)) assert.ok((sampled[op] ?? 0) >= rows, `limit ${limit} op ${op}: ${sampled[op] ?? 0} < ${rows}`);
	}
	assert.ok(checked > 0, "no limit in range could afford the ceils, so the assertion never ran");
});

test("the subset keeps corpus order and never repeats a row", () => {
	const tasks = corpus(SKEWED);
	const positions = new Map(tasks.map((task, index) => [task.id, index]));
	const picked = sampleStratified(tasks, 30).tasks.map((task) => positions.get(task.id) ?? -1);
	assert.ok(picked.every((position) => position >= 0));
	assert.deepEqual(picked, [...picked].sort((a, b) => a - b));
	assert.equal(new Set(picked).size, picked.length);
});

test("coverage reports sampled rows beside corpus rows", () => {
	const tasks = corpus([
		["nudge", 10],
		["flag", 3],
		["leave", 1],
	]);
	const sample = sampleStratified(tasks, 4);
	assert.deepEqual(sample.corpusPerOp, { nudge: 10, flag: 3, leave: 1 });
	assert.deepEqual(sample.sampledPerOp, { nudge: 2, flag: 1, leave: 1 });
});

test("coverage marks an op the subset omits as zero instead of dropping the key", () => {
	const tasks = corpus([
		["nudge", 4],
		["leave", 2],
	]);
	const coverage = coverageOf(
		tasks.filter((task) => task.expectedOp === "nudge"),
		tasks,
	);
	assert.deepEqual(coverage.sampledPerOp, { nudge: 4, leave: 0 });
	assert.deepEqual(coverage.corpusPerOp, { nudge: 4, leave: 2 });
});

test("a trace names the row, what was expected and what was predicted", () => {
	const tasks = [task("dp-0002-b", "leave"), task("dp-0001-a", "nudge")];
	const traces = traceOf(tasks, [decision("nudge", "keep going"), decision("nudge", "still going")]);
	assert.deepEqual(
		traces.map((trace) => trace.id),
		["dp-0001-a", "dp-0002-b"],
	);
	assert.deepEqual(traces[1], {
		id: "dp-0002-b",
		expectedOp: "leave",
		predictedOp: "nudge",
		confidence: 0.4,
		refused: false,
		latencyMs: 12,
		costUsd: 0.0001,
		model: "test-model",
		argument: "keep going",
		raw: "{}",
	});
});

test("a trace file is one JSON line per task, in id order", () => {
	const tasks = [task("dp-0002-b", "leave"), task("dp-0001-a", "nudge")];
	const lines = tracesToJsonl(traceOf(tasks, [decision("flag", "stalled"), decision("nudge", "continue")]))
		.trimEnd()
		.split("\n");
	assert.equal(lines.length, 2);
	const first = JSON.parse(lines[0] ?? "") as { id: string; expectedOp: string; predictedOp: string };
	assert.equal(first.id, "dp-0001-a");
	assert.equal(first.expectedOp, "nudge");
	assert.equal(first.predictedOp, "nudge");
});
