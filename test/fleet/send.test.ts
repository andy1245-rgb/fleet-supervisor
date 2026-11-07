// The send and start refusals, and the path guard.
//
// Every rule below refuses a well-formed request, which is why each one is a test: a gate
// that only refuses malformed input is a gate that lets the interesting case through. The
// `dir_outside_home` case is the one PLAN-v1 D2 picks out by name — the route refused `/tmp`
// while `fleet-manager start /tmp` accepted it, and that disagreement is the lie the plan
// ranks first.

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { SEND_MAX, paneSendable, promptVerb, sendRequest, sourceSendable, textProblem } from "../../src/fleet/send.ts";
import { planStart, resolveStartDir, startDirectoryOptions, startVerb } from "../../src/fleet/start.ts";
import type { Ctx, Row, Source } from "../../src/fleet/types.ts";

function row(paneId: string, overrides: Partial<Row> = {}): Row {
	return {
		pane_id: paneId,
		workspace_id: "w1",
		tab_id: "w1:t1",
		agent: "pi",
		agent_status: "idle",
		cwd: "/home/andrew/work",
		foreground_cwd: "/home/andrew/work",
		focused: false,
		label: null,
		revision: 1,
		terminal_id: "term",
		terminal_title: "",
		terminal_title_stripped: "",
		agent_session: null,
		completion_seq: 1,
		state_change_seq: 1,
		...overrides,
	};
}

function ctxWith(panes: Row[], options: { mode?: "live" | "fixture"; origin?: Source["panes"]["origin"]; enableChat?: boolean; home?: string } = {}): Ctx {
	const source = {
		mode: options.mode ?? "live",
		panes: { origin: options.origin ?? "herdr", panes, reason: null },
		claims: { claims: new Map() },
	} as unknown as Source;
	return {
		opts: { enableChat: options.enableChat ?? true, home: options.home ?? "/home/andrew", herdr: true, agentFleetRoot: "/home/andrew/agentFleet" },
		source,
	} as unknown as Ctx;
}

test("the send gate refuses a disarmed write path, and names the flag", () => {
	const ctx = ctxWith([row("w1:p1")], { enableChat: false });
	const result = sendRequest({ paneId: "w1:p1", text: "hello", ctx });
	assert.equal(result.ok, false);
	if (result.ok) return;
	assert.equal(result.code, "chat_disabled");
	assert.match(result.next ?? "", /--enable-chat/);
});

test("the send gate refuses empty text, oversized text and a NUL byte", () => {
	assert.equal(textProblem(""), "body.text is empty: there is nothing to send");
	assert.equal(textProblem("   "), "body.text is empty: there is nothing to send");
	assert.equal(textProblem(12), "body.text must be a string");
	assert.match(textProblem("x".repeat(SEND_MAX + 1)) ?? "", /the limit is 4000/);
	assert.match(textProblem("a\u0000b") ?? "", /NUL byte/);
	assert.equal(textProblem("hello"), null);
});

test("a fixture fleet cannot be sent to, and the refusal says which source it is", () => {
	const ctx = ctxWith([row("sample1:p1")], { mode: "fixture" });
	const result = sendRequest({ paneId: "sample1:p1", text: "hello", ctx });
	assert.equal(result.ok, false);
	if (result.ok) return;
	assert.equal(result.code, "fixture_data");
	assert.match(result.message, /fixture/);
	assert.equal(sourceSendable({ mode: "fixture", panes: { origin: "fixture", panes: [], reason: null } }).ok, false);
});

test("the pane checks: listed, pi, not blocked — and the claim is never consulted", () => {
	assert.equal(paneSendable(null).code, "unknown_pane");
	assert.equal(paneSendable(row("w1:p1", { agent: "shell" })).code, "not_pi_agent");
	assert.equal(paneSendable(row("w1:p1", { agent_status: "blocked" })).code, "pane_blocked");
	assert.equal(paneSendable(row("w1:p1")).ok, true);

	const ctx = ctxWith([row("w1:p1")]);
	const unknown = sendRequest({ paneId: "w2:p1", text: "hello", ctx });
	assert.equal(unknown.ok, false);
	if (!unknown.ok) assert.equal(unknown.code, "unknown_pane");

	const badId = sendRequest({ paneId: "not a pane", text: "hello", ctx });
	assert.equal(badId.ok, false);
	if (!badId.ok) assert.equal(badId.code, "bad_pane_id");

	const allowed = sendRequest({ paneId: "w1:p1", text: "hello", ctx });
	assert.equal(allowed.ok, true);
	if (!allowed.ok) return;
	assert.deepEqual(allowed.plan.argv, ["agent", "prompt", "w1:p1", "hello", "--wait", "--timeout", "60000"]);
	assert.equal(allowed.plan.command, promptVerb("w1:p1", "hello"));
	// The plan carries no shell: the text is one argv slot.
	assert.equal(allowed.plan.argv.filter((entry) => entry === "hello").length, 1);
});

