// The judge's boundaries, the state file's durability, and the exporter's
// include/skip rule — plus one tick, against fakes, to prove the wiring records a
// decision with the pane's current sequence and judges it only after its window.

import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Decision, DecisionInput, DecisionModel, Op } from "../src/decision/types.ts";
import type { HerdrAgent, HerdrPort, PromptResult } from "../src/herdr/types.ts";
import type { Notifier } from "../src/notify/telegram.ts";
import type { Config } from "../src/manager/config.ts";
import { tick } from "../src/manager/tick.ts";
import { DEFAULT_WINDOW_TICKS, decidedAt, isSilent, judge, observedTicks, parsePending, pendingJson, pendingPath, recordPending, type Observation, type OutcomeKind, type PendingDecision } from "../src/metrics/outcome.ts";
import { eventLine, makeOutcome, parseEvent, type OutcomeEvent } from "../src/metrics/schema.ts";
import { exportObserved, expectedOpFor, observedPath, readOutcomes, writeRows } from "../src/metrics/export-observed.ts";
import { buildReport, MIN_SILENT_DECISIONS, outcomeSummary } from "../src/metrics/report.ts";
import { agent } from "./fixtures.ts";

// --------------------------------------------------------------- fixtures

function pending(overrides: Partial<PendingDecision> = {}): PendingDecision {
	return { paneId: "p1", group: "fleet-supervisor", op: "leave", argument: "still on the current step", decidedAtSeq: 5, ticksObserved: 0, ...overrides };
}

/** A resting pane whose counter has not moved since the decision at sequence 5. */
const STILL: Observation = { completionSeq: 5, status: "idle" };
const MOVED: Observation = { completionSeq: 6, status: "working" };

let fixtureTs = Date.parse("2024-05-01T00:00:00.000Z");

function outcome(op: Op, outcomeKind: OutcomeKind): OutcomeEvent {
	fixtureTs += 60_000;
	return makeOutcome({
		paneId: "p1",
		group: "fleet-supervisor",
		op,
		outcomeKind,
		ticksObserved: DEFAULT_WINDOW_TICKS,
		movedSinceDecision: outcomeKind === "progressed" || outcomeKind === "reopened",
		argument: `${op} on a pane that then ${outcomeKind}`,
		status: outcomeKind === "unobserved" ? "unknown" : "idle",
		idleTicks: outcomeKind === "unobserved" ? 0 : DEFAULT_WINDOW_TICKS,
		cwd: "/home/operator/work/fleet-supervisor",
		title: "pi",
		ts: new Date(fixtureTs).toISOString(),
	});
}

// ------------------------------------------------------------------- judge

test("the window is pinned, and nothing is judged before it elapses", () => {
	assert.equal(DEFAULT_WINDOW_TICKS, 3, "a judgement delayed or hurried by one tick must be a deliberate change");

	assert.equal(judge(pending({ ticksObserved: 0 }), STILL, DEFAULT_WINDOW_TICKS), undefined, "the decision's own tick is not an observation");
	assert.equal(judge(pending({ ticksObserved: DEFAULT_WINDOW_TICKS - 2 }), STILL, DEFAULT_WINDOW_TICKS), undefined, "one tick short of the window is not a verdict");
	assert.deepEqual(judge(pending({ ticksObserved: DEFAULT_WINDOW_TICKS - 1 }), STILL, DEFAULT_WINDOW_TICKS), {
		paneId: "p1",
		op: "leave",
		kind: "stalled",
		ticksObserved: DEFAULT_WINDOW_TICKS,
		movedSinceDecision: false,
	});
});

test("every OutcomeKind is reachable, at its own boundary", () => {
	const atWindow = (decision: PendingDecision, now: Observation) => judge({ ...decision, ticksObserved: DEFAULT_WINDOW_TICKS - 1 }, now, DEFAULT_WINDOW_TICKS);

	// progressed: a silent op, then the pane moved. Movement is judged at once —
	// waiting out the window would only add ticks to a question already answered.
	assert.equal(judge(pending(), MOVED, DEFAULT_WINDOW_TICKS)?.kind, "progressed");
	assert.equal(judge(pending(), MOVED, DEFAULT_WINDOW_TICKS)?.ticksObserved, 1);

	// stalled: silence plus stillness, only at the window.
	assert.equal(atWindow(pending(), STILL)?.kind, "stalled");

	// satisfied: a declaration the pane did not contradict.
	assert.equal(atWindow(pending({ op: "declare_done" }), STILL)?.kind, "satisfied");

	// reopened: a declaration the pane carried on past.
	assert.equal(judge(pending({ op: "declare_done" }), MOVED, DEFAULT_WINDOW_TICKS)?.kind, "reopened");

	// unobserved: the pane left the snapshot — closed, or renamed out of the fleet.
	assert.equal(judge(pending({ ticksObserved: DEFAULT_WINDOW_TICKS - 1 }), { completionSeq: 5, status: "unknown", present: false }, DEFAULT_WINDOW_TICKS)?.kind, "unobserved");
	// unobserved: a counter that went backwards is a restart, not a pane that sat still.
	assert.equal(judge(pending(), { completionSeq: 4, status: "idle" }, DEFAULT_WINDOW_TICKS)?.kind, "unobserved");
});

test("a nudge is never labelled, in either direction", () => {
	// A nudge that produced no movement is a repair rate, so the judge refuses to
	// turn it into a verdict even after the window.
	assert.equal(judge(pending({ op: "nudge", ticksObserved: DEFAULT_WINDOW_TICKS - 1 }), STILL, DEFAULT_WINDOW_TICKS), undefined);
	// And a nudge followed by movement is still a nudge: unidentifiable, never a
	// positive label. That is the exporter's rule, asserted below.
	assert.equal(judge(pending({ op: "nudge" }), MOVED, DEFAULT_WINDOW_TICKS)?.kind, "progressed");
	assert.deepEqual(expectedOpFor("nudge", "progressed"), {
		skip: "a nudge followed by movement cannot be attributed to the nudge, so no positive label is claimed",
	});
});

test("a working pane is not a stalled pane, however long the window", () => {
	assert.equal(judge(pending({ ticksObserved: DEFAULT_WINDOW_TICKS + 5 }), { completionSeq: 5, status: "working" }, DEFAULT_WINDOW_TICKS), undefined);
	assert.equal(isSilent("leave"), true);
	assert.equal(isSilent("flag"), true);
	assert.equal(isSilent("nudge"), false);
	assert.equal(isSilent("declare_done"), false);
});

// ------------------------------------------------------------- persistence

test("pending.json round-trips, and a restarted tick keeps the ticks already spent", () => {
	const path = pendingPath("/state/events.jsonl");
	assert.equal(path, "/state/pending.json", "the state file sits beside the log it explains");

	let open: Map<string, PendingDecision> = new Map();
	open = recordPending(open, decidedAt({ paneId: "p1", group: "fleet-supervisor", op: "leave", argument: "stay out of it" }, 7));
	open = recordPending(open, decidedAt({ paneId: "p2", group: "fleet-supervisor", op: "declare_done", argument: "finished" }, 11));

	const restored = parsePending(JSON.stringify(pendingJson(open), null, "\t"));
	assert.deepEqual([...restored.keys()], ["p1", "p2"], "sorted by pane id, so an unchanged rewrite produces the same bytes");
	assert.deepEqual(restored.get("p1"), open.get("p1"));
	assert.deepEqual(restored.get("p2"), open.get("p2"));

	// Two ticks into a three-tick window, a restart is two ticks in: the counter
	// lives in the file, and a reader that started it at zero would judge a pane
	// that has not had its window yet.
	const spent = recordPending(new Map(), { ...decidedAt({ paneId: "p1", group: "fleet-supervisor", op: "leave", argument: "stay out of it" }, 5), ticksObserved: DEFAULT_WINDOW_TICKS - 1 });
	const reloaded = parsePending(JSON.stringify(pendingJson(spent))).get("p1");
	assert.ok(reloaded !== undefined);
	assert.equal(reloaded.ticksObserved, DEFAULT_WINDOW_TICKS - 1);
	assert.equal(observedTicks(reloaded), DEFAULT_WINDOW_TICKS);
	assert.equal(judge(reloaded, STILL, DEFAULT_WINDOW_TICKS)?.kind, "stalled");

	// A newer decision for the same pane supersedes the open one: judging both
	// would attribute one stretch of stillness to two different ops.
	const superseded = recordPending(open, decidedAt({ paneId: "p1", group: "fleet-supervisor", op: "nudge", argument: "try the next test" }, 9));
	assert.equal(superseded.size, 2);
	assert.equal(superseded.get("p1")?.op, "nudge");
});

test("a malformed pending.json is bookkeeping lost, not a tick stopped", () => {
	assert.deepEqual([...parsePending("").keys()], []);
	assert.deepEqual([...parsePending("not json at all").keys()], []);
	assert.deepEqual([...parsePending("[1, 2, 3]").keys()], []);

	const good = decidedAt({ paneId: "p1", group: "fleet-supervisor", op: "leave", argument: "a" }, 3);
	const mixed = parsePending(JSON.stringify({ p1: good, p2: { op: "nonsense", group: "g" }, p3: { ...good, ticksObserved: -1 } }));
	assert.deepEqual([...mixed.keys()], ["p1"], "an unparseable entry is dropped and the rest of the file still loads");
});

// ---------------------------------------------------------------- exporter

test("the exporter emits only what the outcome justifies, and counts every skip with its reason", () => {
	const fixture = [
		outcome("leave", "stalled"),
		outcome("flag", "stalled"),
		outcome("leave", "progressed"),
		outcome("flag", "progressed"),
		outcome("declare_done", "reopened"),
		outcome("declare_done", "satisfied"),
		outcome("declare_done", "progressed"),
		outcome("nudge", "progressed"),
		outcome("leave", "unobserved"),
		outcome("nudge", "unobserved"),
	];
	const report = exportObserved(fixture);

	assert.equal(report.outcomes, fixture.length);
	assert.equal(report.rows.length, 5, "three rules emit, and five of these ten rows match one");

	const emitted = (op: Op, kind: OutcomeKind): number => report.emitted.find((entry) => entry.op === op && entry.outcomeKind === kind)?.count ?? 0;
	const skipped = (op: Op, kind: OutcomeKind): number => report.skipped.find((entry) => entry.op === op && entry.outcomeKind === kind)?.count ?? 0;

	// silence plus stillness: the counterexample the corpus cannot produce.
	assert.equal(emitted("leave", "stalled"), 1);
	assert.equal(emitted("flag", "stalled"), 1);
	// silence plus movement: staying out of the way did not visibly cost anything.
	assert.equal(emitted("leave", "progressed"), 1);
	assert.equal(emitted("flag", "progressed"), 1);
	// a declaration the pane carried on past: a premature stop.
	assert.equal(emitted("declare_done", "reopened"), 1);

	assert.equal(skipped("declare_done", "satisfied"), 1, "a declaration that held has no op to learn");
	assert.equal(skipped("declare_done", "progressed"), 1);
	assert.equal(skipped("nudge", "progressed"), 1);
	assert.equal(skipped("leave", "unobserved"), 1);
	assert.equal(skipped("nudge", "unobserved"), 1);

	assert.equal(
		report.rows.length + report.skipped.reduce((sum, entry) => sum + entry.count, 0),
		fixture.length,
		"every outcome is either a row or a named skip",
	);
	for (const entry of report.skipped) assert.notEqual(entry.reason, "", `${entry.op}:${entry.outcomeKind} must say why it was skipped`);

	const byExpected = report.rows.map((row) => row.expectedOp).sort();
	assert.deepEqual(byExpected, ["leave", "leave", "nudge", "nudge", "nudge"]);
});

test("an exported row is shaped like a bench task and says where it came from", () => {
	const fixture = outcome("leave", "stalled");
	const report = exportObserved([fixture]);
	const row = report.rows[0];
	assert.ok(row !== undefined);

	assert.deepEqual(Object.keys(row).sort(), ["expectedOp", "id", "input", "provenance"], "the same keys as tasks.jsonl plus provenance");
	assert.equal(row.provenance, "observed");
	assert.equal(row.expectedOp, "nudge");
	assert.match(row.id, /^obs-0000-[0-9a-f]{8}$/);
	assert.equal("humanText" in row, false, "nobody typed anything: that is why the row exists");

	// The row carries what the outcome event observed and nothing it did not: no
	// transcript, no claim. A thin input is the honest one.
	assert.equal(row.input.paneId, "p1");
	assert.equal(row.input.status, "idle");
	assert.equal(row.input.idleTicks, DEFAULT_WINDOW_TICKS);
	assert.equal(row.input.tail, "");
	assert.equal(row.input.phase, "unknown");
	assert.equal(row.input.claimState, "unknown");

	// Two exports of the same log produce the same ids, so rows can be diffed
	// between runs instead of keyed on their position.
	assert.equal(exportObserved([fixture]).rows[0]?.id, row.id);
});

test("the exporter reads outcome rows out of a real events log and skips the rest", () => {
	const dir = mkdtempSync(join(tmpdir(), "agentfleet-outcome-"));
	try {
		const logPath = join(dir, "events.jsonl");
		// A real log: one row of this schema, one pre-schema row, one broken line.
		const written = [eventLine(outcome("leave", "stalled")), '{"kind":"outcome","schema":1,"ts":"2024-05-01T00:00:00.000Z"}', "not json", eventLine(outcome("nudge", "progressed"))];
		writeFileSync(logPath, `${written.join("\n")}\n`);

		const outcomes = readOutcomes(logPath);
		assert.equal(outcomes.length, 2, "a pre-schema row and a broken line are skipped, not guessed at");

		const report = exportObserved(outcomes);
		writeRows(report.rows, observedPath(logPath));

		const outPath = observedPath(logPath);
		assert.equal(outPath, join(dir, "observed-tasks.jsonl"), "rows are written beside the log, never into bench/tasks");
		const lines = readFileSync(outPath, "utf8").split("\n").filter((line) => line.trim() !== "");
		assert.equal(lines.length, 1);
		const row = JSON.parse(lines[0] as string) as { expectedOp: string; provenance: string };
		assert.equal(row.expectedOp, "nudge");
		assert.equal(row.provenance, "observed");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

// ------------------------------------------------------------------ report

test("the report counts outcomes by op and verdict, and refuses a precision on too few decisions", () => {
	const events = [outcome("leave", "progressed"), outcome("leave", "stalled"), outcome("nudge", "progressed"), outcome("declare_done", "reopened")];
	const report = buildReport({ events, window: "all", logPath: "/state/events.jsonl", indexPath: null, indexKind: "scan", ignoredRows: 0 });

	assert.equal(report.outcomes.total, 4);
	assert.deepEqual(
		report.outcomes.byOpKind.map((entry) => `${entry.op}×${entry.outcomeKind} ${entry.count}`),
		["declare_done×reopened 1", "leave×progressed 1", "leave×stalled 1", "nudge×progressed 1"],
	);
	assert.deepEqual(report.outcomes.byKind, [
		{ outcomeKind: "progressed", count: 2 },
		{ outcomeKind: "stalled", count: 1 },
		{ outcomeKind: "satisfied", count: 0 },
		{ outcomeKind: "reopened", count: 1 },
		{ outcomeKind: "unobserved", count: 0 },
	]);

	// Two silent decisions is not a rate: the number is printed, the percentage is
	// not.
	assert.equal(report.outcomes.silence.decisions, 2);
	assert.equal(report.outcomes.silence.precision, null);
	assert.equal(report.outcomes.silence.precisionText, `insufficient data (2 decisions; ${MIN_SILENT_DECISIONS} needed)`);
	assert.equal(report.outcomes.silence.threshold, MIN_SILENT_DECISIONS);

	// The section reaches the human report through the notes, because ./render.ts
	// owns the tables and this module owns every number in them.
	assert.equal(report.notes.some((note) => note.startsWith("outcomes 4 (")), true);
	assert.equal(report.notes.some((note) => note.includes("insufficient data (2 decisions")), true);
	assert.equal(report.notes.some((note) => note.includes("correlation, not causation")), true);
	assert.match(outcomeSummary(report.outcomes), /silent-decision precision insufficient data/);
});

test("silent-decision precision is quoted once the floor is reached", () => {
	const events: OutcomeEvent[] = [];
	for (let index = 0; index < MIN_SILENT_DECISIONS; index += 1) events.push(index < MIN_SILENT_DECISIONS / 2 ? outcome("leave", "progressed") : outcome("leave", "stalled"));
	const report = buildReport({ events, window: "all", logPath: "/state/events.jsonl", indexPath: null, indexKind: "scan", ignoredRows: 0 });

	assert.equal(report.outcomes.silence.decisions, MIN_SILENT_DECISIONS);
	assert.equal(report.outcomes.silence.precision, 0.5);
	assert.equal(report.outcomes.silence.precisionText, `50.0% of ${MIN_SILENT_DECISIONS} silent decisions progressed`);

	// A pane that left the snapshot is excluded from the denominator rather than
	// counted as a silence that failed.
	const withUnobserved = [...events, outcome("leave", "unobserved")];
	const dropped = buildReport({ events: withUnobserved, window: "all", logPath: "/state/events.jsonl", indexPath: null, indexKind: "scan", ignoredRows: 0 });
	assert.equal(dropped.outcomes.silence.dropped, 1);
	assert.equal(dropped.outcomes.silence.decisions, MIN_SILENT_DECISIONS);
	assert.equal(dropped.outcomes.silence.precision, 0.5);
	assert.equal(dropped.notes.some((note) => note.includes("have no verdict")), true);
});

// -------------------------------------------------------------------- tick

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
			return "$ npm test\nok 250 tests";
		},
		async prompt(): Promise<PromptResult> {
			return { disposition: "accepted" };
		},
	};
}

function leaveModel(): DecisionModel {
	const decision: Decision = { op: "leave", argument: "still on the current step", confidence: 0.9, model: "primary", costUsd: 0, latencyMs: 1, refused: false, raw: '{"op":"leave"}' };
	return {
		name: "primary",
		costPerCallUsd: 0,
		async decide(_input: DecisionInput): Promise<Decision> {
			return decision;
		},
	};
}

function liveConfig(dir: string): Config {
	return {
		intervalMs: 60_000,
		once: true,
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

async function runTick(dir: string, agents: readonly HerdrAgent[]): Promise<void> {
	const saved = { registry: process.env.AGENTFLEET_REGISTRY, state: process.env.AGENTFLEET_STATE };
	process.env.AGENTFLEET_REGISTRY = join(dir, "registry");
	process.env.AGENTFLEET_STATE = join(dir, "marks.json");
	try {
		await tick({ port: fakePort(agents), notifier: SILENT, config: liveConfig(dir), models: { primary: leaveModel(), escalator: leaveModel() } });
	} finally {
		if (saved.registry === undefined) delete process.env.AGENTFLEET_REGISTRY;
		else process.env.AGENTFLEET_REGISTRY = saved.registry;
		if (saved.state === undefined) delete process.env.AGENTFLEET_STATE;
		else process.env.AGENTFLEET_STATE = saved.state;
	}
}

interface OutcomeRow {
	outcomeKind: OutcomeKind;
	ticksObserved: number;
	movedSinceDecision: boolean;
	op: Op;
}

function outcomeEvents(dir: string): OutcomeRow[] {
	const rows: OutcomeRow[] = [];
	for (const line of readFileSync(join(dir, "events.jsonl"), "utf8").split("\n")) {
		if (line.trim() === "") continue;
		const event = parseEvent(line);
		if (event === undefined || event.kind !== "outcome") continue;
		rows.push({ outcomeKind: event.outcomeKind, ticksObserved: event.ticksObserved, movedSinceDecision: event.movedSinceDecision, op: event.op });
	}
	return rows;
}

test("a tick records its decision with the pane's current sequence, and judges it only after its window", async () => {
	const dir = mkdtempSync(join(tmpdir(), "agentfleet-judge-"));
	// The pane is at sequence 2 and stays there: the tick that decides *because*
	// the agent appeared must not read its own movement as an answer.
	const still = [agent("p1", { status: "idle", completionSeq: 2 })];
	try {
		await runTick(dir, still);
		const open = parsePending(readFileSync(pendingPath(join(dir, "events.jsonl")), "utf8"));
		assert.equal(open.get("p1")?.op, "leave");
		assert.equal(open.get("p1")?.decidedAtSeq, 2, "the baseline is the pane's sequence as the snapshot saw it");
		assert.equal(open.get("p1")?.ticksObserved, 0);
		assert.equal(outcomeEvents(dir).length, 0, "a decision is not judged in the tick that made it");

		// Two more ticks: the counter is read back from the file each time, which is
		// the same path a restarted supervisor takes.
		await runTick(dir, still);
		assert.equal(parsePending(readFileSync(pendingPath(join(dir, "events.jsonl")), "utf8")).get("p1")?.ticksObserved, 1);
		await runTick(dir, still);
		assert.equal(parsePending(readFileSync(pendingPath(join(dir, "events.jsonl")), "utf8")).get("p1")?.ticksObserved, 2);
		assert.equal(outcomeEvents(dir).length, 0, "one tick short of the window is not a verdict");

		// The third observed tick is the window: silence plus stillness.
		await runTick(dir, still);
		assert.deepEqual(outcomeEvents(dir), [{ outcomeKind: "stalled", ticksObserved: DEFAULT_WINDOW_TICKS, movedSinceDecision: false, op: "leave" }]);
		assert.deepEqual([...parsePending(readFileSync(pendingPath(join(dir, "events.jsonl")), "utf8")).keys()], [], "a judged decision leaves the file");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a flag is silent, so it is tracked even though its action row says skipped", async () => {
	const dir = mkdtempSync(join(tmpdir(), "agentfleet-judge-"));
	const saved = { registry: process.env.AGENTFLEET_REGISTRY, state: process.env.AGENTFLEET_STATE };
	process.env.AGENTFLEET_REGISTRY = join(dir, "registry");
	process.env.AGENTFLEET_STATE = join(dir, "marks.json");
	try {
		const flagged: Decision = { op: "flag", argument: "this pane needs a human", confidence: 0.9, model: "primary", costUsd: 0, latencyMs: 1, refused: false, raw: '{"op":"flag"}' };
		const model: DecisionModel = {
			name: "primary",
			costPerCallUsd: 0,
			async decide(_input: DecisionInput): Promise<Decision> {
				return flagged;
			},
		};
		await tick({ port: fakePort([agent("p1", { status: "idle", completionSeq: 2 })]), notifier: SILENT, config: liveConfig(dir), models: { primary: model, escalator: model } });

		const open = parsePending(readFileSync(pendingPath(join(dir, "events.jsonl")), "utf8"));
		assert.equal(open.get("p1")?.op, "flag", "a flag asked the pane for nothing, so its silence is judgeable");
		assert.equal(open.get("p1")?.decidedAtSeq, 2);
	} finally {
		if (saved.registry === undefined) delete process.env.AGENTFLEET_REGISTRY;
		else process.env.AGENTFLEET_REGISTRY = saved.registry;
		if (saved.state === undefined) delete process.env.AGENTFLEET_STATE;
		else process.env.AGENTFLEET_STATE = saved.state;
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a pane that moves after a silent decision is judged progressed, without waiting for the window", async () => {
	const dir = mkdtempSync(join(tmpdir(), "agentfleet-judge-"));
	try {
		await runTick(dir, [agent("p1", { status: "idle", completionSeq: 2 })]);

		// The pane finished the turn it was already in. Nothing here can tell that
		// from a nudge that worked, which is why movement is only ever a
		// `progressed` outcome and never a positive label.
		await runTick(dir, [agent("p1", { status: "working", completionSeq: 3 })]);
		assert.deepEqual(outcomeEvents(dir), [{ outcomeKind: "progressed", ticksObserved: 1, movedSinceDecision: true, op: "leave" }]);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a dry tick records no open decision, so a rehearsal never becomes evidence", async () => {
	const dir = mkdtempSync(join(tmpdir(), "agentfleet-judge-"));
	const saved = { registry: process.env.AGENTFLEET_REGISTRY, state: process.env.AGENTFLEET_STATE };
	process.env.AGENTFLEET_REGISTRY = join(dir, "registry");
	process.env.AGENTFLEET_STATE = join(dir, "marks.json");
	try {
		const config: Config = { ...liveConfig(dir), dry: true };
		await tick({ port: fakePort([agent("p1", { status: "idle", completionSeq: 2 })]), notifier: SILENT, config, models: { primary: leaveModel(), escalator: leaveModel() } });
		assert.throws(() => readFileSync(pendingPath(join(dir, "events.jsonl")), "utf8"), /ENOENT/, "a dry tick leaves no pending.json behind");
	} finally {
		if (saved.registry === undefined) delete process.env.AGENTFLEET_REGISTRY;
		else process.env.AGENTFLEET_REGISTRY = saved.registry;
		if (saved.state === undefined) delete process.env.AGENTFLEET_STATE;
		else process.env.AGENTFLEET_STATE = saved.state;
		rmSync(dir, { recursive: true, force: true });
	}
});
