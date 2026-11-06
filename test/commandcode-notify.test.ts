// A notification is not allowed to be the reason a tick loses its state. Telegram
// throws on any non-2xx and on a network error, and every send happens before
// `saveMarks` — so an unwrapped send turns "the phone was offline" into "the marks
// were never written" and the same moves get re-decided next tick.
//
// This is the prerequisite phase 7 depends on, tested on its own because the failure
// is about ordering inside one tick, not about the wire.

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { Config } from "../src/manager/config.ts";
import type { Decision, DecisionInput, DecisionModel } from "../src/decision/types.ts";
import type { HerdrAgent, HerdrPort, PromptResult } from "../src/herdr/types.ts";
import type { Notifier } from "../src/notify/telegram.ts";
import { tick } from "../src/manager/tick.ts";
import { agent } from "./fixtures.ts";

const AGENTS: HerdrAgent[] = [agent("p1", { status: "idle", completionSeq: 2 })];

/** Every send fails, the way `telegramNotifier` fails on a non-2xx. */
const BROKEN: Notifier = {
	async send(): Promise<void> {
		throw new Error("telegram 502: Bad Gateway");
	},
};

const PORT: HerdrPort = {
	async list(): Promise<HerdrAgent[]> {
		return [...AGENTS];
	},
	async get(paneId: string): Promise<HerdrAgent | undefined> {
		return AGENTS.find((entry) => entry.paneId === paneId);
	},
	async read(): Promise<string> {
		return "$ npm test\nok 453 tests";
	},
	async prompt(): Promise<PromptResult> {
		return { disposition: "accepted" };
	},
};

function model(reply: Decision): DecisionModel {
	return {
		name: "fake:primary",
		costPerCallUsd: 0,
		async decide(_input: DecisionInput): Promise<Decision> {
			return reply;
		},
	};
}

function config(dir: string): Config {
	return {
		intervalMs: 60_000,
		once: true,
		// Not dry: `saveMarks` only runs in a real tick, and that is the write this test
		// is about.
		dry: false,
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

const FLAG: Decision = { op: "flag", argument: "the pane needs a human", confidence: 0.9, model: "fake:primary", costUsd: 0, latencyMs: 1, refused: false, raw: '{"op":"flag"}' };

test("a throwing notifier does not abort the tick before its marks are saved", async () => {
	const dir = mkdtempSync(join(tmpdir(), "agentfleet-notify-"));
	const saved = { registry: process.env.AGENTFLEET_REGISTRY, state: process.env.AGENTFLEET_STATE };
	process.env.AGENTFLEET_REGISTRY = join(dir, "registry");
	process.env.AGENTFLEET_STATE = join(dir, "marks.json");
	try {
		const report = await tick({ port: PORT, notifier: BROKEN, config: config(dir), models: { primary: model(FLAG), escalator: { ...model(FLAG), name: "fake:escalator" } } });
		// The decision was taken and reported, so the tick ran past the send that threw.
		assert.equal(report.decisions.length, 1);
		assert.equal(report.decisions[0]?.op, "flag");

		// saveMarks ran: the pane's sequence is recorded even though the alert was lost.
		const marksPath = join(dir, "marks.json");
		assert.equal(existsSync(marksPath), true, "saveMarks must run even when a notification throws");
		const marks = JSON.parse(readFileSync(marksPath, "utf8")) as Record<string, { completionSeq: number }>;
		assert.equal(marks.p1?.completionSeq, 2);

		// And the tick row — written after saveMarks — exists.
		const kinds = readFileSync(join(dir, "events.jsonl"), "utf8")
			.split("\n")
			.filter((line) => line.trim() !== "")
			.map((line) => (JSON.parse(line) as { kind?: string }).kind);
		assert.equal(kinds.includes("tick"), true, "the tick row is written after saveMarks");
		assert.equal(kinds.includes("flag"), true);
	} finally {
		if (saved.registry === undefined) delete process.env.AGENTFLEET_REGISTRY;
		else process.env.AGENTFLEET_REGISTRY = saved.registry;
		if (saved.state === undefined) delete process.env.AGENTFLEET_STATE;
		else process.env.AGENTFLEET_STATE = saved.state;
		rmSync(dir, { recursive: true, force: true });
	}
});
