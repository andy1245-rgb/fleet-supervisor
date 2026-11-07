// A claim is exclusive, deny-don't-block, and TTL-bounded; an artifact is addressed by
// content. Both are the donor contracts (`swarmHarness/src/blackboard/`) with the two
// extensions the runtime forces: milliseconds instead of steps, and a file per claim.
//
// No engine, no python: this file is the board alone.

import assert from "node:assert/strict";
import { after, test } from "node:test";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isComplete, resolve, sha256, summaryOf } from "../src/swarm/artifacts.ts";
import { CLAIM_TTL_MS, decideClaim, sweepable } from "../src/swarm/claims.ts";
import { SwarmStore } from "../src/swarm/store.ts";
import type { ReturnRecord } from "../src/swarm/records.ts";

let clock = 1_760_000_000_000;
const root = mkdtempSync(join(tmpdir(), "swarm-board-"));
const store = new SwarmStore({ root, runId: "r-board", now: () => clock });

after(() => rmSync(root, { recursive: true, force: true }));

const provenance = {
	producer: "worker" as const,
	instance: "worker" as const,
	nodeId: "n1",
	grantId: "G1",
	chainId: "c-board",
	depth: 1,
	budget: 3,
};

const returned: ReturnRecord = {
	kind: "return",
	itemId: "w2",
	status: "done",
	artifactIds: ["A1"],
	evidence: { segId: "s3" },
	code: null,
	tries: 1,
};

test("an artifact is addressed by content, and the record is the pointer", () => {
	const bytes = JSON.stringify(returned);
	const first = store.publish({ kind: "return", path: "src/x.ts", record: returned, bytes, provenance });
	const second = store.publish({ kind: "return", path: "src/y.ts", record: returned, bytes, provenance });

	assert.equal(first.sha256, sha256(bytes));
	assert.equal(first.sha256, second.sha256);
	assert.notEqual(first.artifactId, second.artifactId);

	// One blob for identical bytes: the digest is the address, so immutability is a
	// property of the layout rather than a promise.
	const blobs = readdirSync(join(root, ".swarm", "blobs"));
	assert.equal(blobs.length, 1);

	// A pointer resolves to the record; a path resolves to the latest artifact on it.
	assert.equal(resolve(store.artifacts(), first.artifactId)?.record?.kind, "return");
	assert.equal(resolve(store.artifacts(), "src/y.ts")?.artifactId, second.artifactId);
	assert.equal(resolve(store.artifacts(), "A-does-not-exist"), undefined);
});

test("the donor board contract holds on the file-backed store", () => {
	// `isComplete(workId)` is the sim's completion test, and the reason a return record is
	// the board's notion of done; `blob(sha)` is the read side of content addressing.
	assert.equal(isComplete(store.artifacts(), "w2"), true);
	assert.equal(isComplete(store.artifacts(), "w-never"), false);
	const artifact = store.artifacts().find((entry) => entry.record?.kind === "return");
	assert.ok(artifact);
	assert.equal(store.blob(artifact.sha256), JSON.stringify(returned));
});

test("a summary is copied from the record, never generated", () => {
	const summary = summaryOf(returned);
	assert.equal(summary, "w2 done A1");
	assert.ok(summary.length <= 1024);
	const artifact = store.publish({ kind: "return", path: "src/z.ts", record: returned, bytes: "z", provenance });
	assert.equal(artifact.summary, "w2 done A1");
});

test("a claim is exclusive, and a denial names the holder", () => {
	const first = store.acquire({ path: "src/claim.ts", holder: "c/n1", intent: "write w2" });
	assert.equal(first.granted, true);

	const blocked = store.acquire({ path: "src/claim.ts", holder: "c/n2", intent: "write w3" });
	assert.equal(blocked.granted, false);
	if (blocked.granted) return;
	assert.equal(blocked.heldBy, "c/n1");
	assert.ok(blocked.expiresAt > clock);

	// Deny-don't-block: the second holder is not queued, and the first lease is untouched.
	assert.equal(store.guard("src/claim.ts", "c/n1").ok, true);
	assert.deepEqual(store.guard("src/claim.ts", "c/n2"), { ok: false, heldBy: "c/n1" });
});

test("a release hands the path over, and the guard then finds nothing to guard", () => {
	const released = store.release("src/claim.ts");
	assert.equal(released?.state, "released");
	assert.equal(store.guard("src/claim.ts", "c/n2").ok, true, "advisory means advisory: an unclaimed path writes");

	const second = store.acquire({ path: "src/claim.ts", holder: "c/n2", intent: "write w3" });
	assert.equal(second.granted, true);
});

test("the same holder re-acquiring is idempotent, not a conflict", () => {
	const first = store.acquire({ path: "src/same.ts", holder: "c/n1", intent: "write w2" });
	const again = store.acquire({ path: "src/same.ts", holder: "c/n1", intent: "write w2" });
	assert.equal(again.granted, true);
	if (!first.granted || !again.granted) return;
	assert.equal(again.claimId, first.claimId);
	assert.equal(again.renewed, true);
});

test("the sweep is the crashed-holder path, and it runs off the claim path", () => {
	const acquired = store.acquire({ path: "src/stale.ts", holder: "c/dead", intent: "write w9", ttlMs: CLAIM_TTL_MS.read });
	assert.equal(acquired.granted, true);

	assert.equal(store.sweep().length, 0, "nothing is stale yet");
	clock += CLAIM_TTL_MS.read + 1;
	const swept = store.sweep();
	assert.ok(swept.some((record) => record.path === "src/stale.ts"));
	// An expired lease blocks nobody, and the acquire after it succeeds.
	assert.equal(store.acquire({ path: "src/stale.ts", holder: "c/live", intent: "write w9" }).granted, true);
});

test("the claim decision is pure, so a dispute can be replayed without a filesystem", () => {
	const now = 1_000;
	const records = [
		{ claimId: "C1", path: "src/pure.ts", holder: "a", intent: "w", acquiredAt: 0, expiresAt: 2_000, state: "held" as const },
	];
	const denied = decideClaim(records, { path: "src/pure.ts", holder: "b", intent: "w", now });
	assert.equal(denied.granted, false);
	const afterExpiry = decideClaim(records, { path: "src/pure.ts", holder: "b", intent: "w", now: 2_001 });
	assert.equal(afterExpiry.granted, true);
	assert.equal(sweepable(records, 2_001).length, 1);
	assert.equal(sweepable(records, 1_999).length, 0);
});

test("a steer is queued, delivered at one boundary, and drained once", () => {
	const envelope = {
		steerId: "S-board-1",
		from: "orch" as const,
		to: "worker" as const,
		artifactIds: ["A1"],
		intent: "A1 assignment w2 write src/x.ts",
		words: 6,
		issuedAt: clock,
	};
	store.queueSteer(envelope);
	assert.equal(store.drainSteers("fetch", "loop-1").length, 0, "another role's boundary releases nothing");

	const delivered = store.drainSteers("worker", "loop-2");
	assert.equal(delivered.length, 1);
	assert.equal(delivered[0]?.boundary, "loop-2");
	assert.equal(store.drainSteers("worker", "loop-3").length, 0, "an envelope is delivered once");

	const rows = store.events();
	assert.ok(rows.some((event) => event.t === "steer_queued" && event.steerId === "S-board-1"));
	assert.ok(rows.some((event) => event.t === "steer_delivered" && event.boundary === "loop-2"));
});

test("every mutation writes its own row", () => {
	const kinds = new Set(store.events().map((event) => event.t));
	for (const kind of ["artifact_published", "claim_acquired", "claim_denied", "claim_released", "steer_queued", "steer_delivered"]) {
		assert.ok(kinds.has(kind as never), `missing ${kind}`);
	}
});
