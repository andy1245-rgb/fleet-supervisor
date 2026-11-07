// Identity: seven states, and `linked` is earned rather than declared.
//
// The join key is herdr's own `agent_session` object, which is why the row has to carry it.
// Reading `terminal_title` for it, as the four deleted chains did, produced a session id only
// by accident — and a session id that is only usually right is worse than none, because it
// gets screenshotted into reports.

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { SESSION_STATES, isSamplePaneId, sessionOf, sessionReason, uuidOf } from "../../src/fleet/identity.ts";
import type { Ctx, Row, Source } from "../../src/fleet/types.ts";

const PANE = "w46:p1";

function row(overrides: Partial<Row> = {}): Row {
	return {
		pane_id: PANE,
		workspace_id: "w46",
		tab_id: "w46:t1",
		agent: "pi",
		agent_status: "idle",
		cwd: "/home/andrew",
		foreground_cwd: "/home/andrew",
		focused: false,
		label: "Debugging Terminal Pane",
		revision: 3,
		terminal_id: "term_1",
		terminal_title: "π - andrew",
		terminal_title_stripped: "π - andrew",
		agent_session: null,
		completion_seq: 1,
		state_change_seq: 1,
		...overrides,
	};
}

function ctxWith(panes: Row[], origin: Source["panes"]["origin"] = "herdr"): Ctx {
	const source = { panes: { origin, panes, reason: origin === "herdr" ? null : "not read" } } as unknown as Source;
	return { now: Date.now(), source } as unknown as Ctx;
}

test("seven states, `unresolved` included", () => {
	assert.equal(SESSION_STATES.length, 7);
	assert.deepEqual([...SESSION_STATES], ["linked", "unlinked", "unlinkedNotPi", "broken", "ambiguous", "sample", "unresolved"]);
});

test("no report: unlinked for a pi agent, unlinkedNotPi otherwise", () => {
	assert.equal(sessionOf(row(), ctxWith([row()])).state, "unlinked");
	assert.equal(sessionOf(row({ agent: "shell" }), ctxWith([row({ agent: "shell" })])).state, "unlinkedNotPi");
});

test("a sample pane id can never resolve to a live session", () => {
	assert.equal(isSamplePaneId("sample1:p2"), true);
	assert.equal(isSamplePaneId("w46:p1"), false);
	const sample = row({ pane_id: "sample1:p2" });
	const record = sessionOf(sample, ctxWith([sample]));
	assert.equal(record.state, "sample");
	assert.equal(record.linked, false);
});

test("a load whose pane list was not read is unresolved, not unlinked", () => {
	// "I could not ask" must not be reported as "no session exists".
	const record = sessionOf(row(), ctxWith([], "disabled"));
	assert.equal(record.state, "unresolved");
	assert.match(record.reason ?? "", /was not read/);
	assert.equal(sessionReason(record), "no session report yet");
});

test("a path report is linked only when the file's first line carries its id", () => {
	const dir = mkdtempSync(join(tmpdir(), "fleet-identity-"));
	try {
		const id = "01a1b4ce-7554-733b-b545-436371247575";
		const path = join(dir, `2026-11-07T06-59-51-765Z_${id}.jsonl`);
		writeFileSync(path, `${JSON.stringify({ id, type: "session" })}\n${JSON.stringify({ type: "message" })}\n`);
		const report = { agent: "pi", kind: "path", source: "herdr:pi", value: path };

		const linked = sessionOf(row({ agent_session: report }), ctxWith([row({ agent_session: report })] as Row[]));
		assert.equal(linked.state, "linked");
		assert.equal(linked.linked, true);
		assert.equal(linked.id, id);
		assert.equal(linked.firstLineId, id);
		assert.equal(uuidOf(path), id);

		// The file's first line disagrees with the id its name declares.
		writeFileSync(path, `${JSON.stringify({ id: "ffffffff-0000-0000-0000-000000000000" })}\n`);
		const broken = sessionOf(row({ agent_session: report }), ctxWith([row({ agent_session: report })] as Row[]));
		assert.equal(broken.state, "broken");
		assert.equal(broken.linked, false);
		assert.match(broken.reason ?? "", /does not carry this id/);

		rmSync(path);
		const missing = sessionOf(row({ agent_session: report }), ctxWith([row({ agent_session: report })] as Row[]));
		assert.equal(missing.state, "broken");
		assert.equal(missing.reason, "the session file is missing");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("two panes reporting one session id is ambiguous, never linked twice", () => {
	const report = { agent: "pi", kind: "id", source: "herdr:pi", value: "session-abc" };
	const first = row({ agent_session: report });
	const second = row({ pane_id: "w47:p1", agent_session: report });
	const ctx = ctxWith([first, second]);
	assert.equal(sessionOf(first, ctx).state, "ambiguous");
	assert.equal(sessionOf(second, ctx).state, "ambiguous");
	assert.equal(sessionOf(first, ctx).linked, false);
});

test("a report that carries neither a path nor an id is broken", () => {
	const report = { agent: "pi", kind: "weird", source: "herdr:pi", value: "" };
	const record = sessionOf(row({ agent_session: report }), ctxWith([row({ agent_session: report })] as Row[]));
	assert.equal(record.state, "broken");
	assert.match(record.reason ?? "", /neither a path nor an id/);
});
