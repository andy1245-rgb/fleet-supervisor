import assert from "node:assert/strict";
import { test } from "node:test";
import { detect } from "../src/fleet/detect.ts";
import type { Mark, Marks } from "../src/fleet/detect.ts";
import type { AgentStatus } from "../src/herdr/types.ts";
import { agent } from "./fixtures.ts";

const T1 = "2024-05-01T00:00:00.000Z";
const T2 = "2024-05-01T00:00:05.000Z";
const T3 = "2024-05-01T00:00:10.000Z";

const RESTING: readonly AgentStatus[] = ["idle", "done", "blocked"];

function first<T>(items: readonly T[]): T {
	const [head] = items;
	assert.ok(head !== undefined, "expected at least one item");
	return head;
}

function markOf(marks: Marks, paneId: string): Mark {
	const mark = marks[paneId];
	assert.ok(mark, `expected a mark for ${paneId}`);
	return mark;
}

test("a pane never seen before is reported as new", () => {
	const result = detect([agent("w2C:p1", { status: "idle" })], {}, T1);

	assert.equal(result.moves.length, 1);
	const move = first(result.moves);
	assert.equal(move.paneId, "w2C:p1");
	assert.equal(move.reason, "new");
	assert.equal(move.agent.paneId, "w2C:p1");
	// The move records 0, but a resting newcomer already starts its mark at 1.
	assert.equal(move.idleTicks, 0);
	assert.equal(result.still.length, 0);
});

test("a new pane's mark carries the snapshot's sequences and the current timestamps", () => {
	const previous = detect([], {}, T1).marks;
	const result = detect([agent("w2C:p1", { completionSeq: 4, stateChangeSeq: 9, status: "working" })], previous, T2);

	assert.deepEqual(Object.keys(result.marks), ["w2C:p1"]);
	const mark = markOf(result.marks, "w2C:p1");
	assert.equal(mark.completionSeq, 4);
	assert.equal(mark.stateChangeSeq, 9);
	assert.equal(mark.status, "working");
	assert.equal(mark.idleTicks, 0);
	assert.equal(mark.firstSeen, T2);
	assert.equal(mark.lastSeen, T2);
});

test("unchanged sequence numbers report no move", () => {
	const snapshot = agent("w2C:p1", { status: "working", completionSeq: 3, stateChangeSeq: 5 });
	const before = detect([snapshot], {}, T1);
	const after = detect([snapshot], before.marks, T2);

	assert.deepEqual(after.moves, []);
	assert.equal(after.still.length, 1);
	assert.equal(first(after.still).agent.paneId, "w2C:p1");
	assert.equal(first(after.still).idleTicks, 0);
	assert.equal(markOf(after.marks, "w2C:p1").lastSeen, T2);
});

test("a completionSeq advance is a turn_completed", () => {
	const before = agent("w2C:p1", { status: "working", completionSeq: 7, stateChangeSeq: 11 });
	const after = { ...before, completionSeq: 8 };

	const result = detect([before], {}, T1);
	const next = detect([after], result.marks, T2);

	assert.equal(next.moves.length, 1);
	assert.equal(first(next.moves).reason, "turn_completed");
	assert.equal(markOf(next.marks, "w2C:p1").completionSeq, 8);
});

test("a stateChangeSeq advance is a state_change", () => {
	const before = agent("w2C:p1", { status: "working", completionSeq: 7, stateChangeSeq: 11 });
	const after = { ...before, stateChangeSeq: 12 };

	const result = detect([before], {}, T1);
	const next = detect([after], result.marks, T2);

	assert.equal(first(next.moves).reason, "state_change");
	assert.equal(markOf(next.marks, "w2C:p1").stateChangeSeq, 12);
});

test("a status flip alone is a status_change", () => {
	const before = agent("w2C:p1", { status: "working", completionSeq: 7, stateChangeSeq: 11 });
	const after = { ...before, status: "done" as const };

	const result = detect([before], {}, T1);
	const next = detect([after], result.marks, T2);

	assert.equal(first(next.moves).reason, "status_change");
	assert.equal(markOf(next.marks, "w2C:p1").status, "done");
});

test("the reason precedence is turn_completed, then state_change, then status_change", () => {
	const before = agent("w2C:p1", { status: "working", completionSeq: 1, stateChangeSeq: 1 });
	const seed = detect([before], {}, T1).marks;

	const everything = { ...before, status: "done" as const, completionSeq: 2, stateChangeSeq: 2 };
	assert.equal(first(detect([everything], seed, T2).moves).reason, "turn_completed");

	const stateAndStatus = { ...before, status: "done" as const, stateChangeSeq: 2 };
	assert.equal(first(detect([stateAndStatus], seed, T2).moves).reason, "state_change");
});

for (const status of RESTING) {
	test(`idleTicks increments on every consecutive ${status} tick`, () => {
		const snapshot = agent("w2C:p1", { status });
		const one = detect([snapshot], {}, T1);
		const two = detect([snapshot], one.marks, T2);
		const three = detect([snapshot], two.marks, T3);

		assert.equal(markOf(one.marks, "w2C:p1").idleTicks, 1);
		assert.equal(markOf(two.marks, "w2C:p1").idleTicks, 2);
		assert.equal(markOf(three.marks, "w2C:p1").idleTicks, 3);
	});

	test(`idleTicks is reported through still while ${status} does not move`, () => {
		const snapshot = agent("w2C:p1", { status });
		const firstTick = detect([snapshot], {}, T1);
		const second = detect([snapshot], firstTick.marks, T2);

		assert.equal(first(second.still).idleTicks, 2);
		assert.equal(markOf(second.marks, "w2C:p1").idleTicks, 2);
	});
}

test("idleTicks resets to 0 when the agent moves back to working", () => {
	const resting = agent("w2C:p1", { status: "idle" });
	const one = detect([resting], {}, T1);
	const two = detect([resting], one.marks, T2);
	assert.equal(markOf(two.marks, "w2C:p1").idleTicks, 2);

	const woke = { ...resting, status: "working" as const };
	const moved = detect([woke], two.marks, T3);

	assert.equal(first(moved.moves).reason, "status_change");
	assert.equal(first(moved.moves).idleTicks, 0);
	assert.equal(markOf(moved.marks, "w2C:p1").idleTicks, 0);
});

test("idleTicks starts at 1 when a move lands on a resting status", () => {
	const working = agent("w2C:p1", { status: "working" });
	const seed = detect([working], {}, T1).marks;
	const finished = { ...working, status: "done" as const, completionSeq: 1 };

	const moved = detect([finished], seed, T2);

	assert.equal(first(moved.moves).reason, "turn_completed");
	assert.equal(first(moved.moves).idleTicks, 1);
	assert.equal(markOf(moved.marks, "w2C:p1").idleTicks, 1);
	const third = detect([finished], moved.marks, T3);
	assert.equal(markOf(third.marks, "w2C:p1").idleTicks, 2);
});

test("a working status zeroes an idleTicks left in the previous mark", () => {
	const working = agent("w2C:p1", { status: "working" });
	const previous: Marks = {
		"w2C:p1": {
			completionSeq: 0,
			stateChangeSeq: 0,
			status: "working",
			idleTicks: 7,
			firstSeen: T1,
			lastSeen: T1,
		},
	};

	const result = detect([working], previous, T2);

	assert.deepEqual(result.moves, []);
	assert.equal(first(result.still).idleTicks, 0);
	assert.equal(markOf(result.marks, "w2C:p1").idleTicks, 0);
});

test("marks are rebuilt for every agent seen and firstSeen survives the tick", () => {
	const a = agent("w2C:p1", { status: "idle" });
	const b = agent("w2C:p2", { status: "blocked" });

	const t1 = detect([a], {}, T1);
	const t2 = detect([a, b], t1.marks, T2);

	assert.deepEqual(Object.keys(t2.marks).sort(), ["w2C:p1", "w2C:p2"]);
	assert.equal(markOf(t2.marks, "w2C:p1").firstSeen, T1);
	assert.equal(markOf(t2.marks, "w2C:p1").lastSeen, T2);
	assert.equal(markOf(t2.marks, "w2C:p2").firstSeen, T2);
	assert.equal(t2.moves.length, 1);
	assert.equal(first(t2.moves).paneId, "w2C:p2");
	assert.equal(first(t2.moves).reason, "new");
});

test("a pane missing from the snapshot drops out of the marks", () => {
	const a = agent("w2C:p1");
	const b = agent("w2C:p2");
	const t1 = detect([a, b], {}, T1);
	const t2 = detect([b], t1.marks, T2);

	assert.deepEqual(Object.keys(t2.marks), ["w2C:p2"]);
	assert.equal(markOf(t2.marks, "w2C:p2").firstSeen, T1);
});

test("the same mark set drives repeated ticks without spurious moves", () => {
	const snapshot = agent("w2C:p1", { status: "done", completionSeq: 2, stateChangeSeq: 3 });
	let marks: Marks = detect([snapshot], {}, T1).marks;

	for (const now of [T2, T3]) {
		const tick = detect([snapshot], marks, now);
		assert.deepEqual(tick.moves, [], `tick at ${now} should not move`);
		marks = tick.marks;
	}
	assert.equal(markOf(marks, "w2C:p1").idleTicks, 3);
});
