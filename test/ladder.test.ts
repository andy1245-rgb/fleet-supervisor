import assert from "node:assert/strict";
import { test } from "node:test";
import { decideWithEscalation } from "../src/decision/ladder.ts";
import type { Decision, DecisionInput, DecisionModel } from "../src/decision/types.ts";

const THRESHOLD = 0.7;

const INPUT: DecisionInput = {
	paneId: "w2C:p1",
	cwd: "/w/repo",
	status: "idle",
	title: "pi",
	intent: "pin the pure modules",
	phase: "implement",
	claimState: "working",
	last: "wrote test/detect.test.ts",
	idleTicks: 3,
	tail: "$ npm test",
};

function decision(overrides: Partial<Decision> = {}): Decision {
	return {
		op: "nudge",
		argument: "keep going",
		confidence: 0.9,
		model: "primary",
		costUsd: 0,
		latencyMs: 1,
		refused: false,
		raw: '{"op":"nudge"}',
		...overrides,
	};
}

interface FakeOptions {
	reply: Decision | Error;
	seen?: DecisionInput[];
}

function fakeModel(name: string, options: FakeOptions): DecisionModel {
	return {
		name,
		costPerCallUsd: 0,
		async decide(input: DecisionInput): Promise<Decision> {
			options.seen?.push(input);
			if (options.reply instanceof Error) throw options.reply;
			return options.reply;
		},
	};
}

function ladder(primary: DecisionModel, escalator: DecisionModel) {
	return { primary, escalator, threshold: THRESHOLD };
}

test("a confident, actionable primary decision is not escalated", async () => {
	const primaryReply = decision({ op: "nudge", argument: "run the suite", confidence: 0.9 });
	const escalatorSeen: DecisionInput[] = [];
	const result = await decideWithEscalation(
		INPUT,
		ladder(fakeModel("primary", { reply: primaryReply }), fakeModel("escalator", { reply: decision({ model: "escalator" }), seen: escalatorSeen })),
	);

	assert.equal(result.escalated, false);
	assert.equal(result.trail.length, 1);
	assert.equal(result.decision, primaryReply);
	assert.equal(result.decision.op, "nudge");
	assert.deepEqual(escalatorSeen, []);
});

test("confidence exactly at the threshold does not escalate", async () => {
	const primaryReply = decision({ confidence: THRESHOLD });
	const result = await decideWithEscalation(
		INPUT,
		ladder(fakeModel("primary", { reply: primaryReply }), fakeModel("escalator", { reply: decision({ model: "escalator" }) })),
	);

	assert.equal(result.escalated, false);
	assert.equal(result.trail.length, 1);
	assert.equal(result.decision, primaryReply);
});

test("confidence below the threshold consults the escalator", async () => {
	const primaryReply = decision({ op: "leave", argument: "unclear", confidence: THRESHOLD - 0.1 });
	const escalatorReply = decision({ op: "flag", argument: "stalled lock wait", confidence: 0.8, model: "escalator" });
	const primarySeen: DecisionInput[] = [];
	const result = await decideWithEscalation(
		INPUT,
		ladder(fakeModel("primary", { reply: primaryReply, seen: primarySeen }), fakeModel("escalator", { reply: escalatorReply })),
	);

	assert.equal(result.escalated, true);
	assert.equal(result.trail.length, 2);
	assert.deepEqual(result.trail, [primaryReply, escalatorReply]);
	assert.equal(result.decision, escalatorReply);
	assert.equal(result.decision.op, "flag");
	assert.deepEqual(primarySeen, [INPUT]);
});

test("a refused primary is escalated even at full confidence", async () => {
	const primaryReply = decision({ op: "flag", argument: "no grounded op", confidence: 1, refused: true });
	const escalatorReply = decision({ op: "declare_done", argument: "acceptance met", confidence: 0.75, model: "escalator" });

	const result = await decideWithEscalation(
		INPUT,
		ladder(fakeModel("primary", { reply: primaryReply }), fakeModel("escalator", { reply: escalatorReply })),
	);

	assert.equal(result.escalated, true);
	assert.equal(result.decision, escalatorReply);
	assert.equal(result.trail.length, 2);
});

test("an escalator that throws falls back to the primary and does not throw", async () => {
	const primaryReply = decision({ op: "nudge", argument: "rerun with --check", confidence: 0.2, raw: '{"op":"nudge"}' });

	const result = await decideWithEscalation(
		INPUT,
		ladder(fakeModel("primary", { reply: primaryReply }), fakeModel("escalator", { reply: new Error("model timed out") })),
	);

	assert.equal(result.decision.op, "nudge");
	assert.equal(result.decision.argument, "rerun with --check (escalation failed: model timed out)");
	assert.equal(result.decision.confidence, 0.2);
	assert.equal(result.decision.raw, '{"op":"nudge"}');
	assert.equal(result.escalated, false);
	assert.equal(result.trail.length, 1);
	assert.notEqual(result.decision, primaryReply);
	assert.equal(primaryReply.argument, "rerun with --check");
});

test("an escalator that refuses returns the primary's decision", async () => {
	const primaryReply = decision({ op: "nudge", argument: "check the mount", confidence: 0.3, raw: '{"op":"nudge"}' });
	const escalatorReply = decision({ op: "flag", argument: "no grounding", confidence: 0.45, model: "escalator", refused: true, raw: '{"op":"flag"}' });

	const result = await decideWithEscalation(
		INPUT,
		ladder(fakeModel("primary", { reply: primaryReply }), fakeModel("escalator", { reply: escalatorReply })),
	);

	assert.equal(result.escalated, true);
	assert.equal(result.trail.length, 2);
	assert.equal(result.decision.op, "nudge");
	assert.equal(result.decision.argument, "check the mount");
	assert.equal(result.decision.confidence, escalatorReply.confidence);
	assert.equal(result.decision.raw, '{"op":"nudge"}\n{"op":"flag"}');
	assert.equal(result.decision.model, "primary");
});

test("a refused primary plus a throwing escalator still returns the primary", async () => {
	const primaryReply = decision({ op: "flag", argument: "needle said no", confidence: 0, refused: true });

	const result = await decideWithEscalation(
		INPUT,
		ladder(fakeModel("primary", { reply: primaryReply }), fakeModel("escalator", { reply: new Error("connection refused") })),
	);

	assert.equal(result.decision.op, "flag");
	assert.equal(result.decision.argument, "needle said no (escalation failed: connection refused)");
	assert.equal(result.escalated, false);
	assert.equal(result.trail.length, 1);
});

test("the escalator sees the same input as the primary", async () => {
	const primarySeen: DecisionInput[] = [];
	const escalatorSeen: DecisionInput[] = [];
	const result = await decideWithEscalation(
		INPUT,
		ladder(
			fakeModel("primary", { reply: decision({ confidence: 0.1 }), seen: primarySeen }),
			fakeModel("escalator", { reply: decision({ model: "escalator" }), seen: escalatorSeen }),
		),
	);

	assert.equal(result.escalated, true);
	assert.equal(primarySeen.length, 1);
	assert.equal(escalatorSeen.length, 1);
	assert.equal(escalatorSeen[0], INPUT);
});
