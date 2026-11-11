// The time-sampled miner's labelling rule, pinned as a property of the definition
// rather than of the corpus. Every case here is a hand-built transcript, because the
// four outcomes (labelled-by-reply, quiet, censored, mid-call) differ only in the
// clock and in what the last record was — and a corpus that happens to lack one of
// them must not make the branch look unreachable.

import assert from "node:assert/strict";
import test from "node:test";
import { scanSession, type TimePoint } from "../mine/time-sampled-points.ts";
import type { Session } from "../mine/session-cache.ts";
import type { Message } from "../mine/session-cli.ts";

const WINDOW = 60_000;
const T0 = Date.parse("2026-11-10T10:00:00Z");

const at = (seconds: number): string => new Date(T0 + seconds * 1000).toISOString().replace(".000", "");

function message(seq: number, seconds: number, role: string, text: string, extra: Partial<Message> = {}): Message {
	return { seq, ts: at(seconds), role, tool: null, isError: false, durMs: null, text, textTruncated: false, ...extra };
}

function session(messages: Message[], terminalStopReason = "stop"): Session {
	return {
		session: {
			sessionId: "01a10000-0000-7000-8000-000000000001",
			path: "/home/andrew/.pi/agent/sessions/--home--/2026-11-10T10-00-00-000Z_01a10000.jsonl",
			root: "main",
			cwd: "/home/andrew",
			startedTs: at(0),
			endedTs: at(600),
			nMsgs: messages.length,
			nCalls: messages.filter((m) => m.role === "toolResult").length,
			terminalStopReason,
			name: null,
			models: ["deepseek/deepseek-v4.1-flash"],
		},
		messages,
	};
}

const scan = (shown: Session): { points: TimePoint[]; counters: ReturnType<typeof scanSession>["counters"] } =>
	scanSession(shown, WINDOW);

test("a human reply inside the window labels the turn with their message", () => {
	const { points } = scan(
		session([
			message(1, 0, "user", "fix the build"),
			message(2, 5, "assistant", "looking at it"),
			message(3, 10, "assistant", "done, but the linter has 3 errors"),
			message(4, 40, "user", "ok"),
			message(5, 45, "assistant", "thanks"),
		]),
	);
	// Two turns: the first answered at +30s inside the window, the second is the
	// session's last and has nothing after it.
	assert.equal(points.length, 2);
	const first = points[0];
	assert.ok(first);
	assert.equal(first.label, "continue");
	assert.equal(first.gapMs, 30_000);
	assert.equal(first.censored, false);
});

test("no human message inside the window is `quiet`, and it maps to leave", () => {
	const { points } = scan(
		session([
			message(1, 0, "user", "fix the build"),
			message(2, 5, "assistant", "done"),
			message(3, 300, "user", "actually check the tests"),
			message(4, 305, "assistant", "ok"),
		]),
	);
	assert.equal(points[0]?.label, "quiet");
	assert.equal(points[0]?.gapMs, 295_000);
	assert.equal(points[0]?.labelReason.includes("past the 60s window"), true);
	// The reply that did arrive is a `redirect`, and it is deliberately not the label:
	// the state the supervisor faced was the turn end, not the message 5 minutes later.
	assert.equal(points[0]?.nextLabel, "redirect");
});

test("the window is the only thing that moves a reply between quiet and labelled", () => {
	const shown = session([
		message(1, 0, "user", "fix the build"),
		message(2, 5, "assistant", "done"),
		message(3, 100, "user", "ok"),
	]);
	const narrow = scanSession(shown, 30_000).points[0];
	const wide = scanSession(shown, 300_000).points[0];
	assert.equal(narrow?.label, "quiet");
	assert.equal(wide?.label, "continue");
	assert.equal(narrow?.gapMs, wide?.gapMs);
});

test("a session that ends with no human message is censored, not leave", () => {
	const { points, counters } = scan(
		session([
			message(1, 0, "user", "fix the build"),
			message(2, 5, "assistant", "done"),
		]),
	);
	assert.equal(points.length, 1);
	assert.equal(points[0]?.censored, true);
	assert.equal(points[0]?.label, null);
	assert.equal(points[0]?.gapMs, null);
	assert.equal(counters.censored, 1);
});

test("a turn that ends mid-tool-call is dropped as a dead pane, not censored", () => {
	const { points, counters } = scan(
		session(
			[
				message(1, 0, "user", "fix the build"),
				message(2, 5, "assistant", "running the tests"),
				message(3, 6, "toolResult", "FAIL 3 tests", { tool: "bash", isError: true }),
			],
			"toolUse",
		),
	);
	assert.equal(points.length, 0);
	assert.equal(counters.skippedMidCall, 1);
	assert.equal(counters.censored, 0);
});

test("a harness notification neither ends a turn nor labels one", () => {
	const { points, counters } = scan(
		session([
			message(1, 0, "user", "fix the build"),
			message(2, 5, "assistant", "looking"),
			message(3, 6, "user", "[SYSTEM NOTIFICATION: todo continuation]"),
			message(4, 7, "assistant", "still looking"),
			message(5, 30, "user", "ok"),
		]),
	);
	assert.equal(points.length, 1, "the synthetic message must not split the turn");
	assert.equal(points[0]?.label, "continue");
	assert.equal(counters.skippedSynthetic, 1);
});

test("a tool call's evidence is its result's first line, and errors are counted per turn", () => {
	const { points } = scan(
		session([
			message(1, 0, "user", "run the tests"),
			message(2, 5, "assistant", "running"),
			message(3, 8, "toolResult", "\n\n  FAIL src/a.test.ts\nmore", { tool: "bash", isError: true }),
			message(4, 9, "assistant", "one failure"),
			message(5, 30, "user", "ok"),
		]),
	);
	const point = points[0];
	assert.equal(point?.toolCalls.length, 1);
	assert.equal(point?.toolCalls[0]?.name, "bash");
	assert.equal(point?.toolCalls[0]?.summary, "FAIL src/a.test.ts");
	assert.equal(point?.toolErrors, 1);
});

test("every point can become a task, and quiet is the only new label", async () => {
	const { toTask } = await import("../bench/tasks/from-captures.ts");
	const { points } = scan(
		session([
			message(1, 0, "user", "fix the build"),
			message(2, 5, "assistant", "done"),
			message(3, 400, "user", "ok"),
			message(4, 401, "assistant", "good"),
		]),
	);
	const scorable = points.filter((point): point is TimePoint & { label: NonNullable<TimePoint["label"]> } => point.label !== null);
	assert.equal(scorable.length, 1);
	const task = toTask(scorable[0] as TimePoint & { label: "quiet" }, 0);
	assert.equal(task.expectedOp, "leave");
	assert.equal(task.input.idleTicks, 0, "the window must not reach the model as a field");
	assert.equal(task.input.status, "idle");
});

test("a session carrying a credential shape is excluded whole, by shape and not by text", async () => {
	const { sessionExclusion } = await import("../mine/time-sampled-points.ts");
	// Composed at runtime so this fixture does not itself contain a key shape: the
	// guard reads tracked files, and a test that plants a real-looking key in one is
	// the failure it is watching for.
	const key = `AKIA${"ABCDEFGHIJKLMNOP"}`;
	const dirty = session([
		message(1, 0, "user", "check the deploy"),
		message(2, 5, "toolResult", `export AWS_ACCESS_KEY_ID=${key}`, { tool: "bash" }),
		message(3, 6, "assistant", "done"),
	]);
	assert.deepEqual(sessionExclusion(dirty), ["aws-key"]);
	const clean = session([message(1, 0, "user", "check the deploy"), message(2, 5, "assistant", "done")]);
	assert.deepEqual(sessionExclusion(clean), []);
});

test("a placeholder-looking credential still excludes the session: the miner is stricter than the guard", async () => {
	const { sessionExclusion } = await import("../mine/time-sampled-points.ts");
	const { credentialHits } = await import("../src/corpus/credentials.ts");
	const line = `password: "${"test-placeholder-value"}"`;
	const shown = session([message(1, 0, "user", "wire the config"), message(2, 5, "assistant", line)]);
	// The guard exempts a placeholder so a fixture is not a finding; the corpus does
	// not argue with a session, it drops it (docs/CORPUS-POLICY.md §3).
	assert.deepEqual(credentialHits(line, { placeholderExempt: true }), []);
	assert.deepEqual(sessionExclusion(shown), ["assigned-secret"]);
});
