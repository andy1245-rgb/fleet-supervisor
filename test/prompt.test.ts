// The renderer is the boundary between a DecisionInput and a model's prompt, so
// these tests pin the whole string rather than pieces of it: a decision prompt is
// unchanged byte for byte, and the inspector's brief gets a section of its own.

import assert from "node:assert/strict";
import { test } from "node:test";
import { MAX_TAIL_CHARS, clipTail, renderInput } from "../src/decision/prompt.ts";
import type { DecisionInput } from "../src/decision/types.ts";

const BASE: DecisionInput = {
	paneId: "w2C:p1",
	cwd: "/w/repo",
	status: "idle",
	title: "pi",
	intent: "pin the pure modules",
	phase: "implement",
	acceptance: "the mount is clean and tests pass",
	claimState: "working",
	last: "wrote test/detect.test.ts",
	idleTicks: 3,
	tail: "$ npm test\nok 187 tests",
};

test("a decision input renders exactly as it did before brief existed", () => {
	const expected = [
		"pane: w2C:p1",
		"cwd: /w/repo",
		"status: idle",
		"title: pi",
		"intent: pin the pure modules",
		"phase: implement",
		"acceptance: the mount is clean and tests pass",
		"claimed state: working",
		"last completed: wrote test/detect.test.ts",
		"idle ticks: 3",
		"terminal tail:",
		"$ npm test",
		"ok 187 tests",
	].join("\n");

	assert.equal(renderInput(BASE), expected);
});

test("without acceptance and without a tail the render is unchanged", () => {
	const input: DecisionInput = { ...BASE, phase: "verify", acceptance: undefined, last: "checked the ladder", idleTicks: 0, tail: "" };
	const expected = [
		"pane: w2C:p1",
		"cwd: /w/repo",
		"status: idle",
		"title: pi",
		"intent: pin the pure modules",
		"phase: verify",
		"claimed state: working",
		"last completed: checked the ladder",
		"idle ticks: 0",
		"terminal tail:",
		"(empty)",
	].join("\n");

	assert.equal(renderInput(input), expected);
});

test("a tail over the budget is still clipped to it", () => {
	const tail = "a".repeat(1000);
	const expected = [
		"pane: w2C:p1",
		"cwd: /w/repo",
		"status: idle",
		"title: pi",
		"intent: pin the pure modules",
		"phase: implement",
		"acceptance: the mount is clean and tests pass",
		"claimed state: working",
		"last completed: wrote test/detect.test.ts",
		"idle ticks: 3",
		"terminal tail:",
		"[...truncated 300 chars...]",
		"a".repeat(MAX_TAIL_CHARS),
	].join("\n");

	assert.equal(renderInput({ ...BASE, tail }), expected);
	assert.ok(renderInput({ ...BASE, tail }).endsWith(clipTail(tail)));
});

test("a brief gets its own section and is not clipped by the tail budget", () => {
	const brief = `trigger: churn in fleet-supervisor\n\n--- pane p1 (named by the trigger) ---\ntail:\n${"x".repeat(5000)}`;
	const out = renderInput({ ...BASE, acceptance: undefined, tail: "", brief });

	assert.ok(brief.length > MAX_TAIL_CHARS * 5, "the brief really is far past the tail budget");
	assert.ok(out.includes(`\nbrief:\n${brief}`), "the brief is rendered whole, under its own heading");
	assert.equal(out.endsWith(brief), true, "nothing of the brief was cut");
	assert.doesNotMatch(out, /\[\.\.\.truncated/, "the tail budget is not applied to the brief");
	assert.doesNotMatch(out, /terminal tail:/, "the brief already carries the tails, so the tail section is omitted");
	assert.doesNotMatch(out, /^acceptance: /m, "an inspection has no acceptance criteria to show");
	assert.match(out, /^pane: w2C:p1\n/, "the one-line facts a model grounds on are still first");
});

test("a brief plus a printed tail keeps only the brief", () => {
	const brief = "trigger: collision in fleet-supervisor\n\n--- pane p1 ---\ntail:\nshared file";
	const out = renderInput({ ...BASE, tail: "z".repeat(2000), brief });

	assert.equal(out.endsWith(brief), true);
	assert.doesNotMatch(out, /z{10}/, "the brief is the dominant content, so the tail is dropped for that call");
	assert.doesNotMatch(out, /terminal tail:/);
});
