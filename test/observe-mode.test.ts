// Observe mode, pinned by what it must NOT do.
//
// The promise is negative — nothing leaves the process — so the tests are mostly
// assertions about absence: no prompt reached the port, no notification reached the
// channel, no ask was parked, no claim was written. The positive half is what makes
// the absence worth having: every stage-0 verdict and every model proposal is in the
// log, and each decision is recorded as a question awaiting the pane's next state,
// which a `dry` tick deliberately does not do.

import assert from "node:assert/strict";
import { test } from "node:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { tick, type TickReport } from "../src/manager/tick.ts";
import type { Config } from "../src/manager/config.ts";
import type { Decision, DecisionInput, DecisionModel } from "../src/decision/types.ts";
import type { HerdrAgent, HerdrPort, PromptResult } from "../src/herdr/types.ts";
import type { Notifier } from "../src/notify/telegram.ts";
import { agent } from "./fixtures.ts";

const CWD = process.cwd();
const AGENTS: HerdrAgent[] = [agent("p1", { status: "idle", completionSeq: 2, cwd: CWD, foregroundCwd: CWD })];

interface Recorder {
	sent: string[];
	notifier: Notifier;
}

function recorder(): Recorder {
	const sent: string[] = [];
	return {
		sent,
		notifier: {
			async send(text: string): Promise<void> {
				sent.push(text);
			},
		},
	};
}

function port(prompts: string[]): HerdrPort {
	return {
		async list(): Promise<HerdrAgent[]> {
			return [...AGENTS];
		},
		async get(paneId: string): Promise<HerdrAgent | undefined> {
			return AGENTS.find((entry) => entry.paneId === paneId);
		},
		async read(): Promise<string> {
			return "$ npm test\nok 187 tests";
		},
		async prompt(paneId: string, text: string): Promise<PromptResult> {
			prompts.push(`${paneId}: ${text}`);
			return { disposition: "accepted" };
		},
	};
}

function model(name: string, reply: Decision): DecisionModel {
	return {
		name,
		costPerCallUsd: 0,
		async decide(_input: DecisionInput): Promise<Decision> {
			return reply;
		},
	};
}

function decision(overrides: Partial<Decision> = {}): Decision {
	return {
		op: "nudge",
		argument: "carry on with step 3",
		confidence: 0.9,
		model: "primary",
		costUsd: 0.001,
		latencyMs: 2,
		refused: false,
		raw: '{"op":"nudge"}',
		...overrides,
	};
}

function config(dir: string, overrides: Partial<Config> = {}): Config {
	return {
		intervalMs: 60_000,
		once: true,
		dry: false,
		observe: true,
		primary: "fake:primary",
		escalator: "fake:escalator",
		threshold: 0.7,
		effort: "low",
		decisionTimeoutMs: 90_000,
		readLines: 40,
		concurrency: 2,
		maxPromptsPerTick: 3,
		nudgeCooldownMin: 10,
		dailyCostCapUsd: 0,
		globalSpendCapUsd: null,
		usageLogPath: join(dir, "usage.jsonl"),
		inspector: "off",
		maxInspectionsPerTick: 0,
		// `always` would hold every action; observe has to produce the same absence
		// either way, so the strictest policy is the one to test under.
		ask: "always",
		askByGroup: {},
		eventsPath: join(dir, "events.jsonl"),
		triggerHistoryPath: join(dir, "triggers.json"),
		cooldownsPath: join(dir, "cooldowns.json"),
		asksPath: join(dir, "asks.jsonl"),
		policyPath: join(dir, "policy.json"),
		watchdog: false,
		...overrides,
	};
}

interface Row {
	kind: string;
	[key: string]: unknown;
}

function rows(dir: string): Row[] {
	const path = join(dir, "events.jsonl");
	if (!existsSync(path)) return [];
	return readFileSync(path, "utf8")
		.split("\n")
		.filter((line) => line.trim() !== "")
		.map((line) => JSON.parse(line) as Row);
}

async function withDir(fn: (dir: string) => Promise<void>): Promise<void> {
	const dir = mkdtempSync(join(tmpdir(), "agentfleet-observe-"));
	const saved = { registry: process.env.AGENTFLEET_REGISTRY, state: process.env.AGENTFLEET_STATE };
	process.env.AGENTFLEET_REGISTRY = join(dir, "registry");
	process.env.AGENTFLEET_STATE = join(dir, "marks.json");
	try {
		await fn(dir);
	} finally {
		if (saved.registry === undefined) delete process.env.AGENTFLEET_REGISTRY;
		else process.env.AGENTFLEET_REGISTRY = saved.registry;
		if (saved.state === undefined) delete process.env.AGENTFLEET_STATE;
		else process.env.AGENTFLEET_STATE = saved.state;
		rmSync(dir, { recursive: true, force: true });
	}
}

async function run(dir: string, reply: Decision, overrides: Partial<Config> = {}): Promise<{ report: TickReport; prompts: string[]; channel: Recorder }> {
	const prompts: string[] = [];
	const channel = recorder();
	const report = await tick({
		port: port(prompts),
		notifier: channel.notifier,
		config: config(dir, overrides),
		models: { primary: model("primary", reply), escalator: model("escalator", reply) },
	});
	return { report, prompts, channel };
}

test("a nudge that would have been sent is recorded and not sent", async () => {
	await withDir(async (dir) => {
		// `never` so the gate does not hold it: this test is about the path that would
		// have reached the pane, which is the one the hold policy keeps it off.
		const { report, prompts, channel } = await run(dir, decision(), { ask: "never" });
		assert.deepEqual(prompts, [], "no prompt reaches the port");
		assert.deepEqual(channel.sent, [], "no notification reaches the channel");
		assert.equal(report.promptsSent, 0);
		assert.equal(report.observe, true);
		assert.equal(report.decisions.length, 1, "the model was still consulted");

		const observed = rows(dir).find((row) => row.kind === "nudge_observed");
		assert.ok(observed, "the prompt that would have gone out is in the log");
		assert.equal(observed.text, "carry on with step 3");

		const action = rows(dir).find((row) => row.kind === "action");
		assert.equal(action?.disposition, "observed");
		assert.equal(action?.reason, "would-nudge");
		assert.equal(rows(dir).some((row) => row.kind === "nudge"), false, "no sent row exists");
	});
});

test("a held action is not parked, and its would-be hold is in the log", async () => {
	await withDir(async (dir) => {
		const { report } = await run(dir, decision());
		assert.equal(report.asks, 0, "nothing was parked for the operator");
		assert.equal(existsSync(join(dir, "asks.jsonl")), false, "asks.jsonl was not even created");
		assert.ok(rows(dir).some((row) => row.kind === "ask_observed"), "the gate's verdict is recorded");
	});
});

test("a declare_done writes no claim", async () => {
	await withDir(async (dir) => {
		const { report } = await run(dir, decision({ op: "declare_done", argument: "finished the migration" }), { ask: "never" });
		assert.equal(report.decisions[0]?.op, "declare_done");
		const registry = join(dir, "registry");
		assert.equal(existsSync(registry), false, "no claim file was written");
		assert.ok(rows(dir).some((row) => row.kind === "done_observed"));
	});
});

test("observe judges and records pending; dry does neither", async () => {
	await withDir(async (dir) => {
		const { report } = await run(dir, decision({ op: "leave", argument: "on track" }));
		assert.equal(report.decisions[0]?.op, "leave");
		const pendingPath = join(dir, "pending.json");
		assert.equal(existsSync(pendingPath), true, "the decision is a question awaiting the pane's next state");
		const pending = JSON.parse(readFileSync(pendingPath, "utf8")) as Record<string, { paneId: string; op: string }>;
		assert.equal(pending.p1?.op, "leave");
	});
	await withDir(async (dir) => {
		await run(dir, decision({ op: "leave", argument: "on track" }), { observe: false, dry: true });
		assert.equal(existsSync(join(dir, "pending.json")), false, "a dry tick leaves no question to join later");
	});
});

test("marks advance in observe, so the next tick sees a steady fleet", async () => {
	await withDir(async (dir) => {
		await run(dir, decision({ op: "leave", argument: "on track" }));
		assert.equal(existsSync(join(dir, "marks.json")), true, "a supervisor that never advances would re-decide everything every minute");
	});
});

test("every pane gets a stage-0 verdict, spoken or not", async () => {
	await withDir(async (dir) => {
		const { report } = await run(dir, decision({ op: "leave", argument: "on track" }));
		assert.equal(report.stage0Panes, 1);
		const verdicts = rows(dir).filter((row) => row.kind === "stage0");
		assert.equal(verdicts.length, 1, "silence is recorded too, not inferred from a missing row");
		assert.equal(typeof verdicts[0]?.rule, "string");
		assert.equal(typeof verdicts[0]?.why, "string");
		assert.equal(verdicts[0]?.paneId, "p1");
		// This test process's own working directory is attributed to the pane, so the
		// verdict is about real processes: whatever it says, it is answerable.
		assert.equal(report.stage0Spoke + (report.stage0Panes - report.stage0Spoke), 1);
	});
});

test("the tick row says observe, which is not what dry says", async () => {
	await withDir(async (dir) => {
		await run(dir, decision({ op: "leave", argument: "on track" }));
		const row = rows(dir).find((entry) => entry.kind === "tick");
		assert.equal(row?.observe, true);
		assert.equal(row?.dry, false);
	});
	await withDir(async (dir) => {
		await run(dir, decision({ op: "leave", argument: "on track" }), { observe: false, dry: true });
		const row = rows(dir).find((entry) => entry.kind === "tick");
		// Explicitly false rather than absent: the row was written by a build that knows
		// about observe, and a reader should not have to infer that from a missing key.
		assert.equal(row?.observe, false);
		assert.equal(row?.dry, true);
	});
});

test("the notification that would have been sent is logged instead, and flag is included", async () => {
	await withDir(async (dir) => {
		const { channel } = await run(dir, decision({ op: "flag", argument: "the mount is dead" }));
		assert.deepEqual(channel.sent, [], "a flag's alert is a message, and no message leaves");
		const suppressed = rows(dir).find((row) => row.kind === "notify_observed");
		assert.ok(suppressed, "the alert that would have been sent is in the log");
		assert.equal(suppressed.level, "alert");
		const action = rows(dir).find((row) => row.kind === "action");
		assert.equal(action?.disposition, "observed");
		assert.equal(action?.reason, "would-flag");
	});
});

test("the idle-turn rule is reachable from a tick: silence accumulates until it fires", async () => {
	await withDir(async (dir) => {
		// Three ticks with the pane not moving. `detect` counts ticks in which a pane
		// did not change, so the third observe tick is where an idle pane crosses
		// IDLE_TICKS. A rule that exists but is never handed a clock is a rule that
		// never fires in the system; this is the test that would catch that.
		const { IDLE_TICKS, IDLE_RULE } = await import("../src/watchdog/needs-a-word.ts");
		const seen: Array<{ rule: string; speak: boolean }> = [];
		for (let i = 0; i < IDLE_TICKS + 1; i += 1) {
			await run(dir, decision({ op: "leave", argument: "on track" }));
			const verdicts = rows(dir).filter((row) => row.kind === "stage0");
			const last = verdicts[verdicts.length - 1];
			if (last) seen.push({ rule: String(last.rule), speak: last.speak === true });
		}
		const fired = seen.filter((entry) => entry.rule === IDLE_RULE && entry.speak);
		assert.ok(fired.length > 0, `no idle-turn verdict across ${IDLE_TICKS + 1} ticks: ${JSON.stringify(seen)}`);
	});
});
