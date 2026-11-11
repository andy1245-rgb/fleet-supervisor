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
