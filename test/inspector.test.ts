// The inspector is pure by construction, so everything here runs against plain
// objects: a fake model that returns a fixed string, a fake spawn that returns a
// fixed child output. No pi process, no herdr call, no network.

import assert from "node:assert/strict";
import { test } from "node:test";
import { BRIEF_BUDGET, buildBrief, inspect, DEEP_TIMEOUT_MS, type InspectContext } from "../src/manager/inspector.ts";
import type { Decision, DecisionInput, DecisionModel } from "../src/decision/types.ts";
import type { Claim } from "../src/fleet/registry.ts";
import type { Trigger } from "../src/manager/triggers.ts";
import { agent, claim } from "./fixtures.ts";

const GROUP = "agentFleet";

const CHURN: Trigger = {
	kind: "churn",
	group: GROUP,
	paneIds: ["p1"],
	detail: '3 turns in a row reporting phase "implement" and "wrote test/detect.test.ts"',
};

const COLLISION: Trigger = {
	kind: "collision",
	group: GROUP,
	paneIds: ["p1", "p2"],
	detail: `2 agents working in ${"/home/andrew/work/agentFleet"}`,
};

const AGENTS = [agent("p1", { status: "working" }), agent("p2", { status: "working" })];
const CLAIMS: ReadonlyMap<string, Claim> = new Map<string, Claim>([
	["p1", claim("p1", { group: GROUP })],
	["p2", claim("p2", { group: GROUP })],
]);
const TAILS: ReadonlyMap<string, string> = new Map<string, string>([
	["p1", "$ npm test\nok 160 tests"],
	["p2", "$ npm test\nok 160 tests"],
]);

interface FakeModel {
	model: DecisionModel;
	inputs: DecisionInput[];
}

function fakeModel(raw: string, overrides: Partial<Decision> = {}): FakeModel {
	const inputs: DecisionInput[] = [];
	return {
		inputs,
		model: {
			name: "fake:inspector",
			costPerCallUsd: 0,
			async decide(input: DecisionInput): Promise<Decision> {
				inputs.push(input);
				return {
					op: "flag",
					argument: "",
					confidence: 0,
					model: "fake-model",
					costUsd: 0.0002,
					latencyMs: 1,
					refused: false,
					raw,
					...overrides,
				};
			},
		},
	};
}

function context(model: DecisionModel, overrides: Partial<InspectContext> = {}): InspectContext {
	return { agents: AGENTS, claims: CLAIMS, tails: TAILS, model, ...overrides };
}

function answer(overrides: Record<string, unknown> = {}): string {
	return JSON.stringify({
		diagnosis: "both agents are editing the same files",
		recommendation: "hold p2 until p1 finishes",
		evidence: ["p1 claims phase implement", "p2 claims phase implement"],
		confidence: 0.72,
		proposed: { paneId: "p1", op: "nudge", argument: "run the tests before editing further" },
		...overrides,
	});
}

/** The brief's tail section for one pane, so its width can be measured. */
function tailOf(brief: string, paneId: string): string {
	const block = brief.split("\n\n").find((entry) => entry.startsWith(`--- pane ${paneId} `));
	assert.ok(block !== undefined, `no block for ${paneId}`);
	const at = block.indexOf("\ntail:\n");
	assert.ok(at >= 0, `no tail section for ${paneId}`);
	return block.slice(at + "\ntail:\n".length);
}

// ------------------------------------------------------------------ the brief

test("the brief names every pane in the trigger and its group, and nobody else", () => {
	const agents = [
		agent("p1", { status: "working" }),
		agent("p2", { status: "working" }),
		agent("p3", { status: "idle" }),
		agent("p9", { status: "working" }),
	];
	const claims: ReadonlyMap<string, Claim> = new Map<string, Claim>([
		["p1", claim("p1", { group: GROUP })],
		["p2", claim("p2", { group: GROUP })],
		["p3", claim("p3", { group: GROUP, phase: "verify", state: "waiting", last: "check the ladder" })],
		["p9", claim("p9", { group: "anotherRepo" })],
	]);
	const tails: ReadonlyMap<string, string> = new Map<string, string>([
		["p1", "p1 last line"],
		["p2", "p2 last line"],
		["p3", ""],
		["p9", "p9 last line"],
	]);

	const brief = buildBrief(COLLISION, agents, claims, tails);
	assert.match(brief, /^trigger: collision in agentFleet/);
	assert.match(brief, /detail: 2 agents working in \/home\/andrew\/work\/agentFleet/);
	assert.match(brief, /panes: 3 \(2 named by the trigger, 1 in the same group\)/);

	assert.match(brief, /--- pane p1 \(named by the trigger\) ---/);
	assert.match(brief, /--- pane p2 \(named by the trigger\) ---/);
	assert.match(brief, /--- pane p3 \(same group as agentFleet\) ---/);
	assert.doesNotMatch(brief, /p9/, "another group's pane is not this trigger's business");

	assert.match(brief, /cwd: \/home\/andrew\/work\/agentFleet/);
	assert.match(brief, /herdr: working/);
	assert.match(brief, /claim: phase implement, state working, last "wrote test\/detect\.test\.ts"/);
	assert.match(brief, /claim: phase verify, state waiting, last "check the ladder"/);
	assert.match(brief, /tail:\np1 last line/);
	assert.match(brief, /tail:\n\(empty\)/, "a read that returned nothing says so");
});

test("a pane with no claim file says so instead of inventing one", () => {
	const brief = buildBrief(COLLISION, [agent("p1", { status: "blocked" })], new Map(), new Map());

	assert.match(brief, /herdr: blocked/);
	assert.match(brief, /claim: none \(no claim file\)/);
	assert.match(brief, /tail:\n\(not read\)/);
});

test("the brief stays inside its character bound however large the tails are", () => {
	const paneIds = ["p1", "p2", "p3", "p4", "p5", "p6"];
	const agents = paneIds.map((paneId) => agent(paneId, { status: "working" }));
	const claims: ReadonlyMap<string, Claim> = new Map<string, Claim>(
		paneIds.map((paneId) => [paneId, claim(paneId, { group: GROUP })]),
	);
	const tails: ReadonlyMap<string, string> = new Map<string, string>(
		paneIds.map((paneId) => [paneId, `${paneId} head\n${"x".repeat(5000)}\n${paneId} last`]),
	);

	const brief = buildBrief(COLLISION, agents, claims, tails);

	assert.ok(brief.length <= BRIEF_BUDGET, `brief is ${brief.length} chars, bound is ${BRIEF_BUDGET}`);
	for (const paneId of paneIds) {
		assert.ok(brief.includes(`--- pane ${paneId} `), `${paneId} must not be dropped`);
		assert.ok(tailOf(brief, paneId).length > 0, `${paneId} keeps some tail`);
	}
});

test("truncation shortens the tails far from the trigger before the ones near it", () => {
	const agents = [
		agent("p1", { status: "working" }),
		agent("p2", { status: "working" }),
		agent("p3", { status: "working" }),
		agent("p4", { status: "working" }),
	];
	const claims: ReadonlyMap<string, Claim> = new Map<string, Claim>(
		agents.map((entry) => [entry.paneId, claim(entry.paneId, { group: GROUP })]),
	);
	const tails: ReadonlyMap<string, string> = new Map<string, string>(
		agents.map((entry) => [entry.paneId, `${entry.paneId} head\n${"y".repeat(4000)}\n${entry.paneId} last`]),
	);

	const brief = buildBrief(COLLISION, agents, claims, tails);

	const near = tailOf(brief, "p1").length;
	const other = tailOf(brief, "p3").length;
	assert.ok(brief.length <= BRIEF_BUDGET, `brief is ${brief.length} chars`);
	assert.ok(near > other, `the pane named by the trigger keeps more tail (${near}) than a peer (${other})`);
	assert.match(brief, /\[\.\.\.truncated \d+ chars\.\.\.\]/, "a cut tail says it was cut");
	assert.ok(tailOf(brief, "p1").endsWith("p1 last"), "the ending is the evidence, so the ending is kept");
});

test("a group too large for the budget loses peers, never the panes the trigger named", () => {
	const paneIds = ["p1", "p2", ...Array.from({ length: 60 }, (_, index) => `x${index}`)];
	const agents = paneIds.map((paneId) => agent(paneId, { status: "working" }));
	const claims: ReadonlyMap<string, Claim> = new Map<string, Claim>(
		paneIds.map((paneId) => [paneId, claim(paneId, { group: GROUP })]),
	);
	const tails: ReadonlyMap<string, string> = new Map<string, string>(paneIds.map((paneId) => [paneId, `${paneId} tail`]));

	const brief = buildBrief(COLLISION, agents, claims, tails);

	assert.ok(brief.length <= BRIEF_BUDGET, `brief is ${brief.length} chars, bound is ${BRIEF_BUDGET}`);
	assert.match(brief, /--- pane p1 \(named by the trigger\) ---/);
	assert.match(brief, /--- pane p2 \(named by the trigger\) ---/);
	assert.match(brief, /more in the group not read/, "the brief says what it stopped reading");
});

// ----------------------------------------------------------------- parsing

test("a well-formed answer survives with its proposal intact", async () => {
	const fake = fakeModel(answer());

	const finding = await inspect(COLLISION, context(fake.model));

	assert.equal(finding.trigger, COLLISION);
	assert.equal(finding.diagnosis, "both agents are editing the same files");
	assert.equal(finding.recommendation, "hold p2 until p1 finishes");
	assert.deepEqual(finding.evidence, ["p1 claims phase implement", "p2 claims phase implement"]);
	assert.equal(finding.confidence, 0.72);
	assert.deepEqual(finding.proposed, { paneId: "p1", op: "nudge", argument: "run the tests before editing further" });
	assert.equal(finding.model, "fake-model");
	assert.equal(finding.costUsd, 0.0002);
});

test("an unknown op is rejected and the finding keeps no action", async () => {
	const fake = fakeModel(answer({ proposed: { paneId: "p1", op: "restart", argument: "restart p1" } }));

	const finding = await inspect(COLLISION, context(fake.model));

	assert.equal(finding.proposed, undefined);
	assert.equal(finding.diagnosis, "both agents are editing the same files", "the report survives the rejected action");
});

test("a pane outside the trigger is rejected and the finding keeps no action", async () => {
	const fake = fakeModel(answer({ proposed: { paneId: "p7", op: "nudge", argument: "run the tests" } }));

	const finding = await inspect(COLLISION, context(fake.model));

	assert.equal(finding.proposed, undefined);
	assert.equal(finding.trigger.paneIds.includes("p7"), false);
});

test("leave is not an action, so it is not a proposal either", async () => {
	const fake = fakeModel(answer({ proposed: { paneId: "p1", op: "leave", argument: "it is fine" } }));

	assert.equal((await inspect(COLLISION, context(fake.model))).proposed, undefined);
});

test("confidence outside 0..1 is rejected and the finding keeps no action", async () => {
	for (const confidence of [4, -1, Number.NaN]) {
		const fake = fakeModel(answer({ confidence }));
		const finding = await inspect(COLLISION, context(fake.model));

		assert.equal(finding.proposed, undefined, `confidence ${confidence} must strip the proposal`);
		assert.ok(finding.confidence >= 0 && finding.confidence <= 1, `confidence ${finding.confidence} must be clamped`);
	}
});

test("a cheap model that answers in prose proposes nothing", async () => {
	const prose = "Both panes are editing the same file, so one of them should stop for a moment.";
	const fake = fakeModel(prose);

	const finding = await inspect(COLLISION, context(fake.model));

	assert.equal(finding.proposed, undefined);
	assert.equal(finding.confidence, 0);
	assert.equal(finding.diagnosis, prose);
	assert.match(finding.recommendation, /no action proposed/);
});

test("an empty answer is reported as nothing rather than as an empty diagnosis", async () => {
	const fake = fakeModel("");

	const finding = await inspect(COLLISION, context(fake.model));

	assert.equal(finding.diagnosis, "the inspector returned nothing");
	assert.equal(finding.proposed, undefined);
});

test("a decision-shaped answer on a one-pane trigger names that pane", async () => {
	const fake = fakeModel(JSON.stringify({ op: "nudge", argument: "stop repeating the same edit", confidence: 0.8 }));

	const finding = await inspect(CHURN, context(fake.model));

	assert.deepEqual(finding.proposed, { paneId: "p1", op: "nudge", argument: "stop repeating the same edit" });
});

test("a decision-shaped answer never invents a target on a multi-pane trigger", async () => {
	const fake = fakeModel(JSON.stringify({ op: "nudge", argument: "stop repeating the same edit", confidence: 0.8 }));

	const finding = await inspect(COLLISION, context(fake.model));

	assert.equal(finding.proposed, undefined);
});

test("the brief reaches the model in the field the adapter does not clip", async () => {
	const fake = fakeModel(answer());

	await inspect(COLLISION, context(fake.model));

	const input = fake.inputs[0];
	assert.ok(input !== undefined, "the model was called once");
	assert.equal(fake.inputs.length, 1);
	assert.match(input.acceptance ?? "", /--- pane p1 \(named by the trigger\) ---/);
	assert.match(input.acceptance ?? "", /=== inspector task ===/);
	assert.equal(input.tail, "", "the adapter clips tail to 700 chars, so the brief cannot live there");
});

test("a model outage is a finding, not a failed tick", async () => {
	const model: DecisionModel = {
		name: "openrouter:fake",
		costPerCallUsd: 0,
		async decide(): Promise<Decision> {
			throw new Error("OPENROUTER_API_KEY is not set");
		},
	};

	const finding = await inspect(COLLISION, context(model));

	assert.match(finding.diagnosis, /could not run: OPENROUTER_API_KEY is not set/);
	assert.equal(finding.recommendation, "no action proposed: nothing was inspected");
	assert.equal(finding.proposed, undefined);
	assert.equal(finding.model, "openrouter:fake");
});

// -------------------------------------------------------------------- deep

test("deep mode is one bounded pi child that is told what it may read", async () => {
	const fake = fakeModel(answer());
	const calls: Array<{ args: string[]; timeoutMs: number }> = [];

	const finding = await inspect(
		COLLISION,
		context(fake.model, {
			deep: true,
			spawnPi: async (args: string[], timeoutMs: number) => {
				calls.push({ args, timeoutMs });
				return { ok: true, stdout: `looked around\n${answer({ diagnosis: "p2 is blocked on a lock" })}` };
			},
		}),
	);

	const call = calls[0];
	assert.ok(call !== undefined, "the child was spawned once");
	assert.equal(calls.length, 1);
	assert.deepEqual(call.args.slice(0, 4), ["-p", "--no-session", "--tools", "bash"]);
	assert.match(call.args[4] ?? "", /trigger: collision in agentFleet/);
	assert.match(call.args[4] ?? "", /herdr agent read <paneId>/);
	assert.match(call.args[4] ?? "", /Never prompt, focus, close/);
	assert.equal(call.timeoutMs, DEEP_TIMEOUT_MS);

	assert.equal(fake.inputs.length, 0, "a deep answer costs no model call");
	assert.equal(finding.diagnosis, "p2 is blocked on a lock");
	assert.equal(finding.model, "pi:deep");
	assert.equal(finding.proposed?.paneId, "p1");
});

test("deep mode falls back to cheap when pi cannot be spawned", async () => {
	const fake = fakeModel(answer());

	const finding = await inspect(
		COLLISION,
		context(fake.model, { deep: true, spawnPi: async () => ({ ok: false, stdout: "", stderr: "spawn pi ENOENT" }) }),
	);

	assert.equal(fake.inputs.length, 1, "the cheap call is the floor, not an error");
	assert.equal(finding.proposed?.paneId, "p1");
});

test("deep mode falls back to cheap when the child answers in prose", async () => {
	const fake = fakeModel(answer());

	const finding = await inspect(
		COLLISION,
		context(fake.model, { deep: true, spawnPi: async () => ({ ok: true, stdout: "I could not decide anything useful." }) }),
	);

	assert.equal(fake.inputs.length, 1);
	assert.equal(finding.diagnosis, "both agents are editing the same files");
	assert.equal(finding.proposed?.paneId, "p1");
});

test("a deep answer is validated exactly like a cheap one", async () => {
	const fake = fakeModel(answer());

	const finding = await inspect(
		COLLISION,
		context(fake.model, {
			deep: true,
			spawnPi: async () => ({ ok: true, stdout: answer({ proposed: { paneId: "p8", op: "nudge", argument: "go" } }) }),
		}),
	);

	assert.equal(finding.proposed, undefined);
	assert.equal(fake.inputs.length, 0, "a parsed deep answer does not fall back");
});
