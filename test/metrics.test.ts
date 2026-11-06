// The metric layer, end to end: the taxonomy's parser, the store's windows and
// its incremental index, the aggregates over a fixture whose every number is
// stated by hand, and one real tick proving the stages actually write rows the
// report can read.
//
// The fixture is deliberately small enough to assert exactly: a percentile that
// is off by one rank, a hold counted over the wrong denominator, or a rate that
// reads zero instead of null all show up here rather than in a month of data.

import assert from "node:assert/strict";
import { test } from "node:test";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SCHEMA_VERSION, eventLine, forkKindOf, makeAction, makeClaim, makeDecision, makeInspection, makeTick, makeTrigger, makeWatchdog, parseEvent, type ActionEvent, type ClaimEvent, type DecisionEvent, type InspectionEvent, type SchemaEvent, type TickEvent, type TriggerEvent, type WatchdogEvent } from "../src/metrics/schema.ts";
import { metricsIndexPath, openStore } from "../src/metrics/store.ts";
import { REPORT_SCHEMA, buildReport, type MetricsReport } from "../src/metrics/report.ts";
import { formatReport } from "../src/metrics/render.ts";
import { tick } from "../src/manager/tick.ts";
import type { Config } from "../src/manager/config.ts";
import type { Decision, DecisionInput, DecisionModel } from "../src/decision/types.ts";
import type { HerdrAgent, HerdrPort, PromptResult } from "../src/herdr/types.ts";

// ------------------------------------------------------------------ lifecycle

async function withDir(fn: (dir: string) => Promise<void> | void): Promise<void> {
	const dir = mkdtempSync(join(tmpdir(), "agentfleet-metrics-"));
	try {
		await fn(dir);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

function writeLog(path: string, events: readonly SchemaEvent[]): void {
	mkdirSync(join(path, ".."), { recursive: true });
	writeFileSync(path, events.map((event) => `${eventLine(event)}\n`).join(""));
}

// ------------------------------------------------------------- the taxonomy

const NOW = Date.parse("2026-10-26T12:00:00.000Z");

function at(minutesAgo: number): string {
	return new Date(NOW - minutesAgo * 60_000).toISOString();
}

function decisionRow(overrides: Partial<DecisionEvent> = {}): DecisionEvent {
	return makeDecision({
		paneId: "p1",
		group: "alpha",
		model: "needle3",
		op: "nudge",
		confidence: 0.4,
		refused: false,
		escalated: false,
		escalationFailed: false,
		latencyMs: 100,
		costUsd: 0,
		policy: "fork",
		held: false,
		ts: at(60),
		...overrides,
	});
}

function actionRow(overrides: Partial<ActionEvent> = {}): ActionEvent {
	return makeAction({
		paneId: "p1",
		group: "alpha",
		op: "nudge",
		disposition: "sent",
		reason: "ok",
		latencyMs: 40,
		gated: true,
		policy: "fork",
		ts: at(60),
		...overrides,
	});
}

function tickRow(overrides: Partial<TickEvent> = {}): TickEvent {
	return makeTick({
		agents: 5,
		moved: 3,
		decisions: 3,
		escalated: 0,
		escalationFailed: 0,
		triggers: 2,
		inspected: 1,
		prompts: 2,
		held: 1,
		costUsd: 0.004,
		durationMs: 1000,
		models: ["needle3", "openrouter:glm"],
		dry: false,
		ts: at(60),
		...overrides,
	});
}

function triggerRow(overrides: Partial<TriggerEvent> = {}): TriggerEvent {
	return makeTrigger({ triggerKind: "blocked", group: "alpha", paneIds: ["p1"], detail: "blocked while testing", ts: at(60), ...overrides });
}

function inspectionRow(overrides: Partial<InspectionEvent> = {}): InspectionEvent {
	return makeInspection({
		triggerKind: "blocked",
		group: "alpha",
		paneIds: ["p1"],
		mode: "cheap",
		confidence: 0.7,
		costUsd: 0.0002,
		latencyMs: 500,
		proposed: true,
		degraded: false,
		ts: at(60),
		...overrides,
	});
}

function watchdogRow(overrides: Partial<WatchdogEvent> = {}): WatchdogEvent {
	return makeWatchdog({ rule: "command", pid: 4242, ageMs: 600_000, command: "npm test", ts: at(60), ...overrides });
}

function claimRow(overrides: Partial<ClaimEvent> = {}): ClaimEvent {
	return makeClaim({ paneId: "p1", group: "alpha", phase: "implement", state: "working", ageMs: 60_000, diverged: true, ts: at(60), ...overrides });
}

test("every event kind survives a trip through the log line", () => {
	const rows: SchemaEvent[] = [
		decisionRow(),
		tickRow(),
		triggerRow(),
		inspectionRow(),
		actionRow(),
		watchdogRow(),
		claimRow(),
	];
	for (const row of rows) {
		assert.deepEqual(parseEvent(eventLine(row)), row, `${row.kind} must round-trip`);
		assert.equal(row.schema, SCHEMA_VERSION);
	}
});

test("a row carries its schema version, so an old row cannot be read as a new one", () => {
	const row = decisionRow();
	assert.equal(eventLine(row).includes(`"schema":${SCHEMA_VERSION}`), true);
	const withoutVersion: Record<string, unknown> = { ...row };
	delete withoutVersion.schema;
	assert.equal(parseEvent(JSON.stringify(withoutVersion)), undefined, "a pre-schema row is not a row of this schema");
});

test("parseEvent rejects what must never reach an aggregate", () => {
	const good = eventLine(decisionRow());
	const cases: Array<[string, string]> = [
		["empty line", ""],
		["whitespace", "   \n"],
		["not json", "{op: nudge}"],
		["a json array", "[]"],
		["json null", "null"],
		["a string", '"decision"'],
		["an unknown kind", JSON.stringify({ ...decisionRow(), kind: "shenanigans" })],
		["a legacy kind", JSON.stringify({ ts: at(1), kind: "nudge", paneId: "p1", text: "go" })],
		["no ts", JSON.stringify({ ...JSON.parse(good) as Record<string, unknown>, ts: undefined })],
		["an unparseable ts", JSON.stringify({ ...JSON.parse(good) as Record<string, unknown>, ts: "yesterday" })],
		["a missing required field", JSON.stringify({ ...JSON.parse(good) as Record<string, unknown>, confidence: undefined })],
		["a string where a number belongs", JSON.stringify({ ...JSON.parse(good) as Record<string, unknown>, latencyMs: "1200" })],
		["a non-finite number", JSON.stringify({ ...JSON.parse(good) as Record<string, unknown>, costUsd: null })],
		["an op that is not an op", JSON.stringify({ ...JSON.parse(good) as Record<string, unknown>, op: "think" })],
		["a policy that is not a policy", JSON.stringify({ ...JSON.parse(good) as Record<string, unknown>, policy: "sometimes" })],
	];
	for (const [label, line] of cases) {
		assert.equal(parseEvent(line), undefined, `should reject: ${label}`);
	}
});

test("an optional field of the wrong type is still rejected, but an extra key is kept", () => {
	const base = JSON.parse(eventLine(decisionRow())) as Record<string, unknown>;
	assert.equal(parseEvent(JSON.stringify({ ...base, promptTokens: "many" })), undefined, "tokens must be a number when present");

	const withLegacy = { ...base, decision: "nudge(finish) via needle3 conf 0.40", legacyExtra: 7 };
	const parsed = parseEvent(JSON.stringify(withLegacy));
	assert.ok(parsed !== undefined, "the human-readable keys that ride along must not invalidate the row");
	assert.equal((parsed as unknown as Record<string, unknown>)["decision"], "nudge(finish) via needle3 conf 0.40");
});

test("the fork kinds are read from the gate's own sentences", () => {
	assert.equal(forkKindOf("declare_done stops a live agent and cannot be silently undone"), "irreversible");
	assert.equal(forkKindOf("collision in fleet-supervisor: 2 agents working in /repo"), "cross-agent");
	assert.equal(forkKindOf("churn in fleet-supervisor: 3 turns"), "cross-agent");
	assert.equal(forkKindOf("nudge is 340 chars (limit 300)"), "scope-change");
	assert.equal(forkKindOf("nudge names /etc/passwd outside /repo"), "scope-change");
	assert.equal(forkKindOf("3 prompts already sent this tick (cap 3)"), "at-cap");
	assert.equal(forkKindOf("something nobody wrote yet"), "other");
});

// -------------------------------------------------------------------- store

test("a store windows and filters by time, group, pane and kind", async () => {
	await withDir(async (dir) => {
		const log = join(dir, "events.jsonl");
		writeLog(log, [
			decisionRow({ paneId: "p1", group: "alpha", ts: at(30) }),
			decisionRow({ paneId: "p2", group: "beta", ts: at(180) }),
			decisionRow({ paneId: "p3", group: "beta", ts: at(1800) }),
			actionRow({ paneId: "p1", group: "alpha", ts: at(30) }),
		]);

		const store = openStore(log);
		const ingested = store.ingest();
		assert.equal(ingested.rows, 4);
		assert.equal(ingested.ignoredTotal, 0);

		const all = store.query({ now: NOW });
		assert.equal(all.length, 4, "all means all");

		assert.equal(store.query({ window: "1h", now: NOW }).length, 2);
		assert.equal(store.query({ window: "24h", now: NOW }).length, 3, "the 30h-old row is outside 24h");
		assert.deepEqual(
			store.query({ group: "beta", now: NOW }).map((event) => (event as DecisionEvent).paneId),
			["p2", "p3"],
		);
		assert.deepEqual(
			store.query({ paneId: "p1", now: NOW }).map((event) => event.kind),
			["decision", "action"],
		);
		assert.deepEqual(
			store.query({ kinds: ["action"], now: NOW }).map((event) => event.kind),
			["action"],
		);
		assert.equal(store.query({ window: "1h", group: "beta", now: NOW }).length, 0, "filters compose");

		store.close();
	});
});

test("a pre-schema log is ingested without error, and its rows are counted rather than read", async () => {
	await withDir(async (dir) => {
		const log = join(dir, "events.jsonl");
		writeFileSync(
			log,
			[
				// What the supervisor wrote before the taxonomy existed.
				JSON.stringify({ ts: at(10), kind: "tick", agents: 21, moved: 4, decisions: 4, escalated: 1, escalationFailed: 0, prompts: 1, asks: 0, costUsd: 0.002, triggers: 1, inspected: 1 }),
				JSON.stringify({ ts: at(10), kind: "decision", paneId: "p1", group: "alpha", decision: "leave(nothing to do) via needle3 conf 0.90", escalated: false, escalationFailed: false }),
				JSON.stringify({ ts: at(10), kind: "trigger:blocked", group: "alpha", paneIds: ["p1"], detail: "blocked" }),
				"{ truncated write",
				"",
				// A row of the current schema, which must be the only one read.
				eventLine(decisionRow({ ts: at(5) })),
			].join("\n") + "\n",
		);

		const store = openStore(log);
		const ingested = store.ingest();
		assert.equal(ingested.added, 1, "only the current-schema row is an event");
		assert.equal(ingested.ignoredTotal, 4, "three pre-schema lines and one truncated write");
		assert.equal(store.query({ now: NOW }).length, 1);
		assert.equal(store.query({ now: NOW })[0]?.kind, "decision");
		store.close();
	});
});

test("the incremental index agrees with a full rebuild, and with a plain scan", async () => {
	await withDir(async (dir) => {
		const log = join(dir, "events.jsonl");
		// The log exists before the store is opened, which is how the report always
		// meets it: a derived index beside a log that is already being appended to.
		writeLog(log, [decisionRow({ paneId: "p1", ts: at(50) }), actionRow({ paneId: "p1", ts: at(50) })]);

		const incremental = openStore(log);
		assert.equal(incremental.indexKind, "sqlite");
		assert.equal(incremental.ingest().added, 2);

		appendFileSync(log, `${eventLine(decisionRow({ paneId: "p2", ts: at(40) }))}\n`);
		appendFileSync(log, `${eventLine(triggerRow({ ts: at(39) }))}\n${eventLine(tickRow({ ts: at(39) }))}\n`);
		const second = incremental.ingest();
		assert.equal(second.added, 3, "an ingest reads only what the log added");
		assert.equal(second.bytes > 0, true);
		assert.equal(second.rebuilt, false);

		const incrementalRows = incremental.query({ now: NOW });
		assert.equal(incrementalRows.length, 5);

		const rebuilt = incremental.rebuild();
		assert.equal(rebuilt.rebuilt, true);
		assert.deepEqual(incremental.query({ now: NOW }), incrementalRows, "a rebuild must reproduce the incremental index exactly");

		const scanned = openStore(log, { forceScan: true });
		scanned.ingest();
		assert.equal(scanned.indexKind, "scan");
		assert.deepEqual(scanned.query({ now: NOW }), incrementalRows, "the fallback index reads the same log the same way");

		// A second store over the same log and index file is a fresh reader, not a
		// second opinion: it must agree with the first.
		const reopened = openStore(log);
		const third = reopened.ingest();
		assert.equal(third.added, 0, "the index already covers the whole log");
		assert.deepEqual(reopened.query({ now: NOW }), incrementalRows);

		incremental.close();
		reopened.close();
		scanned.close();
	});
});

test("a half-written line is not read until it is finished", async () => {
	await withDir(async (dir) => {
		const log = join(dir, "events.jsonl");
		writeLog(log, [decisionRow({ ts: at(10) })]);

		const store = openStore(log);
		store.ingest();
		const before = store.query({ now: NOW }).length;

		// A tick writing right now: the newline has not landed yet.
		const pending = eventLine(decisionRow({ paneId: "p2", ts: at(9) }));
		appendFileSync(log, pending);
		store.ingest();
		assert.equal(store.query({ now: NOW }).length, before, "an unterminated line is not an event yet");

		appendFileSync(log, "\n");
		store.ingest();
		assert.equal(store.query({ now: NOW }).length, before + 1, "once it is terminated it is read, exactly once");
		store.ingest();
		assert.equal(store.query({ now: NOW }).length, before + 1, "and ingesting again does not double it");
		store.close();
	});
});

test("a log that shrinks under the index is rebuilt, not trusted", async () => {
	await withDir(async (dir) => {
		const log = join(dir, "events.jsonl");
		writeLog(log, [decisionRow({ ts: at(30) }), decisionRow({ paneId: "p2", ts: at(29) }), decisionRow({ paneId: "p3", ts: at(28) })]);

		const store = openStore(log);
		store.ingest();
		assert.equal(store.query({ now: NOW }).length, 3);

		// Rotated away and restarted with less in it.
		writeFileSync(log, `${eventLine(decisionRow({ ts: at(2) }))}\n`);
		const result = store.ingest();
		assert.equal(result.rebuilt, true, "a shorter log cannot be covered by the old offset");
		assert.equal(store.query({ now: NOW }).length, 1);
		store.close();
	});
});

test("the index lives beside the log unless it is told otherwise", async () => {
	await withDir(async (dir) => {
		const log = join(dir, "events.jsonl");
		writeLog(log, [decisionRow({ ts: at(1) })]);
		assert.equal(metricsIndexPath(log), join(dir, "events.metrics.sqlite"));

		const store = openStore(log);
		assert.equal(store.indexKind, "sqlite");
		assert.equal(store.indexPath, join(dir, "events.metrics.sqlite"));
		store.ingest();
		store.close();

		const inMemory = openStore(log, { memory: true });
		assert.equal(inMemory.indexPath, ":memory:");
		inMemory.ingest();
		assert.equal(inMemory.query({ now: NOW }).length, 1);
		inMemory.close();
	});
});

// ------------------------------------------------------------------- report

/** Six decisions, five actions, two ticks, three triggers, two inspections, two
 *  watchdog findings and two claims. Every expected number below is derived from
 *  this list by hand, so a broken denominator cannot hide behind a plausible
 *  percentage. */
function fixture(): SchemaEvent[] {
	return [
		decisionRow({ paneId: "p1", model: "needle3", op: "nudge", confidence: 0.4, latencyMs: 100 }),
		decisionRow({ paneId: "p2", model: "needle3", op: "leave", confidence: 0.95, latencyMs: 300 }),
		decisionRow({ paneId: "p3", model: "openrouter:glm", op: "leave", confidence: 0.9, latencyMs: 1000, costUsd: 0.001, refused: true }),
		decisionRow({ paneId: "p4", model: "openrouter:glm", op: "declare_done", confidence: 0.2, latencyMs: 2000, costUsd: 0.002, escalated: true }),
		decisionRow({ paneId: "p5", model: "needle3", op: "nudge", confidence: 0.4, latencyMs: 500 }),
		decisionRow({ paneId: "p6", group: "beta", model: "openrouter:glm", op: "flag", confidence: 0.1, latencyMs: 3000, costUsd: 0.003, escalated: true, escalationFailed: true }),

		actionRow({ paneId: "p1", op: "nudge", disposition: "sent", reason: "ok", latencyMs: 40 }),
		actionRow({ paneId: "p4", op: "declare_done", disposition: "held", reason: "gate", latencyMs: 0, forkKinds: ["irreversible"], forkSeverities: ["hard"] }),
		actionRow({ paneId: "p5", op: "nudge", disposition: "skipped", reason: "capped", latencyMs: 0, policy: "often" }),
		actionRow({ paneId: "p6", group: "beta", op: "nudge", disposition: "rejected", reason: "agent_blocked", latencyMs: 12, policy: "always" }),
		actionRow({ paneId: "p9", op: "nudge", disposition: "skipped", reason: "cooldown", latencyMs: 0, gated: false }),

		tickRow({ ts: at(60) }),
		tickRow({ ts: at(30), moved: 4, durationMs: 3000, costUsd: 0.002, held: 0, models: ["needle3"], dry: true }),

		triggerRow({ triggerKind: "blocked", ts: at(60) }),
		triggerRow({ triggerKind: "blocked", paneIds: ["p2"], ts: at(30) }),
		triggerRow({ triggerKind: "churn", paneIds: ["p3"], ts: at(30) }),

		inspectionRow({ triggerKind: "blocked", mode: "cheap", proposed: true, degraded: false, costUsd: 0.0002, latencyMs: 500 }),
		inspectionRow({ triggerKind: "churn", mode: "deep", proposed: false, degraded: true, costUsd: 0, latencyMs: 90_000 }),

		watchdogRow({ rule: "command", pid: 1, stalled: false }),
		watchdogRow({ rule: "build", pid: 2 }),

		claimRow({ paneId: "p1", state: "working", ageMs: 60_000, diverged: true }),
		claimRow({ paneId: "p2", state: "done", ageMs: 300_000, diverged: false }),
	];
}

function reportOf(events: readonly SchemaEvent[], now = NOW): MetricsReport {
	return buildReport({ events, window: "all", logPath: "/tmp/fixture/events.jsonl", indexPath: null, indexKind: "scan", ignoredRows: 4, now });
}

test("the report counts decisions, ops and confidence from the rows in front of it", () => {
	const report = reportOf(fixture());

	assert.equal(report.reportSchema, REPORT_SCHEMA);
	assert.equal(report.source.rows, fixture().length);
	assert.equal(report.source.ignoredRows, 4);
	assert.equal(report.source.firstTs, at(60));
	assert.equal(report.source.lastTs, at(30), "the newest row in the selection, whatever order the array arrived in");

	const decisions = report.decisions;
	assert.equal(decisions.total, 6);
	assert.deepEqual(
		decisions.opMix.map((entry) => [entry.op, entry.count, Number(entry.share.toFixed(4))]),
		[
			["leave", 2, 0.3333],
			["nudge", 2, 0.3333],
			["declare_done", 1, 0.1667],
			["flag", 1, 0.1667],
		],
	);
	assert.deepEqual(
		decisions.byGroup.map((entry) => [entry.group, entry.count]),
		[
			["alpha", 5],
			["beta", 1],
		],
	);

	// 0.1 → decile 1, 0.2 → 2, 0.4 → 2 rows in decile 4, 0.9 and 0.95 → decile 9.
	const occupied = decisions.confidence.deciles.filter((entry) => entry.count > 0).map((entry) => [entry.decile, entry.count]);
	assert.deepEqual(occupied, [
		[1, 1],
		[2, 1],
		[4, 2],
		[9, 2],
	]);
	assert.equal(decisions.confidence.mean?.toFixed(4), ((0.4 + 0.95 + 0.9 + 0.2 + 0.4 + 0.1) / 6).toFixed(4));

	assert.equal(decisions.escalation.escalated, 2);
	assert.equal(decisions.escalation.rate?.toFixed(4), "0.3333");
	assert.equal(decisions.escalation.failed, 1);
	assert.equal(decisions.escalation.failedRate, 0.5, "a failed escalation is a share of attempted escalations");

	assert.deepEqual(
		decisions.refusalByModel.map((entry) => [entry.model, entry.decisions, entry.refused, Number((entry.rate ?? -1).toFixed(4))]),
		[
			["needle3", 3, 0, 0],
			["openrouter:glm", 3, 1, 0.3333],
		],
	);
});

test("nearest-rank percentiles are values that occurred, and are per model", () => {
	const report = reportOf(fixture());
	const needle = report.decisions.latencyByModel.find((entry) => entry.model === "needle3");
	const glm = report.decisions.latencyByModel.find((entry) => entry.model === "openrouter:glm");

	assert.ok(needle !== undefined && glm !== undefined);
	assert.equal(needle.n, 3);
	assert.deepEqual([needle.p50, needle.p95, needle.p99, needle.max, needle.mean], [300, 500, 500, 500, 300]);
	assert.equal(glm.n, 3);
	assert.deepEqual([glm.p50, glm.p95, glm.p99, glm.max], [2000, 3000, 3000, 3000]);
});

test("cost is totalled, split by model and by day, and the models add up", () => {
	const report = reportOf(fixture());
	assert.equal(report.decisions.cost.totalUsd.toFixed(6), "0.006000");
	assert.deepEqual(
		report.decisions.cost.byModel.map((entry) => [entry.model, entry.totalUsd.toFixed(6)]),
		[
			["needle3", "0.000000"],
			["openrouter:glm", "0.006000"],
		],
	);
	const summed = report.decisions.cost.byModel.reduce((sum, entry) => sum + entry.totalUsd, 0);
	assert.equal(summed.toFixed(6), report.decisions.cost.totalUsd.toFixed(6));
	assert.deepEqual(report.decisions.cost.byDay.map((entry) => entry.day), ["2026-10-26"]);
});

test("the hold rate is over gated actions, not over every row, and is readable per policy and per fork", () => {
	const report = reportOf(fixture());
	const hold = report.actions.hold;

	assert.equal(report.actions.total, 5);
	assert.equal(hold.gated, 4, "the cooldown skip never reached the gate");
	assert.equal(hold.held, 1);
	assert.equal(hold.rate, 0.25, "one hold out of four gated actions, not out of five rows");

	assert.deepEqual(
		hold.byPolicy.map((entry) => [entry.policy, entry.gated, entry.held, entry.rate]),
		[
			["fork", 2, 1, 0.5],
			["always", 1, 0, 0],
			["often", 1, 0, 0],
		],
	);
	assert.deepEqual(
		hold.byForkKind.map((entry) => [entry.kind, entry.gated, entry.held, entry.rate]),
		[["irreversible", 1, 1, 1]],
	);

	assert.deepEqual(
		report.actions.byDisposition.map((entry) => [entry.disposition, entry.count]),
		[
			["sent", 1],
			["held", 1],
			["rejected", 1],
			["skipped", 2],
			["dry", 0],
		],
	);
	assert.deepEqual(
		report.actions.skippedByReason.map((entry) => [entry.reason, entry.count]),
		[
			["capped", 1],
			["cooldown", 1],
		],
	);
	assert.deepEqual(
		report.actions.rejectedByReason.map((entry) => [entry.reason, entry.count]),
		[["agent_blocked", 1]],
	);
	assert.equal(report.actions.latencyMs.n, 2, "one sent and one refused nudge made a round trip; the claim write did not");
	assert.equal(report.actions.latencyMs.p50, 12, "nearest rank over [12, 40] is 12");
	assert.equal(report.actions.latencyMs.max, 40);
	assert.equal(report.actions.byOp.find((entry) => entry.op === "declare_done")?.held, 1);
});

test("triggers, inspections and their yield are counted per tick and per kind", () => {
	const report = reportOf(fixture());

	assert.equal(report.triggers.total, 3);
	assert.deepEqual(
		report.triggers.byKind.map((entry) => [entry.kind, entry.count]),
		[
			["blocked", 2],
			["churn", 1],
		],
	);
	assert.equal(report.triggers.perTick, 1.5);
	assert.equal(report.triggers.inspectedShare, 0.5, "two inspections out of the four triggers the ticks saw");

	assert.equal(report.inspections.total, 2);
	assert.deepEqual(
		report.inspections.byMode.map((entry) => [entry.mode, entry.count]),
		[
			["cheap", 1],
			["deep", 1],
		],
	);
	assert.equal(report.inspections.proposed.count, 1);
	assert.equal(report.inspections.proposed.rate, 0.5);
	assert.equal(report.inspections.degraded.count, 1);
	assert.equal(report.inspections.degraded.rate, 0.5);
	assert.equal(report.inspections.costUsd.total.toFixed(6), "0.000200");
	assert.equal(report.inspections.perTick, 1);
	assert.deepEqual(
		report.inspections.byTriggerKind.map((entry) => [entry.kind, entry.count, entry.proposed, entry.rate]),
		[
			["blocked", 1, 1, 1],
			["churn", 1, 0, 0],
		],
	);
});

test("ticks, watchdog findings and claims are aggregated, and absence is stated rather than zeroed", () => {
	const report = reportOf(fixture());

	assert.equal(report.ticks.total, 2);
	assert.equal(report.ticks.agents.mean, 5);
	assert.equal(report.ticks.moved.total, 7);
	assert.equal(report.ticks.moved.max, 4);
	assert.equal(report.ticks.decisions.total, 6);
	assert.equal(report.ticks.dry, 1);
	assert.deepEqual([report.ticks.durationMs.p50, report.ticks.durationMs.p95, report.ticks.durationMs.max], [1000, 3000, 3000]);
	assert.deepEqual(
		report.ticks.models.map((entry) => [entry.model, entry.ticks]),
		[
			["needle3", 2],
			["openrouter:glm", 1],
		],
	);

	assert.equal(report.watchdog.total, 2);
	assert.deepEqual(
		report.watchdog.byRule.map((entry) => [entry.rule, entry.count]),
		[
			["build", 1],
			["command", 1],
		],
	);
	assert.equal(report.watchdog.stalled.tested, 1, "only the row that recorded a verdict counts as tested");
	assert.equal(report.watchdog.stalled.rate, 0);

	assert.equal(report.claims.total, 2);
	assert.equal(report.claims.diverged.count, 1);
	assert.equal(report.claims.diverged.rate, 0.5);
	assert.deepEqual([report.claims.ageMs.p50, report.claims.ageMs.max], [60_000, 300_000]);

	const staleField = report.coverage.find((entry) => entry.kind === "watchdog" && entry.field === "stalled");
	assert.equal(staleField?.absent, 1);
	assert.equal(report.decisions.accuracyByDecile, null, "no labels, so no accuracy");
	assert.equal(report.notes.some((note) => note.includes("accuracy by decile is null")), true);
	assert.equal(report.notes.some((note) => note.includes("token counts are absent")), true);
	assert.equal(report.notes.some((note) => note.includes("stalled is absent")), true);
});

test("accuracy by decile is computed only when rows carry ground truth", () => {
	const events: SchemaEvent[] = [
		decisionRow({ paneId: "p1", confidence: 0.4, op: "nudge", labelOp: "nudge" }),
		decisionRow({ paneId: "p2", confidence: 0.4, op: "leave", labelOp: "nudge" }),
		decisionRow({ paneId: "p3", confidence: 0.9, op: "leave", labelOp: "leave" }),
		decisionRow({ paneId: "p4", confidence: 0.95, op: "leave" }),
	];
	const report = reportOf(events);
	const accuracy = report.decisions.accuracyByDecile;
	assert.ok(accuracy !== null);
	const decile4 = accuracy.find((entry) => entry.decile === 4);
	const decile9 = accuracy.find((entry) => entry.decile === 9);
	assert.equal(decile4?.labelled, 2);
	assert.equal(decile4?.correct, 1);
	assert.equal(decile4?.accuracy, 0.5);
	assert.equal(decile9?.labelled, 1, "the unlabelled row is not counted as wrong");
	assert.equal(decile9?.accuracy, 1);
	assert.equal(accuracy.find((entry) => entry.decile === 0)?.accuracy, null, "an empty decile is unknown, not 0%");
	assert.equal(report.notes.some((note) => note.includes("accuracy by decile is null")), false);
});

test("an empty window reports nothing rather than zeros everywhere", () => {
	const report = reportOf([]);
	assert.equal(report.source.rows, 0);
	assert.equal(report.decisions.total, 0);
	assert.equal(report.decisions.escalation.rate, null);
	assert.equal(report.actions.hold.rate, null);
	assert.equal(report.triggers.perTick, null);
	assert.equal(report.inspections.perTick, null);
	assert.equal(report.ticks.durationMs.p50, null);
	assert.equal(report.notes.some((note) => note.includes("no rows in this window")), true);

	const text = formatReport(report);
	assert.equal(text.includes("—"), true, "a null is printed as a dash");
	assert.equal(text.includes("no rows in this window"), true);
});

test("the human report and the JSON are the same numbers", () => {
	const report = reportOf(fixture());
	const text = formatReport(report);
	for (const line of [
		"decisions · 6",
		"actions · 5",
		"ticks · 2",
		"triggers · 3",
		"inspections · 2",
		"watchdog · 2",
		"claims · 2",
		"hold  1/4 (25.0%) of gated actions",
		"accuracy by decile  not available",
	]) {
		assert.equal(text.includes(line), true, `the table should say: ${line}`);
	}

	// The JSON is the contract an optimisation script reads: it must survive a
	// round trip unchanged and expose every section.
	const parsed = JSON.parse(JSON.stringify(report)) as Record<string, unknown>;
	for (const key of ["reportSchema", "window", "source", "coverage", "decisions", "actions", "ticks", "triggers", "inspections", "watchdog", "claims", "notes"]) {
		assert.equal(key in parsed, true, `the JSON must carry ${key}`);
	}
	assert.deepEqual(parsed, JSON.parse(JSON.stringify(report)));
});

// -------------------------------------------------- the stages write these rows

const REPO = "/home/operator/work/fleet-supervisor";

function fakePort(agent: HerdrAgent, promptResult: PromptResult = { disposition: "accepted" }): HerdrPort {
	return {
		async list() {
			return [agent];
		},
		async get() {
			return agent;
		},
		async read() {
			return "$ npm test\nok 196 tests";
		},
		async prompt(): Promise<PromptResult> {
			return promptResult;
		},
	};
}

function fixedModel(name: string, reply: Partial<Decision>): DecisionModel {
	return {
		name,
		costPerCallUsd: 0,
		async decide(_input: DecisionInput): Promise<Decision> {
			return { op: "nudge", argument: "run the suite", confidence: 0.9, model: name, costUsd: 0.0001, latencyMs: 1200, refused: false, raw: '{"op":"nudge"}', ...reply };
		},
	};
}

function tickConfig(dir: string, overrides: Partial<Config> = {}): Config {
	const base: Config = {
		intervalMs: 60_000,
		once: true,
		dry: false,
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
		inspector: "off",
		maxInspectionsPerTick: 0,
		ask: "fork",
		askByGroup: {},
		eventsPath: join(dir, "events.jsonl"),
		triggerHistoryPath: join(dir, "triggers.json"),
		cooldownsPath: join(dir, "cooldowns.json"),
		asksPath: join(dir, "asks.jsonl"),
		policyPath: join(dir, "policy.json"),
		watchdog: false,
	};
	return { ...base, ...overrides };
}

test("one tick writes rows the report can read, with the gate's verdict on the action", async () => {
	await withDir(async (dir) => {
		mkdirSync(join(dir, "registry"), { recursive: true });
		const saved = { registry: process.env.AGENTFLEET_REGISTRY, state: process.env.AGENTFLEET_STATE };
		process.env.AGENTFLEET_REGISTRY = join(dir, "registry");
		process.env.AGENTFLEET_STATE = join(dir, "marks.json");

		try {
			const agent: HerdrAgent = {
				paneId: "p1",
				agent: "pi",
				status: "working",
				cwd: REPO,
				foregroundCwd: REPO,
				workspaceId: "w2C",
				tabId: "w2C:t1",
				title: "pi",
				completionSeq: 1,
				stateChangeSeq: 1,
				focused: false,
			};
			writeFileSync(
				join(dir, "registry", "p1.json"),
				JSON.stringify({ paneId: "p1", cwd: REPO, intent: "pin the pure modules", phase: "implement", state: "working", last: "wrote tests", updated: new Date(Date.now() - 120_000).toISOString(), group: "fleet-supervisor" }),
			);

			const config = tickConfig(dir);
			// `declare_done` is the hard fork the policy stops for, so the tick has to
			// produce a held action with the fork that held it.
			await tick({
				port: fakePort(agent),
				notifier: { async send() {} },
				config,
				models: { primary: fixedModel("primary", { op: "declare_done", argument: "the work is pinned" }), escalator: fixedModel("escalator", { op: "declare_done", argument: "the work is pinned" }) },
			});

			const store = openStore(config.eventsPath);
			const ingested = store.ingest();
			assert.equal(store.indexKind, "sqlite");
			assert.equal(ingested.added > 0, true);

			const events = store.query({ window: "all" });
			const decision = events.find((event): event is DecisionEvent => event.kind === "decision");
			const action = events.find((event): event is ActionEvent => event.kind === "action");
			const claimEvent = events.find((event): event is ClaimEvent => event.kind === "claim");
			const tickEvent = events.find((event): event is TickEvent => event.kind === "tick");

			assert.ok(decision !== undefined && action !== undefined && claimEvent !== undefined && tickEvent !== undefined);
			assert.equal(decision.op, "declare_done");
			assert.equal(decision.held, true);
			assert.equal(decision.policy, "fork");
			assert.equal(decision.group, "fleet-supervisor");
			assert.equal(decision.decision, "declare_done(the work is pinned) via escalator conf 0.90", "the human-readable summary rides on the row, naming the model that decided — and declare_done is always cross-checked (R3), so that is the escalator's");

			assert.equal(action.disposition, "held");
			assert.equal(action.gated, true);
			assert.equal(action.reason, "gate");
			assert.deepEqual(action.forkKinds, ["irreversible"]);
			assert.deepEqual(action.forkSeverities, ["hard"]);

			assert.equal(claimEvent.state, "working");
			assert.equal(claimEvent.diverged, false);
			assert.equal(claimEvent.ageMs !== undefined && claimEvent.ageMs >= 120_000, true);

			assert.equal(tickEvent.held, 1);
			assert.equal(tickEvent.decisions, 1);
			assert.deepEqual(tickEvent.models, ["escalator", "primary"], "declare_done is cross-checked, so both models were consulted");
			assert.equal(tickEvent.asks, 1, "the legacy key is still on the row");

			// The human-readable log the operator already reads is untouched: the
			// legacy rows are still there, byte for byte, beside the typed ones.
			const kinds = readFileSync(config.eventsPath, "utf8")
				.split("\n")
				.filter((line) => line.trim() !== "")
				.map((line) => JSON.parse(line) as { kind: string; policy?: string; why?: string })
				.map((event) => event.kind);
			assert.equal(kinds.includes("ask"), true, "the ask was still written the way it always was");
			assert.equal(kinds.filter((kind) => kind === "decision").length, 1, "one decision row, not two");

			const report = buildReport({
				events,
				window: "all",
				logPath: config.eventsPath,
				indexPath: store.indexPath,
				indexKind: store.indexKind,
				ignoredRows: ingested.ignoredTotal,
			});
			assert.equal(report.decisions.total, 1);
			assert.equal(report.actions.hold.held, 1);
			assert.equal(report.actions.hold.rate, 1);
			assert.equal(report.ticks.total, 1);
			assert.equal(report.claims.diverged.count, 0);

			store.close();
		} finally {
			if (saved.registry === undefined) delete process.env.AGENTFLEET_REGISTRY;
			else process.env.AGENTFLEET_REGISTRY = saved.registry;
			if (saved.state === undefined) delete process.env.AGENTFLEET_STATE;
			else process.env.AGENTFLEET_STATE = saved.state;
		}
	});
});

test("a dry tick records the rehearsal as dry, and an inspector finding as an inspection", async () => {
	await withDir(async (dir) => {
		mkdirSync(join(dir, "registry"), { recursive: true });
		const saved = { registry: process.env.AGENTFLEET_REGISTRY, state: process.env.AGENTFLEET_STATE };
		process.env.AGENTFLEET_REGISTRY = join(dir, "registry");
		process.env.AGENTFLEET_STATE = join(dir, "marks.json");

		try {
			const agent: HerdrAgent = {
				paneId: "p1",
				agent: "pi",
				status: "blocked",
				cwd: REPO,
				foregroundCwd: REPO,
				workspaceId: "w2C",
				tabId: "w2C:t1",
				title: "pi",
				completionSeq: 1,
				stateChangeSeq: 1,
				focused: false,
			};
			writeFileSync(
				join(dir, "registry", "p1.json"),
				JSON.stringify({ paneId: "p1", cwd: REPO, intent: "answer the prompt", phase: "verify", state: "working", last: "ran the suite", updated: new Date(Date.now() - 60_000).toISOString(), group: "fleet-supervisor" }),
			);

			const finding = JSON.stringify({ diagnosis: "waiting on a yes", recommendation: "say yes", evidence: ["blocked"], confidence: 0.8, proposed: { paneId: "p1", op: "nudge", argument: "yes, continue" } });
			const config = tickConfig(dir, { dry: true, inspector: "cheap", maxInspectionsPerTick: 1, ask: "never" });
			await tick({
				port: fakePort(agent),
				notifier: { async send() {} },
				config,
				models: {
					primary: fixedModel("primary", { op: "nudge", argument: "keep going" }),
					escalator: fixedModel("escalator", { argument: finding, raw: finding, confidence: 0.8 }),
				},
			});

			const store = openStore(config.eventsPath);
			const ingested = store.ingest();
			const events = store.query({ window: "all" });
			const inspection = events.find((event): event is InspectionEvent => event.kind === "inspection");
			const trigger = events.find((event): event is TriggerEvent => event.kind === "trigger");
			const actions = events.filter((event): event is ActionEvent => event.kind === "action");

			assert.ok(inspection !== undefined && trigger !== undefined);
			assert.equal(trigger.triggerKind, "blocked");
			assert.equal(inspection.triggerKind, "blocked");
			assert.equal(inspection.mode, "cheap");
			assert.equal(inspection.proposed, true);
			assert.equal(inspection.degraded, false);
			assert.equal(inspection.model, "escalator");
			assert.equal(actions.length >= 1, true);
			assert.equal(actions.every((action) => action.disposition === "dry"), true, "a dry tick performs nothing");

			const report = buildReport({
				events,
				window: "all",
				logPath: config.eventsPath,
				indexPath: store.indexPath,
				indexKind: store.indexKind,
				ignoredRows: ingested.ignoredTotal,
			});
			assert.equal(report.ticks.dry, 1);
			assert.equal(report.ticks.held.total, 0);
			assert.equal(report.inspections.proposed.count, 1);
			assert.equal(report.triggers.byKind[0]?.kind, "blocked");
			store.close();
		} finally {
			if (saved.registry === undefined) delete process.env.AGENTFLEET_REGISTRY;
			else process.env.AGENTFLEET_REGISTRY = saved.registry;
			if (saved.state === undefined) delete process.env.AGENTFLEET_STATE;
			else process.env.AGENTFLEET_STATE = saved.state;
		}
	});
});
