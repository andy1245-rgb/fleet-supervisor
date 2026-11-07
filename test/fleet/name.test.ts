// The name chain, as a contract. Five surfaces used to derive a pane's name and all five
// had to agree; four panes on this box read `π - andrew` on the CLI while the page read
// `unnamed`. Every case below is one of the rules that makes the chain a decision rather
// than a fallback chain of string operations.

import assert from "node:assert/strict";
import { test } from "node:test";

import {
	NAME_MAX,
	RUNGS,
	cutMidPhrase,
	firstClause,
	isConductClaim,
	isMachineText,
	nameOf,
	noteOf,
	paneName,
	rejectionReason,
	shorten,
} from "../../src/fleet/name.ts";

test("the three rungs, in order, and the floor", () => {
	assert.deepEqual([...RUNGS], ["pane label", "note intent", "unnamed"]);

	// rung 1: the pane label
	const label = nameOf({ label: "Debugging Terminal Pane", noteIntent: "something else", paneId: "w46:p1" });
	assert.equal(label.text, "Debugging Terminal Pane");
	assert.equal(label.source, "pane label");

	// rung 2: the note's intent, when the label is unusable
	const note = nameOf({ label: null, noteIntent: "Make the metrics schema the only writer", paneId: "w46:p1" });
	assert.equal(note.text, "Make the metrics schema the only writer");
	assert.equal(note.source, "note intent");

	// rung 3: the floor, and it is one word
	const floor = nameOf({ label: null, noteIntent: null, paneId: "w46:p1" });
	assert.equal(floor.text, "unnamed");
	assert.equal(floor.source, "unnamed");
	assert.equal(floor.raw, null);
});

test("the acceptance case from PLAN-v1 §2: pi's chrome is not a name", () => {
	const cases = ["π - andrew", "Debugging Terminal Pane", null];
	assert.deepEqual(
		cases.map((label) => nameOf({ label, noteIntent: null, paneId: "w46:p1" }).text),
		["unnamed", "Debugging Terminal Pane", "unnamed"],
	);
});

test("the pi-chrome rejection is recorded, so line 2 can say which end is missing", () => {
	const record = nameOf({ label: "π - andrew", noteIntent: null, paneId: "w46:p1" });
	assert.equal(record.rejected.length, 1);
	assert.equal(record.rejected[0]?.source, "pane label");
	assert.equal(record.rejected[0]?.reason, "machine text");
	assert.equal(rejectionReason(record.rejected), "label is terminal chrome");
});

test("machine text is the named classes and only those", () => {
	for (const value of ["", "  ", "~", "-", "/", "/home/andrew", "~/x", "π", "π - andrew", "notes.md", "src/fleet", "working", "idle"]) {
		assert.equal(isMachineText(value), true, `${JSON.stringify(value)} should be machine text`);
	}
	for (const value of ["Debugging Terminal Pane", "Lab 3: finish part B", "the fleet"] as const) {
		assert.equal(isMachineText(value), false, `${JSON.stringify(value)} should survive`);
	}
});

test("the conduct rule withholds an allegation and nothing else", () => {
	assert.equal(isConductClaim("Lab 3 Preparation and Cheating"), true);
	assert.equal(isConductClaim("cheating"), true);
	assert.equal(isConductClaim("Teaching the fleet to tick"), false, "`teaching` contains `cheat` and must survive");
	assert.equal(isConductClaim("Lab 3 Preparation Strategy"), false);
	assert.equal(isConductClaim("Debugging Terminal Pane"), false);
	assert.equal(nameOf({ label: null, noteIntent: "Lab 3 Preparation and Cheating", paneId: "w1:p1" }).text, "unnamed");
});

test("a label that is the pane id is not a name either", () => {
	const record = nameOf({ label: "w46:p1", noteIntent: null, paneId: "w46:p1" });
	assert.equal(record.text, "unnamed");
	assert.equal(record.rejected[0]?.reason, "pane id");
});

test("a cut is marked, and a candidate cut mid-phrase is refused instead", () => {
	const long = "Make the metrics schema the only writer of every measurement row in this fleet";
	const cut = shorten(long);
	assert.equal(typeof cut, "string");
	assert.equal((cut as string).endsWith("\u2026"), true, "a shortened name must mark the cut");
	assert.equal((cut as string).length <= NAME_MAX, true);

	// 30 characters, a writer's cap, no mark of having been cut: this is the artefact the
	// rule bans, so the whole candidate is refused rather than printed.
	assert.equal(cutMidPhrase("Migrate Solana MLH Hackathon to"), true);
	const refused = nameOf({ label: "Migrate Solana MLH Hackathon to", noteIntent: null, paneId: "w1:p1" });
	assert.equal(refused.text, "unnamed");
	assert.equal(refused.rejected[0]?.reason, "cut mid-phrase");
	assert.equal(rejectionReason(refused.rejected), "label ends mid-phrase");
});

test("a supervisor-written note is never a name candidate", () => {
	const claim = { intent: "Make the metrics schema the only writer", updated: "2026-01-01T00:00:00.000Z", state: "working" as const, phase: "implement" as const, last: "", paneId: "w1:p1", cwd: "/tmp" };
	assert.equal(paneName({ label: null, note: noteOf(claim), paneId: "w1:p1" }).text, "Make the metrics schema the only writer");
	assert.equal(paneName({ label: null, note: noteOf(claim, "supervisor"), paneId: "w1:p1" }).text, "unnamed");
});

test("the first clause keeps the subject and drops the tail", () => {
	assert.equal(firstClause("Lab 3: finish part B"), "Lab 3: finish part B");
	assert.equal(firstClause("Fix the bug. Then write the tests."), "Fix the bug");
	assert.equal(firstClause("Fix the bug — then write the tests"), "Fix the bug");
	assert.equal(firstClause("Fix the bug - then write the tests"), "Fix the bug");
	assert.equal(firstClause("Fix the bug; then write the tests"), "Fix the bug");
	assert.equal(firstClause("   "), null);
});
