// The grant arithmetic, and the one claim that has to be checked across a language
// boundary: the local plan (`planSpawn`) and `profiles/common.py:may_spawn` must agree.
//
// The profile package owns the predicate; `planSpawn` owns the arithmetic the predicate
// is fed and the bin lattice the package does not carry. If the two ever disagree, one
// of them is a second definition, and this file is what says so.

import assert from "node:assert/strict";
import { test } from "node:test";
import { BIN_RANK, GrantBook, planSpawn, rankOf } from "../src/swarm/grant.ts";
import { capsOf, pythonProfiles } from "../src/swarm/profiles.ts";

const bridge = pythonProfiles();
const table = await bridge.table().catch(() => undefined);
const skip = table ? false : "the profiles bridge needs python3 and the profiles/ package";

function mint(book: GrantBook, depth: number, budget: number, bin = "sequence", chainCeiling = 3) {
	return book.mint({ chainId: "c-grant", profile: "orch", agentId: "c-grant/n0", depth, budget, bin, chainCeiling, now: 0 });
}

test("the bin lattice is ranked by how much decomposition the bin implies", () => {
	assert.deepEqual(Object.values(BIN_RANK).sort(), [0, 0, 0, 1, 1, 2, 2, 3]);
	assert.equal(rankOf("1tool"), 0);
	assert.equal(rankOf("contextual"), 0, "an anaphoric request resolves against context; it does not spawn");
	assert.equal(rankOf("sequence"), 2);
	assert.equal(rankOf("combo"), 3);
	assert.equal(rankOf("not-a-bin"), undefined);

	// Monotone: a child's rank may never exceed its parent's, and rank 3 has nowhere to go.
	const book = new GrantBook();
	const combo = mint(book, 0, 9, "combo");
	assert.equal(planSpawn(combo, { k: 1, childBin: "combo", chainCeiling: 3, binCeiling: 8 }).ok, true);
	const oneTool = mint(book, 0, 9, "1tool");
	const up = planSpawn(oneTool, { k: 1, childBin: "combo", chainCeiling: 3, binCeiling: 8 });
	assert.equal(up.ok, false);
	if (!up.ok) assert.equal(up.cause, "bin_ceiling");
});

test("child budget is floor((parent − 1) / k) and Σ child_budget + 1 ≤ parent, over 200 traces", () => {
	let seed = 12_345;
	const next = (limit: number): number => {
		seed = (seed * 1_103_515_245 + 12_345) & 0x7fffffff;
		return (seed % limit) + 1;
	};
	const book = new GrantBook();
	let admitted = 0;
	for (let trace = 0; trace < 200; trace += 1) {
		const budget = next(40);
		const k = next(9);
		const grant = mint(book, 0, budget);
		const plan = planSpawn(grant, { k, childBin: "sequence", chainCeiling: 3, binCeiling: 8 });
		if (!plan.ok) continue;
		admitted += 1;
		assert.equal(plan.childBudget, Math.floor((budget - 1) / k));
		assert.ok(plan.k * plan.childBudget + 1 <= budget, `budget ${budget}, k ${k}`);
		assert.ok(plan.childBudget >= 1);
	}
	assert.ok(admitted > 100, `the trace admitted only ${admitted} plans; the sample is not exercising the arithmetic`);
});

test("maySpawn is decided at mint time, and a spent spawn stays spent", () => {
	const book = new GrantBook();
	const root = mint(book, 0, 6);
	assert.equal(root.maySpawn, true, "depth 0 < 3 and budget 6 ≥ 2");

	const leafByBudget = mint(book, 0, 1);
	assert.equal(leafByBudget.maySpawn, false, "budget 1 can dispatch and nothing else");
	const leafByDepth = mint(book, 3, 9);
	assert.equal(leafByDepth.maySpawn, false, "at the ceiling the option is absent, not discouraged");

	book.markSpawned(root.grantId);
	assert.equal(book.get(root.grantId)?.maySpawn, false);
});

test("exhaustion revokes the grant", () => {
	const book = new GrantBook();
	const grant = mint(book, 1, 2);
	assert.equal(book.spend(grant.grantId, 10)?.revoked, false);
	assert.equal(book.get(grant.grantId)?.remaining, 1);
	assert.equal(book.spend(grant.grantId, 20)?.revoked, true);
	assert.equal(book.get(grant.grantId)?.remaining, 0);
	assert.equal(book.get(grant.grantId)?.maySpawn, false);
	assert.equal(book.expired(30).length, 0, "a spent grant is not expired either: it is spent");
});

test("an expired grant is not honoured, and expiry is wall clock", () => {
	const book = new GrantBook(1_000);
	const grant = mint(book, 1, 4);
	assert.deepEqual(book.expired(999), []);
	assert.deepEqual(book.expired(1_001).map((entry) => entry.grantId), [grant.grantId]);
});

test("the profile package and the local plan agree about the ceiling", { skip }, async () => {
	const caps = capsOf(table as NonNullable<typeof table>, "orch");
	let compared = 0;
	for (const depth of [0, 1, 2, 3, 4]) {
		for (const budget of [1, 2, 3, 6]) {
			for (const k of [1, 2, 3]) {
				const book = new GrantBook();
				const grant = mint(book, depth, budget, "sequence", caps.chainCeiling);
				const plan = planSpawn(grant, {
					k,
					childBin: "sequence",
					chainCeiling: caps.chainCeiling,
					binCeiling: caps.binCeiling,
				});
				// The verdict the gate would ask for, on the plan's own child budget.
				const verdict = await bridge.ceilings.maySpawn("orch", grant.depth, grant.remaining, plan.ok ? plan.childBudget : 0);
				const label = `depth ${depth} budget ${budget} k ${k}: ${verdict.reason}`;
				compared += 1;
				if (plan.ok) assert.equal(verdict.allowed, true, `plan permitted what may_spawn refuses — ${label}`);
				if (!verdict.allowed) assert.equal(plan.ok, false, `may_spawn refused what plan permits — ${label}`);
			}
		}
	}
	assert.ok(compared === 60);
});
