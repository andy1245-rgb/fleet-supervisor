// The global spend cap: the account's UTC day, across every agent, not only the
// supervisor.
//
// Same evidence rule as ./daily-cap.test.ts: every assertion about money not being
// spent is a model call count on a stub, and the log line is corroboration. A test
// that only read `events.jsonl` would pass on a tick that spent the money and then
// wrote that it had not.
//
// The failure this file is most concerned with is the quiet one: a cap that reads an
// unreadable source as `$0.00`, decides the fleet is under budget, and spends. That
// case has a test of its own, twice — once for a missing file and once for a file
// that exists but cannot be read — because the whole value of the cap is that its
// number means what it says.

import assert from "node:assert/strict";
import { test } from "node:test";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_DAILY_COST_CAP_USD, DEFAULT_GLOBAL_SPEND_CAP_USD, loadConfig, parseGlobalSpendCap, type Config } from "../src/manager/config.ts";
import { dailySpend, utcDay } from "../src/metrics/daily.ts";
import { globalSpend } from "../src/metrics/global.ts";
import { tick } from "../src/manager/tick.ts";
import type { Decision, DecisionInput, DecisionModel } from "../src/decision/types.ts";
import type { HerdrAgent, HerdrPort, PromptResult } from "../src/herdr/types.ts";
import type { Notifier } from "../src/notify/telegram.ts";
import { agent } from "./fixtures.ts";

/** Midday UTC on a fixed date. The global cap measures UTC days, so every test here
 *  states its instants in UTC rather than in the box's timezone. */
const NOON_UTC = Date.UTC(2026, 10, 6, 12, 0, 0);

const MOVED: readonly HerdrAgent[] = [agent("p1", { completionSeq: 2 })];

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

function countingModel(name: string, counter: Counter): DecisionModel {
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
			};
		},
	};
}

function recordingNotifier(): { notifier: Notifier; texts: string[] } {
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

/** `console.error` is how the fail-open path is loud, so it is captured rather than
 *  printed: asserting on it is the difference between a warning and a log line nobody
 *  checks. */
function captureStderr(): { lines: string[]; restore: () => void } {
	const original = console.error;
	const lines: string[] = [];
	console.error = (...args: unknown[]): void => {
		lines.push(args.map((arg) => String(arg)).join(" "));
	};
	return {
		lines,
		restore: () => {
			console.error = original;
		},
	};
}

function testConfig(dir: string, fleetCapUsd: number, globalCapUsd: number | null, usageLogPath = join(dir, "usage.jsonl")): Config {
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
		dailyCostCapUsd: fleetCapUsd,
		globalSpendCapUsd: globalCapUsd,
		usageLogPath,
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

/** One `usage.jsonl` row, in the shape the usage extension writes:
 *  `{ ts, model, sessionId, input, output, cacheRead, cacheWrite, cost }`. `model`
 *  is `"unknown"` on every real row, which is why nothing here depends on it. */
function seedUsage(dir: string, tsMs: number, costUsd: number): void {
	mkdirSync(dir, { recursive: true });
	const row = { ts: tsMs, model: "unknown", sessionId: "s1", input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: costUsd };
	appendFileSync(join(dir, "usage.jsonl"), `${JSON.stringify(row)}\n`);
}

/** One tick row, as the supervisor writes them: no `schema` key needed, and the
 *  rollup takes it either way. */
function seedTick(dir: string, tsMs: number, costUsd: number, extra: Record<string, unknown> = {}): void {
	mkdirSync(dir, { recursive: true });
	const row = { ts: new Date(tsMs).toISOString(), kind: "tick", costUsd, models: ["seeded"], ...extra };
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

function lastTickRow(dir: string): SeqEvent {
	const rows = events(dir).filter((event) => event.kind === "tick");
	const found = rows[rows.length - 1];
	assert.ok(found !== undefined, "every tick writes a tick row");
	return found;
}

interface RunOptions {
	dir: string;
	now: number;
	fleetCap: number;
	globalCap: number | null;
	primary: DecisionModel;
	escalator: DecisionModel;
	notifier: Notifier;
	agents?: readonly HerdrAgent[];
	usageLogPath?: string;
}

async function runTick(options: RunOptions): Promise<{ capped: boolean; capScope?: "fleet" | "global"; decisions: number }> {
	const saved = { registry: process.env.AGENTFLEET_REGISTRY, state: process.env.AGENTFLEET_STATE };
	process.env.AGENTFLEET_REGISTRY = join(options.dir, "registry");
	process.env.AGENTFLEET_STATE = join(options.dir, "marks.json");
	try {
		const report = await tick({
			port: fakePort(options.agents ?? MOVED),
			notifier: options.notifier,
			config: testConfig(options.dir, options.fleetCap, options.globalCap, options.usageLogPath),
			models: { primary: options.primary, escalator: options.escalator },
			now: () => options.now,
		});
		return { capped: report.capped, capScope: report.capScope, decisions: report.decisions.length };
	} finally {
		if (saved.registry === undefined) delete process.env.AGENTFLEET_REGISTRY;
		else process.env.AGENTFLEET_REGISTRY = saved.registry;
		if (saved.state === undefined) delete process.env.AGENTFLEET_STATE;
		else process.env.AGENTFLEET_STATE = saved.state;
	}
}

async function withDir(fn: (dir: string) => Promise<void>): Promise<void> {
	const dir = mkdtempSync(join(tmpdir(), "agentfleet-global-"));
	try {
		await fn(dir);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

function withDirSync(fn: (dir: string) => void): void {
	const dir = mkdtempSync(join(tmpdir(), "agentfleet-global-"));
	try {
		fn(dir);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

// ------------------------------------------------------------------ the config

test("both caps ship off, and the wide one does not arm the narrow one", () => {
	assert.equal(DEFAULT_GLOBAL_SPEND_CAP_USD, null, "the mechanism exists and is switched off");
	assert.equal(loadConfig({}).globalSpendCapUsd, null);
	assert.equal(loadConfig({ AGENTFLEET_GLOBAL_SPEND_CAP_USD: "" }).globalSpendCapUsd, null, "an empty var is unset");
	assert.equal(loadConfig({ AGENTFLEET_GLOBAL_SPEND_CAP_USD: "0" }).globalSpendCapUsd, 0, "0 is the other way to say off");
	assert.equal(loadConfig({ AGENTFLEET_GLOBAL_SPEND_CAP_USD: "20" }).globalSpendCapUsd, 20);
	assert.equal(loadConfig({ AGENTFLEET_GLOBAL_SPEND_CAP_USD: " .5 " }).globalSpendCapUsd, 0.5);
	assert.equal(loadConfig({}).dailyCostCapUsd, DEFAULT_DAILY_COST_CAP_USD, "the fleet's own cap ships off too");
	assert.equal(loadConfig({}).dailyCostCapUsd, null);
	// Two independent switches: arming one must not arm the other, or an operator who
	// set the account-wide limit would find the supervisor refusing on a number he
	// never wrote.
	assert.equal(loadConfig({ AGENTFLEET_GLOBAL_SPEND_CAP_USD: "20" }).dailyCostCapUsd, null);
	assert.equal(loadConfig({ AGENTFLEET_DAILY_COST_CAP_USD: "0.50" }).globalSpendCapUsd, null);
	assert.match(loadConfig({}).usageLogPath, /usage\.jsonl$/, "the wide cap reads the agent log by default");
	assert.equal(loadConfig({ AGENTFLEET_USAGE_LOG: "/tmp/other.jsonl" }).usageLogPath, "/tmp/other.jsonl");
});

test("an unparseable global cap is an error at startup, by name", () => {
	for (const value of ["twenty", "-1", "0x10", "1e3", "0.5abc", "half a day", "NaN", "Infinity"]) {
		assert.throws(
			() => loadConfig({ AGENTFLEET_GLOBAL_SPEND_CAP_USD: value }),
			/AGENTFLEET_GLOBAL_SPEND_CAP_USD/,
			`"${value}" must be rejected by name`,
		);
	}
	assert.throws(() => parseGlobalSpendCap("twenty"), /non-negative dollar amount such as "20"/);
});

test("whichever enabled cap is lower wins, and a tie goes to the fleet cap", async () => {
	// Both caps at the same limit and both reached: one configuration must not record two
	// different scopes, so the narrower one wins and it wins every time.
	await withDir(async (dir) => {
		seedUsage(dir, NOON_UTC, 30);
		seedTick(dir, NOON_UTC, 30);
		const report = await runTick({
			dir,
			now: NOON_UTC,
			fleetCap: 10,
			globalCap: 10,
			primary: countingModel("primary", { calls: 0 }),
			escalator: countingModel("escalator", { calls: 0 }),
			notifier: recordingNotifier().notifier,
		});
		assert.equal(report.capScope, "fleet");
		assert.equal(lastTickRow(dir).globalSpendUsd, 60, "the agents' $30 plus the supervisor's $30");
	});
});

// ------------------------------------------------------------------ the off switch

test("a disabled cap never blocks, never notifies, never reads the source, and writes no cap row", async () => {
	for (const cap of [null, 0]) {
		await withDir(async (dir) => {
			// $50 of agent spend and a used tick row, either of which would fire a cap that
			// was on. The usage path does not exist, and nothing may care.
			seedUsage(dir, NOON_UTC, 50);
			seedTick(dir, NOON_UTC, 3);
			const primary: Counter = { calls: 0 };
			const recording = recordingNotifier();
			const stderr = captureStderr();
			try {
				const report = await runTick({
					dir,
					now: NOON_UTC,
					fleetCap: 0,
					globalCap: cap,
					primary: countingModel("primary", primary),
					escalator: countingModel("escalator", { calls: 0 }),
					notifier: recording.notifier,
				});
				assert.equal(primary.calls, 1, "a disabled cap does not stop the call");
				assert.equal(report.capped, false);
				assert.equal(recording.texts.length, 0, "and says nothing");
				assert.deepEqual(stderr.lines, [], "and does not even read the source: no read was attempted");

				const row = lastTickRow(dir);
				assert.equal(row.capped, undefined);
				assert.equal(row.globalCostCapUsd, undefined, "no cap on the row when there is no cap");
				assert.equal(row.globalSpendUsd, undefined);
				assert.equal(row.globalSpendSource, undefined);
			} finally {
				stderr.restore();
			}
		});
	}
});

// ------------------------------------------------------------------- the check

test("set and exceeded: zero model calls, one notification, no decision row", async () => {
	await withDir(async (dir) => {
		seedUsage(dir, NOON_UTC, 30);
		seedTick(dir, NOON_UTC, 0.01);
		const primary: Counter = { calls: 0 };
		const escalator: Counter = { calls: 0 };
		const recording = recordingNotifier();

		const report = await runTick({
			dir,
			now: NOON_UTC,
			fleetCap: 0,
			globalCap: 20,
			primary: countingModel("primary", primary),
			escalator: countingModel("escalator", escalator),
			notifier: recording.notifier,
			agents: [agent("p1", { completionSeq: 2 }), agent("p2", { completionSeq: 2 }), agent("p3", { completionSeq: 2 })],
		});

		assert.equal(primary.calls, 0, "the global cap stopped the tick before its first model call");
		assert.equal(escalator.calls, 0);
		assert.equal(report.capped, true);
		assert.equal(report.capScope, "global");
		assert.equal(report.decisions, 0);

		const row = lastTickRow(dir);
		assert.deepEqual(row.models, [], "no model was consulted, and the row says so");
		assert.equal(row.capped, true);
		assert.equal(row.capScope, "global", "the row records which cap fired");
		assert.equal(row.costUsd, 0);
		assert.equal(row.agents, 3, "the tick still looked at the fleet");
		assert.equal(row.globalCostCapUsd, 20);
		assert.equal(row.globalSpendUsd, 30.01, "the agents' $30 plus the supervisor's $0.01");
		assert.equal(row.dailyCostCapUsd, undefined, "the fleet's own cap is off, so it writes nothing");
		assert.match(String(row.capReason), /global spend cap reached/);
		assert.match(String(row.capReason), /AGENTFLEET_GLOBAL_SPEND_CAP_USD/);
		assert.match(String(row.capReason), /\$30\.010000 spent across every agent/);
		assert.match(String(row.capReason), /\$20\.00 cap/);

		assert.equal(recording.texts.length, 1, "one message for the day, not one per pane");
		assert.match(recording.texts[0] ?? "", /global spend cap/);

		assert.deepEqual(events(dir).filter((event) => event.kind === "decision"), [], "no decision row for a call not made");
		assert.deepEqual(events(dir).filter((event) => event.kind === "action"), [], "and no action row either");
	});
});

test("set and not exceeded: the tick decides normally and the row carries both numbers", async () => {
	await withDir(async (dir) => {
		seedUsage(dir, NOON_UTC, 5);
		const primary: Counter = { calls: 0 };
		const recording = recordingNotifier();

		const report = await runTick({
			dir,
			now: NOON_UTC,
			fleetCap: 0,
			globalCap: 20,
			primary: countingModel("primary", primary),
			escalator: countingModel("escalator", { calls: 0 }),
			notifier: recording.notifier,
		});

		assert.equal(primary.calls, 1, "the money was there, so the call was made");
		assert.equal(report.capped, false);
		assert.equal(recording.texts.length, 0);

		const row = lastTickRow(dir);
		assert.equal(row.capped, undefined);
		assert.equal(row.globalCostCapUsd, 20, "the cap in force, for the page to read");
		assert.equal(row.globalSpendUsd, 5.000138, "the day's agents plus this tick's own cost");
		assert.equal(row.globalSpendSource, "usage.jsonl");
	});
});

test("the supervisor's own spend counts toward the global total", async () => {
	await withDir(async (dir) => {
		// Nothing from any agent: the whole $25 is this supervisor's tick rows. If the
		// global cap measured only the agent log, this tick would run.
		seedUsage(dir, NOON_UTC, 0);
		seedTick(dir, NOON_UTC, 25);
		const primary: Counter = { calls: 0 };

		const report = await runTick({
			dir,
			now: NOON_UTC,
			fleetCap: 0,
			globalCap: 20,
			primary: countingModel("primary", primary),
			escalator: countingModel("escalator", { calls: 0 }),
			notifier: recordingNotifier().notifier,
		});

		assert.equal(primary.calls, 0);
		assert.equal(report.capScope, "global");
		assert.equal(lastTickRow(dir).globalSpendUsd, 25);
	});
});

test("both caps reached: the lower one fires", async () => {
	// The fleet cap is the lower of the two, so it is the one that fires.
	await withDir(async (dir) => {
		seedUsage(dir, NOON_UTC, 30);
		seedTick(dir, NOON_UTC, 0.9);
		const recording = recordingNotifier();
		const report = await runTick({
			dir,
			now: NOON_UTC,
			fleetCap: 0.5,
			globalCap: 20,
			primary: countingModel("primary", { calls: 0 }),
			escalator: countingModel("escalator", { calls: 0 }),
			notifier: recording.notifier,
		});
		assert.equal(report.capScope, "fleet", "0.50 is lower than 20");
		const row = lastTickRow(dir);
		assert.match(String(row.capReason), /AGENTFLEET_DAILY_COST_CAP_USD/);
		assert.equal(row.globalCostCapUsd, 20, "the wide cap is still on the row: it is in force, it just was not the one that fired");
		assert.match(recording.texts[0] ?? "", /daily spend cap/);
	});

	// Same two caps, swapped: now the global one is lower and it is the one that fires.
	await withDir(async (dir) => {
		seedUsage(dir, NOON_UTC, 0.6);
		seedTick(dir, NOON_UTC, 25);
		const recording = recordingNotifier();
		const report = await runTick({
			dir,
			now: NOON_UTC,
			fleetCap: 20,
			globalCap: 0.5,
			primary: countingModel("primary", { calls: 0 }),
			escalator: countingModel("escalator", { calls: 0 }),
			notifier: recording.notifier,
		});
		assert.equal(report.capScope, "global", "0.50 is lower than 20");
		const row = lastTickRow(dir);
		assert.match(String(row.capReason), /AGENTFLEET_GLOBAL_SPEND_CAP_USD/);
		assert.equal(row.dailyCostCapUsd, 20);
		assert.match(recording.texts[0] ?? "", /global spend cap/);
	});
});

test("a capped UTC day notifies once, and the marker is the row itself", async () => {
	await withDir(async (dir) => {
		seedUsage(dir, NOON_UTC, 30);
		const recording = recordingNotifier();
		const primary: Counter = { calls: 0 };
		for (let i = 0; i < 3; i += 1) {
			await runTick({
				dir,
				now: NOON_UTC,
				fleetCap: 0,
				globalCap: 20,
				primary: countingModel("primary", primary),
				escalator: countingModel("escalator", { calls: 0 }),
				notifier: recording.notifier,
			});
		}
		assert.equal(primary.calls, 0);
		assert.equal(recording.texts.length, 1, "three capped ticks, one message");
		assert.equal(events(dir).filter((event) => event.capScope === "global").length, 3, "and all three are on the record");
	});
});

// ------------------------------------------------------------------ fail open

test("a missing source fails open with a loud warning, never a silent zero", async () => {
	await withDir(async (dir) => {
		// A cap of one cent against a supervisor that has spent a dollar: if the absent
		// log were read as $0.00 the tick would run and spend through the cap. It must
		// run — failing open is the documented behaviour — and it must say so.
		seedTick(dir, NOON_UTC, 1);
		const primary: Counter = { calls: 0 };
		const recording = recordingNotifier();
		const stderr = captureStderr();
		try {
			const report = await runTick({
				dir,
				now: NOON_UTC,
				fleetCap: 0,
				globalCap: 0.01,
				primary: countingModel("primary", primary),
				escalator: countingModel("escalator", { calls: 0 }),
				notifier: recording.notifier,
				usageLogPath: join(dir, "no-such-usage.jsonl"),
			});

			assert.equal(primary.calls, 1, "an unreadable source does not stop the fleet");
			assert.equal(report.capped, false);

			assert.equal(stderr.lines.length, 1, "and it is not quiet about it");
			assert.match(stderr.lines[0] ?? "", /WARNING/);
			assert.match(stderr.lines[0] ?? "", /no-such-usage\.jsonl/);
			assert.match(stderr.lines[0] ?? "", /failing open/);

			assert.equal(recording.texts.length, 1, "the operator hears it too");
			assert.match(recording.texts[0] ?? "", /WARNING/);

			const row = lastTickRow(dir);
			assert.equal(row.globalSpendSource, "unavailable", "the row says the reading is missing");
			assert.equal(row.globalSpendUsd, undefined, "and never writes a number it did not measure");
			assert.notEqual(row.globalSpendUsd, 0, "$0.00 is the lie this test exists to prevent");
			assert.equal(row.globalCostCapUsd, 0.01, "the cap itself is still stated");
			assert.equal(row.capped, undefined);
		} finally {
			stderr.restore();
		}
	});
});

test("a source that exists but cannot be read fails open the same way", async () => {
	await withDir(async (dir) => {
		// A directory where the log should be: it stats cleanly and `read` refuses it. That
		// is the read-error path, which is the one a half-unmounted disk takes.
		mkdirSync(join(dir, "usage-dir"), { recursive: true });
		seedTick(dir, NOON_UTC, 1);
		const primary: Counter = { calls: 0 };
		const stderr = captureStderr();
		try {
			const report = await runTick({
				dir,
				now: NOON_UTC,
				fleetCap: 0,
				globalCap: 0.01,
				primary: countingModel("primary", primary),
				escalator: countingModel("escalator", { calls: 0 }),
				notifier: recordingNotifier().notifier,
				usageLogPath: join(dir, "usage-dir"),
			});
			assert.equal(primary.calls, 1, "fails open");
			assert.equal(report.capped, false);
			assert.equal(stderr.lines.length, 1);
			assert.match(stderr.lines[0] ?? "", /could not be read/);
			const row = lastTickRow(dir);
			assert.equal(row.globalSpendSource, "unavailable");
			assert.equal(row.globalSpendUsd, undefined);
		} finally {
			stderr.restore();
		}
	});
});

// --------------------------------------------------------------------- the day

test("the total is the UTC day's: an agent row from the previous UTC day is not in it", () => {
	withDirSync((dir) => {
		const now = Date.UTC(2026, 10, 7, 0, 30, 0);
		seedUsage(dir, Date.UTC(2026, 10, 7, 0, 10, 0), 2);
		// 40 minutes earlier on the clock, but the previous UTC day — and, on this box, the
		// same *local* day as `now`, which is exactly the mix-up this asserts against.
		seedUsage(dir, Date.UTC(2026, 10, 6, 23, 50, 0), 9);

		const spend = globalSpend({ usagePath: join(dir, "usage.jsonl"), eventsPath: join(dir, "events.jsonl"), nowMs: now });
		assert.equal(spend.day, "2026-11-07");
		assert.equal(spend.day, utcDay(now));
		assert.equal(spend.agentsUsd, 2, "the $9 belongs to yesterday in UTC");
		assert.equal(spend.rows, 1);
		assert.equal(spend.supervisorUsd, 0, "no tick rows, no supervisor spend");
		assert.equal(spend.totalUsd, 2);
	});
});

test("the agent log's rows are summed, and a row that cannot be placed or priced is skipped", () => {
	withDirSync((dir) => {
		seedUsage(dir, NOON_UTC, 0.25);
		seedUsage(dir, NOON_UTC + 1_000, 0.5);
		// Junk in the same file: a row with no timestamp, a string cost, an empty object,
		// and a line that is not JSON at all. None of them is spend, and none of them may
		// throw.
		appendFileSync(join(dir, "usage.jsonl"), `${JSON.stringify({ cost: 9 })}\n`);
		appendFileSync(join(dir, "usage.jsonl"), `${JSON.stringify({ ts: NOON_UTC, cost: "9" })}\n`);
		appendFileSync(join(dir, "usage.jsonl"), "{}\n");
		appendFileSync(join(dir, "usage.jsonl"), "not json at all\n");

		const spend = globalSpend({ usagePath: join(dir, "usage.jsonl"), eventsPath: join(dir, "events.jsonl"), nowMs: NOON_UTC });
		assert.equal(spend.agentsUsd, 0.75);
		assert.equal(spend.rows, 2, "only the two priced, dated rows");
		assert.equal(spend.source, "usage.jsonl");
	});
});

test("a replaced or rewritten log is recounted from zero, not added to", () => {
	withDirSync((dir) => {
		// The usage logger prunes itself with a rewrite once a month, and a rotate is a rotate.
		// The fold is a running total, so a reader that kept its buckets across a reset would
		// count the surviving rows twice — and a cap that over-counts is a cap that stops the
		// fleet early, which is the milder of the two ways to be wrong but still wrong.
		const usage = join(dir, "usage.jsonl");
		const events = join(dir, "events.jsonl");
		seedUsage(dir, NOON_UTC, 0.5);
		seedTick(dir, NOON_UTC, 0.25);
		assert.equal(globalSpend({ usagePath: usage, eventsPath: events, nowMs: NOON_UTC }).totalUsd, 0.75);

		// Truncated in place, holding one smaller row: same inode, shorter file.
		const row = (cost: number): string =>
			`${JSON.stringify({ ts: NOON_UTC, model: "unknown", sessionId: "s1", input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost })}\n`;
		writeFileSync(usage, row(0.2));
		assert.equal(globalSpend({ usagePath: usage, eventsPath: events, nowMs: NOON_UTC }).agentsUsd, 0.2, "the old $0.50 is gone, not added to");

		// Replaced: a new inode, which is what a rename-based prune looks like.
		writeFileSync(`${usage}.tmp`, row(0.3));
		renameSync(`${usage}.tmp`, usage);
		assert.equal(globalSpend({ usagePath: usage, eventsPath: events, nowMs: NOON_UTC }).agentsUsd, 0.3);

		// The same contract for the day rollup the fleet cap uses, since it is the same reader.
		assert.equal(dailySpend(events, NOON_UTC).spentUsd, 0.25);
		writeFileSync(events, `${JSON.stringify({ ts: new Date(NOON_UTC).toISOString(), kind: "tick", costUsd: 0.1, models: [] })}\n`);
		assert.equal(dailySpend(events, NOON_UTC).spentUsd, 0.1, "the supervisor's log is recounted too");
	});
});

test("an empty source is a quiet day, not an unreadable one", () => {	withDirSync((dir) => {
		// The distinction that matters: a log that exists and holds nothing today is $0.00
		// spent, and a log that cannot be found is no reading at all.
		seedUsage(dir, NOON_UTC - 3 * 24 * 3600 * 1000, 4);
		const spend = globalSpend({ usagePath: join(dir, "usage.jsonl"), eventsPath: join(dir, "events.jsonl"), nowMs: NOON_UTC });
		assert.equal(spend.agentsUsd, 0, "nothing today, and that is a real zero");
		assert.equal(spend.totalUsd, 0);
		assert.equal(spend.source, "usage.jsonl");
		assert.equal(spend.reason, undefined);
	});
});

test("the fail-open warning is once per UTC day, so 1,440 ticks are not 1,440 messages", async () => {
	await withDir(async (dir) => {
		seedTick(dir, NOON_UTC, 1);
		const recording = recordingNotifier();
		const stderr = captureStderr();
		try {
			for (let i = 0; i < 3; i += 1) {
				await runTick({
					dir,
					now: NOON_UTC + i * 60_000,
					fleetCap: 0,
					globalCap: 0.01,
					primary: countingModel("primary", { calls: 0 }),
					escalator: countingModel("escalator", { calls: 0 }),
					notifier: recording.notifier,
					usageLogPath: join(dir, "no-such-usage.jsonl"),
				});
			}
			assert.equal(stderr.lines.length, 3, "stderr every tick: that is the loud half, and it is cheap");
			assert.equal(recording.texts.length, 1, "the operator's phone hears it once");
		} finally {
			stderr.restore();
		}
	});
});
