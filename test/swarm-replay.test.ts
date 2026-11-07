// The dispatcher loop end to end, against scripted engines and a real run root, then the
// ledger folded back into the delegation chain.
//
// The assertions are the ones the spec asks to be provable rather than promised: every
// action passes one gate, a refusal leaves with a next actor and a corrective record, a
// crash loses the outcome but never the question, and a chain reconstructs from the
// ledger alone — including where it stopped.

import assert from "node:assert/strict";
import { after, test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run, step, type StepDeps } from "../src/swarm/dispatcher.ts";
import { EngineFailure, type ProfileEngine } from "../src/swarm/engine.ts";
import { Gate } from "../src/swarm/gate.ts";
import { GrantBook } from "../src/swarm/grant.ts";
import { InstanceRegistry } from "../src/swarm/instances.ts";
import { ProfileProcess } from "../src/swarm/process.ts";
import { capsOf, pythonProfiles } from "../src/swarm/profiles.ts";
import { chainOf, describeChain, foldEvents } from "../src/swarm/replay.ts";
import { SwarmStore } from "../src/swarm/store.ts";
import { refusal, type InstanceKey, type ProfileReply } from "../src/swarm/types.ts";

const bridge = pythonProfiles();
const table = await bridge.table().catch(() => undefined);
const skip = table ? false : "the profiles bridge needs python3 and the profiles/ package";

let clock = 1_760_000_000_000;
const roots: string[] = [];

after(() => {
	for (const root of roots) rmSync(root, { recursive: true, force: true });
});

type Scripted = ProfileReply | "crash";

interface World {
	deps: StepDeps;
	store: SwarmStore;
	grants: GrantBook;
	registry: InstanceRegistry;
}

/** One scripted engine per instance. `crash` makes the engine die while a request is in
 *  flight, which is the one failure a fake that returns refusals cannot produce. */
function world(script: Partial<Record<InstanceKey, Scripted[]>>): World {
	const root = mkdtempSync(join(tmpdir(), "swarm-replay-"));
	roots.push(root);
	const store = new SwarmStore({ root, runId: "r-replay", now: () => clock });
	const grants = new GrantBook(600_000);
	const gate = new Gate({ store, grants, profiles: table as NonNullable<typeof table>, ceilings: bridge.ceilings, now: () => clock });
	const registry = new InstanceRegistry();
	let pid = 8_000;
	for (const [instance, replies] of Object.entries(script)) {
		const queue: Scripted[] = [...(replies ?? [])];
		const engine: ProfileEngine = {
			kind: "fake",
			pid: (pid += 1),
			async ask(): Promise<ProfileReply> {
				const next = queue.shift() ?? refusal(2);
				if (next === "crash") throw new EngineFailure("exit", "scripted crash");
				return next;
			},
			close(): void {
				/* nothing */
			},
		};
		registry.bind(instance as InstanceKey, new ProfileProcess({ instance: instance as InstanceKey, spawn: () => engine, idleMs: 0 }));
	}
	const deps: StepDeps = {
		gate,
		registry,
		grants,
		profiles: table as NonNullable<typeof table>,
		// The profile package's renderer is injected in production; here the state is the
		// JSON the spans were taken from, so the provenance check is exercised.
		render: async (_role, _licence, state) => JSON.stringify(state),
		now: () => clock,
	};
	return { deps, store, grants, registry };
}

function call(op: string, args: Record<string, string>, confidence = 0.8): ProfileReply {
	return { op, args, confidence, refused: false, suppressed: 0, latencyMs: 12 };
}

function mintOrch(grants: GrantBook, depth: number, budget: number, node = "n0"): string {
	const chainCeiling = capsOf(table as NonNullable<typeof table>, "orch").chainCeiling;
	return grants.mint({ chainId: "c1", profile: "orch", agentId: `c1/${node}`, depth, budget, bin: "sequence", chainCeiling, now: clock }).grantId;
}

test("a chain runs, refuses, and reconstructs from the ledger alone", { skip }, async () => {
	const { deps, store, grants } = world({
		"orch.inner": [call("spawn", { binId: "sequence", slotIds: "ACT", k: "2" }), call("spawn", { binId: "sequence", slotIds: "ACT", k: "1" })],
		"orch.leaf": [call("dispatch", { workId: "w2", path: "src/x.ts" })],
		worker: [call("submit", { item: "w2", art: "A1" }), refusal(9)],
	});

	// depth 0: the root allocates.
	const root = mintOrch(grants, 0, 6);
	const first = await step(
		{ chainId: "c1", grantId: root, nodeId: "n0", profile: "orch", state: { bins: ["sequence"], license: ["ACT"], k: 2 } },
		deps,
	);
	assert.equal(first.outcome.kind, "performed", JSON.stringify(first.outcome));
	assert.equal(first.instance, "orch.inner", "a node with budget and depth left is offered `spawn`");
	if (first.outcome.kind === "performed") assert.equal(first.outcome.effect.grants?.length, 2);

	// depth 1: the first child allocates once more, which makes its child a leaf.
	const child = grants.get(grants.all()[1]?.grantId ?? "");
	assert.ok(child);
	const second = await step(
		{ chainId: "c1", grantId: child.grantId, nodeId: "n1", profile: "orch", state: { bins: ["sequence"], license: ["ACT"], k: 1 } },
		deps,
	);
	assert.equal(second.outcome.kind, "performed");

	// depth 2, budget 1: a leaf, so `dispatch` is the only creation available.
	const leaf = grants.all().find((grant) => grant.depth === 2);
	assert.ok(leaf);
	assert.equal(leaf.maySpawn, false);
	const assignment = {
		kind: "assignment" as const,
		record: {
			kind: "assignment" as const,
			itemId: "w2",
			briefId: "B1",
			task: "write" as const,
			path: "src/x.ts",
			sourceId: null,
			slots: { goal: "write w2", done: "tests pass", limit: null },
			depth: 2,
		},
	};
	const third = await step(
		{
			chainId: "c1",
			grantId: leaf.grantId,
			nodeId: "n2",
			profile: "orch",
			state: { workId: "w2", path: "src/x.ts" },
			payload: assignment,
		},
		deps,
	);
	assert.equal(third.outcome.kind, "performed");
	assert.equal(third.instance, "orch.leaf");
	if (third.outcome.kind === "performed") {
		assert.ok(third.outcome.effect.claimId);
		assert.ok(third.outcome.effect.steerId);
	}
	const claimed = store.claims().filter((record) => record.state === "held");
	assert.equal(claimed.length, 1, "the claim is taken at dispatch, before the worker is asked");
	assert.equal(claimed[0]?.path, "src/x.ts");

	// The worker answers with the record it was given, and the dispatcher publishes it.
	const workerGrant = grants.mint({ chainId: "c1", profile: "worker", agentId: "c1/w2", depth: 2, budget: 1, bin: "1tool", chainCeiling: 3, now: clock });
	const submitted = await step(
		{
			chainId: "c1",
			grantId: workerGrant.grantId,
			nodeId: "w2",
			profile: "worker",
			state: { item: "w2", artifacts: ["A1"] },
			payload: {
				kind: "return",
				record: { kind: "return", itemId: "w2", status: "done", artifactIds: ["A1"], evidence: { segId: "s3" }, code: null, tries: 1 },
			},
		},
		deps,
	);
	assert.equal(submitted.outcome.kind, "performed");
	assert.equal(submitted.delivered, 1, "the steer queued by the dispatch is released at the worker's boundary");
	assert.equal(store.claims().filter((record) => record.state === "held").length, 0, "submit releases the claim");

	// A second worker node refuses. That is the escalation signal, and the dispatcher writes
	// the block the refusing profile did not.
	const failingGrant = grants.mint({ chainId: "c1", profile: "worker", agentId: "c1/w4", depth: 2, budget: 1, bin: "1tool", chainCeiling: 3, now: clock });
	const refused = await step(
		{ chainId: "c1", grantId: failingGrant.grantId, nodeId: "w4", profile: "worker", state: { item: "w4" } },
		deps,
	);
	assert.equal(refused.outcome.kind, "refused");
	assert.equal(refused.escalated, true);
	if (refused.outcome.kind === "refused") {
		assert.equal(refused.outcome.escalation.nextActor, "parent");
		assert.equal(refused.outcome.escalation.action, "synthesize_block");
	}
	assert.equal(refused.corrective?.kind, "performed", "the corrective is an action like any other, through the gate");
	const blocked = store.artifacts().find((artifact) => artifact.record?.kind === "return" && artifact.record.itemId === "w4");
	assert.equal(blocked?.record?.kind === "return" ? blocked.record.status : undefined, "blocked");

	// ---------------------------------------------------------------- replay
	const events = store.events();
	const fold = foldEvents(events);
	assert.equal(fold.byProfile.orch, 3);
	assert.equal(fold.byProfile.worker, 2);
	assert.equal(fold.unanswered.length, 0);
	assert.equal(fold.failures.refusal, 1);
	assert.ok(fold.escalations.length >= 1);
	assert.ok(fold.artifacts.size >= 2);

	const chain = chainOf(fold, "c1");
	assert.equal(chain.maxDepth, 2);
	assert.ok(chain.grants.length >= 3);
	assert.ok(chain.stopped, "the chain records where it stopped");
	assert.ok(chain.stopped?.detail.includes("refusal"), chain.stopped?.detail);
	const lines = describeChain(chain);
	assert.ok(lines.some((line) => line.includes("refused")), lines.join("\n"));
	assert.ok(events.some((event) => event.t === "steer_delivered"));

	// L3: the question is written before the sidecar is awaited, so the two rows exist in
	// that order and an unanswered ask is a fact rather than a hole.
	const asked = events.findIndex((event) => event.t === "decision_asked");
	const answered = events.findIndex((event) => event.t === "profile_decision");
	assert.ok(asked >= 0 && answered > asked);
});

test("a crash loses the outcome, never the question", { skip }, async () => {
	const { deps, store, grants } = world({ worker: ["crash"] });
	const grant = grants.mint({ chainId: "c-crash", profile: "worker", agentId: "c-crash/w1", depth: 1, budget: 1, bin: "1tool", chainCeiling: 3, now: clock });
	const result = await step({ chainId: "c-crash", grantId: grant.grantId, nodeId: "w1", profile: "worker", state: { item: "w1" } }, deps);

	// No decision is invented in its place: the profile is unavailable, not wrong.
	assert.equal(result.reply, undefined);
	assert.equal(result.outcome.kind, "refused");
	if (result.outcome.kind === "refused") {
		assert.equal(result.outcome.cause, "unavailable");
		assert.equal(result.outcome.escalation.nextActor, "dispatcher");
		assert.equal(result.outcome.escalation.action, "respawn");
	}
	const fold = foldEvents(store.events());
	assert.equal(fold.unanswered.length, 1, "an asked-and-never-answered decision is visible");
	assert.ok(store.events().some((event) => event.t === "profile_unhealthy"));
});

test("a leaf cannot spawn, end to end: the verifier catches it before the gate", { skip }, async () => {
	// depth 3 with budget 2 means `maySpawn` is false, so this node is routed to the leaf
	// process — whose catalogue has no `spawn` at all.
	const { deps, store, grants } = world({ "orch.leaf": [call("spawn", { binId: "sequence", slotIds: "ACT", k: "2" })] });
	const grantId = mintOrch(grants, 3, 2);
	const before = grants.all().length;
	const result = await step(
		{ chainId: "c1", grantId, nodeId: "n3", profile: "orch", state: { bins: ["sequence"], license: ["ACT"], k: 2 } },
		deps,
	);
	assert.equal(result.instance, "orch.leaf");
	assert.equal(result.outcome.kind, "refused");
	if (result.outcome.kind === "refused") {
		assert.equal(result.outcome.cause, "unparseable");
		assert.match(result.outcome.detail, /not in the answering catalogue/);
	}
	assert.equal(grants.all().length, before, "a leaf emitted a spawn and no child grant exists");
	assert.ok(store.events().some((event) => event.t === "escalation"));
});

test("a run writes one tick row and the fold agrees with it", { skip }, async () => {
	const { deps, store, grants } = world({
		"orch.leaf": [call("wait", {}), refusal(4)],
	});
	const grants_ = [mintOrch(grants, 3, 1, "n1"), mintOrch(grants, 3, 1, "n2")];
	const report = await run(
		grants_.map((grantId, index) => ({ chainId: "c1", grantId, nodeId: `n${index + 1}`, profile: "orch" as const, state: {} })),
		deps,
	);
	assert.equal(report.decisions, 2);
	assert.equal(report.refused, 1);
	assert.equal(report.dropped, 0);

	const fold = foldEvents(store.events());
	assert.equal(fold.ticks.length, 1);
	assert.equal(fold.ticks[0]?.decisions, 2);
	assert.equal(fold.ticks[0]?.refused, 1);
	assert.equal(fold.decisions, 2);
	assert.equal(fold.refused, 1);
});

test("a spent grant refuses before any decode happens", { skip }, async () => {
	const { deps, store, grants } = world({ "orch.leaf": [call("wait", {})] });
	const grantId = mintOrch(grants, 3, 1);
	assert.ok(grants.revoke(grantId));
	// `wait` is ungated (I2), so it still answers; the gated action is what is refused.
	const waited = await step({ chainId: "c1", grantId, nodeId: "n0", profile: "orch", state: {} }, deps);
	assert.equal(waited.outcome.kind, "ungated", "a report is never refused");
	const refused = await deps.gate.dispatch({
		chainId: "c1",
		grantId,
		nodeId: "n0",
		profile: "orch",
		instance: "orch.leaf",
		op: "dispatch",
		args: { workId: "w1", path: "src/a.ts" },
	});
	assert.equal(refused.kind, "refused");
	if (refused.kind === "refused") assert.equal(refused.cause, "budget");
	assert.equal(store.artifacts().length, 0);
});

test("the loop sweeps before it decides", { skip }, async () => {
	const { deps, store, grants } = world({ "orch.leaf": [call("wait", {})] });
	const grantId = mintOrch(grants, 3, 1);
	// A lease whose holder is gone: the crashed-holder path is the only thing that can make
	// it disappear, and it must run before a decision can be taken under it.
	store.acquire({ path: "src/orphan.ts", holder: "c/dead", intent: "write w9", ttlMs: 1 });
	clock += 10;
	await run([{ chainId: "c1", grantId, nodeId: "n1", profile: "orch", state: {} }], deps);
	const expired = store.events().filter((event) => event.t === "claim_expired" && event.path === "src/orphan.ts");
	assert.equal(expired.length, 1);
});
