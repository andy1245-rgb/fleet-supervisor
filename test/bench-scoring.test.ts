import assert from "node:assert/strict";
import { test } from "node:test";
import { baselineModels, REGRET, regretOf, score } from "../bench/runners/run.ts";
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
