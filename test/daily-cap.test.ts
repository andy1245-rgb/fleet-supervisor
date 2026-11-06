// The daily spend cap: the one limit in the supervisor that is not per tick.
//
// Every assertion here is about money not being spent, so the model call count is
// the evidence and the log line is the supporting record — not the other way
// round. A test that only read a string out of `events.jsonl` would pass on a tick
// that spent the money and then said it had not.

import assert from "node:assert/strict";
import { test } from "node:test";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_DAILY_COST_CAP_USD, loadConfig, parseDailyCostCap, type Config } from "../src/manager/config.ts";
import { dailySpend, localDay } from "../src/metrics/daily.ts";
import { tick } from "../src/manager/tick.ts";
import type { Decision, DecisionInput, DecisionModel } from "../src/decision/types.ts";
import type { HerdrAgent, HerdrPort, PromptResult } from "../src/herdr/types.ts";
import type { Notifier } from "../src/notify/telegram.ts";
import { agent } from "./fixtures.ts";

const AGENTS: HerdrAgent[] = [agent("p1", { status: "idle", completionSeq: 2 })];

/** The day the tests live in: fixed, local, midday. Two days either side of it are
 *  named explicitly where a test needs a boundary, so no test depends on when it
 *  runs. */
const NOON = new Date(2026, 10, 6, 12, 0, 0).getTime();
const JUST_AFTER_MIDNIGHT = new Date(2026, 10, 6, 0, 0, 30).getTime();
const LATE_YESTERDAY = new Date(2026, 10, 5, 23, 59, 0).getTime();

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

interface Counter {
	calls: number;
}

function countingModel(name: string, counter: Counter, overrides: Partial<Decision> = {}): DecisionModel {
	return {
		name,
		costPerCallUsd: 0.000138,
		async decide(_input: DecisionInput): Promise<Decision> {
			counter.calls += 1;
			return {
				op: "leave",
				argument: "still on the current step",
				confidence: 0.9,
				model: name,
				costUsd: 0.000138,
				latencyMs: 1,
				refused: false,
				raw: '{"op":"leave"}',
				...overrides,
			};
		},
	};
}

interface Recording {
	notifier: Notifier;
	texts: string[];
}

function recordingNotifier(): Recording {
	const texts: string[] = [];
	return {
		texts,
		notifier: {
			async send(text: string): Promise<void> {
				texts.push(text);
			},
		},
	};
}

function testConfig(dir: string, dailyCostCapUsd: number): Config {
	return {
		intervalMs: 60_000,
		once: true,
		dry: true,
		primary: "fake:primary",
		escalator: "fake:escalator",
		threshold: 0.7,
		effort: "low",
		decisionTimeoutMs: 90_000,
		readLines: 40,
		concurrency: 2,
		maxPromptsPerTick: 3,
		nudgeCooldownMin: 10,
		dailyCostCapUsd,
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

/** A tick row as the supervisor has written them since before the schema existed:
 *  no `schema` key. The cap counts it, because under-counting spend is the only
 *  error that lets a runaway through. */
function seedTick(dir: string, tsMs: number, costUsd: number): void {
	mkdirSync(dir, { recursive: true });
	const row = { ts: new Date(tsMs).toISOString(), kind: "tick", costUsd, models: ["seeded"] };
	appendFileSync(join(dir, "events.jsonl"), `${JSON.stringify(row)}\n`);
}

interface SeqEvent {
	kind: string;
	[key: string]: unknown;
}

function events(dir: string): SeqEvent[] {
	let text: string;
	try {
		text = readFileSync(join(dir, "events.jsonl"), "utf8");
	} catch {
		return [];
	}
	return text
		.split("\n")
		.filter((line) => line.trim() !== "")
		.map((line) => JSON.parse(line) as SeqEvent);
}

function tickRows(dir: string): SeqEvent[] {
	return events(dir).filter((event) => event.kind === "tick");
}

/** The tick row this run wrote: the last one in the file. */
function lastTickRow(dir: string): SeqEvent {
	const rows = tickRows(dir);
	const found = rows[rows.length - 1];
	assert.ok(found !== undefined, "every tick writes a tick row");
	return found;
}

async function runTick(
	dir: string,
	options: { cap: number; now: number; primary: DecisionModel; escalator: DecisionModel; notifier: Notifier; agents?: readonly HerdrAgent[] },
): Promise<{ capped: boolean; decisions: number; costUsd: number }> {
	const saved = { registry: process.env.AGENTFLEET_REGISTRY, state: process.env.AGENTFLEET_STATE };
	process.env.AGENTFLEET_REGISTRY = join(dir, "registry");
	process.env.AGENTFLEET_STATE = join(dir, "marks.json");
	try {
		const report = await tick({
			port: fakePort(options.agents ?? AGENTS),
			notifier: options.notifier,
			config: testConfig(dir, options.cap),
			models: { primary: options.primary, escalator: options.escalator },
			now: () => options.now,
		});
		return { capped: report.capped, decisions: report.decisions.length, costUsd: report.costUsd };
	} finally {
		if (saved.registry === undefined) delete process.env.AGENTFLEET_REGISTRY;
		else process.env.AGENTFLEET_REGISTRY = saved.registry;
		if (saved.state === undefined) delete process.env.AGENTFLEET_STATE;
		else process.env.AGENTFLEET_STATE = saved.state;
	}
}

async function withDir(fn: (dir: string) => Promise<void>): Promise<void> {
	const dir = mkdtempSync(join(tmpdir(), "agentfleet-cap-"));
	try {
		await fn(dir);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

// ------------------------------------------------------------------ the config

test("the cap defaults to $0.50 and is settable, with 0 disabling it", () => {
	assert.equal(DEFAULT_DAILY_COST_CAP_USD, 0.5);
	assert.equal(loadConfig({}).dailyCostCapUsd, 0.5);
	// An empty string is "unset", not a cap of nothing.
	assert.equal(loadConfig({ AGENTFLEET_DAILY_COST_CAP_USD: "" }).dailyCostCapUsd, 0.5);
	assert.equal(loadConfig({ AGENTFLEET_DAILY_COST_CAP_USD: "2.25" }).dailyCostCapUsd, 2.25);
	assert.equal(loadConfig({ AGENTFLEET_DAILY_COST_CAP_USD: "0" }).dailyCostCapUsd, 0, "0 is the documented off switch");
	assert.equal(parseDailyCostCap(" .5 ").toString(), "0.5");
});

test("an unparseable cap is an error at startup, not a silent default", () => {
	// The whole point of the cap is that the operator's belief about his limit matches
	// the supervisor's. A silent fallback to 0.50 breaks that quietly.
	for (const value of ["fifty", "-1", "0x10", "1e3", "0.5abc", "half a dollar", "NaN", "Infinity"]) {
		assert.throws(
			() => loadConfig({ AGENTFLEET_DAILY_COST_CAP_USD: value }),
			/AGENTFLEET_DAILY_COST_CAP_USD/,
			`"${value}" must be rejected by name`,
		);
	}
	assert.throws(() => parseDailyCostCap("fifty"), /non-negative dollar amount such as "0\.50"/);
});

// ------------------------------------------------------------------- the check

test("under the cap, the tick decides exactly as it would without one", async () => {
	await withDir(async (dir) => {
		seedTick(dir, NOON, 0.1);
		const primary: Counter = { calls: 0 };
		const escalator: Counter = { calls: 0 };
		const recording = recordingNotifier();

		const report = await runTick(dir, {
			cap: 0.5,
			now: NOON,
			primary: countingModel("primary", primary),
			escalator: countingModel("escalator", escalator),
			notifier: recording.notifier,
		});

		assert.equal(primary.calls, 1, "the money was there, so the call was made");
		assert.equal(escalator.calls, 0, "a confident primary earns no second call");
		assert.equal(report.capped, false);
		assert.equal(report.decisions, 1);
		assert.equal(recording.texts.length, 0, "a normal tick says nothing about the cap");

		const row = lastTickRow(dir);
		assert.equal(row.capped, undefined, "a normal tick does not claim to be capped");
		assert.deepEqual(row.models, ["primary"]);
		assert.equal(row.dailyCostCapUsd, 0.5, "the cap in force is on the row, so a GUI can read it");
		assert.equal(row.dailyCostUsd, 0.100138, "yesterday's rows are not in it, and this tick's own cost is");
	});
});

test("at the cap, the tick makes zero model calls", async () => {
	await withDir(async (dir) => {
		seedTick(dir, NOON, 0.5);
		const primary: Counter = { calls: 0 };
		const escalator: Counter = { calls: 0 };
		const recording = recordingNotifier();

		const report = await runTick(dir, {
			cap: 0.5,
			now: NOON,
			primary: countingModel("primary", primary),
			escalator: countingModel("escalator", escalator),
			notifier: recording.notifier,
			// Three panes that moved: without the cap this is three decisions and up to
			// three notifications. The cap is one row and one message.
			agents: [agent("p1", { completionSeq: 2 }), agent("p2", { completionSeq: 2 }), agent("p3", { completionSeq: 2 })],
		});

		assert.equal(primary.calls, 0, "the cap is checked before the first model call");
		assert.equal(escalator.calls, 0);
		assert.equal(report.capped, true);
		assert.equal(report.decisions, 0);
		assert.equal(report.costUsd, 0);

		const row = lastTickRow(dir);
		assert.deepEqual(row.models, [], "no model was consulted, and the row says so");
		assert.equal(row.capped, true);
		assert.equal(row.costUsd, 0);
		assert.equal(row.agents, 3, "the tick still looked at the fleet; it only refused to spend on it");
		assert.match(String(row.capReason), /\$0\.500000 spent today/);
		assert.match(String(row.capReason), /\$0\.50 cap/);

		assert.equal(recording.texts.length, 1, "notified once for the tick, not once per pane");
		assert.match(recording.texts[0] ?? "", /daily spend cap/);
	});
});

test("a capped tick appends no decision row", async () => {
	await withDir(async (dir) => {
		seedTick(dir, NOON, 0.75);
		const recording = recordingNotifier();
		await runTick(dir, {
			cap: 0.5,
			now: NOON,
			primary: countingModel("primary", { calls: 0 }),
			escalator: countingModel("escalator", { calls: 0 }),
			notifier: recording.notifier,
		});

		// The invariant SPEC §4.9b states for the quota case: a decision row for a call
		// that was not made is a record of something that did not happen.
		assert.deepEqual(
			events(dir).filter((event) => event.kind === "decision"),
			[],
			"no decision row for a call the cap prevented",
		);
		assert.deepEqual(
			events(dir).filter((event) => event.kind === "action"),
			[],
			"and no action row either, since an action comes from a decision",
		);
		assert.equal(events(dir).filter((event) => event.kind === "tick").length, 2, "the seeded row plus this tick's one");
	});
});

test("a capped day notifies once, not once per tick", async () => {
	await withDir(async (dir) => {
		seedTick(dir, NOON, 0.9);
		const recording = recordingNotifier();
		const primary: Counter = { calls: 0 };

		for (let i = 0; i < 3; i += 1) {
			await runTick(dir, {
				cap: 0.5,
				now: NOON,
				primary: countingModel("primary", primary),
				escalator: countingModel("escalator", { calls: 0 }),
				notifier: recording.notifier,
			});
		}

		assert.equal(primary.calls, 0);
		assert.equal(recording.texts.length, 1, "three capped ticks, one message: 1,440 a day is a channel nobody reads");
		assert.equal(tickRows(dir).filter((row) => row.capped === true).length, 3, "and every capped tick is still on the record");
	});
});

test("cap 0 disables the feature: the tick spends past any amount", async () => {
	await withDir(async (dir) => {
		seedTick(dir, NOON, 5);
		const primary: Counter = { calls: 0 };
		const recording = recordingNotifier();

		const report = await runTick(dir, {
			cap: 0,
			now: NOON,
			primary: countingModel("primary", primary),
			escalator: countingModel("escalator", { calls: 0 }),
			notifier: recording.notifier,
		});

		assert.equal(primary.calls, 1, "0 is the documented off switch");
		assert.equal(report.capped, false);
		assert.equal(recording.texts.length, 0);

		const row = lastTickRow(dir);
		assert.equal(row.capped, undefined);
		assert.equal(row.dailyCostCapUsd, undefined, "no cap on the row when there is no cap");
	});
});

// ---------------------------------------------------------------------- the day

test("the count is per local day: yesterday is yesterday", () => {
	withDirSync((dir) => {
		seedTick(dir, LATE_YESTERDAY, 5);
		seedTick(dir, JUST_AFTER_MIDNIGHT, 0.01);

		const yesterday = dailySpend(join(dir, "events.jsonl"), LATE_YESTERDAY + 30_000);
		assert.equal(yesterday.spentUsd, 5);
		assert.equal(yesterday.day, localDay(LATE_YESTERDAY));

		const today = dailySpend(join(dir, "events.jsonl"), NOON);
		assert.equal(today.spentUsd, 0.01, "the $5 belongs to yesterday");
		assert.equal(today.day, localDay(NOON));
		assert.notEqual(today.day, yesterday.day);
	});
});

test("a day boundary resets the total, so midnight is not a permanent stop", async () => {
	await withDir(async (dir) => {
		// Yesterday blew the cap by ten times; today has not spent anything yet.
		seedTick(dir, LATE_YESTERDAY, 5);
		const primary: Counter = { calls: 0 };

		const report = await runTick(dir, {
			cap: 0.5,
			now: JUST_AFTER_MIDNIGHT,
			primary: countingModel("primary", primary),
			escalator: countingModel("escalator", { calls: 0 }),
			notifier: recordingNotifier().notifier,
		});

		assert.equal(primary.calls, 1, "twenty-nine seconds into the new day the cap is clear again");
		assert.equal(report.capped, false);
	});
});

test("the rollup counts a pre-schema tick row, because under-counting is the unsafe direction", () => {
	withDirSync((dir) => {
		// No `schema` key: `parseEvent` would reject this line, and a cap built on
		// `parseEvent` would read the log as free.
		seedTick(dir, NOON, 0.25);
		assert.equal(dailySpend(join(dir, "events.jsonl"), NOON).spentUsd, 0.25);
	});
});

test("only tick rows price a day: decision rows would double-count the same money", () => {
	withDirSync((dir) => {
		mkdirSync(dir, { recursive: true });
		const write = (row: Record<string, unknown>): void => {
			appendFileSync(join(dir, "events.jsonl"), `${JSON.stringify({ ts: new Date(NOON).toISOString(), ...row })}\n`);
		};
		write({ kind: "tick", costUsd: 0.02 });
		write({ kind: "decision", costUsd: 0.01 });
		write({ kind: "inspection", costUsd: 0.005 });
		write({ kind: "action", latencyMs: 3 });

		assert.equal(dailySpend(join(dir, "events.jsonl"), NOON).spentUsd, 0.02, "the tick row already contains the decision's cost");
		assert.equal(dailySpend(join(dir, "events.jsonl"), NOON).ticks, 1);
	});
});

test("a half-written line is not counted until its newline arrives", () => {
	withDirSync((dir) => {
		mkdirSync(dir, { recursive: true });
		const log = join(dir, "events.jsonl");
		const row = JSON.stringify({ schema: 2, kind: "tick", ts: new Date(NOON).toISOString(), costUsd: 0.4, models: [] });
		// A tick writing right now: the bytes are there, the line is not finished.
		writeFileSync(log, row);
		assert.equal(dailySpend(log, NOON).spentUsd, 0, "half a row is not money spent");

		appendFileSync(log, "\n");
		assert.equal(dailySpend(log, NOON).spentUsd, 0.4, "the same bytes, once the newline makes it a row");
	});
});

/** The synchronous twin of `withDir`, for the assertions that only read the log. */
function withDirSync(fn: (dir: string) => void): void {
	const dir = mkdtempSync(join(tmpdir(), "agentfleet-cap-"));
	try {
		fn(dir);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}
