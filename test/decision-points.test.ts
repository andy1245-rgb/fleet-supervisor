// The corpus label is the ground truth every downstream number inherits, so its
// semantics are pinned here rather than left to the miner's regexes. Each case
// below is either a real row that was mislabelled before this test existed or a
// guard against the two shape-based labels that produced the bad corpus:
// `text.length > 200` → new_task, and a first-word regex → stop.

import assert from "node:assert/strict";
import { test } from "node:test";
import { labelFor } from "../mine/decision-points.ts";
import { LABEL_TO_OP, isLabel, type Label } from "../src/labeling/label-to-op.ts";

function labelOf(text: string): Label | undefined {
	return labelFor(text)?.label;
}

function reasonOf(text: string): string {
	const labelled = labelFor(text);
	assert.ok(labelled, `expected a label for ${JSON.stringify(text)}`);
	return labelled.labelReason;
}

test("a bare halt is a stop", () => {
	assert.equal(labelOf("cancel"), "stop");
	assert.equal(labelOf("cancel."), "stop");
	assert.equal(labelOf("never mind"), "stop");
	assert.equal(labelOf("ok stop"), "stop");
});

test("a halt word that opens a question is not a stop", () => {
	// Both rows were labelled stop → leave by the old `^wait\b` rule. Neither
	// halts anything: the pane has to answer.
	assert.equal(labelOf("wait so what does this mean?"), "question");
	assert.equal(labelOf("wait so what did you do here? full description please"), "question");
	assert.equal(labelOf("wait what so lets test it out on some stuff in this chat js rq"), "instruction");
});

test("a halt that also issues an instruction is not a stop", () => {
	assert.equal(
		labelOf("cancel the run, lets js run a regular subagent through them pointed at the tools in the visionHelper harness"),
		"instruction",
	);
});

test("an acknowledgement is a continue, whatever its length", () => {
	for (const text of ["ok", "okay go", "yes please", "yes yes and yes please", "continue", "go", "perfect"]) {
		assert.equal(labelOf(text), "continue", text);
	}
});

test("an acknowledgement with content in it is an instruction", () => {
	// 63 characters, so the old `length < 80` rule called all three a go-ahead.
	assert.equal(labelOf("okay do the 3 commits please then lets discuss next steps please"), "instruction");
	assert.equal(labelOf("okay fix with subagents in parallel but make them isolated please."), "instruction");
	assert.equal(labelOf("yes source code programs please."), "instruction");
	assert.equal(labelOf("continue now you have ohmypi default skills use them wisely"), "instruction");
});

test("message length is not a label", () => {
	// The old new_task bucket was `text.length > 200`. All three are follow-ups on
	// the work in progress, and none is a new task, a halt or a correction.
	const long1 =
		"okay so yes i want to do all that but maybe we can make a new folder as home/polycrawlerMarketing and do preliminary readme and notes of what we should be doing, then port the scrapers over and keep the same commit style throughout";
	const long2 =
		"okay great js make sure we are not messing with any data with the real pi stuff... keep all that safe i have runing other convos on it and i dont want the supervisor touching the live sessions while you are testing";
	const long3 =
		"do all with subagents and then come back and tell me where to move next if we want to start making money on hackerone with this, and keep the notes in the research folder so the next session can pick it up";
	for (const text of [long1, long2, long3]) {
		assert.ok(text.length > 200, "case must exceed the retired 200-char threshold");
		assert.equal(labelOf(text), "instruction", text.slice(0, 40));
	}
	assert.equal(labelFor("a".repeat(600))?.label, "instruction");
});

test("a correction of the agent's course is a redirect", () => {
	assert.equal(labelOf("i meant /home/operator/swarmHarness oops"), "redirect");
	assert.equal(labelOf("two reviewres actually"), "redirect");
	assert.equal(labelOf("nope images for the website are js placeholders"), "redirect");
	assert.equal(reasonOf("i meant my cmdc go accounts").includes('"i meant"'), true);
});

test("a proposal using `instead of` is not a correction", () => {
	// `instead of` compares options; it does not repair a wrong turn.
	assert.equal(labelOf("can we port the profiles instead of using the command code account"), "instruction");
});

test("a question is a question unless it is really a request", () => {
	assert.equal(labelOf("what are next steps"), "question");
	assert.equal(labelOf("so whtas next?"), "question");
	assert.equal(labelOf("why is v2 two times bigger than v1"), "question");
	// Request form: the pane is being asked to do work, not to answer.
	assert.equal(labelOf("can you make sure nothing is paused/corrupted?"), "instruction");
	assert.equal(labelOf("check the pdfs of the lectures?"), "instruction");
});

test("a message with no words carries no evidence and is dropped", () => {
	assert.equal(labelFor("."), undefined);
	assert.equal(labelFor(","), undefined);
	assert.equal(labelFor("   "), undefined);
});

test("every label has a stated reason that is not a fallback", () => {
	const corpus = [
		"cancel",
		"ok",
		"i meant the other repo oops",
		"why is the build red",
		"make sure we dont push api keys please",
		"chlorphine",
	];
	const seen = new Set<Label>();
	for (const text of corpus) {
		const labelled = labelFor(text);
		assert.ok(labelled, text);
		assert.ok(labelled.labelReason.length > 0, `${text}: empty reason`);
		assert.notEqual(labelled.labelReason, "no explicit signal");
		assert.ok(isLabel(labelled.label), `${text}: ${labelled.label} is not in the vocabulary`);
		seen.add(labelled.label);
	}
	assert.deepEqual([...seen].sort(), ["continue", "instruction", "question", "redirect", "stop"]);
});

test("the vocabulary has no new_task and no unmapped label", () => {
	assert.equal(isLabel("new_task"), false);
	assert.equal(isLabel("nudge"), false);
	assert.deepEqual(Object.keys(LABEL_TO_OP).sort(), ["continue", "instruction", "question", "redirect", "stop"]);
	for (const op of Object.values(LABEL_TO_OP)) {
		assert.ok(["leave", "nudge", "declare_done", "flag"].includes(op), op);
	}
});
