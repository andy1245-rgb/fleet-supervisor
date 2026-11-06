// Escalation by rule, against fakes: no herdr, no network, no needle engine.
//
// The nine cases at the top are the ladder's nine (test/ladder.test.ts), ported
// case-for-case with the same assertions — only the thing that earns the second
// call changed, from a confidence number to one of the four facts in §4.6.

import assert from "node:assert/strict";
import { test } from "node:test";
import { decideWithEscalation, escalationRule, familyOf, type EscalationRule } from "../src/decision/escalation.ts";
import type { Decision, DecisionInput, DecisionModel } from "../src/decision/types.ts";

/** The ladder's gate, kept here only as a number to prove it routes nothing. */
const RETIRED_THRESHOLD = 0.7;

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
	/** Every call lands here, so "how many escalations" is counted, not assumed. */
	calls?: DecisionInput[];
}

function fakeModel(name: string, options: FakeOptions): DecisionModel {
	return {
		name,
		costPerCallUsd: 0,
		async decide(input: DecisionInput): Promise<Decision> {
			options.seen?.push(input);
			options.calls?.push(input);
			if (options.reply instanceof Error) throw options.reply;
			return options.reply;
		},
	};
}

function pair(primary: DecisionModel, escalator: DecisionModel, triggers?: readonly { kind: string; paneIds: readonly string[] }[]) {
	return triggers === undefined ? { primary, escalator } : { primary, escalator, triggers };
}

// ---------------------------------------------------------------------------
// The nine ladder cases, ported. Same assertions; a rule earns what the threshold
// used to. "Well-formed, grounded, reversible, no cross-agent fact" is the new
// "confident enough".
// ---------------------------------------------------------------------------

test("a well-formed primary decision that no rule fires on is not escalated", async () => {
	const primaryReply = decision({ op: "nudge", argument: "run the suite", confidence: 0.9 });
	const escalatorSeen: DecisionInput[] = [];
	const result = await decideWithEscalation(
		INPUT,
		pair(fakeModel("primary", { reply: primaryReply }), fakeModel("escalator", { reply: decision({ model: "escalator" }), seen: escalatorSeen })),
	);

	assert.equal(result.escalated, false);
	assert.equal(result.escalationFailed, undefined, "no escalation was attempted, so nothing failed");
	assert.equal(result.trail.length, 1);
	assert.equal(result.decision, primaryReply);
	assert.equal(result.decision.op, "nudge");
	assert.deepEqual(escalatorSeen, []);
	assert.equal(result.rule, undefined, "no rule fired, so no rule is recorded");
});

test("confidence at the retired threshold escalates nothing", async () => {
	const primaryReply = decision({ confidence: RETIRED_THRESHOLD });
	const result = await decideWithEscalation(
		INPUT,
		pair(fakeModel("primary", { reply: primaryReply }), fakeModel("escalator", { reply: decision({ model: "escalator" }) })),
	);

	assert.equal(result.escalated, false);
	assert.equal(result.trail.length, 1);
	assert.equal(result.decision, primaryReply);
});

test("a declare_done primary consults the escalator at full confidence", async () => {
	const primaryReply = decision({ op: "declare_done", argument: "unclear", confidence: 1 });
	const escalatorReply = decision({ op: "flag", argument: "stalled lock wait", confidence: 0.8, model: "escalator" });
	const primarySeen: DecisionInput[] = [];
	const result = await decideWithEscalation(
		INPUT,
		pair(fakeModel("primary", { reply: primaryReply, seen: primarySeen }), fakeModel("escalator", { reply: escalatorReply })),
	);

	assert.equal(result.escalated, true);
	assert.equal(result.escalationFailed, false, "a successful escalation is not a failed one");
	assert.equal(result.trail.length, 2);
	assert.deepEqual(result.trail, [primaryReply, escalatorReply]);
	assert.equal(result.decision, escalatorReply);
	assert.equal(result.decision.op, "flag");
	assert.equal(result.rule, "R3_irreversible");
	assert.deepEqual(primarySeen, [INPUT]);
});

test("a refused primary is escalated even at full confidence", async () => {
	const primaryReply = decision({ op: "flag", argument: "model returned unparseable JSON", confidence: 1, refused: true });
	const escalatorReply = decision({ op: "declare_done", argument: "acceptance met", confidence: 0.75, model: "escalator" });

	const result = await decideWithEscalation(INPUT, pair(fakeModel("primary", { reply: primaryReply }), fakeModel("escalator", { reply: escalatorReply })));

	assert.equal(result.escalated, true);
	assert.equal(result.decision, escalatorReply);
	assert.equal(result.trail.length, 2);
});

test("an escalator that throws falls back to the primary and does not throw", async () => {
	const primaryReply = decision({ op: "nudge", argument: "rerun with --check", confidence: 0.2, raw: '{"op":"nudge"}', suppressed: 2 });

	const result = await decideWithEscalation(
		INPUT,
		pair(fakeModel("primary", { reply: primaryReply }), fakeModel("escalator", { reply: new Error("model timed out") })),
	);

	assert.equal(result.decision.op, "nudge");
	assert.equal(result.decision.argument, "rerun with --check (escalation failed: model timed out)");
	assert.equal(result.decision.confidence, 0.2);
	assert.equal(result.decision.raw, '{"op":"nudge"}');
	assert.equal(result.trail.length, 1, "an escalator that threw was never consulted");
	assert.notEqual(result.decision, primaryReply);
	assert.equal(primaryReply.argument, "rerun with --check");
});

test("a failed escalation is reported as an escalation, and as a failed one", async () => {
	const primaryReply = decision({ op: "flag", argument: "unsure which test to run", confidence: 0.1, refused: true });

	const result = await decideWithEscalation(
		INPUT,
		pair(fakeModel("primary", { reply: primaryReply }), fakeModel("escalator", { reply: new Error("OPENROUTER_API_KEY is not set") })),
	);

	// The number that exists to reveal "the primary could not handle this" must not
	// go silent precisely when the escalator is down.
	assert.equal(result.escalated, true);
	assert.equal(result.escalationFailed, true);
	assert.equal(result.decision.op, "flag", "the primary's op is preserved across the outage");
	assert.match(result.decision.argument, /^unsure which test to run \(escalation failed: OPENROUTER_API_KEY is not set\)$/);
	assert.deepEqual(result.trail, [primaryReply], "the trail records what was consulted: the primary alone");
});

test("an escalator that refuses returns the primary's decision", async () => {
	const primaryReply = decision({ op: "nudge", argument: "check the mount", confidence: 0.3, raw: '{"op":"nudge"}', suppressed: 1 });
	const escalatorReply = decision({ op: "flag", argument: "no grounding", confidence: 0.45, model: "escalator", refused: true, raw: '{"op":"flag"}' });

	const result = await decideWithEscalation(INPUT, pair(fakeModel("primary", { reply: primaryReply }), fakeModel("escalator", { reply: escalatorReply })));

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

	const result = await decideWithEscalation(INPUT, pair(fakeModel("primary", { reply: primaryReply }), fakeModel("escalator", { reply: new Error("connection refused") })));

	assert.equal(result.decision.op, "flag");
	assert.equal(result.decision.argument, "needle said no (escalation failed: connection refused)");
	assert.equal(result.escalated, true);
	assert.equal(result.escalationFailed, true);
	assert.equal(result.trail.length, 1);
});

test("the escalator sees the same input as the primary", async () => {
	const primarySeen: DecisionInput[] = [];
	const escalatorSeen: DecisionInput[] = [];
	const result = await decideWithEscalation(
		INPUT,
		pair(
			fakeModel("primary", { reply: decision({ confidence: 0.1, suppressed: 1 }), seen: primarySeen }),
			fakeModel("escalator", { reply: decision({ model: "escalator" }), seen: escalatorSeen }),
		),
	);

	assert.equal(result.escalated, true);
	assert.equal(primarySeen.length, 1);
	assert.equal(escalatorSeen.length, 1);
	assert.equal(escalatorSeen[0], INPUT);
});

// ---------------------------------------------------------------------------
// One test per rule, plus the negative half of R1 and R4 — a rule that fires on
// everything would be the threshold again under a new name.
// ---------------------------------------------------------------------------

test("R1: a refusal with nothing usable in it escalates", async () => {
	const primaryReply = decision({ op: "flag", argument: "model returned no JSON object", confidence: 0, refused: true });
	const result = await decideWithEscalation(INPUT, pair(fakeModel("primary", { reply: primaryReply }), fakeModel("escalator", { reply: decision({ model: "escalator" }) })));

	assert.equal(result.rule, "R1_unparseable");
	assert.equal(result.escalated, true);
});

test("R1: a refusal that already asks for a human does not escalate", async () => {
	const primaryReply = decision({ op: "flag", argument: "needs a human or stronger model", confidence: 0, refused: true });
	const escalatorSeen: DecisionInput[] = [];
	const result = await decideWithEscalation(
		INPUT,
		pair(fakeModel("primary", { reply: primaryReply }), fakeModel("escalator", { reply: decision({ model: "escalator" }), seen: escalatorSeen })),
	);

	assert.equal(result.rule, undefined, "the answer is already the hand-off a second call would produce");
	assert.equal(result.escalated, false);
	assert.deepEqual(escalatorSeen, []);
});

test("R2: a grounding suppression escalates", async () => {
	const primaryReply = decision({ op: "leave", argument: "looks finished", confidence: 1, suppressed: 1 });
	const result = await decideWithEscalation(INPUT, pair(fakeModel("primary", { reply: primaryReply }), fakeModel("escalator", { reply: decision({ op: "leave", model: "escalator" }) })));

	assert.equal(result.rule, "R2_ungrounded");
	assert.equal(result.escalated, true);
});

test("R3: declare_done escalates", async () => {
	const primaryReply = decision({ op: "declare_done", argument: "slice shipped", confidence: 1 });
	const result = await decideWithEscalation(INPUT, pair(fakeModel("primary", { reply: primaryReply }), fakeModel("escalator", { reply: decision({ op: "declare_done", argument: "agreed", model: "escalator" }) })));

	assert.equal(result.rule, "R3_irreversible");
	assert.equal(result.escalated, true);
});

test("R4: a collision that names the pane escalates", async () => {
	const primaryReply = decision({ op: "leave", argument: "on track", confidence: 1 });
	const triggers = [{ kind: "collision", group: "repo", paneIds: ["w2C:p1", "w2C:p2"], detail: "2 agents working in /w/repo" }];
	const result = await decideWithEscalation(INPUT, pair(fakeModel("primary", { reply: primaryReply }), fakeModel("escalator", { reply: decision({ op: "leave", model: "escalator" }) }), triggers));

	assert.equal(result.rule, "R4_cross_agent");
	assert.equal(result.escalated, true);
});

test("R4: a churn that names the pane escalates", async () => {
	const primaryReply = decision({ op: "leave", argument: "on track", confidence: 1 });
	const triggers = [{ kind: "churn", group: "repo", paneIds: ["w2C:p1"], detail: "3 turns in a row reporting phase \"implement\"" }];
	const result = await decideWithEscalation(INPUT, pair(fakeModel("primary", { reply: primaryReply }), fakeModel("escalator", { reply: decision({ op: "leave", model: "escalator" }) }), triggers));

	assert.equal(result.rule, "R4_cross_agent");
	assert.equal(result.escalated, true);
});

test("R4 does not fire on a trigger that names another pane, or on a pane-visible kind", async () => {
	const primaryReply = decision({ op: "leave", argument: "on track", confidence: 1 });
	const otherPane = [{ kind: "collision", group: "elsewhere", paneIds: ["w2C:p9"], detail: "2 agents working in /w/other" }];
	const paneVisible = [
		{ kind: "divergence", group: "repo", paneIds: ["w2C:p1"], detail: "claims working, herdr reports idle" },
		{ kind: "blocked", group: "repo", paneIds: ["w2C:p1"], detail: "blocked while \"pin the pure modules\"" },
	];
	for (const triggers of [otherPane, paneVisible]) {
		const result = await decideWithEscalation(INPUT, pair(fakeModel("primary", { reply: primaryReply }), fakeModel("escalator", { reply: decision({ model: "escalator" }) }), triggers));
		assert.equal(result.rule, undefined, `${triggers[0]?.kind} does not earn a second call`);
		assert.equal(result.escalated, false);
	}
});

// ---------------------------------------------------------------------------
// The structural guarantees: one escalation, one rule, a real family check, and
// no threshold anywhere in the path.
// ---------------------------------------------------------------------------

test("no more than one escalation per decision, even when all four rules fire", async () => {
	const primaryReply = decision({ op: "declare_done", argument: "model returned no JSON object", confidence: 1, refused: true, suppressed: 3 });
	const escalatorReply = decision({ op: "declare_done", argument: "agreed", model: "escalator" });
	const escalatorCalls: DecisionInput[] = [];
	const triggers = [{ kind: "collision", group: "repo", paneIds: ["w2C:p1"] }];
	const result = await decideWithEscalation(
		INPUT,
		pair(fakeModel("primary", { reply: primaryReply }), fakeModel("escalator", { reply: escalatorReply, calls: escalatorCalls }), triggers),
	);

	assert.equal(escalatorCalls.length, 1, "one second call, not four");
	assert.equal(result.trail.length, 2);
	assert.equal(result.escalated, true);
	assert.equal(result.decision, escalatorReply);
});

test("a rule fires once: the escalator's own answer is never escalated again", async () => {
	// The escalator's answer is itself R3-eligible (declare_done). If the rules were
	// re-applied to the second answer this would recurse; it does not, because the
	// function decides once and returns.
	const primaryReply = decision({ op: "declare_done", argument: "slice shipped", confidence: 1 });
	const escalatorReply = decision({ op: "declare_done", argument: "slice shipped, checked", confidence: 1, model: "escalator" });
	const primaryCalls: DecisionInput[] = [];
	const escalatorCalls: DecisionInput[] = [];
	const result = await decideWithEscalation(
		INPUT,
		pair(fakeModel("primary", { reply: primaryReply, calls: primaryCalls }), fakeModel("escalator", { reply: escalatorReply, calls: escalatorCalls })),
	);

	assert.equal(primaryCalls.length, 1);
	assert.equal(escalatorCalls.length, 1, "the second call is not re-judged");
	assert.equal(result.trail.length, 2);
	assert.equal(result.rule, "R3_irreversible");
	assert.equal(result.decision, escalatorReply);
});

test("a same-family escalator is refused with a clear error, before the primary is called", async () => {
	const primaryCalls: DecisionInput[] = [];
	const primary = fakeModel("commandcode:deepseek/deepseek-v4.1-flash", { reply: decision(), calls: primaryCalls });
	const escalator = fakeModel("openrouter:deepseek/deepseek-v4.1-flash", { reply: decision({ model: "escalator" }) });

	await assert.rejects(() => decideWithEscalation(INPUT, pair(primary, escalator)), /same model family/);
	assert.deepEqual(primaryCalls, [], "a misconfigured pair fails before it spends a call");

	// The configured pair is two vendors, and it is not refused.
	assert.equal(familyOf("commandcode:deepseek/deepseek-v4.1-flash"), "deepseek");
	assert.equal(familyOf("openrouter:z-ai/glm-5.3-flash"), "z-ai");
	assert.equal(familyOf("needle3"), "needle3");
	await decideWithEscalation(INPUT, pair(fakeModel("commandcode:deepseek/deepseek-v4.1-flash", { reply: decision() }), fakeModel("openrouter:z-ai/glm-5.3-flash", { reply: decision() })));
});

test("a pair with no falsifier decides alone, and records the rule it could not act on", async () => {
	// The degraded case only: the primary's adapter could not be built, so there is no
	// second model to ask. A pair the operator configured as one model is refused by
	// assertDifferentFamily instead, which the test above covers.
	const primaryReply = decision({ op: "declare_done", argument: "slice shipped", confidence: 1 });
	const result = await decideWithEscalation(INPUT, { primary: fakeModel("primary", { reply: primaryReply }) });

	assert.equal(result.decision, primaryReply);
	assert.equal(result.escalated, false, "nobody was asked, so no escalation is reported");
	assert.equal(result.escalationFailed, undefined, "the escalation was not attempted, so it did not fail");
	assert.equal(result.trail.length, 1);
	assert.equal(result.rule, "R3_irreversible", "the rule that could not be acted on is still on the record");
});

test("escalationFailed is set on throw, and the rule that earned the attempt is kept", async () => {
	const primaryReply = decision({ op: "declare_done", argument: "slice shipped", confidence: 1 });
	const result = await decideWithEscalation(INPUT, pair(fakeModel("primary", { reply: primaryReply }), fakeModel("escalator", { reply: new Error("429 from upstream") })));

	assert.equal(result.escalated, true);
	assert.equal(result.escalationFailed, true);
	assert.equal(result.rule, "R3_irreversible", "a failed attempt still names why it was made");
	assert.equal(result.decision.model, "primary");
	assert.equal(result.decision.op, "declare_done");
	assert.match(result.decision.argument, /^slice shipped \(escalation failed: 429 from upstream\)$/);
});

test("confidence plays no part in any decision path", async () => {
	const confidences = [0, 0.35, RETIRED_THRESHOLD, 0.9, 1];
	const escalatorCalls: DecisionInput[] = [];
	const escalator = fakeModel("escalator", { reply: decision({ op: "leave", model: "escalator" }), calls: escalatorCalls });

	// No rule fires: no confidence value buys a second call, and none is refused one.
	for (const confidence of confidences) {
		const primary = fakeModel("primary", { reply: decision({ op: "nudge", argument: "run the suite", confidence }) });
		const quiet = await decideWithEscalation(INPUT, pair(primary, escalator));
		assert.equal(quiet.escalated, false, `confidence ${confidence} must not escalate on its own`);
	}
	assert.equal(escalatorCalls.length, 0);

	// R3 fires: every confidence value escalates, including a maximal one.
	for (const confidence of confidences) {
		const primary = fakeModel("primary", { reply: decision({ op: "declare_done", argument: "slice shipped", confidence }) });
		const loud = await decideWithEscalation(INPUT, pair(primary, escalator));
		assert.equal(loud.escalated, true, `confidence ${confidence} must not suppress a rule`);
	}
	assert.equal(escalatorCalls.length, confidences.length);
});

test("escalationRule is a pure function of the answer and the facts", () => {
	const cases: { first: Decision; facts: Parameters<typeof escalationRule>[1]; expected: EscalationRule | undefined }[] = [
		{ first: decision({ refused: true, argument: "model returned unparseable JSON" }), facts: { paneId: "w2C:p1" }, expected: "R1_unparseable" },
		{ first: decision({ refused: true, argument: "" }), facts: { paneId: "w2C:p1" }, expected: "R1_unparseable" },
		{ first: decision({ refused: true, argument: "Needs a human." }), facts: { paneId: "w2C:p1" }, expected: undefined },
		{ first: decision({ suppressed: 1, op: "leave" }), facts: { paneId: "w2C:p1" }, expected: "R2_ungrounded" },
		{ first: decision({ suppressed: 0, op: "declare_done" }), facts: { paneId: "w2C:p1" }, expected: "R3_irreversible" },
		{ first: decision({ op: "nudge" }), facts: { paneId: "w2C:p1", triggers: [{ kind: "collision", paneIds: ["w2C:p1"] }] }, expected: "R4_cross_agent" },
		{ first: decision({ op: "nudge" }), facts: { paneId: "w2C:p1", triggers: [{ kind: "blocked", paneIds: ["w2C:p1"] }] }, expected: undefined },
		{ first: decision({ op: "nudge" }), facts: { paneId: "w2C:p1", triggers: [] }, expected: undefined },
		{ first: decision({ op: "nudge" }), facts: { paneId: "w2C:p1" }, expected: undefined },
	];
	for (const entry of cases) assert.equal(escalationRule(entry.first, entry.facts), entry.expected);
});
