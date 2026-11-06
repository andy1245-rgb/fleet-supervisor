// One tick, against fakes: a fake port that reports one agent, a fake ladder pair
// that fails on demand, a temp state dir the report is written to. No herdr, no
// network, no needle engine.

import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { tick, type TickReport } from "../src/manager/tick.ts";
import type { Config } from "../src/manager/config.ts";
import type { Decision, DecisionInput, DecisionModel } from "../src/decision/types.ts";
import type { HerdrAgent, HerdrPort, PromptResult } from "../src/herdr/types.ts";
import type { Notifier } from "../src/notify/telegram.ts";
import { agent } from "./fixtures.ts";

const AGENTS: HerdrAgent[] = [agent("p1", { status: "idle", completionSeq: 2 })];

const SILENT: Notifier = { async send(): Promise<void> {} };

function fakePort(agents: readonly HerdrAgent[]): HerdrPort {
	return {
		async list(): Promise<HerdrAgent[]> {
			return [...agents];
		},
		async get(paneId: string): Promise<HerdrAgent | undefined> {
			return agents.find((entry) => entry.paneId === paneId);
		},
		async read(): Promise<string> {
			return "$ npm test\nok 187 tests";
		},
		async prompt(): Promise<PromptResult> {
			return { disposition: "accepted" };
		},
	};
}

function decision(overrides: Partial<Decision> = {}): Decision {
	return {
		op: "leave",
		argument: "still on the current step",
		confidence: 0.2,
		model: "primary",
		costUsd: 0,
		latencyMs: 1,
		refused: false,
		raw: '{"op":"leave"}',
		...overrides,
	};
}

function fakeModel(name: string, reply: Decision | Error): DecisionModel {
	return {
		name,
		costPerCallUsd: 0,
		async decide(_input: DecisionInput): Promise<Decision> {
			if (reply instanceof Error) throw reply;
			return reply;
		},
	};
}

function testConfig(dir: string): Config {
	return {
		intervalMs: 60_000,
		once: true,
		dry: true,
		primary: "fake:primary",
		escalator: "fake:escalator",
		threshold: 0.7,
		readLines: 40,
		concurrency: 2,
		maxPromptsPerTick: 3,
		nudgeCooldownMin: 10,
		inspector: "off",
		maxInspectionsPerTick: 0,
		ask: "never",
		askByGroup: {},
		eventsPath: join(dir, "events.jsonl"),
		triggerHistoryPath: join(dir, "triggers.json"),
		cooldownsPath: join(dir, "cooldowns.json"),
		asksPath: join(dir, "asks.jsonl"),
		policyPath: join(dir, "policy.json"),
		watchdog: false,
	};
}

interface SeqEvent {
	kind: string;
	[key: string]: unknown;
}

function events(dir: string): SeqEvent[] {
	return readFileSync(join(dir, "events.jsonl"), "utf8")
		.split("\n")
		.filter((line) => line.trim() !== "")
		.map((line) => JSON.parse(line) as SeqEvent);
}

function tickEvent(dir: string): SeqEvent {
	const found = events(dir).find((event) => event.kind === "tick");
	assert.ok(found !== undefined, "every tick writes one tick event");
	return found;
}

/** Runs one tick in a throwaway state dir: the manager reads its registry and its
 *  marks from the environment, so both are pointed at the temp dir and restored. */
async function runTick(dir: string, primary: DecisionModel, escalator: DecisionModel, agents: readonly HerdrAgent[] = AGENTS): Promise<TickReport> {
	const saved = { registry: process.env.AGENTFLEET_REGISTRY, state: process.env.AGENTFLEET_STATE };
	process.env.AGENTFLEET_REGISTRY = join(dir, "registry");
	process.env.AGENTFLEET_STATE = join(dir, "marks.json");
	try {
		return await tick({ port: fakePort(agents), notifier: SILENT, config: testConfig(dir), models: { primary, escalator } });
	} finally {
		if (saved.registry === undefined) delete process.env.AGENTFLEET_REGISTRY;
		else process.env.AGENTFLEET_REGISTRY = saved.registry;
		if (saved.state === undefined) delete process.env.AGENTFLEET_STATE;
		else process.env.AGENTFLEET_STATE = saved.state;
	}
}

async function withDir(fn: (dir: string) => Promise<void>): Promise<void> {
	const dir = mkdtempSync(join(tmpdir(), "agentfleet-tick-"));
	try {
		await fn(dir);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

test("an escalator outage is counted as an escalation, and as a failed one", async () => {
	await withDir(async (dir) => {
		// A needle refusal carries no usable argument, which is R1: the primary could not
		// stand behind an op, so the second call is earned regardless of any number.
		const report = await runTick(
			dir,
			fakeModel("primary", decision({ op: "leave", argument: "", confidence: 0.1, refused: true })),
			fakeModel("escalator", new Error("OPENROUTER_API_KEY is not set")),
		);

		assert.equal(report.decisions.length, 1);
		assert.equal(report.escalated, 1, "the primary was found insufficient, so the tick escalated");
		assert.equal(report.escalationFailed, 1, "and the escalation is reported as failed, not as absent");
		assert.equal(report.decisions[0]?.op, "leave", "the primary's op survives the outage");
		assert.match(report.decisions[0]?.argument ?? "", /escalation failed: OPENROUTER_API_KEY is not set/);

		const written = tickEvent(dir);
		assert.equal(written.escalated, 1);
		assert.equal(written.escalationFailed, 1);

		const perDecision = events(dir).find((event) => event.kind === "decision");
		assert.equal(perDecision?.escalated, true);
		assert.equal(perDecision?.escalationFailed, true);
	});
});

test("a successful escalation is one escalation and zero failures", async () => {
	await withDir(async (dir) => {
		const report = await runTick(
			dir,
			fakeModel("primary", decision({ op: "leave", argument: "", confidence: 0.1, refused: true })),
			fakeModel("escalator", decision({ op: "leave", argument: "the escalator agrees", confidence: 0.8, model: "escalator" })),
		);

		assert.equal(report.escalated, 1);
		assert.equal(report.escalationFailed, 0, "a healthy escalator is not counted as an outage");
		assert.equal(report.decisions[0]?.model, "escalator");

		const written = tickEvent(dir);
		assert.equal(written.escalated, 1);
		assert.equal(written.escalationFailed, 0);
	});
});

test("a confident primary escalates nothing and fails nothing", async () => {
	await withDir(async (dir) => {
		const report = await runTick(
			dir,
			fakeModel("primary", decision({ op: "leave", confidence: 0.9 })),
			fakeModel("escalator", new Error("must not be called")),
		);

		assert.equal(report.escalated, 0);
		assert.equal(report.escalationFailed, 0);
		assert.equal(report.decisions[0]?.argument, "still on the current step");

		const written = tickEvent(dir);
		assert.equal(written.escalated, 0);
		assert.equal(written.escalationFailed, 0);
	});
});

test("a collision trigger reaches the decision, so the pane it names escalates", async () => {
	await withDir(async (dir) => {
		// R4 is the one rule the decision call cannot see for itself: it is a fact about
		// the fleet, handed down by the trigger scan. Two working panes in one tree.
		const colliding = [agent("p1", { status: "working", completionSeq: 2 }), agent("p2", { status: "working", completionSeq: 2 })];
		const report = await runTick(
			dir,
			fakeModel("primary", decision({ op: "leave", confidence: 1 })),
			fakeModel("escalator", decision({ op: "leave", argument: "the escalator sees the collision", model: "escalator" })),
			colliding,
		);

		assert.equal(report.triggers.filter((trigger) => trigger.kind === "collision").length, 1, "one collision, naming both panes");
		assert.equal(report.decisions.length, 2);
		assert.equal(report.escalated, 2, "the collision earned a second call on each pane it names");
		assert.deepEqual(
			report.decisions.map((entry) => entry.argument),
			["the escalator sees the collision", "the escalator sees the collision"],
		);
	});
});
