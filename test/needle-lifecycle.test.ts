// The sidecar is a process, so it is also an event-loop handle, and a handle that
// is never released is a host that cannot exit. These tests pin the lifecycle
// against a stub interpreter that speaks the sidecar's line protocol, so they
// cost milliseconds instead of a 5.3s model load.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { needleModel } from "../src/decision/needle.ts";
import type { DecisionInput } from "../src/decision/types.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..");

const INPUT: DecisionInput = {
	paneId: "w2C:p1",
	cwd: "/w/repo",
	status: "idle",
	title: "pi",
	intent: "pin the pure modules",
	phase: "implement",
	claimState: "working",
	last: "wrote test/detect.test.ts",
	idleTicks: 3,
	tail: "$ npm test",
};

/** Answers every request line with a grounded op, and records its pid so the
 *  test can prove the child died rather than merely disappeared from view. With a
 *  `stall` marker present it swallows requests instead, which is how a wedged
 *  decode looks from the adapter's side. */
const STUB = `import { appendFileSync, existsSync } from "node:fs";
const trace = process.env.NEEDLE_STUB_TRACE;
const stall = process.env.NEEDLE_STUB_STALL && existsSync(process.env.NEEDLE_STUB_STALL);
if (trace) appendFileSync(trace, process.pid + "\\n");
process.stdin.setEncoding("utf8");
let buffer = "";
process.stdin.on("data", (chunk) => {
	buffer += chunk;
	let index;
	while ((index = buffer.indexOf("\\n")) !== -1) {
		const line = buffer.slice(0, index);
		buffer = buffer.slice(index + 1);
		if (!line.trim()) continue;
		if (stall) continue;
		const reply = { ok: true, op: "leave", argument: "stub answer", confidence: 0.5, refused: false, latency_ms: 1 };
		process.stdout.write(JSON.stringify(reply) + "\\n");
	}
});
process.stdin.on("end", () => process.exit(0));
`;

const dirs: string[] = [];

after(() => {
	for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

interface Interpreter {
	python: string;
	trace: string;
	dir: string;
}

/** A python-shaped executable that ignores `-u <sidecar.py>` and speaks the
 *  line protocol itself, so the adapter's spawn path is the real one. */
function stubInterpreter(): Interpreter {
	const dir = mkdtempSync(join(tmpdir(), "needle-lifecycle-"));
	dirs.push(dir);
	const script = join(dir, "sidecar-stub.mjs");
	const python = join(dir, "python");
	const trace = join(dir, "spawns.log");
	writeFileSync(script, STUB);
	writeFileSync(trace, "");
	writeFileSync(python, `#!/bin/sh\nexec '${process.execPath}' '${script}' "$@"\n`);
	chmodSync(python, 0o755);
	return { python, trace, dir };
}

function pids(trace: string): number[] {
	return readFileSync(trace, "utf8")
		.split("\n")
		.filter((line) => line.trim())
		.map(Number);
}

function latestPid(trace: string): number {
	const seen = pids(trace);
	const last = seen[seen.length - 1];
	assert.ok(last !== undefined, "the sidecar stub should have recorded its pid");
	return last;
}

function alive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => {
		setTimeout(resolve, ms);
	});
}

/** SIGKILL plus reaping are not instantaneous; a killed child is briefly a zombie
 *  that still answers kill(pid, 0). */
async function waitForDeath(pid: number, budgetMs = 4_000): Promise<boolean> {
	const deadline = Date.now() + budgetMs;
	while (Date.now() < deadline) {
		if (!alive(pid)) return true;
		await delay(20);
	}
	return !alive(pid);
}

interface RunResult {
	code: number | null;
	stdout: string;
	stderr: string;
}

function runToCompletion(command: string, args: string[], env: NodeJS.ProcessEnv, budgetMs = 30_000): Promise<RunResult> {
	return new Promise((resolveRun) => {
		const child = spawn(command, args, { env });
		let stdout = "";
		let stderr = "";
		child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
			stdout += chunk;
		});
		child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
			stderr += chunk;
		});
		const watchdog = setTimeout(() => child.kill("SIGKILL"), budgetMs);
		child.on("close", (code) => {
			clearTimeout(watchdog);
			resolveRun({ code, stdout, stderr });
		});
	});
}

test("the sidecar is referenced only while a request is in flight", async () => {
	const { python, trace } = stubInterpreter();
	process.env.NEEDLE_STUB_TRACE = trace;
	const model = needleModel({ pythonPath: python, idleMs: 60_000 });
	try {
		const decision = await model.decide(INPUT);
		assert.equal(decision.op, "leave");
		assert.equal(decision.refused, false);
		const pid = latestPid(trace);
		assert.equal(alive(pid), true, "the sidecar should still be resident while idle");
	} finally {
		model.close?.();
		delete process.env.NEEDLE_STUB_TRACE;
	}
});

test("close() releases the sidecar without waiting for the idle timer", async () => {
	const { python, trace } = stubInterpreter();
	process.env.NEEDLE_STUB_TRACE = trace;
	const model = needleModel({ pythonPath: python, idleMs: 60_000 });
	try {
		await model.decide(INPUT);
		const pid = latestPid(trace);
		assert.equal(typeof model.close, "function");
		model.close?.();
		assert.equal(await waitForDeath(pid), true, "close() must reap the sidecar");
	} finally {
		model.close?.();
		delete process.env.NEEDLE_STUB_TRACE;
	}
});

test("the sidecar is reaped after idleMs with no request in flight", async () => {
	const { python, trace } = stubInterpreter();
	process.env.NEEDLE_STUB_TRACE = trace;
	const model = needleModel({ pythonPath: python, idleMs: 120 });
	try {
		await model.decide(INPUT);
		const pid = latestPid(trace);
		assert.equal(await waitForDeath(pid), true, `the idle sidecar (pid ${pid}) should be gone`);
	} finally {
		model.close?.();
		delete process.env.NEEDLE_STUB_TRACE;
	}
});

test("a decision after the idle reap spawns a fresh sidecar and still answers", async () => {
	const { python, trace } = stubInterpreter();
	process.env.NEEDLE_STUB_TRACE = trace;
	const model = needleModel({ pythonPath: python, idleMs: 120 });
	try {
		await model.decide(INPUT);
		const first = latestPid(trace);
		assert.equal(await waitForDeath(first), true, "the first sidecar should have been reaped");

		const again = await model.decide(INPUT);
		assert.equal(again.op, "leave");
		const spawns = pids(trace);
		assert.equal(spawns.length, 2, "the reap must not have left the adapter one-shot");
		const second = latestPid(trace);
		assert.notEqual(second, first);
		assert.equal(alive(second), true);
	} finally {
		model.close?.();
		delete process.env.NEEDLE_STUB_TRACE;
	}
});

test("a process that makes one decision exits on its own and orphans nothing", async () => {
	const { python, trace, dir } = stubInterpreter();
	const script = join(dir, "tick.ts");
	const adapter = join(REPO, "src", "decision", "needle.ts");
	writeFileSync(
		script,
		`import { needleModel } from '${adapter}';\n` +
			`const model = needleModel({ pythonPath: '${python}' });\n` +
			`const decision = await model.decide(${JSON.stringify(INPUT)});\n` +
			`process.stdout.write(JSON.stringify({ op: decision.op }) + "\\n");\n`,
	);

	const run = await runToCompletion(process.execPath, [script], { ...process.env, NEEDLE_STUB_TRACE: trace });
	assert.equal(run.stderr, "");
	assert.equal(run.code, 0, `a one-decision host must exit 0 by itself, got ${run.code}: ${run.stderr}`);
	assert.deepEqual(JSON.parse(run.stdout), { op: "leave" });
	const pid = latestPid(trace);
	assert.equal(await waitForDeath(pid), true, `the exited host must not leave pid ${pid} behind`);
});

test("a timed-out request kills the wedged child and the next decision respawns", async () => {
	const { python, trace, dir } = stubInterpreter();
	const stall = join(dir, "stall");
	writeFileSync(stall, "");
	process.env.NEEDLE_STUB_TRACE = trace;
	process.env.NEEDLE_STUB_STALL = stall;
	const model = needleModel({ pythonPath: python, timeoutMs: 200, idleMs: 60_000 });
	try {
		const timedOut = await model.decide(INPUT);
		assert.equal(timedOut.refused, true, "a timeout is a refusal, never an op");
		assert.equal(timedOut.argument, "sidecar error: needle timeout after 200ms");
		const dead = latestPid(trace);
		assert.equal(await waitForDeath(dead), true, "the wedged child must be killed, not reused");

		rmSync(stall, { force: true });
		const recovered = await model.decide(INPUT);
		assert.equal(recovered.op, "leave");
		assert.equal(pids(trace).length, 2, "the retry must spawn a fresh sidecar");
		assert.notEqual(latestPid(trace), dead);
	} finally {
		model.close?.();
		delete process.env.NEEDLE_STUB_TRACE;
		delete process.env.NEEDLE_STUB_STALL;
	}
});

test("close() before any decision is a no-op and later decisions still work", async () => {
	const { python, trace } = stubInterpreter();
	process.env.NEEDLE_STUB_TRACE = trace;
	const model = needleModel({ pythonPath: python, idleMs: 60_000 });
	try {
		model.close?.();
		model.close?.();
		assert.equal(pids(trace).length, 0, "close() must not spawn anything");

		const decision = await model.decide(INPUT);
		assert.equal(decision.op, "leave");
		assert.equal(pids(trace).length, 1);
	} finally {
		model.close?.();
		model.close?.();
		delete process.env.NEEDLE_STUB_TRACE;
	}
});
