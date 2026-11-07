// The two axes, as a contract.
//
// The bug this module exists for: whether the panes are live is a fact about herdr, and
// whether there is any decision history is a fact about `events.jsonl`. The GUI derived both
// from the log's existence, so a live fleet with an empty decision log reported itself as
// "the shipped fixture" and the pane list was never even requested. Every test below pins one
// half of that: a live pane list with no log is `live` + `none yet`, and a fixture load says
// it is a sample without ever claiming a measurement.

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { defaultOptions } from "../../src/fleet/envelope.ts";
import { readEventLog } from "../../src/fleet/events.ts";
import { decisionAxis, paneAxis, resetPaneCache, scopeOf, sourceOf } from "../../src/fleet/source.ts";
import type { PaneList } from "../../src/fleet/types.ts";

function tempDir(): string {
	return mkdtempSync(join(tmpdir(), "fleet-source-"));
}

function paneList(origin: PaneList["origin"], count: number, reason: string | null = null): PaneList {
	return {
		origin,
		reason,
		panes: Array.from({ length: count }, (_unused, index) => ({
			pane_id: `w4${index}:p1`,
			workspace_id: `w4${index}`,
			tab_id: `w4${index}:t1`,
			agent: "pi",
			agent_status: "idle",
			cwd: "/home/andrew/work",
			foreground_cwd: "/home/andrew/work",
			focused: false,
			label: null,
			revision: 1,
			terminal_id: "term_x",
			terminal_title: "π - andrew",
			terminal_title_stripped: "π - andrew",
			agent_session: null,
			completion_seq: 1,
			state_change_seq: 1,
		})),
	};
}

test("the pane axis is decided by the pane list, never by the log", () => {
	const live = paneAxis(paneList("herdr", 3));
	assert.equal(live.name, "live");
	assert.equal(live.words, "3 live panes");
	assert.match(live.reason, /herdr answered with 3/);

	const absent = paneAxis(paneList("herdr-failed", 0, "herdr agent list: timeout"));
	assert.equal(absent.name, "panes-absent");
	assert.equal(absent.words, "panes absent");
	assert.match(absent.reason, /timeout/);

	const fixture = paneAxis(paneList("fixture", 2));
	assert.equal(fixture.name, "fixture");
	assert.equal(fixture.words, "2 sample panes");
});

test("the decision axis says `none yet` without changing what the pane axis says", () => {
	const empty = decisionAxis([], { present: false, path: "/tmp/events.jsonl" });
	assert.equal(empty.count, 0);
	assert.equal(empty.words, "none yet");
	assert.match(empty.reason, /does not exist yet/);

	const present = decisionAxis([], { present: true, path: "/tmp/events.jsonl" });
	assert.equal(present.words, "none yet");
	assert.match(present.reason, /has no decision row/);

	const rows = [{ kind: "decision" }, { kind: "tick" }, { kind: "decision" }];
	const two = decisionAxis(rows, { present: true, path: "/tmp/events.jsonl" });
	assert.equal(two.count, 2);
	assert.equal(two.words, "2 decisions");

	const one = decisionAxis([{ kind: "decision" }], { present: true, path: "/tmp/events.jsonl" });
	assert.equal(one.words, "1 decision");
});

test("a live pane list and an empty log is live + none yet, never the fixture", async () => {
	const dir = tempDir();
	resetPaneCache();
	try {
		const opts = defaultOptions({ dataDir: dir, herdr: false, forceFixture: false });
		// `herdr: false` cannot be live, so this asserts the axis rule from the other side:
		// a box with no herdr and no log is a fixture load, and it says so in its own words.
		const source = await sourceOf(opts, 1_700_000_000_000);
		assert.equal("error" in source, false);
		if ("error" in source) return;
		assert.equal(source.mode, "fixture");
		assert.equal(source.paneAxis.name, "fixture");
		assert.equal(source.decisions.words, "none yet");
		assert.equal(source.decisions.sample, true);
		assert.match(source.banner ?? "", /made-up conversation/);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("--live with nothing to read is an error, not an empty fleet", async () => {
	const dir = tempDir();
	resetPaneCache();
	try {
		const source = await sourceOf(defaultOptions({ dataDir: dir, herdr: false, live: true }), 1_700_000_000_000);
		assert.equal("error" in source, true);
		if (!("error" in source)) return;
		assert.match(source.error, /--live was given/);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a fixture pane id outside the sample namespace fails the load", async () => {
	const dir = tempDir();
	resetPaneCache();
	try {
		mkdirSync(join(dir, "panes.json"), { recursive: true });
		rmSync(join(dir, "panes.json"), { recursive: true, force: true });
		writeFileSync(join(dir, "panes.json"), JSON.stringify([{ pane_id: "w46:p1", agent: "pi" }]));
		const source = await sourceOf(defaultOptions({ dataDir: dir, fixtureDir: dir, herdr: false, forceFixture: true }), 1_700_000_000_000);
		assert.equal("error" in source, true);
		if (!("error" in source)) return;
		assert.match(source.error, /outside the sample namespace/);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("comparable is true only when the records and the pane list came from the same source", () => {
	const live = scopeOf({ mode: "live", panes: paneList("herdr", 1) });
	assert.equal(live.comparable, true);

	const split = scopeOf({ mode: "live", panes: paneList("fixture", 1) });
	assert.equal(split.comparable, false);
	assert.match(split.why, /the two are not compared/);

	const none = scopeOf({ mode: "live", panes: paneList("disabled", 0, "--no-herdr") });
	assert.equal(none.comparable, false);
	assert.equal(none.panes.kind, "none");
	assert.match(none.why, /no pane list/);
});

test("a cartesian record load is live even when the pane list is missing", () => {
	// `panes-absent` is a *live record* load: the state files were read from the real state
	// dir and only the pane list is missing. Reading it as `fixture` was how a box with no
	// herdr came to be described as "sample data".
	const scope = scopeOf({ mode: "panes-absent", panes: paneList("herdr-failed", 0, "timeout") });
	assert.equal(scope.records, "live");
	assert.equal(scope.comparable, false);
});

test("the event log separates typed rows, untyped rows and refusals", () => {
	const dir = tempDir();
	try {
		const path = join(dir, "events.jsonl");
		const typed = { schema: 2, ts: "2026-01-01T00:00:00.000Z", kind: "tick", agents: 1, moved: 0, decisions: 0, escalated: 0, escalationFailed: 0, triggers: 0, inspected: 0, prompts: 0, held: 0, costUsd: 0, durationMs: 1, models: [], dry: true };
		const untyped = { kind: "operator", ts: "2026-01-01T00:01:00.000Z", operator: "andrew", verb: "answer" };
		const oldSchema = { schema: 1, ts: "2026-01-01T00:02:00.000Z", kind: "tick" };
		writeFileSync(path, [JSON.stringify(typed), JSON.stringify(untyped), JSON.stringify(oldSchema), "not json", ""].join("\n"));
		const log = readEventLog(path);
		assert.equal(log.typed.length, 1, "only the schema-2 row is typed");
		// A row with a `kind` but not schema 2 is counted and skipped in the untyped bucket, not
		// rejected: it is a human-readable line from an older writer as far as this reader can
		// tell, and the counters are where that is visible.
		assert.equal(log.untypedCount, 2, "the operator row and the v1 row are both untyped");
		assert.equal(log.untyped[0]?.kind, "operator");
		assert.equal(log.rejected.count, 1, "the unparseable line is the only refusal");
		assert.equal(log.truncatedTail, false);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
