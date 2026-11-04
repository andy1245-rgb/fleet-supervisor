import assert from "node:assert/strict";
import { test } from "node:test";
import { baselineModels, REGRET, regretOf, score, traceOf } from "../bench/runners/run.ts";
import { compare } from "../bench/runners/rescore.ts";
import type { BaselineBlock, Task } from "../bench/runners/run.ts";
import type { Decision, DecisionInput, DecisionModel, Op } from "../src/decision/types.ts";
import { OPS } from "../src/decision/types.ts";

const SHA = "testsha";

function input(id: string): DecisionInput {
	return {
		paneId: `pane-${id}`,
		cwd: "/home/andrew/agentFleet",
		status: "idle",
		title: "scored the matrix",
		intent: "price abandonment",
		phase: "implement",
		claimState: "working",
		last: "wrote test/bench-scoring.test.ts",
		idleTicks: 0,
		tail: "> write: test/bench-scoring.test.ts",
	};
}

function task(id: string, expectedOp: Op): Task {
	return { id, input: input(id), expectedOp, humanText: "" };
}

/** Skewed like the real corpus: nudge dominates, flag is real but thin, leave is
 *  a handful of rows, declare_done has none. */
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

const TASKS = corpus(SKEWED);

function decision(op: Op, model: string): Decision {
	return { op, argument: `always ${op}`, confidence: 1, model, costUsd: 0, latencyMs: 0, refused: false, raw: "{}" };
}

function constantDecisions(tasks: readonly Task[], op: Op, model: string): Decision[] {
	return tasks.map(() => decision(op, model));
}

/** Deliberately bad and deliberately adversarial: it names the wrong op on every
 *  row it is given, so it is a floor below the constants rather than another
 *  constant. */
const WRONG: Record<Op, Op> = { leave: "nudge", nudge: "leave", declare_done: "leave", flag: "leave" };

function adversarialModel(tasks: readonly Task[]): DecisionModel {
	const expectedOf = new Map(tasks.map((theTask) => [theTask.input.paneId, theTask.expectedOp]));
	return {
		name: "fake:adversarial",
		costPerCallUsd: 0,
		decide: async (row: DecisionInput): Promise<Decision> => decision(WRONG[expectedOf.get(row.paneId) ?? "nudge"], "fake:adversarial"),
	};
}

test("every expected/predicted pair is priced, and the only free pair is a correct one", () => {
	for (const expected of OPS) {
		for (const predicted of OPS) {
			const regret = regretOf(expected, predicted);
			assert.equal(typeof regret, "number", `${expected} → ${predicted} has no cell`);
			assert.ok(Number.isFinite(regret), `${expected} → ${predicted} is not finite`);
			if (expected === predicted) assert.equal(regret, 0, `${expected} → ${predicted} must be free`);
			else assert.ok(regret > 0, `${expected} → ${predicted} must cost something`);
		}
	}
});

test("every row of the matrix is square, so no prediction is unpriced", () => {
	for (const expected of OPS) {
		assert.deepEqual(Object.keys(REGRET[expected]).sort(), [...OPS].sort(), `row ${expected}`);
	}
});

test("abandonment is the expensive mistake in the rows that owed action", () => {
	const worstIn = (row: Op): number => Math.max(...OPS.map((predicted) => REGRET[row][predicted]));
	assert.equal(REGRET.nudge.leave, worstIn("nudge"));
	assert.equal(REGRET.flag.leave, worstIn("flag"));
	assert.ok(REGRET.declare_done.leave < REGRET.nudge.leave, "declare_done abandoned costs a little less than nudge abandoned");
	assert.ok(REGRET.nudge.leave > REGRET.nudge.declare_done, "abandoning a working agent costs more than calling it done");
	assert.ok(REGRET.leave.nudge > REGRET.leave.flag, "nudging a rested agent costs more than flagging it");
});

test("always leave is no longer the regret optimum", () => {
	const leave = score("always-leave", TASKS, constantDecisions(TASKS, "leave", "always-leave"), SHA);
	const nudge = score("always-nudge", TASKS, constantDecisions(TASKS, "nudge", "always-nudge"), SHA);
	assert.ok(leave.regret.total > 0, "abandoning every row costs something");
	assert.ok(leave.regret.perTask > 0, "perTask is not zero");
	assert.ok(nudge.regret.perTask < leave.regret.perTask, "the majority class beats do-nothing on regret");
	const block = leave.baselines;
	assert.ok(block, "the record carries a baselines block");
	const worst = Math.max(...Object.values(block).map((entry) => entry.regretPerTask));
	assert.equal(block.alwaysLeave.regretPerTask, worst, "do-nothing is the worst constant, not the best");
});

test("a constant baseline scores above a deliberately bad fake model", async () => {
	const fake = adversarialModel(TASKS);
	const decisions: Decision[] = [];
	for (const theTask of TASKS) decisions.push(await fake.decide(theTask.input));
	const record = score(fake.name, TASKS, decisions, SHA);
	const block = record.baselines;
	assert.ok(block, "the record carries a baselines block");
	assert.equal(record.ops.exactMatch, 0, "the fake model is wrong on every row");
	assert.ok(block.alwaysNudge.exactMatch > record.ops.exactMatch, "always nudge beats it on exact match");
	assert.ok(block.alwaysNudge.regretPerTask < record.regret.perTask, "always nudge beats it on regret");
	for (const scoreOf of Object.values(block)) {
		assert.ok(scoreOf.exactMatch >= record.ops.exactMatch, "no constant is worse than always wrong");
		assert.ok(scoreOf.regretPerTask <= record.regret.perTask, "no constant is worse than always wrong on regret");
	}
});

test("the record's baselines block is what score() returns for the baseline models", async () => {
	const record = score("always-leave", TASKS, constantDecisions(TASKS, "leave", "always-leave"), SHA);
	const block: BaselineBlock | undefined = record.baselines;
	assert.ok(block);
	const keys: Array<[string, keyof BaselineBlock]> = [
		["baseline:always-leave", "alwaysLeave"],
		["baseline:always-nudge", "alwaysNudge"],
		["baseline:always-declare_done", "alwaysDeclareDone"],
		["baseline:always-flag", "alwaysFlag"],
	];
	const models = baselineModels();
	assert.deepEqual(models.map((model) => model.name), keys.map(([name]) => name));
	for (const [name, key] of keys) {
		const model = models.find((candidate) => candidate.name === name);
		assert.ok(model, `${name} is a baseline model`);
		const decisions: Decision[] = [];
		for (const theTask of TASKS) decisions.push(await model.decide(theTask.input));
		const scored = score(model.name, TASKS, decisions, SHA);
		assert.deepEqual(
			{ exactMatch: scored.ops.exactMatch, regretPerTask: scored.regret.perTask },
			block[key],
			`${name} scores the same through the normal path as through the block`,
		);
		assert.equal(model.costPerCallUsd, 0);
		assert.equal(scored.costUsd.total, 0);
		assert.equal(scored.refusals, 0);
		assert.equal(decisions[0]?.model, model.name, "the decision names the model that produced it");
		assert.equal(decisions[0]?.confidence, 1, "a constant has nothing to be unsure about");
	}
});

/** A refusal is coerced to `flag` so the ladder can route it, which means each
 *  refused row that expected `flag` counts as a correct answer. The refusal count is
 *  therefore visible inside `ops`, and `usableOutputRate` is what tells a reader
 *  whether the accuracy means anything. */
function refusal(model: string, suppressed?: number): Decision {
	return {
		op: "flag",
		argument: "needle declined to call a tool",
		confidence: 0,
		model,
		costUsd: 0,
		latencyMs: 0,
		refused: true,
		raw: "{}",
		...(typeof suppressed === "number" ? { suppressed } : {}),
	};
}

test("a run where nothing is usable reports no usable output and no conditional accuracy", () => {
	const decisions = TASKS.map(() => refusal("needle3"));
	const record = score("needle3", TASKS, decisions, SHA);

	assert.equal(record.usableOutputRate, 0, "no row produced a decidable op");
	assert.deepEqual(
		record.accuracyGivenUsable,
		{ value: null, n: 0 },
		"accuracy conditional on usability is undefined at n=0, and must not be reported as 0",
	);
	assert.equal(record.refusals, TASKS.length);
});

test("usable output rate and conditional accuracy use their own denominators", () => {
	const half = Math.floor(TASKS.length / 2);
	const decisions = TASKS.map((task, index) => (index < half ? decision(task.expectedOp, "m") : refusal("m")));
	const record = score("m", TASKS, decisions, SHA);

	assert.equal(record.usableOutputRate, Number((half / TASKS.length).toFixed(4)), "usable share is over rows offered");
	const conditional = record.accuracyGivenUsable;
	assert.ok(conditional, "the block is present when something was usable");
	assert.equal(conditional.n, half, "the denominator is the usable rows, not every row");
	assert.equal(conditional.value, 1, "every usable row was answered correctly");
});

test("a refusal is scored as flag, so a fully refusing run cannot beat the always-flag baseline", () => {
	const record = score("needle3", TASKS, TASKS.map(() => refusal("needle3")), SHA);
	const baseline = record.baselines;
	assert.ok(baseline, "the record carries a baselines block");
	assert.equal(
		record.ops.exactMatch,
		baseline.alwaysFlag.exactMatch,
		"a run that refuses everything scores exactly the constant, because every flag-expecting row counts as a hit",
	);
	assert.equal(
		record.ops.perOpRecall.flag,
		1,
		"and flag recall reads 1.0 while the model produced nothing, which is why usableOutputRate has to be read first",
	);
});

test("a suppression count survives onto the trace, so a gate-refusal is not an empty decode", () => {
	const traces = traceOf(TASKS.slice(0, 2), [refusal("needle3", 2), refusal("needle3", 0)]);
	assert.equal(traces[0]?.suppressed, 2, "the engine withheld two proposals");
	assert.equal(traces[1]?.suppressed, 0, "and zero is recorded, not dropped as falsy");
});

test("a rescore refuses when the task set sha differs, even if every other field agrees", () => {
	// A corpus that agrees on labels but not on bytes reproduces every aggregate, so
	// without this check the rescore emits a record citing different data while
	// claiming to be the same measurement.
	const decisions = TASKS.map((task) => decision(task.expectedOp, "m"));
	const base = score("m", TASKS, decisions, SHA);
	const drifted = { ...base, taskSetSha: "deadbeefdeadbeef" };
	assert.deepEqual(Object.keys(compare(base, drifted)), ["taskSetSha"]);
});

test("a rescore ignores key order, so an unsorted corpus does not block a valid emit", () => {
	const decisions = TASKS.map((task) => decision(task.expectedOp, "m"));
	const base = score("m", TASKS, decisions, SHA);
	const reordered = {
		...base,
		ops: { exactMatch: base.ops.exactMatch, perOpRecall: { flag: 1, nudge: 1, leave: 1, declare_done: 0 } },
	};
	const original = { ...base, ops: { exactMatch: base.ops.exactMatch, perOpRecall: { leave: 1, nudge: 1, declare_done: 0, flag: 1 } } };
	assert.deepEqual(Object.keys(compare(original, reordered)), [], "same numbers, different insertion order, no divergence");
});
