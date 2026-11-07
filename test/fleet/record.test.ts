// The record: one pass, one read, one object per conversation — and the four numbers a row
// carries that used to be derived three times (once for the table, once for the lanes, once
// for the pane screen).

import assert from "node:assert/strict";
import { test } from "node:test";

import {
	applyFilter,
	compareOrphans,
	compareRows,
	filterCounts,
	lastPerPane,
	lastPromptFor,
	record,
	recordFor,
	recordInputs,
	type Rec,
} from "../../src/fleet/record.ts";
import type { Ctx, Row, Source } from "../../src/fleet/types.ts";
import type { SchemaEvent } from "../../src/metrics/schema.ts";

const NOW = 1_700_000_000_000;

function row(paneId: string, overrides: Partial<Row> = {}): Row {
	return {
		pane_id: paneId,
		workspace_id: paneId.split(":")[0] ?? "w1",
		tab_id: "t1",
		agent: "pi",
		agent_status: "idle",
		cwd: "/home/andrew/work",
		foreground_cwd: "/home/andrew/work",
		focused: false,
		label: `label ${paneId}`,
		revision: 1,
		terminal_id: "term",
		terminal_title: "π - andrew",
		terminal_title_stripped: "π - andrew",
		agent_session: null,
		completion_seq: 1,
		state_change_seq: 1,
		...overrides,
	};
}

function decision(paneId: string, ts: number, costUsd = 0.001): SchemaEvent {
	return {
		schema: 2,
		ts: new Date(ts).toISOString(),
		kind: "decision",
		paneId,
		group: "work",
		model: "commandcode/deepseek/deepseek-v4.1-flash",
		op: "leave",
		confidence: 0.5,
		refused: false,
		escalated: false,
		escalationFailed: false,
		latencyMs: 100,
		costUsd,
		policy: "fork",
		held: false,
	};
}

function ctxFrom(panes: Row[], events: SchemaEvent[], claims: Map<string, { claim: { paneId: string; intent: string; state: "working" | "waiting" | "done"; phase: "implement"; last: string; updated: string }; name: string; path: string; mtimeMs: number; mtime: string }> = new Map()): Ctx {
	const source = {
		mode: "live",
		modeReason: "",
		paneAxis: { name: "live", words: "live", reason: "" },
		decisions: { present: true, count: 1, words: "1 decision", reason: "", sample: false },
		sourceDetail: "/state/events.jsonl",
		stateDir: "/state",
		registryDir: "/claims",
		events: { typed: events, untyped: [], untypedCount: 0, rejected: { count: 0, samples: [] }, stat: { exists: true, bytes: 1, mtimeMs: NOW, mtime: "", error: null }, truncatedTail: false, exists: true },
		asks: { log: new Map(), pending: [], answered: [], answeredTotal: 0, stat: { exists: false, bytes: 0, mtimeMs: null, mtime: null, error: null }, exists: false, lines: 0, rejected: 0 },
		claims: { dir: "/claims", dirExists: true, dirError: null, claims, files: [] },
		panes: { origin: "herdr", panes, reason: null },
		marks: {},
		policy: {},
		triggers: null,
		cooldowns: {},
		pending: {},
		banner: null,
		clock: { shiftMs: 0, rebase: false, anchorOriginal: null },
		files: [],
	} as unknown as Source;
	return {
		now: NOW,
		dataDir: "/state",
		host: null,
		port: null,
		window: "24h",
		dump: null,
		fixture: false,
		herdr: true,
		opts: {} as Ctx["opts"],
		source,
		events,
		allEvents: events,
		byKind: (kind) => events.filter((event) => event.kind === kind),
		allByKind: (kind) => events.filter((event) => event.kind === kind),
		newestRowTs: new Date(NOW - 1000).toISOString(),
		lagSeconds: 1,
		staleAfterMs: 180_000,
		stopAfterMs: 120_000,
	};
}

test("the name on a record is the one chain's, and pi's chrome is not a name", () => {
	const ctx = ctxFrom([row("w1:p1", { label: null })], []);
	const rec = recordFor(ctx, ctx.source.panes.panes[0] as Row);
	assert.equal(rec.name.text, "unnamed");
	assert.equal(rec.name.source, "unnamed");

	const named = recordFor(ctx, row("w2:p1"));
	assert.equal(named.name.text, "label w2:p1");
	assert.equal(named.name.source, "pane label");
});

test("divergence is a fact on the record, not a comparison each renderer makes", () => {
	const claim = {
		claim: { paneId: "w1:p1", intent: "work", state: "working" as const, phase: "implement" as const, last: "", updated: new Date(NOW - 1000).toISOString() },
		name: "w1:p1.json",
		path: "/claims/w1:p1.json",
		mtimeMs: NOW,
		mtime: "",
	};
	const ctx = ctxFrom([row("w1:p1", { agent_status: "idle" })], [], new Map([["w1:p1", claim]]));
	const set = record(ctx);
	const rec = set.rows[0] as Rec;
	assert.equal(rec.claim.present, true);
	assert.equal(rec.diverged, true);
	assert.equal(rec.verdict, "live");
	assert.equal(rec.triage.classes.includes("diverged"), true);
	assert.equal(rec.triage.rank, 1, "a claim that disagrees with its pane ranks above a stale claim");
});

test("a claim whose pane is gone is an orphan, and it is never merged into the pane list", () => {
	const claim = {
		claim: { paneId: "w9:p1", intent: "gone", state: "done" as const, phase: "implement" as const, last: "", updated: new Date(NOW - 1000).toISOString() },
		name: "w9:p1.json",
		path: "/claims/w9:p1.json",
		mtimeMs: NOW,
		mtime: "",
	};
	const ctx = ctxFrom([row("w1:p1")], [], new Map([["w9:p1", claim]]));
	const set = record(ctx);
	assert.equal(set.rows.length, 1);
	assert.equal(set.orphans.length, 1);
	assert.equal(set.orphans[0]?.verdict, "orphaned");
	assert.equal(set.orphans[0]?.triage.rank, null, "an orphan has no place in the pane order");
});

test("the order is consequence first, then age, then the pane id", () => {
	const ctx = ctxFrom([row("w3:p1", { agent_status: "idle" }), row("w1:p1", { agent_status: "blocked" }), row("w2:p1", { agent_status: "working" })], []);
	const rows = record(ctx).rows;
	// No claim file on any of them, so all three are `never claimed` (rank 3) except the one
	// whose status outranks it: a blocked pane cannot resolve itself and leads. Rank 5 is a
	// resting pane *with* a live claim, which this fixture does not have.
	assert.deepEqual(rows.map((r) => r.paneId).sort(), ["w1:p1", "w2:p1", "w3:p1"]);
	assert.equal(rows[0]?.paneId, "w1:p1");
	assert.equal(rows[0]?.triage.rank, 0);
	assert.deepEqual(rows.slice(1).map((r) => r.triage.rank), [3, 3]);
});

test("the comparator is total: two identical rows still order by pane id", () => {
	const ctx = ctxFrom([row("w2:p1"), row("w1:p1")], []);
	const rows = record(ctx).rows;
	assert.equal(rows[0]?.triage.rank, rows[1]?.triage.rank);
	assert.deepEqual(rows.map((r) => r.paneId), ["w1:p1", "w2:p1"]);
	assert.equal(compareRows(rows[0] as Rec, rows[0] as Rec), 0);
	// Oldest first: the row with the larger age sorts ahead, so compare(younger, older) is
	// positive.
	const older = { ...(rows[0] as unknown as Record<string, unknown>), ageSeconds: 900 } as never;
	const younger = { ...(rows[0] as unknown as Record<string, unknown>), ageSeconds: 5 } as never;
	assert.equal(compareOrphans(younger, older) > 0, true);
});

test("the last decision per pane is a fact about now, not about the window", () => {
	const older = decision("w1:p1", NOW - 60_000, 0.0001);
	const newer = decision("w1:p1", NOW - 1_000, 0.0002);
	const latest = lastPerPane([older, newer], "decision").get("w1:p1");
	assert.equal(latest?.ts, newer.ts);
	const ctx = ctxFrom([row("w1:p1")], [older, newer]);
	const rec = recordFor(ctx, ctx.source.panes.panes[0] as Row, recordInputs(ctx));
	assert.equal(rec.lastDecision?.costUsd, 0.0002);
});

test("the last prompt is looked up in the ask log before the untyped rows", () => {
	const asks = new Map([
		[
			"ask-1",
			{
				id: "ask-1",
				ts: new Date(NOW - 10_000).toISOString(),
				paneId: "w1:p1",
				group: "work",
				op: "nudge" as const,
				argument: "from the ask log",
				why: "",
				forks: [],
				cwd: "/home/andrew/work",
				status: "answered" as const,
				answeredAt: new Date(NOW - 5_000).toISOString(),
				answer: "yes" as const,
			},
		],
	]);
	const untyped = [{ kind: "nudge", ts: new Date(NOW - 1_000).toISOString(), paneId: "w1:p1", text: "later, untyped" }];
	const found = lastPromptFor("w1:p1", asks, untyped);
	// The untyped row is newer, and it wins; the source it names is what makes it honest.
	assert.equal(found?.text, "later, untyped");
	assert.match(String(found?.textSource), /untyped/);
	const onlyAsk = lastPromptFor("w1:p1", asks, []);
	assert.equal(onlyAsk?.text, "from the ask log");
});

test("the filter and the chip count are one computation", () => {
	const ctx = ctxFrom([row("w1:p1", { agent_status: "blocked" }), row("w2:p1")], []);
	const set = record(ctx);
	const filtered = applyFilter(set, "blocked");
	assert.equal(filtered.panesMatched, 1);
	assert.equal(filtered.panes[0]?.paneId, "w1:p1");
	const counts = filterCounts(set, { blocked: 1 });
	const blocked = counts.find((entry) => entry.id === "blocked");
	assert.equal(blocked?.count, 1);
	assert.equal(blocked?.attentionCount, 1);
	assert.equal(blocked?.agreesWithStrip, true);
	const none = filterCounts(set, { blocked: 2 }).find((entry) => entry.id === "blocked");
	assert.equal(none?.agreesWithStrip, false, "a chip and the strip disagreeing is visible");
});
