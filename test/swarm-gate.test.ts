// The gate's hard properties, against the real profile package and a real run root.
//
// What is faked: the engine (there is none in this file), the clock, and nothing else.
// The catalogue, the caps and `may_spawn` are the real ones, because "a leaf has no
// `spawn`" is a claim about `profiles/` and testing it against a table written here
// would only test this file.

import assert from "node:assert/strict";
import { after, test } from "node:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { GrantBook, planSpawn } from "../src/swarm/grant.ts";
import { Gate } from "../src/swarm/gate.ts";
import { capsOf, pythonProfiles, type Ceilings, type ProfileTable } from "../src/swarm/profiles.ts";
import type { AssignmentRecord, StructuredRecord } from "../src/swarm/records.ts";
import { SwarmStore } from "../src/swarm/store.ts";
import type { Action, ProfileReply } from "../src/swarm/types.ts";
import type { EscalationEvent } from "../src/swarm/events.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC_SWARM = resolve(HERE, "..", "src", "swarm");

const bridge = pythonProfiles();
const table = await bridge.table().catch(() => undefined);
const skip = table ? false : "the profiles bridge needs python3 and the profiles/ package";

if (table) test("the profile package is the one the runtime consumes", () => {
	assert.equal(capsOf(table, "orch").chainCeiling, 3);
	assert.equal(capsOf(table, "worker").chainCeiling, 0);
	const leaf = table.roles.orch.licences.leaf?.tools ?? [];
	const inner = table.roles.orch.licences.inner?.tools ?? [];
	assert.ok(inner.some((tool) => tool.name === "spawn"), "the inner catalogue must offer spawn");
	assert.ok(!leaf.some((tool) => tool.name === "spawn"), "the leaf catalogue must not offer spawn");
});

let clock = 1_760_000_000_000;
let root = "";
let store: SwarmStore;
let book: GrantBook;
let gate: Gate;

function harness(): { store: SwarmStore; book: GrantBook; gate: Gate; table: ProfileTable } {
	if (!table) throw new Error("no profile table");
	if (!store) {
		root = mkdtempSync(join(tmpdir(), "swarm-gate-"));
		store = new SwarmStore({ root, runId: "r-gate", now: () => clock });
		book = new GrantBook(600_000);
		const ceilings: Ceilings = bridge.ceilings;
		gate = new Gate({ store, grants: book, profiles: table, ceilings, now: () => clock });
	}
	return { store, book, gate, table };
}

after(() => {
	if (root) rmSync(root, { recursive: true, force: true });
});

function assignment(itemId: string, path: string): StructuredRecord {
	const record: AssignmentRecord = {
		kind: "assignment",
		itemId,
		briefId: "B1",
		task: "write",
		path,
		sourceId: null,
		slots: { goal: `write ${itemId}`, done: "tests pass", limit: null },
		depth: 1,
	};
	return record;
}

function dispatchAction(input: {
	chainId: string;
	grant: string;
	node: string;
	item: string;
	path: string;
}): Action {
	return {
		chainId: input.chainId,
		grantId: input.grant,
		nodeId: input.node,
		profile: "orch",
		// A node that dispatches is a leaf node: the two orchestrator catalogues are
		// exclusive, and `dispatch` is the leaf one (RG §4.2).
		instance: "orch.leaf",
		op: "dispatch",
		args: { workId: input.item, path: input.path },
		payload: { kind: "assignment", record: assignment(input.item, input.path) },
	};
}

function spawnAction(input: { chainId: string; grant: string; node: string; k: number; bin: string; instance?: "orch.leaf" | "orch.inner" }): Action {
	return {
		chainId: input.chainId,
		grantId: input.grant,
		nodeId: input.node,
		profile: "orch",
		instance: input.instance ?? "orch.inner",
		op: "spawn",
		args: { binId: input.bin, slotIds: "ACT", k: String(input.k) },
	};
}

test("a second agent cannot claim a claimed path", { skip }, async () => {
	const { store: board, book: grants, gate: g } = harness();
	const chainCeiling = capsOf(table as ProfileTable, "orch").chainCeiling;
	const first = grants.mint({ chainId: "c-claim", profile: "orch", agentId: "c-claim/n1", depth: 1, budget: 6, bin: "sequence", chainCeiling, now: clock });
	const second = grants.mint({ chainId: "c-claim", profile: "orch", agentId: "c-claim/n2", depth: 1, budget: 6, bin: "sequence", chainCeiling, now: clock });

	const one = await g.dispatch(dispatchAction({ chainId: "c-claim", grant: first.grantId, node: "n1", item: "w2", path: "src/x.ts" }));
	assert.equal(one.kind, "performed", JSON.stringify(one));

	const two = await g.dispatch(dispatchAction({ chainId: "c-claim", grant: second.grantId, node: "n2", item: "w3", path: "src/x.ts" }));
	assert.equal(two.kind, "refused");
	if (two.kind !== "refused") return;
	assert.equal(two.cause, "contested_claim");
	// The denial is a fact handed back — holder and deadline — not an exception.
	assert.match(two.detail, /held by c-claim\/n1/);
	assert.equal(two.escalation.nextActor, "profile");
	assert.equal(two.escalation.action, "reroute");
	// Nothing was published for the refused dispatch: the claim is taken before the work.
	assert.equal(board.artifacts().filter((artifact) => artifact.path === "src/x.ts").length, 1);

	// A release makes it grantable again, and the second holder can then claim it.
	board.release("src/x.ts");
	const three = await g.dispatch(dispatchAction({ chainId: "c-claim", grant: second.grantId, node: "n2", item: "w3", path: "src/x.ts" }));
	assert.equal(three.kind, "performed");
});

test("a leaf cannot spawn — the licence, not the prompt", { skip }, async () => {
	const { store: board, book: grants, gate: g } = harness();
	const chainCeiling = capsOf(table as ProfileTable, "orch").chainCeiling;
	const grant = grants.mint({ chainId: "c-leaf", profile: "orch", agentId: "c-leaf/n0", depth: 0, budget: 6, bin: "sequence", chainCeiling, now: clock });
	const before = board.artifacts().length;
	const grantsBefore = grants.all().length;

	const refused = await g.dispatch(spawnAction({ chainId: "c-leaf", grant: grant.grantId, node: "n0", k: 2, bin: "sequence", instance: "orch.leaf" }));
	assert.equal(refused.kind, "refused");
	if (refused.kind !== "refused") return;
	// §4.2 row 2 owns this case: "op not in the answering catalogue".
	assert.equal(refused.cause, "unparseable");
	assert.match(refused.detail, /not in the orch\.leaf catalogue/);
	assert.equal(grants.all().length, grantsBefore, "no child grant may exist for a refused spawn");
	assert.equal(board.artifacts().length, before);

	// The same action on the process that does hold the catalogue is fine: the refusal was
	// about the answering process, not about the request.
	const performed = await g.dispatch(spawnAction({ chainId: "c-leaf", grant: grant.grantId, node: "n0", k: 2, bin: "sequence", instance: "orch.inner" }));
	assert.equal(performed.kind, "performed");
	if (performed.kind !== "performed") return;
	assert.equal(performed.effect.grants?.length, 2);
	for (const childId of performed.effect.grants ?? []) {
		const child = grants.get(childId);
		assert.equal(child?.depth, 1);
		// The budget arithmetic nobody but grant.ts performs: floor((parent − 1) / k).
		assert.equal(child?.budget, 2);
	}
});

test("a delegation cannot exceed the chain ceiling", { skip }, async () => {
	const { book: grants, gate: g } = harness();
	const chainCeiling = capsOf(table as ProfileTable, "orch").chainCeiling;
	// A budget wide enough that the depth is what stops the chain, not the arithmetic.
	let grant = grants.mint({ chainId: "c-depth", profile: "orch", agentId: "c-depth/n0", depth: 0, budget: 40, bin: "sequence", chainCeiling, now: clock });

	for (let depth = 0; depth < chainCeiling; depth += 1) {
		const outcome = await g.dispatch(spawnAction({ chainId: "c-depth", grant: grant.grantId, node: `n${depth}`, k: 2, bin: "sequence" }));
		assert.equal(outcome.kind, "performed", `spawn at depth ${depth}: ${JSON.stringify(outcome)}`);
		if (outcome.kind !== "performed") return;
		const childId = (outcome.effect.grants ?? [])[0] ?? "";
		const child = grants.get(childId);
		assert.ok(child);
		grant = child;
	}
	assert.equal(grant.depth, chainCeiling);

	const beyond = await g.dispatch(spawnAction({ chainId: "c-depth", grant: grant.grantId, node: "nlast", k: 2, bin: "sequence" }));
	assert.equal(beyond.kind, "refused");
	if (beyond.kind !== "refused") return;
	assert.equal(beyond.cause, "chain_ceiling");
	assert.equal(beyond.escalation.nextActor, "orchestrator");
	// No decode is retried and no grandchild exists: the refusal happened before any work.
	assert.ok(!grants.all().some((entry) => entry.depth > chainCeiling));
});

test("the bin ceiling refuses both a width and a rank regression", { skip }, async () => {
	const { book: grants, gate: g } = harness();
	const caps = capsOf(table as ProfileTable, "orch");
	const grant = grants.mint({ chainId: "c-bin", profile: "orch", agentId: "c-bin/n0", depth: 0, budget: 6, bin: "sequence", chainCeiling: caps.chainCeiling, now: clock });

	const wide = await g.dispatch(spawnAction({ chainId: "c-bin", grant: grant.grantId, node: "n0", k: caps.binCeiling + 1, bin: "sequence" }));
	assert.equal(wide.kind, "refused");
	if (wide.kind === "refused") {
		assert.equal(wide.cause, "bin_ceiling");
		assert.equal(wide.escalation.nextActor, "human");
	}

	const uprank = await g.dispatch(spawnAction({ chainId: "c-bin", grant: grant.grantId, node: "n0", k: 1, bin: "combo" }));
	assert.equal(uprank.kind, "refused");
	if (uprank.kind === "refused") {
		assert.equal(uprank.cause, "bin_ceiling");
		assert.match(uprank.detail, /rank 3/);
	}

	const unaffordable = await g.dispatch(spawnAction({ chainId: "c-bin", grant: grant.grantId, node: "n0", k: 6, bin: "sequence" }));
	assert.equal(unaffordable.kind, "refused");
	if (unaffordable.kind === "refused") assert.equal(unaffordable.cause, "bin_ceiling");
});

test("an exhausted budget revokes the grant and refuses before any work", { skip }, async () => {
	const { store: board, book: grants, gate: g } = harness();
	const chainCeiling = capsOf(table as ProfileTable, "orch").chainCeiling;
	// At the ceiling: `maySpawn` is false, so this node is routed to the leaf catalogue and
	// its whole budget is available for dispatch.
	const grant = grants.mint({ chainId: "c-budget", profile: "orch", agentId: "c-budget/n0", depth: chainCeiling, budget: 2, bin: "sequence", chainCeiling, now: clock });

	for (const [index, path] of ["src/a.ts", "src/b.ts"].entries()) {
		const out = await g.dispatch(dispatchAction({ chainId: "c-budget", grant: grant.grantId, node: "n0", item: `w${index}`, path }));
		assert.equal(out.kind, "performed", JSON.stringify(out));
	}
	assert.equal(grants.get(grant.grantId)?.remaining, 0);
	const artifactsAfterSpend = board.artifacts().length;

	const refused = await g.dispatch(dispatchAction({ chainId: "c-budget", grant: grant.grantId, node: "n0", item: "w9", path: "src/c.ts" }));
	assert.equal(refused.kind, "refused");
	if (refused.kind !== "refused") return;
	assert.equal(refused.cause, "budget");
	assert.equal(refused.escalation.nextActor, "human", "the root's budget spent is the human's bill");
	assert.equal(board.artifacts().length, artifactsAfterSpend, "nothing may be published under a spent grant");
});

test("the cheap correct answers are never gated", { skip }, async () => {
	const { store: board, book: grants, gate: g } = harness();
	const chainCeiling = capsOf(table as ProfileTable, "orch").chainCeiling;
	const grant = grants.mint({ chainId: "c-wait", profile: "orch", agentId: "c-wait/n0", depth: 1, budget: 1, bin: "sequence", chainCeiling, now: clock });
	grants.revoke(grant.grantId);

	// I2: a revoked grant does not stop `wait`. Holding a report is how a supervisor
	// becomes a bottleneck for its own alarms.
	const waited = await g.dispatch({ chainId: "c-wait", grantId: grant.grantId, nodeId: "n0", profile: "orch", instance: "orch.leaf", op: "wait", args: {} });
	assert.equal(waited.kind, "ungated");
	const rows = board.events().filter((event) => event.t === "action");
	assert.equal(rows.at(-1)?.outcome, "ungated");

	// `hi.done` publishes the brief and is still not refused: it produces a record, not a
	// side effect the graph has to arbitrate.
	const briefArtifacts = board.artifacts().length;
	const done = await g.dispatch({
		chainId: "c-wait",
		grantId: grant.grantId,
		nodeId: "n0",
		profile: "hi",
		instance: "hi",
		op: "done",
		args: {},
		payload: {
			kind: "brief",
			record: {
				kind: "brief",
				briefId: "B1",
				msgId: "m1",
				cites: [{ segId: "s01", slot: "ACT", textStart: 0, textEnd: 4 }],
				status: { ACT: "FILLED", TARGET: "ABSENT", LOCUS: "ABSENT", CONSTRAINT: "ABSENT", ACCEPTANCE: "ABSENT" },
				absentWhy: { TARGET: "not_in_message" },
				question: null,
			},
		},
	});
	assert.equal(done.kind, "performed");
	if (done.kind !== "performed") return;
	assert.equal(done.gated, false);
	assert.equal(board.artifacts().length, briefArtifacts + 1);
});

test("a refusal leaves with a next actor, never with silence", { skip }, async () => {
	const { store: board, gate: g } = harness();
	const outcome = g.reject({
		chainId: "c-refuse",
		grantId: "G-absent",
		nodeId: "n3",
		profile: "worker",
		instance: "worker",
		op: "none",
		cause: "refusal",
		detail: "the profile emitted no call",
	});
	assert.equal(outcome.kind, "refused");
	if (outcome.kind !== "refused") return;
	assert.equal(outcome.escalation.nextActor, "parent");
	assert.equal(outcome.escalation.action, "synthesize_block");
	const escalations = board
		.events()
		.filter((event): event is EscalationEvent => event.t === "escalation" && event.chainId === "c-refuse");
	assert.equal(escalations.length, 1);
	assert.equal(escalations[0]?.to, "parent");
	// The corrective is a record the dispatcher writes, not a decision it invents.
	assert.match(outcome.escalation.detail, /emitted no call/);
});

test("one module opens files under the run root (I1)", { skip }, () => {
	const files = readdirSync(SRC_SWARM).filter((name) => name.endsWith(".ts"));
	const writers = files.filter((name) => {
		const body = readFileSync(join(SRC_SWARM, name), "utf8");
		return /(writeFileSync|appendFileSync|mkdirSync|renameSync|rmSync|unlinkSync|openSync|createWriteStream)\(/.test(body);
	});
	assert.deepEqual(writers, ["store.ts"], "only the store may write the run root");

	const gateBody = readFileSync(join(SRC_SWARM, "gate.ts"), "utf8");
	assert.ok(!gateBody.includes("node:fs"), "the gate mutates state, it never opens a file");
});

test("a steer without a route is refused, because a profile cannot address another", { skip }, async () => {
	const { store: board, book: grants, gate: g } = harness();
	const chainCeiling = capsOf(table as ProfileTable, "orch").chainCeiling;
	const grant = grants.mint({ chainId: "c-steer", profile: "orch", agentId: "c-steer/n0", depth: 1, budget: 4, bin: "sequence", chainCeiling, now: clock });
	const published = board.publish({
		kind: "return",
		path: "src/x.ts",
		record: { kind: "return", itemId: "w2", status: "done", artifactIds: [], evidence: null, code: null, tries: 1 },
		bytes: "{}",
		provenance: { producer: "worker", instance: "worker", nodeId: "n1", grantId: grant.grantId, chainId: "c-steer", depth: 1, budget: 4 },
	});

	const refused = await g.dispatch({
		chainId: "c-steer",
		grantId: grant.grantId,
		nodeId: "n0",
		profile: "orch",
		instance: "orch.inner",
		op: "steer",
		args: { toAgent: "a1", artifactIds: published.artifactId },
	});
	assert.equal(refused.kind, "refused");
	if (refused.kind === "refused") assert.match(refused.detail, /no route/);

	const performed = await g.dispatch({
		chainId: "c-steer",
		grantId: grant.grantId,
		nodeId: "n0",
		profile: "orch",
		instance: "orch.inner",
		op: "steer",
		args: { toAgent: "a1", artifactIds: published.artifactId },
		route: "worker",
	});
	assert.equal(performed.kind, "performed");
	const delivered = board.drainSteers("worker", "loop-1").filter((envelope) => envelope.artifactIds.includes(published.artifactId));
	assert.equal(delivered.length, 1);
	assert.deepEqual(delivered[0]?.artifactIds, [published.artifactId]);
	// No content crosses: the envelope carries a pointer and a line copied from the record.
	assert.ok((delivered[0]?.intent ?? "").startsWith(published.artifactId));
});

test("planSpawn's arithmetic never grants more than the parent holds", { skip }, () => {
	const { book: grants } = harness();
	const chainCeiling = capsOf(table as ProfileTable, "orch").chainCeiling;
	for (let budget = 1; budget <= 24; budget += 1) {
		for (let k = 1; k <= 9; k += 1) {
			const grant = grants.mint({ chainId: "c-sum", profile: "orch", agentId: "c-sum/n0", depth: 0, budget, bin: "sequence", chainCeiling, now: clock });
			const plan = planSpawn(grant, { k, childBin: "sequence", chainCeiling, binCeiling: capsOf(table as ProfileTable, "orch").binCeiling });
			if (!plan.ok) continue;
			assert.ok(plan.k * plan.childBudget + 1 <= budget, `Σ child_budget + 1 ≤ parent at budget ${budget}, k ${k}`);
		}
	}
});

test("the grants carry wall-clock expiry, so a dead dispatcher's chain ends", { skip }, async () => {
	const { book: grants, gate: g } = harness();
	const chainCeiling = capsOf(table as ProfileTable, "orch").chainCeiling;
	const grant = grants.mint({ chainId: "c-expired", profile: "orch", agentId: "c-expired/n0", depth: 1, budget: 4, bin: "sequence", chainCeiling, now: clock });
	clock += 700_000;
	const refused = await g.dispatch(dispatchAction({ chainId: "c-expired", grant: grant.grantId, node: "n0", item: "w1", path: "src/late.ts" }));
	assert.equal(refused.kind, "refused");
	if (refused.kind !== "refused") return;
	assert.equal(refused.cause, "grant_expired");
	assert.equal(refused.escalation.action, "revoke_grant");
});

test("an unparseable reply is the requestor's problem, and a second one revokes", { skip }, async () => {
	const { book: grants, gate: g } = harness();
	const chainCeiling = capsOf(table as ProfileTable, "orch").chainCeiling;
	const grant = grants.mint({ chainId: "c-bad", profile: "orch", agentId: "c-bad/n0", depth: 1, budget: 4, bin: "sequence", chainCeiling, now: clock });
	const reject = (): ReturnType<Gate["reject"]> =>
		g.reject({
			chainId: "c-bad",
			grantId: grant.grantId,
			nodeId: "n0",
			profile: "orch",
			instance: "orch.inner",
			op: "dispatch",
			cause: "unparseable",
			detail: "dispatch.path=src/x.ts is not a span of the state",
		});
	const first = reject();
	assert.equal(first.kind, "refused");
	if (first.kind === "refused") {
		assert.equal(first.escalation.nextActor, "requestor");
		assert.equal(first.escalation.action, "reroute");
	}
	const second = reject();
	if (second.kind === "refused") {
		assert.equal(second.escalation.nextActor, "dispatcher");
		assert.equal(second.escalation.action, "revoke_grant");
	}
	const reply: ProfileReply = { op: null, args: {}, confidence: 0, refused: true, suppressed: 0, latencyMs: 12 };
	assert.equal(reply.refused, true);
});
