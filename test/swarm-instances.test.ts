// The process model, enforced: one process per profile, and one archive per process.
//
// `needle_init` installs the grammar as process-global state and a second call replaces
// the first, so a shared process is not a slow configuration — it is a configuration
// whose second profile answers with the first profile's archive and grammar. These
// tests use both a fake engine (to prove the registry refuses reuse by pid) and a real
// child process (to prove a release leaves no orphan), because the second is the only
// claim a comment cannot make.

import assert from "node:assert/strict";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import type { ProfileEngine } from "../src/swarm/engine.ts";
import { stdioEngine } from "../src/swarm/engine.ts";
import { GrammarConflict, InstanceRegistry, createInstances } from "../src/swarm/instances.ts";
import { INSTANCES } from "../src/swarm/types.ts";
import { ProfileProcess, ProfileUnavailable } from "../src/swarm/process.ts";
import { refusal, type ProfileReply } from "../src/swarm/types.ts";

let nextPid = 7_000;

function waitReply(confidence = 0.4): ProfileReply {
	return { op: "wait", args: {}, confidence, refused: false, suppressed: 0, latencyMs: 1 };
}

function fakeEngine(reply: ProfileReply = waitReply(), pid = (nextPid += 1)): ProfileEngine {
	return {
		kind: "fake",
		pid,
		async ask(): Promise<ProfileReply> {
			return reply;
		},
		close(): void {
			/* no handles to drop */
		},
	};
}

test("the shipped set is six engine processes for five profiles", () => {
	// Five profiles, six processes: the orchestrator's two catalogues are two processes,
	// because the tool set is fixed at `needle_init` (§1.5, §3.4).
	assert.equal(INSTANCES.length, 6);
	assert.deepEqual([...INSTANCES].sort(), ["fetch", "hi", "orch.inner", "orch.leaf", "search", "worker"]);
});

test("one process cannot host two profiles", () => {
	const registry = new InstanceRegistry();
	const shared = fakeEngine();
	registry.bind("worker", new ProfileProcess({ instance: "worker", spawn: () => shared, idleMs: 0 }));

	const second = new ProfileProcess({ instance: "fetch", spawn: () => shared, idleMs: 0 });
	assert.throws(
		() => registry.bind("fetch", second),
		(error: unknown) => error instanceof GrammarConflict && /needle_init is process-global/.test(error.message),
	);
	// The registry binds nothing on failure, so the duplicate is not half-registered and the
	// process that is legitimately hosting `worker` is untouched.
	assert.deepEqual(registry.instances(), ["worker"]);
});

test("the engine child counts as a process of its own", () => {
	// A tuned archive's weights live in a child of the sidecar (`Needle(weights=path)`
	// forks it), so two sidecars sharing one engine child are the same conflict as two
	// profiles in one process — the second `needle_init` would replace the first's grammar.
	const registry = new InstanceRegistry();
	const child = { kind: "fake", pid: 7_500, enginePid: 7_501, async ask() { return waitReply(); }, close(): void {} };
	registry.bind("worker", new ProfileProcess({ instance: "worker", spawn: () => child, idleMs: 0 }));
	const sharedChild = { kind: "fake", pid: 7_600, enginePid: 7_501, async ask() { return waitReply(); }, close(): void {} };
	assert.throws(
		() => registry.bind("fetch", new ProfileProcess({ instance: "fetch", spawn: () => sharedChild, idleMs: 0 })),
		(error: unknown) => error instanceof GrammarConflict && /pid 7501/.test(error.message),
	);
});

test("the orchestrator's two catalogues are two processes", () => {
	const registry = new InstanceRegistry();
	const shared = fakeEngine();
	registry.bind("orch.leaf", new ProfileProcess({ instance: "orch.leaf", spawn: () => shared, idleMs: 0 }));
	assert.throws(
		() => registry.bind("orch.inner", new ProfileProcess({ instance: "orch.inner", spawn: () => shared, idleMs: 0 })),
		GrammarConflict,
	);

	const other = new InstanceRegistry();
	other.bind("orch.leaf", new ProfileProcess({ instance: "orch.leaf", spawn: () => fakeEngine(), idleMs: 0 }));
	other.bind("orch.inner", new ProfileProcess({ instance: "orch.inner", spawn: () => fakeEngine(), idleMs: 0 }));
	assert.deepEqual([...other.instances()].sort(), ["orch.inner", "orch.leaf"]);
});

test("a process bound twice for the same instance is refused, and a foreign instance is refused", () => {
	const registry = new InstanceRegistry();
	const process = new ProfileProcess({ instance: "worker", spawn: () => fakeEngine(), idleMs: 0 });
	registry.bind("worker", process);
	assert.throws(() => registry.bind("worker", new ProfileProcess({ instance: "worker", spawn: () => fakeEngine(), idleMs: 0 })), GrammarConflict);
	assert.throws(() => registry.bind("fetch", process), GrammarConflict);
	assert.equal(registry.healthy("worker"), true);
	assert.equal(registry.healthy("fetch"), false, "an absent instance is unhealthy, never invented");
});

test("a real child process is killed by release", async () => {
	const script = [
		'let buf = "";',
		'process.stdin.on("data", (chunk) => {',
		"  buf += chunk;",
		'  let i;',
		'  while ((i = buf.indexOf("\\n")) !== -1) {',
		"    buf = buf.slice(i + 1);",
		'    process.stdout.write(JSON.stringify({ op: "wait", args: {}, confidence: 0.5, refused: false, suppressed: 0 }) + "\\n");',
		"  }",
		"});",
	].join("\n");
	const engine = stdioEngine(process.execPath, ["-e", script], { timeoutMs: 5_000 });
	const process_ = new ProfileProcess({ instance: "fetch", spawn: () => engine, idleMs: 0 });
	process_.start();
	const pid = process_.pid();
	assert.ok(typeof pid === "number" && pid > 0);

	const reply = await process_.ask({ system: "system", state: "state" });
	assert.equal(reply.op, "wait");
	assert.equal(reply.refused, false);

	process_.release("test");
	// SIGKILL is asynchronous; the only honest assertion is that the pid is gone shortly.
	let alive = true;
	for (let attempt = 0; attempt < 40 && alive; attempt += 1) {
		await delay(25);
		try {
			process.kill(pid, 0);
		} catch {
			alive = false;
		}
	}
	assert.equal(alive, false, "release must leave no engine process behind");
});

test("a wedged decode is a timeout, and three of them make the instance unhealthy", async () => {
	const wedged: ProfileEngine = {
		kind: "fake",
		pid: 9_001,
		ask: () => new Promise<ProfileReply>(() => undefined),
		close(): void {
			/* nothing */
		},
	};
	const process_ = new ProfileProcess({
		instance: "worker",
		spawn: () => wedged,
		timeoutMs: 20,
		backoffMs: [5],
		maxConsecutiveFailures: 3,
		idleMs: 0,
	});
	process_.start();

	await assert.rejects(() => process_.ask({ system: "s", state: "a" }), (error: unknown) => {
		return error instanceof ProfileUnavailable && error.cause === "timeout";
	});
	// Two more failures, and the instance stops pretending it can answer.
	for (let attempt = 0; attempt < 2; attempt += 1) {
		await delay(10);
		await assert.rejects(() => process_.ask({ system: "s", state: "a" }));
	}
	assert.equal(process_.healthOf(), "unhealthy");
	assert.equal(process_.stats().consecutiveFailures, 3);
	assert.ok(process_.restartInMs() > 0);
	// A crash is unavailable, never a fabricated `leave`: the next caller is refused at once.
	await assert.rejects(() => process_.ask({ system: "s", state: "a" }), ProfileUnavailable);
});

test("the queue is per instance: two requests never interleave", async () => {
	let call = 0;
	const ordered: ProfileEngine = {
		kind: "fake",
		pid: 9_100,
		async ask(): Promise<ProfileReply> {
			const index = call;
			call += 1;
			// The first request finishes last if the queue is broken.
			await delay(index === 0 ? 25 : 0);
			return index === 0 ? waitReply(0.9) : { op: "step", args: { item: "w2", tool: "read" }, confidence: 0.2, refused: false, suppressed: 0, latencyMs: 1 };
		},
		close(): void {
			/* nothing */
		},
	};
	const process_ = new ProfileProcess({ instance: "worker", spawn: () => ordered, idleMs: 0 });
	process_.start();
	const [first, second] = await Promise.all([
		process_.ask({ system: "s", state: "a" }),
		process_.ask({ system: "s", state: "b" }),
	]);
	assert.equal(first.op, "wait");
	assert.equal(second.op, "step");
});

test("createInstances binds only what it is given, and closing releases everything", () => {
	const registry = createInstances({ worker: () => fakeEngine(), "orch.leaf": () => fakeEngine() }, { idleMs: 0 });
	assert.deepEqual([...registry.instances()].sort(), ["orch.leaf", "worker"]);
	assert.equal(registry.get("fetch"), undefined);
	registry.close();
	assert.deepEqual(registry.instances(), []);
	assert.throws(() => registry.require("worker"), GrammarConflict);
});

test("a dead engine that refuses everything is still a reply, not an exit", async () => {
	const process_ = new ProfileProcess({ instance: "search", spawn: () => fakeEngine(refusal(3)), idleMs: 0 });
	process_.start();
	const reply = await process_.ask({ system: "s", state: "a" });
	assert.equal(reply.refused, true);
	assert.equal(process_.healthOf(), "ready", "a refusal is a decision; the process is fine");
});
