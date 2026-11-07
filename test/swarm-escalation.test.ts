// The failure matrix as a total function. Every cause, every role, three consecutive
// counts: a refusal with no next actor is the one outcome `escalate` may not produce,
// and this walks the whole matrix to prove it does not.

import assert from "node:assert/strict";
import { test } from "node:test";
import { correctiveOp, escalate } from "../src/swarm/escalate.ts";
import {
	ESCALATION_ACTIONS,
	FAILURE_CAUSES,
	NEXT_ACTORS,
	ROLES,
	type FailureCause,
	type Role,
} from "../src/swarm/types.ts";

/** The seven conditions the brief names. The other two (a spent budget, an expired
 *  grant) come from the grant ledger and are in the same table. */
const REQUIRED: readonly FailureCause[] = [
	"refusal",
	"unparseable",
	"suppressed",
	"contested_claim",
	"chain_ceiling",
	"bin_ceiling",
	"unavailable",
];

function name(cause: FailureCause, role: Role, consecutive = 1, isRoot = false): string {
	return `${cause}/${role}/${consecutive}${isRoot ? "/root" : ""}`;
}

test("every failure has a named next actor", () => {
	for (const cause of REQUIRED) {
		assert.ok(FAILURE_CAUSES.includes(cause), `${cause} must be in the vocabulary`);
	}
	for (const cause of FAILURE_CAUSES) {
		for (const role of ROLES) {
			for (const consecutive of [1, 2, 3]) {
				for (const isRoot of [false, true]) {
					const escalation = escalate({ cause, role, consecutive, isRoot, detail: "detail" });
					const label = name(cause, role, consecutive, isRoot);
					assert.ok(NEXT_ACTORS.includes(escalation.nextActor), `${label}: ${escalation.nextActor}`);
					assert.ok(ESCALATION_ACTIONS.includes(escalation.action), `${label}: ${escalation.action}`);
					assert.equal(escalation.cause, cause);
					assert.equal(escalation.role, role);
				}
			}
		}
	}
});

test("a refusal is the escalation signal, and each role has its own disposition", () => {
	const of = (role: Role, consecutive = 1): ReturnType<typeof escalate> =>
		escalate({ cause: "refusal", role, consecutive, isRoot: false, detail: "no call" });

	// The front door cannot go silent: the 1B lane speaks.
	assert.deepEqual(pick(of("hi")), { nextActor: "oneB", action: "escalate_lane" });
	// Re-ask once in the same grammar, then change the decision source.
	assert.deepEqual(pick(of("orch", 1)), { nextActor: "ladder", action: "reask_once" });
	assert.deepEqual(pick(of("orch", 2)), { nextActor: "hosted", action: "escalate_lane" });
	// A worker that never blocks hides its failures, so a refusal becomes a block.
	assert.deepEqual(pick(of("worker")), { nextActor: "parent", action: "synthesize_block" });
	assert.deepEqual(pick(of("fetch")), { nextActor: "parent", action: "synthesize_drop" });
	assert.deepEqual(pick(of("search")), { nextActor: "parent", action: "partial_result" });
});

test("the synthesized block is an op, not a fabricated leave", () => {
	const block = correctiveOp(escalate({ cause: "refusal", role: "worker", consecutive: 1, isRoot: false, detail: "" }));
	assert.deepEqual(block?.op, "block");
	const drop = correctiveOp(escalate({ cause: "refusal", role: "fetch", consecutive: 1, isRoot: false, detail: "" }));
	assert.deepEqual(drop?.op, "drop");
	// Everything else is a report: a human flag, a parked node, a lane swap.
	assert.equal(correctiveOp(escalate({ cause: "refusal", role: "hi", consecutive: 1, isRoot: false, detail: "" })), undefined);
});

test("suppression behaves as a refusal and is reported to the corpus owner", () => {
	const suppressed = escalate({ cause: "suppressed", role: "fetch", consecutive: 1, isRoot: false, detail: "1 suppressed" });
	const refused = escalate({ cause: "refusal", role: "fetch", consecutive: 1, isRoot: false, detail: "1 suppressed" });
	assert.equal(suppressed.nextActor, refused.nextActor);
	assert.equal(suppressed.action, refused.action);
	assert.equal(suppressed.alsoNotifies, "corpus_owner");
	assert.match(suppressed.detail, /corpus owner/);
});

test("a contested claim goes to the requester, then to the human", () => {
	const first = escalate({ cause: "contested_claim", role: "orch", consecutive: 1, isRoot: false, detail: "held by w4" });
	assert.deepEqual(pick(first), { nextActor: "profile", action: "reroute" });
	const second = escalate({ cause: "contested_claim", role: "orch", consecutive: 2, isRoot: false, detail: "held by w4" });
	assert.deepEqual(pick(second), { nextActor: "human", action: "flag_human" });
});

test("a ceiling hit is elastic on human authority only", () => {
	const chain = escalate({ cause: "chain_ceiling", role: "orch", consecutive: 1, isRoot: false, detail: "depth 4 > 3" });
	assert.deepEqual(pick(chain), { nextActor: "orchestrator", action: "reroute" });
	const twice = escalate({ cause: "chain_ceiling", role: "orch", consecutive: 2, isRoot: false, detail: "depth 4 > 3" });
	assert.equal(twice.nextActor, "human");

	const bin = escalate({ cause: "bin_ceiling", role: "orch", consecutive: 1, isRoot: false, detail: "child 3 > parent 2" });
	assert.deepEqual(pick(bin), { nextActor: "parent", action: "reroute" });
	const rootBin = escalate({ cause: "bin_ceiling", role: "orch", consecutive: 1, isRoot: true, detail: "child 3 > parent 2" });
	assert.equal(rootBin.nextActor, "human");
});

test("an exhausted budget is the parent's re-plan, and at the root it is the bill", () => {
	const child = escalate({ cause: "budget", role: "worker", consecutive: 1, isRoot: false, detail: "remaining 0" });
	assert.deepEqual(pick(child), { nextActor: "parent", action: "reroute" });
	const root = escalate({ cause: "budget", role: "orch", consecutive: 1, isRoot: true, detail: "remaining 0" });
	assert.equal(root.nextActor, "human");
	assert.match(root.detail, /Q_SCOPE/);
});

test("a crash is unavailable, not wrong: respawn, then degrade the lane", () => {
	const first = escalate({ cause: "unavailable", role: "fetch", consecutive: 1, isRoot: false, detail: "engine exited" });
	assert.deepEqual(pick(first), { nextActor: "dispatcher", action: "respawn" });
	const third = escalate({ cause: "unavailable", role: "fetch", consecutive: 3, isRoot: false, detail: "engine exited" });
	assert.deepEqual(pick(third), { nextActor: "hosted", action: "escalate_lane" });
	assert.match(third.detail, /degraded/);
});

test("an expired grant ends the chain rather than resuming unverifiably", () => {
	const expired = escalate({ cause: "grant_expired", role: "orch", consecutive: 1, isRoot: false, detail: "G7 expired" });
	assert.deepEqual(pick(expired), { nextActor: "dispatcher", action: "revoke_grant" });
});

function pick(escalation: ReturnType<typeof escalate>): { nextActor: string; action: string } {
	return { nextActor: escalation.nextActor, action: escalation.action };
}
