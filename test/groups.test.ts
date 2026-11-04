import assert from "node:assert/strict";
import { test } from "node:test";
import { basename, resolve } from "node:path";
import { collisions, groupAll, groupOf } from "../src/fleet/groups.ts";
import type { Claim } from "../src/fleet/registry.ts";
import type { Grouped } from "../src/fleet/groups.ts";
import { agent, claim, HOME, REPO } from "./fixtures.ts";

const NESTED = `${REPO}/src/fleet`;

function none(): Map<string, Claim> {
	return new Map<string, Claim>();
}

function sizes(grouped: readonly Grouped[]): number[] {
	return grouped.map((g) => g.agents.length);
}

test("a declared label wins over the cwd-derived bucket", () => {
	assert.equal(groupOf(agent("w2C:p1"), claim("w2C:p1", { group: "alpha" }), HOME), "alpha");
	assert.equal(groupOf(agent("w2C:p1", { foregroundCwd: "/opt/other" }), claim("w2C:p1", { group: "alpha" }), HOME), "alpha");
});

test("an empty declared label does not win", () => {
	assert.equal(groupOf(agent("w2C:p1"), claim("w2C:p1", { group: "" }), HOME), "fleet-supervisor");
});

test("a path equal to the home dir buckets to home", () => {
	const atHome = agent("w2C:p1", { cwd: HOME, foregroundCwd: HOME });
	assert.equal(groupOf(atHome, undefined, HOME), "home");
	assert.equal(groupOf(agent("w2C:p2", { cwd: "/", foregroundCwd: "/" }), undefined, HOME), "home");
});

test("a nested repo path buckets to its basename", () => {
	assert.equal(groupOf(agent("w2C:p1", { cwd: REPO, foregroundCwd: REPO }), undefined, HOME), "fleet-supervisor");
	assert.equal(groupOf(agent("w2C:p2", { cwd: NESTED, foregroundCwd: NESTED }), undefined, HOME), "fleet");
});

test("foregroundCwd is preferred over cwd", () => {
	const split = agent("w2C:p1", { cwd: HOME, foregroundCwd: REPO });
	assert.equal(groupOf(split, undefined, HOME), "fleet-supervisor");

	const fallback = agent("w2C:p2", { cwd: NESTED, foregroundCwd: "" });
	assert.equal(groupOf(fallback, undefined, HOME), "fleet");
});

test("an agent with no path of its own buckets to unknown, not home and not the manager's tree", () => {
	const managerBucket = groupOf(agent("w2C:p9", { cwd: resolve(""), foregroundCwd: resolve("") }), undefined, HOME);

	const blankPaths: Array<[string, string]> = [
		["", ""],
		["   ", "  "],
		["", "\t"],
		[" \n", ""],
	];

	for (const [cwd, foregroundCwd] of blankPaths) {
		const lost = agent("w2C:p1", { cwd, foregroundCwd });
		const bucket = groupOf(lost, undefined, HOME);

		assert.equal(bucket, "unknown", JSON.stringify({ cwd, foregroundCwd }));
		assert.notEqual(bucket, "home", JSON.stringify({ cwd, foregroundCwd }));
		assert.notEqual(bucket, basename(HOME), JSON.stringify({ cwd, foregroundCwd }));
		assert.notEqual(bucket, managerBucket, JSON.stringify({ cwd, foregroundCwd }));
	}
});

test("groupAll sorts by size descending then by name", () => {
	const grouped = groupAll(
		[
			agent("p3", { foregroundCwd: "/w/beta", cwd: "/w/beta" }),
			agent("p1", { foregroundCwd: "/w/alpha", cwd: "/w/alpha" }),
			agent("p4", { foregroundCwd: "/w/gamma", cwd: "/w/gamma" }),
			agent("p2", { foregroundCwd: "/w/alpha", cwd: "/w/alpha" }),
			agent("p5", { cwd: HOME, foregroundCwd: HOME }),
		],
		none(),
		HOME,
	);

	assert.deepEqual(
		grouped.map((g) => g.group),
		["alpha", "beta", "gamma", "home"],
	);
	assert.deepEqual(sizes(grouped), [2, 1, 1, 1]);
	assert.deepEqual(
		grouped[0]?.agents.map((a) => a.paneId),
		["p1", "p2"],
	);
});

test("groupAll sizes are descending even when a large group is named late", () => {
	const grouped = groupAll(
		[
			agent("p1", { foregroundCwd: "/w/zeta", cwd: "/w/zeta" }),
			agent("p2", { foregroundCwd: "/w/alpha", cwd: "/w/alpha" }),
			agent("p3", { foregroundCwd: "/w/alpha", cwd: "/w/alpha" }),
			agent("p4", { foregroundCwd: "/w/alpha", cwd: "/w/alpha" }),
		],
		none(),
		HOME,
	);

	assert.deepEqual(
		grouped.map((g) => g.group),
		["alpha", "zeta"],
	);
	assert.deepEqual(sizes(grouped), [3, 1]);
});

test("groupAll honours declared labels and puts every agent in exactly one bucket", () => {
	const agents = [
		agent("p1"),
		agent("p2", { foregroundCwd: "/w/beta", cwd: "/w/beta" }),
		agent("p3", { cwd: HOME, foregroundCwd: HOME }),
		agent("p4", { cwd: NESTED, foregroundCwd: NESTED }),
	];
	const claims = new Map<string, Claim>([["p1", claim("p1", { group: "declared" })]]);

	const grouped = groupAll(agents, claims, HOME);

	assert.deepEqual(
		grouped.map((g) => g.group).sort(),
		["beta", "declared", "fleet", "home"],
	);
	const placed = grouped.flatMap((g) => g.agents.map((a) => a.paneId));
	assert.equal(placed.length, agents.length);
	assert.equal(new Set(placed).size, agents.length);
	for (const group of grouped) assert.ok(group.agents.length > 0);
});

test("groupAll of an empty fleet is empty", () => {
	assert.deepEqual(groupAll([], none(), HOME), []);
});

test("two working agents in the same repo collide", () => {
	const found = collisions(
		[
			agent("p1", { status: "working", foregroundCwd: "/w/repo", cwd: "/w/repo" }),
			agent("p2", { status: "working", foregroundCwd: "/w/repo", cwd: "/w/repo" }),
		],
		none(),
		HOME,
	);

	assert.equal(found.size, 1);
	const members = found.get("repo");
	assert.ok(members, "expected a collision bucket named after the repo");
	assert.deepEqual(
		members.map((m) => m.paneId),
		["p1", "p2"],
	);
});

test("agents working in a home directory never collide, however many there are", () => {
	const atHome = ["p1", "p2", "p3", "p4", "p5", "p6", "p7", "p8"].map((paneId) =>
		agent(paneId, { status: "working", cwd: HOME, foregroundCwd: HOME }),
	);

	assert.equal(collisions(atHome, none(), HOME).size, 0);
	assert.equal(collisions(atHome).size, 0, "and with the real homedir default too");
});

test("agents with no path of their own never collide", () => {
	const lost = ["p1", "p2"].map((paneId) => agent(paneId, { status: "working", cwd: "", foregroundCwd: " " }));

	assert.equal(collisions(lost, none(), HOME).size, 0);
});

test("two working agents sharing a declared group label collide even when their cwds differ", () => {
	const agents = [
		agent("p1", { status: "working", foregroundCwd: "/w/alpha", cwd: "/w/alpha" }),
		agent("p2", { status: "working", foregroundCwd: "/w/beta", cwd: "/w/beta" }),
	];
	const claims = new Map<string, Claim>([
		["p1", claim("p1", { group: "shared" })],
		["p2", claim("p2", { group: "shared" })],
	]);

	const found = collisions(agents, claims, HOME);

	assert.deepEqual([...found.keys()], ["shared"]);
	assert.deepEqual(
		found.get("shared")?.map((m) => m.paneId),
		["p1", "p2"],
	);
	assert.equal(collisions(agents, none(), HOME).size, 0, "without the label they are two unrelated repos");
});

test("a declared label outranks the home bucket, so a labelled pair in $HOME can collide", () => {
	const agents = [
		agent("p1", { status: "working", cwd: HOME, foregroundCwd: HOME }),
		agent("p2", { status: "working", cwd: HOME, foregroundCwd: HOME }),
	];
	const claims = new Map<string, Claim>([
		["p1", claim("p1", { group: "notes" })],
		["p2", claim("p2", { group: "notes" })],
	]);

	assert.deepEqual([...collisions(agents, claims, HOME).keys()], ["notes"]);
});

test("one working and one idle agent in the same group do not collide", () => {
	const found = collisions(
		[
			agent("p1", { status: "working", foregroundCwd: "/w/repo", cwd: "/w/repo" }),
			agent("p2", { status: "idle", foregroundCwd: "/w/repo", cwd: "/w/repo" }),
		],
		none(),
		HOME,
	);

	assert.equal(found.size, 0);
});

test("two working agents in different repos do not collide", () => {
	const found = collisions(
		[
			agent("p1", { status: "working", foregroundCwd: "/w/repo", cwd: "/w/repo" }),
			agent("p2", { status: "working", foregroundCwd: "/w/other", cwd: "/w/other" }),
		],
		none(),
		HOME,
	);

	assert.equal(found.size, 0);
});

test("a home neighbour does not collide with a repo neighbour", () => {
	const found = collisions(
		[
			agent("p1", { status: "working", cwd: HOME, foregroundCwd: HOME }),
			agent("p2", { status: "working", foregroundCwd: "/w/repo", cwd: "/w/repo" }),
			agent("p3", { status: "working", cwd: HOME, foregroundCwd: HOME }),
		],
		none(),
		HOME,
	);

	assert.equal(found.size, 0);
});

test("collision buckets follow the cwd fallback and the nested basename", () => {
	const one = agent("p1", { status: "working", foregroundCwd: "/w/repo", cwd: "/w/repo" });
	const messy = agent("p2", { status: "working", foregroundCwd: "/w/other/../repo", cwd: "/w/other/../repo" });
	const noForeground = agent("p3", { status: "working", foregroundCwd: "", cwd: "/w/repo" });

	assert.deepEqual(
		collisions([one, messy], none(), HOME).get("repo")?.map((m) => m.paneId),
		["p1", "p2"],
	);
	assert.deepEqual(
		collisions([one, noForeground], none(), HOME).get("repo")?.map((m) => m.paneId),
		["p1", "p3"],
	);

	const nested = [
		agent("p4", { status: "working", foregroundCwd: NESTED, cwd: NESTED }),
		agent("p5", { status: "working", foregroundCwd: NESTED, cwd: NESTED }),
	];
	assert.deepEqual([...collisions(nested, none(), HOME).keys()], ["fleet"]);
});

test("a home-heavy fleet collides only where two agents share a repo", () => {
	const agents = [
		...["h1", "h2", "h3", "h4", "h5"].map((paneId) => agent(paneId, { status: "working", cwd: HOME, foregroundCwd: HOME })),
		agent("r1", { status: "working", foregroundCwd: REPO, cwd: REPO }),
		agent("r2", { status: "working", foregroundCwd: REPO, cwd: REPO }),
		agent("o1", { status: "working", foregroundCwd: "/w/other", cwd: "/w/other" }),
	];

	const found = collisions(agents, none(), HOME);

	assert.deepEqual([...found.keys()], ["fleet-supervisor"]);
	assert.equal(found.size, 1, "five agents in $HOME must not manufacture a trigger");
	assert.deepEqual(
		found.get("fleet-supervisor")?.map((m) => m.paneId),
		["r1", "r2"],
	);
});
