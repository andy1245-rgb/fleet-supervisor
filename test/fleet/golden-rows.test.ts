// The four golden rows, and the field list that used to make them impossible.
//
// The bug: `herdr agent list` carries no `label`, and both `toAgent` copies fed on it, so the
// name chain's first rung was handed `terminal_title_stripped` instead. On this box that meant
// four panes read `π - andrew` on the CLI and `unnamed` on the page, in the same minute, and
// nobody noticed because `label` and `terminal_title_stripped` are identical on the other 38.
//
// So this file pins both halves: the row shape keeps `label`/`revision`/`agent_session`/
// `terminal_id`, and the four rows read `unnamed` through the one chain.

import assert from "node:assert/strict";
import { test } from "node:test";

import { toRow } from "../../src/herdr/cli.ts";
import { nameOf } from "../../src/fleet/name.ts";
import { sessionOf } from "../../src/fleet/identity.ts";
import type { Ctx, Row, Source } from "../../src/fleet/types.ts";

/** One `herdr api snapshot` entry, as the wire carries it: panes have `label` and `revision`,
 * agents have the counters, and only some rows carry `agent_session`. */
const PANES = [
	{ pane_id: "w46:p1", workspace_id: "w46", tab_id: "w46:t1", agent: "pi", agent_status: "idle", cwd: "/home/andrew", foreground_cwd: "/home/andrew", focused: false, label: null, revision: 3, terminal_id: "term_w46", terminal_title: "π - andrew", terminal_title_stripped: "π - andrew" },
	{ pane_id: "w4C:p1", workspace_id: "w4C", tab_id: "w4C:t1", agent: "pi", agent_status: "idle", cwd: "/home/andrew", foreground_cwd: "/home/andrew", focused: false, label: null, revision: 2, terminal_id: "term_w4C", terminal_title: "π - andrew", terminal_title_stripped: "π - andrew" },
	{ pane_id: "w56:p1", workspace_id: "w56", tab_id: "w56:t1", agent: "pi", agent_status: "done", cwd: "/home/andrew", foreground_cwd: "/home/andrew", focused: false, label: null, revision: 1, terminal_id: "term_w56", terminal_title: "π - andrew", terminal_title_stripped: "π - andrew" },
	{ pane_id: "w5G:p1", workspace_id: "w5G", tab_id: "w5G:t1", agent: "pi", agent_status: "done", cwd: "/home/andrew", foreground_cwd: "/home/andrew", focused: false, label: null, revision: 4, terminal_id: "term_w5G", terminal_title: "π - andrew", terminal_title_stripped: "π - andrew" },
	{ pane_id: "w44:p1", workspace_id: "w44", tab_id: "w44:t1", agent: "pi", agent_status: "idle", cwd: "/home/andrew/agentFleet", foreground_cwd: "/home/andrew/agentFleet", focused: false, label: "Parallel Subagent Market", revision: 6, terminal_id: "term_w44", terminal_title: "π - andrew", terminal_title_stripped: "π - andrew" },
];

const AGENTS = [
	{ pane_id: "w44:p1", agent: "pi", agent_status: "idle", completion_seq: 173, state_change_seq: 173, revision: 6, terminal_id: "term_w44" },
	{ pane_id: "w46:p1", agent: "pi", agent_status: "idle", completion_seq: 8, state_change_seq: 8, revision: 3, terminal_id: "term_w46" },
];

test("the row keeps the four fields both `toAgent` copies dropped", () => {
	const pane = PANES[0];
	const agent = AGENTS[1];
	const row = toRow(pane, agent);
	assert.notEqual(row, undefined);
	if (row === undefined) return;
	for (const key of ["label", "revision", "terminal_id", "agent_session"] as const) {
		assert.equal(key in row, true, `${key} must survive the wire`);
	}
	assert.equal(row.revision, 3);
	assert.equal(row.terminal_id, "term_w46");
	assert.equal(row.completion_seq, 8, "the counters are merged in from the agent row");
	assert.equal(row.label, null, "an empty label stays null rather than becoming the chrome");
});

test("the four panes read `unnamed` on both surfaces, and the named one does not", () => {
	const context = { source: { panes: { origin: "herdr", panes: [], reason: null } } } as unknown as Ctx;
	const names = PANES.map((pane) => nameOf({ label: pane.label, noteIntent: null, paneId: pane.pane_id }).text);
	assert.deepEqual(names, ["unnamed", "unnamed", "unnamed", "unnamed", "Parallel Subagent Market"]);
	// The id is reported, not used: identity is a separate question from the name.
	assert.equal(sessionOf(toRow(PANES[0]) as Row, context).state, "unlinked");
});

test("an empty label and a missing label are the same fact", () => {
	const blank = toRow({ ...PANES[4], label: "   " });
	assert.equal(blank?.label, null, "whitespace is not a label");
	assert.equal(nameOf({ label: blank?.label ?? null, noteIntent: null, paneId: "w44:p1" }).text, "unnamed");
	// ... and the same row with its real label proves the chain still reads one.
	assert.equal(nameOf({ label: "Parallel Subagent Market", noteIntent: null, paneId: "w44:p1" }).text, "Parallel Subagent Market");
});

test("a fixture pane row still parses through the same validator", () => {
	// `fixtures/panes.json` is the same shape, so every downstream reader is identical in both
	// modes — that is why one `toRow` serves the snapshot and the fixture.
	const fixture = { pane_id: "sample1:p1", agent: "pi", agent_status: "working", cwd: "/home/andrew/work", terminal_title: "Reviewing Documents", label: "Reviewing Documents" };
	const row = toRow(fixture);
	assert.equal(row?.pane_id, "sample1:p1");
	assert.equal(row?.label, "Reviewing Documents");
	assert.equal(row?.agent_status, "working");
	assert.equal(row?.foreground_cwd, "/home/andrew/work", "the foreground cwd falls back to cwd");
	assert.equal(row?.revision, 0);
});

test("a row with no pane id is not a row", () => {
	assert.equal(toRow(null), undefined);
	assert.equal(toRow({}), undefined);
	assert.equal(toRow({ pane_id: "" }), undefined);
	const context = { source: { panes: { origin: "herdr", panes: [], reason: null } } } as unknown as Source;
	assert.equal(typeof context, "object");
});
