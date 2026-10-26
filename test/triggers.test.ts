import assert from "node:assert/strict";
import { test } from "node:test";
import { scanTriggers } from "../src/manager/triggers.ts";
import type { ClaimHistory, Trigger, TriggerOptions } from "../src/manager/triggers.ts";
import type { Claim } from "../src/fleet/registry.ts";
import { agent, claim } from "./fixtures.ts";

const OPTIONS: TriggerOptions = { divergenceTicks: 3, churnRepeats: 2 };
const TREE = "/w/repo";

function first<T>(items: readonly T[]): T {
	const [head] = items;
	assert.ok(head !== undefined, "expected at least one item");
	return head;
}

function kinds(triggers: readonly Trigger[], kind: Trigger["kind"]): Trigger[] {
	return triggers.filter((t) => t.kind === kind);
}

function claimsOf(...entries: Array<[string, Claim]>): Map<string, Claim> {
	return new Map<string, Claim>(entries);
}

function ticks(entries: Array<[string, number]> = []): Map<string, number> {
	return new Map<string, number>(entries);
}

function past(...entries: Array<[string, ClaimHistory]>): Map<string, ClaimHistory> {
	return new Map<string, ClaimHistory>(entries);
}

test("divergence does not fire one tick below the threshold", () => {
	const working = agent("p1", { status: "idle", foregroundCwd: TREE, cwd: TREE });
	const claims = claimsOf(["p1", claim("p1", { state: "working", group: "repo", last: "run the tests" })]);

	const scan = scanTriggers([working], claims, ticks([["p1", OPTIONS.divergenceTicks - 1]]), past(), OPTIONS);

	assert.deepEqual(kinds(scan.triggers, "divergence"), []);
});

test("divergence fires at the threshold", () => {
	const working = agent("p1", { status: "idle", foregroundCwd: TREE, cwd: TREE });
	const claims = claimsOf(["p1", claim("p1", { state: "working", group: "repo", last: "run the tests" })]);

	const scan = scanTriggers([working], claims, ticks([["p1", OPTIONS.divergenceTicks]]), past(), OPTIONS);

	const divergence = first(kinds(scan.triggers, "divergence"));
	assert.deepEqual(divergence.paneIds, ["p1"]);
	assert.equal(divergence.group, "repo");
	assert.match(divergence.detail, /claims working on "run the tests"/);
	assert.match(divergence.detail, /idle for 3 ticks/);
});

test("divergence needs a working claim, however long the pane rests", () => {
	const resting = agent("p1", { status: "idle" });

	for (const state of ["waiting", "done"] as const) {
		const claims = claimsOf(["p1", claim("p1", { state })]);
		const scan = scanTriggers([resting], claims, ticks([["p1", 50]]), past(), OPTIONS);
		assert.deepEqual(kinds(scan.triggers, "divergence"), [], `state ${state} must not diverge`);
	}
});

test("divergence is driven by the claim state and idleTicks alone", () => {
	const busy = agent("p1", { status: "working" });
	const claims = claimsOf(["p1", claim("p1", { state: "working" })]);

	assert.deepEqual(kinds(scanTriggers([busy], claims, ticks([["p1", 0]]), past(), OPTIONS).triggers, "divergence"), []);

	// The scan never re-reads status, so a non-zero idleTicks diverges even while
	// herdr still calls the pane working. detect() is what keeps that from happening.
	const inflated = scanTriggers([busy], claims, ticks([["p1", OPTIONS.divergenceTicks]]), past(), OPTIONS);
	assert.equal(kinds(inflated.triggers, "divergence").length, 1);
});

test("divergence counts a missing idleTicks entry as zero", () => {
	const resting = agent("p1", { status: "idle" });
	const claims = claimsOf(["p1", claim("p1", { state: "working" })]);
	const scan = scanTriggers([resting], claims, ticks(), past(), OPTIONS);

	assert.deepEqual(kinds(scan.triggers, "divergence"), []);
});

test("blocked fires for an agent with no claim file", () => {
	const stuck = agent("p1", { status: "blocked" });
	const scan = scanTriggers([stuck], claimsOf(), ticks(), past(), OPTIONS);

	assert.equal(scan.triggers.length, 1);
	const blocked = first(scan.triggers);
	assert.equal(blocked.kind, "blocked");
	assert.deepEqual(blocked.paneIds, ["p1"]);
	assert.equal(blocked.detail, "blocked with no claim file");
	assert.equal(scan.history.size, 0);
});

test("blocked fires alongside the claim's last action", () => {
	const stuck = agent("p1", { status: "blocked" });
	const claims = claimsOf(["p1", claim("p1", { group: "repo", last: "waiting on review" })]);
	const scan = scanTriggers([stuck], claims, ticks(), past(), OPTIONS);

	const blocked = first(kinds(scan.triggers, "blocked"));
	assert.equal(blocked.detail, 'blocked while "waiting on review"');
	assert.equal(blocked.group, "repo");
});

test("blocked fires even when other triggers are silent", () => {
	const agents = [agent("p1", { status: "working" }), agent("p2", { status: "blocked" })];
	const scan = scanTriggers(agents, claimsOf(), ticks(), past(), OPTIONS);

	assert.deepEqual(
		scan.triggers.map((t) => `${t.kind}:${t.paneIds.join(",")}`),
		["blocked:p2"],
	);
});

test("churn does not fire one repeat below the threshold", () => {
	const working = agent("p1", { status: "working" });
	const claims = claimsOf(["p1", claim("p1", { phase: "implement", last: "edit detect.ts" })]);
	const previous = past(["p1", { phase: "implement", last: "edit detect.ts", repeats: 0 }]);

	const scan = scanTriggers([working], claims, ticks(), previous, OPTIONS);

	assert.deepEqual(kinds(scan.triggers, "churn"), []);
	assert.equal(scan.history.get("p1")?.repeats, 1);
});

test("churn fires at the threshold", () => {
	const working = agent("p1", { status: "working", foregroundCwd: TREE, cwd: TREE });
	const claims = claimsOf(["p1", claim("p1", { group: "repo", phase: "implement", last: "edit detect.ts" })]);
	const previous = past(["p1", { phase: "implement", last: "edit detect.ts", repeats: OPTIONS.churnRepeats - 1 }]);

	const scan = scanTriggers([working], claims, ticks(), previous, OPTIONS);

	const churn = first(kinds(scan.triggers, "churn"));
	assert.deepEqual(churn.paneIds, ["p1"]);
	assert.equal(churn.group, "repo");
	assert.equal(scan.history.get("p1")?.repeats, OPTIONS.churnRepeats);
	assert.match(churn.detail, /phase "implement"/);
});

test("the first observation of a claim never churns", () => {
	const working = agent("p1", { status: "working" });
	const claims = claimsOf(["p1", claim("p1", { phase: "implement", last: "edit detect.ts" })]);

	const scan = scanTriggers([working], claims, ticks(), past(), OPTIONS);

	assert.deepEqual(kinds(scan.triggers, "churn"), []);
	assert.deepEqual(scan.history.get("p1"), { phase: "implement", last: "edit detect.ts", repeats: 0 });
});

test("a phase change resets the churn counter", () => {
	const working = agent("p1", { status: "working" });
	const claims = claimsOf(["p1", claim("p1", { phase: "verify", last: "edit detect.ts" })]);
	const previous = past(["p1", { phase: "implement", last: "edit detect.ts", repeats: 5 }]);

	const scan = scanTriggers([working], claims, ticks(), previous, OPTIONS);

	assert.deepEqual(kinds(scan.triggers, "churn"), []);
	assert.deepEqual(scan.history.get("p1"), { phase: "verify", last: "edit detect.ts", repeats: 0 });
});

test("a changed last action resets the churn counter", () => {
	const working = agent("p1", { status: "working" });
	const claims = claimsOf(["p1", claim("p1", { phase: "implement", last: "edit groups.ts" })]);
	const previous = past(["p1", { phase: "implement", last: "edit detect.ts", repeats: 5 }]);

	const scan = scanTriggers([working], claims, ticks(), previous, OPTIONS);

	assert.deepEqual(kinds(scan.triggers, "churn"), []);
	assert.deepEqual(scan.history.get("p1"), { phase: "implement", last: "edit groups.ts", repeats: 0 });
});

test("collision triggers come from same-tree working agents", () => {
	const agents = [
		agent("p1", { status: "working", foregroundCwd: TREE, cwd: TREE }),
		agent("p2", { status: "working", foregroundCwd: TREE, cwd: TREE }),
	];
	const scan = scanTriggers(agents, claimsOf(), ticks(), past(), OPTIONS);

	const collision = first(kinds(scan.triggers, "collision"));
	assert.deepEqual(collision.paneIds, ["p1", "p2"]);
	assert.equal(collision.group, "repo");
	assert.equal(collision.detail, `2 agents working in ${TREE}`);
});

test("no collision when only one of two same-tree agents is working", () => {
	const agents = [
		agent("p1", { status: "working", foregroundCwd: TREE, cwd: TREE }),
		agent("p2", { status: "idle", foregroundCwd: TREE, cwd: TREE }),
	];
	const scan = scanTriggers(agents, claimsOf(), ticks(), past(), OPTIONS);

	assert.deepEqual(kinds(scan.triggers, "collision"), []);
});

test("no collision across different trees", () => {
	const agents = [
		agent("p1", { status: "working", foregroundCwd: "/w/one", cwd: "/w/one" }),
		agent("p2", { status: "working", foregroundCwd: "/w/two", cwd: "/w/two" }),
	];
	const scan = scanTriggers(agents, claimsOf(), ticks(), past(), OPTIONS);

	assert.deepEqual(kinds(scan.triggers, "collision"), []);
});

test("history is returned for every claimed agent and for no one else", () => {
	const agents = [agent("p1"), agent("p2"), agent("p3")];
	const claims = claimsOf(
		["p1", claim("p1", { phase: "implement", last: "a" })],
		["p2", claim("p2", { phase: "verify", last: "b" })],
	);
	const previous = past(["p1", { phase: "implement", last: "a", repeats: 3 }]);

	const scan = scanTriggers(agents, claims, ticks(), previous, OPTIONS);

	assert.deepEqual([...scan.history.keys()].sort(), ["p1", "p2"]);
	assert.deepEqual(scan.history.get("p1"), { phase: "implement", last: "a", repeats: 4 });
	assert.deepEqual(scan.history.get("p2"), { phase: "verify", last: "b", repeats: 0 });
	assert.equal(scan.history.has("p3"), false);
});

test("history for a claim seen last tick increments across three ticks", () => {
	const working = agent("p1", { status: "working" });
	const claims = claimsOf(["p1", claim("p1", { phase: "research", last: "grep the repo" })]);

	const one = scanTriggers([working], claims, ticks(), past(), OPTIONS);
	const two = scanTriggers([working], claims, ticks(), one.history, OPTIONS);
	const three = scanTriggers([working], claims, ticks(), two.history, OPTIONS);

	assert.equal(one.history.get("p1")?.repeats, 0);
	assert.equal(two.history.get("p1")?.repeats, 1);
	assert.equal(three.history.get("p1")?.repeats, 2);
	assert.deepEqual(kinds(one.triggers, "churn"), []);
	assert.deepEqual(kinds(two.triggers, "churn"), []);
	assert.equal(kinds(three.triggers, "churn").length, 1);
});

test("triggers are independent: a divergent, blocked churner reports all three", () => {
	const agents = [agent("p1", { status: "blocked" })];
	const claims = claimsOf(["p1", claim("p1", { state: "working", phase: "implement", last: "edit detect.ts" })]);
	const previous = past(["p1", { phase: "implement", last: "edit detect.ts", repeats: 4 }]);

	const scan = scanTriggers(agents, claims, ticks([["p1", 4]]), previous, OPTIONS);

	assert.deepEqual(
		kinds(scan.triggers, "blocked").length,
		1,
	);
	assert.deepEqual(
		kinds(scan.triggers, "divergence").length,
		1,
	);
	assert.deepEqual(
		kinds(scan.triggers, "churn").length,
		1,
	);
});

test("an empty fleet produces nothing", () => {
	const scan = scanTriggers([], claimsOf(), ticks(), past(), OPTIONS);

	assert.deepEqual(scan.triggers, []);
	assert.equal(scan.history.size, 0);
});
