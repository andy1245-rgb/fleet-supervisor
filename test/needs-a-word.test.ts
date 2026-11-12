// The stage-0 contract, pinned. Every case here is about a verdict that returns
// WITHOUT a word: silence is the answer the supervisor gives most of the time, so a
// silence that cannot say which rule permitted it is a silence nobody can audit.

import assert from "node:assert/strict";
import { test } from "node:test";
import { needsAWord, processesOf, SILENCE_RULE, stage0Fields } from "../src/watchdog/needs-a-word.ts";
import type { CommandSample } from "../src/watchdog/rules.ts";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const CWD = "/home/andrew/project";

function sample(overrides: Partial<CommandSample> = {}): CommandSample {
	return {
		pid: 4242,
		ppid: 1,
		cpuMs: 0,
		elapsedMs: 0,
		command: "sleep 600",
		ancestors: ["bash"],
		foreground: true,
		cwd: CWD,
		...overrides,
	};
}

const target = { paneId: "w1:p1", cwd: CWD };

test("a pane with nothing running is silent, and says so rather than falling through", () => {
	const verdict = needsAWord(target, []);
	assert.equal(verdict.speak, false);
	assert.equal(verdict.rule, SILENCE_RULE);
	assert.match(verdict.why, /no process of this pane is running/);
	assert.equal(verdict.finding, undefined);
});

test("silence names the rule that permitted it", () => {
	const verdict = needsAWord(target, [sample({ command: "llama-server --port 8080", elapsedMs: 12 * HOUR })]);
	assert.equal(verdict.speak, false);
	assert.equal(verdict.rule, "inference-server");
	assert.match(verdict.why, /long-lived by design/);
});

test("a bare shell under its own rule is silent with that rule's sentence", () => {
	const verdict = needsAWord(target, [sample({ command: "bash", elapsedMs: 9 * HOUR })]);
	assert.equal(verdict.speak, false);
	assert.equal(verdict.rule, "idle-shell");
});

test("a command past five minutes speaks, and carries the finding", () => {
	const verdict = needsAWord(target, [sample({ command: "curl http://dead.host/x", elapsedMs: 6 * MINUTE })]);
	assert.equal(verdict.speak, true);
	assert.equal(verdict.rule, "command");
	assert.equal(verdict.finding?.pid, 4242);
	assert.equal(verdict.finding?.ageMs, 6 * MINUTE);
});

test("a build gets twenty minutes and not twenty-one seconds", () => {
	const build = sample({ command: "npm run build", elapsedMs: 10 * MINUTE });
	assert.equal(needsAWord(target, [build]).speak, false);
	assert.equal(needsAWord(target, [{ ...build, elapsedMs: 21 * MINUTE }]).speak, true);
});

test("past its allowance but burning CPU is working, not hung — silence, and a distinguishable one", () => {
	const before = sample({ command: "node long-thing.js", elapsedMs: 6 * MINUTE, cpuMs: 1000 });
	const after = { ...before, cpuMs: 5000, elapsedMs: 6 * MINUTE + 10_000 };
	const verdict = needsAWord(target, [after], { previousCpu: new Map([[4242, before.cpuMs]]) });
	assert.equal(verdict.speak, false);
	assert.equal(verdict.working, true);
	assert.equal(verdict.rule, "command");
	assert.match(verdict.why, /CPU progress/);
});

test("a working process does not mask a hung one in the same pane", () => {
	const working = sample({ pid: 10, command: "node build.js", elapsedMs: 9 * MINUTE, cpuMs: 1000 });
	const hung = sample({ pid: 20, command: "curl http://dead.host/x", elapsedMs: 30 * MINUTE });
	const verdict = needsAWord(target, [working, hung], { previousCpu: new Map([[10, 900]]) });
	assert.equal(verdict.speak, true, "the oldest process is covered, the hung one is not");
	assert.equal(verdict.finding?.pid, 20);
});

test("another pane's process is not this pane's", () => {
	const elsewhere = sample({ cwd: "/home/andrew/other", command: "curl http://dead.host/x", elapsedMs: 30 * MINUTE });
	assert.deepEqual(processesOf([elsewhere], CWD), []);
	const verdict = needsAWord(target, [elsewhere]);
	assert.equal(verdict.speak, false);
	assert.equal(verdict.rule, SILENCE_RULE);
});

test("a process whose cwd could not be read is not attributed to any pane", () => {
	const unknown = sample({ command: "curl http://dead.host/x", elapsedMs: 30 * MINUTE });
	delete unknown.cwd;
	assert.deepEqual(processesOf([unknown], CWD), []);
});

test("the row keeps the verdict's own facts and never re-derives the rule", () => {
	const verdict = needsAWord(target, [sample({ command: "curl http://dead.host/x", elapsedMs: 6 * MINUTE, cpuMs: 7 })]);
	const row = stage0Fields(target, verdict);
	assert.deepEqual(Object.keys(row).sort(), ["ageMs", "cwd", "paneId", "pid", "rule", "speak", "why"]);
	assert.equal(row.rule, verdict.rule);
	assert.equal(row.speak, true);
	const silent = stage0Fields(target, { speak: false, rule: "inference-server", why: "long-lived by design" });
	assert.deepEqual(Object.keys(silent).sort(), ["cwd", "paneId", "rule", "speak", "why"]);
});

// ---------------------------------------------------------------- the idle rule
//
// The rule the first pass was missing. It is a clock, so the tests are about the
// boundary and about who is allowed to reach it: one tick short is silence, a
// working or finished pane is not this rule's business, and a caller with no clock
// is never told a pane has been idle.

const IDLE_TARGET = { paneId: "w1:p1", cwd: CWD, status: "idle", idleTicks: 2 };

test("an agent idle for N ticks speaks, and names the rule", async () => {
	const { IDLE_RULE } = await import("../src/watchdog/needs-a-word.ts");
	const verdict = needsAWord(IDLE_TARGET, []);
	assert.equal(verdict.speak, true);
	assert.equal(verdict.rule, IDLE_RULE);
	assert.match(verdict.why, /nobody is coming back/);
	assert.ok(verdict.action, "and it carries the same action contract as a process finding");
});

test("one tick short is silence — the threshold is the threshold", async () => {
	const { IDLE_TICKS } = await import("../src/watchdog/needs-a-word.ts");
	const verdict = needsAWord({ ...IDLE_TARGET, idleTicks: IDLE_TICKS - 1 }, []);
	assert.equal(verdict.speak, false);
	assert.equal(verdict.rule, SILENCE_RULE);
});

test("working, blocked and done panes are not the idle rule's business", () => {
	for (const status of ["working", "blocked", "done", "unknown"]) {
		const verdict = needsAWord({ ...IDLE_TARGET, status, idleTicks: 99 }, []);
		assert.equal(verdict.speak, false, status);
	}
});

test("a caller with no clock is never told a pane has been idle", () => {
	const verdict = needsAWord({ paneId: "w1:p1", cwd: CWD }, []);
	assert.equal(verdict.speak, false);
	assert.equal(verdict.rule, SILENCE_RULE);
});

test("a running command past its allowance outranks the clock", () => {
	const running = sample({ command: "curl http://dead.host/x", elapsedMs: 30 * MINUTE });
	const verdict = needsAWord({ ...IDLE_TARGET, idleTicks: 99 }, [running]);
	assert.equal(verdict.speak, true);
	assert.equal(verdict.rule, "command", "the process finding is the stronger evidence");
	assert.ok(verdict.finding, "and it is a process finding, with a pid");
});

test("the idle rule's action hands the decision over and signals nothing", async () => {
	const { idleActionFor } = await import("../src/watchdog/needs-a-word.ts");
	const action = idleActionFor(IDLE_TARGET, 4);
	assert.equal(action.signal, "none");
	assert.equal(action.leavesRunning, true);
	assert.match(action.prompt, /final decision is yours/i);
	assert.match(action.prompt, /no input for 4 ticks/);
	assert.match(action.prompt, /nothing will be/i);
	assert.match(action.notify, /nothing was stopped/i);
});
