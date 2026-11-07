// What a real tick does on this box after phase 3: the primary is the hosted model, and
// there is no OPENROUTER_API_KEY here, so every rule-fired escalation fails. That has to
// degrade loudly and softly — the primary's opinion survives, the tick reports the
// failure instead of reporting no escalation, and a notification that throws cannot take
// the tick's state with it.
//
// The escalator is the real OpenRouter adapter with no key: it rejects before any socket
// opens, which is exactly the failure this box produces, without a network.

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { Decision, DecisionInput, DecisionModel } from "../src/decision/types.ts";
import { openRouterModel } from "../src/decision/openrouter.ts";
import type { HerdrAgent, HerdrPort, PromptResult } from "../src/herdr/types.ts";
import type { Config } from "../src/manager/config.ts";
import { tick } from "../src/manager/tick.ts";
import type { Notifier } from "../src/notify/telegram.ts";
import { agent } from "./fixtures.ts";

const AGENTS: HerdrAgent[] = [agent("p1", { status: "idle", completionSeq: 2 })];

const PORT: HerdrPort = {
	async list(): Promise<HerdrAgent[]> {
		return [...AGENTS];
	},
	async get(paneId: string): Promise<HerdrAgent | undefined> {
		return AGENTS.find((entry) => entry.paneId === paneId);
	},
	async read(): Promise<string> {
		return "$ npm test\nok 489 tests";
	},
	async prompt(): Promise<PromptResult> {
		return { disposition: "accepted" };
	},
};

/** Every send throws, the way `telegramNotifier` does on a non-2xx, and counts how many
 *  times it was asked so "the notify path ran" is assertable rather than assumed. */
function brokenNotifier(): Notifier & { sent: number } {
	const notifier = {
		sent: 0,
		async send(): Promise<void> {
			notifier.sent += 1;
			throw new Error("telegram 502: Bad Gateway");
		},
	};
	return notifier;
}

/** A refusal with no usable argument, which is R1 — the same shape the local engine's
 *  22/22 refusals had, and the reason the default primary was the top of this phase. */
const FLAG: Decision = { op: "flag", argument: "", confidence: 0, model: "commandcode:deepseek/deepseek-v4.1-flash", costUsd: 0, latencyMs: 1, refused: true, raw: "" };

function primary(): DecisionModel {
	return {
		name: FLAG.model,
		costPerCallUsd: 0,
		async decide(_input: DecisionInput): Promise<Decision> {
			return FLAG;
		},
	};
}

function config(dir: string): Config {
	return {
		intervalMs: 60_000,
		once: true,
		// Not dry: `saveMarks` only runs in a real tick, and that is the write the broken
		// notification must not cost.
		dry: false,
		primary: "commandcode/deepseek/deepseek-v4.1-flash",
		escalator: "z-ai/glm-5.3-flash",
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

test("an escalation with no key reports the failure and keeps the primary's op", async () => {
	const dir = mkdtempSync(join(tmpdir(), "agentfleet-nokey-"));
	const saved = { registry: process.env.AGENTFLEET_REGISTRY, state: process.env.AGENTFLEET_STATE };
	process.env.AGENTFLEET_REGISTRY = join(dir, "registry");
	process.env.AGENTFLEET_STATE = join(dir, "marks.json");
	const notifier = brokenNotifier();
	try {
		// `apiKey: ""` is the no-key state this box is in, and it rejects before any
		// socket opens, so the failure is the real one and the test needs no network.
		const escalator = openRouterModel({ model: "z-ai/glm-5.3-flash", apiKey: "" });
		const report = await tick({ port: PORT, notifier, config: config(dir), models: { primary: primary(), escalator } });

		assert.equal(report.decisions.length, 1);
		assert.equal(report.escalated, 1, "the primary was insufficient, so the tick escalated");
		assert.equal(report.escalationFailed, 1, "and the attempt is reported as failed, not as absent");
		assert.equal(report.decisions[0]?.op, "flag", "the primary's op survives the outage");
		assert.equal(report.decisions[0]?.model, FLAG.model, "and the decision is still attributed to the primary");
		assert.match(report.decisions[0]?.argument ?? "", /escalation failed: OPENROUTER_API_KEY is not set/);

		const rows = readFileSync(join(dir, "events.jsonl"), "utf8")
			.split("\n")
			.filter((line) => line.trim() !== "")
			.map((line) => JSON.parse(line) as { kind?: string; escalated?: boolean | number; escalationFailed?: boolean | number });
		const written = rows.find((row) => row.kind === "tick");
		assert.equal(written?.escalated, 1, "the tick row counts the escalation");
		assert.equal(written?.escalationFailed, 1, "and counts it as a failure");
		const perDecision = rows.find((row) => row.kind === "decision");
		assert.equal(perDecision?.escalated, true);
		assert.equal(perDecision?.escalationFailed, true);

		assert.ok(notifier.sent > 0, "the failed escalation is notified, not silent");
		assert.equal(existsSync(join(dir, "marks.json")), true, "a throwing notifier cannot cost the tick its marks");
	} finally {
		if (saved.registry === undefined) delete process.env.AGENTFLEET_REGISTRY;
		else process.env.AGENTFLEET_REGISTRY = saved.registry;
		if (saved.state === undefined) delete process.env.AGENTFLEET_STATE;
		else process.env.AGENTFLEET_STATE = saved.state;
		rmSync(dir, { recursive: true, force: true });
	}
});
