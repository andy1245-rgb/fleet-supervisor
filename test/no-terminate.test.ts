// The watchdog never stops, kills or signals anything. This file is what makes
// that a property rather than a promise.
//
// The rule is absolute and it is the operator's: a flagged command gets a sentence
// to its agent (which is told the decision is its own) and a notification to the
// human, and it keeps running. So the four absences below are the contract:
//
//   1. nothing in `src/watchdog/` can spawn, signal or exit a process;
//   2. the port the supervisor acts through has no stop/close/kill member — a
//      capability that does not exist cannot be reached by a mistake;
//   3. the op vocabulary a model answers with has no stop op, so no proposal can
//      even name one;
//   4. the action a flagged command produces says `signal: "none"` and carries a
//      prompt that hands the decision to the agent.
//
// Each is checked against the source text rather than by running anything, because
// the failure these guard against is a future commit adding the capability back.

import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { needsAWord, wordActionFor } from "../src/watchdog/needs-a-word.ts";
import { OPS } from "../src/decision/types.ts";
import type { CommandSample } from "../src/watchdog/rules.ts";

const ROOT = join(import.meta.dirname, "..");

function source(path: string): string {
	return readFileSync(join(ROOT, path), "utf8");
}

/** Comments are stripped before matching: `rules.ts` says "never kills" in prose,
 *  and a guard that reads its own contract as a violation is a guard nobody keeps. */
function code(path: string): string {
	return source(path)
		.replace(/\/\*[\s\S]*?\*\//g, "")
		.replace(/(^|[^:])\/\/.*$/gm, "$1");
}

test("nothing in src/watchdog can spawn, signal or exit a process", () => {
	const files = readdirSync(join(ROOT, "src", "watchdog")).filter((name) => name.endsWith(".ts"));
	assert.ok(files.length >= 2, "the watchdog is where this file expects it");
	const forbidden = [
		{ name: "child_process", re: /child_process/ },
		{ name: "spawn", re: /\bspawn(Sync)?\s*\(/ },
		{ name: "exec", re: /\bexec(File|Sync|SyncFile)?\s*\(/ },
		{ name: "process.kill", re: /process\.kill\s*\(/ },
		{ name: "child.kill", re: /\.kill\s*\(/ },
		{ name: "killpg", re: /killpg/ },
		{ name: "a signal name", re: /\bSIG(TERM|KILL|INT|QUIT|HUP)\b/ },
		{ name: "process.exit", re: /process\.exit\s*\(/ },
	];
	for (const file of files) {
		const text = code(`src/watchdog/${file}`);
		for (const rule of forbidden) {
			assert.equal(rule.re.test(text), false, `src/watchdog/${file} mentions ${rule.name}`);
		}
	}
});

test("the port has no stop, close or kill member", () => {
	const text = code("src/herdr/types.ts");
	const start = text.indexOf("export interface HerdrPort");
	assert.ok(start >= 0, "the port interface is where this test expects it");
	const body = text.slice(start, text.indexOf("}", start));
	for (const member of ["stop", "kill", "close", "terminate", "signal", "abort"]) {
		const declared = new RegExp(`\\b${member}\\s*[(:]`).test(body);
		assert.equal(declared, false, `HerdrPort declares ${member}: the supervisor must have no way to stop a pane`);
	}
	// And the four it does have, so a member added without thought is visible here.
	for (const member of ["list", "get", "read", "prompt"]) {
		assert.ok(new RegExp(`\\b${member}\\s*\\(`).test(body), `HerdrPort still has ${member}`);
	}
});

test("no op a model can answer with means stop", () => {
	assert.deepEqual([...OPS].sort(), ["declare_done", "flag", "leave", "nudge"]);
	for (const op of OPS) {
		assert.equal(/stop|kill|term|abort/i.test(op), false, `${op} would be a stop in disguise`);
	}
});

test("a flagged command's action hands the decision to the agent and signals nothing", () => {
	const sample: CommandSample = {
		pid: 4242,
		ppid: 1,
		cpuMs: 0,
		elapsedMs: 7 * 60_000,
		command: "curl http://dead.host/x",
		ancestors: ["bash"],
		foreground: true,
		cwd: "/home/andrew/project",
	};
	const verdict = needsAWord({ paneId: "w1:p1", cwd: "/home/andrew/project" }, [sample]);
	assert.equal(verdict.speak, true);
	const action = verdict.action;
	assert.ok(action, "a speaking verdict carries the action");
	assert.equal(action.signal, "none");
	assert.equal(action.leavesRunning, true);
	assert.equal(action.kind, "prompt-agent-and-notify");
	assert.match(action.prompt, /final decision is yours/i);
	assert.match(action.prompt, /nothing (has been signalled|will be)/i);
	assert.match(action.prompt, /still running|yours to decide/i);
	// The operator's message says the command is still running, so a reader cannot
	// mistake the notification for a report of something having been done to it.
	assert.match(action.notify, /still running/i);
	assert.match(action.notify, /nothing was stopped/i);
});

test("the action is a pure function of the finding, so the sentence has one author", () => {
	const finding = { rule: "command", pid: 7, ageMs: 6 * 60_000, command: "make" };
	const a = wordActionFor({ paneId: "p", cwd: "/x" }, "command", "past five minutes", finding);
	const b = wordActionFor({ paneId: "p", cwd: "/x" }, "command", "past five minutes", finding);
	assert.deepEqual(a, b);
	assert.match(a.prompt, /6m00s/, "the age is in the sentence, in the watchdog's own format");
	assert.equal(a.signal, "none");
});
