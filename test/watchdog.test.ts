import assert from "node:assert/strict";
import { test } from "node:test";
import { classify, RULES, sampleProcesses } from "../src/watchdog/rules.ts";
import type { CommandSample, Rule } from "../src/watchdog/rules.ts";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

function sample(overrides: Partial<CommandSample> = {}): CommandSample {
	return {
		pid: 4242,
		ppid: 1,
		cpuMs: 0,
		elapsedMs: 0,
		command: "sleep 600",
		ancestors: ["bash"],
		foreground: true,
		...overrides,
	};
}

function build(elapsedMs: number): CommandSample {
	return sample({ command: "npm run build", ancestors: ["bash"], foreground: true, elapsedMs });
}

test("an inference server is never flagged however old", () => {
	for (const command of [
		"/home/operator/llama.cpp/build/bin/llama-server -m model.gguf",
		"llama-server --port 8080",
		"/usr/local/bin/vllm serve /models/thing",
	]) {
		const verdict = classify(sample({ command, elapsedMs: 365 * 24 * HOUR }));
		assert.equal(verdict.rule, "inference-server", command);
		assert.equal(verdict.flagged, false, command);
		assert.equal(verdict.stalled, undefined, command);
	}
});

test("an idle bare shell is never flagged", () => {
	for (const command of ["bash", "zsh", "/usr/bin/sh", "/bin/fish"]) {
		const verdict = classify(sample({ command, elapsedMs: 30 * 24 * HOUR }));
		assert.equal(verdict.rule, "idle-shell", command);
		assert.equal(verdict.flagged, false, command);
	}
});

test("a background service with no tty and no agent ancestor is never flagged", () => {
	const verdict = classify(
		sample({
			command: "python3 /opt/svc/worker.py",
			ancestors: ["systemd", "init"],
			foreground: false,
			elapsedMs: 24 * HOUR,
		}),
	);

	assert.equal(verdict.rule, "background-service");
	assert.equal(verdict.flagged, false);
	assert.equal(verdict.stalled, undefined);
});

test("a foreground process with no agent ancestor is still a command", () => {
	const verdict = classify(sample({ command: "python3 /opt/svc/worker.py", ancestors: [], foreground: true, elapsedMs: 6 * MINUTE }));

	assert.equal(verdict.rule, "command");
	assert.equal(verdict.flagged, true);
});

test("a build is unflagged at 15m and flagged at 21m", () => {
	const early = classify(build(15 * MINUTE));
	assert.equal(early.rule, "build");
	assert.equal(early.flagged, false);

	const late = classify(build(21 * MINUTE));
	assert.equal(late.rule, "build");
	assert.equal(late.flagged, true);
});

test("an unknown foreground command is unflagged at 4m and flagged at 6m", () => {
	const early = classify(sample({ elapsedMs: 4 * MINUTE }));
	assert.equal(early.rule, "command");
	assert.equal(early.flagged, false);

	const late = classify(sample({ elapsedMs: 6 * MINUTE }));
	assert.equal(late.rule, "command");
	assert.equal(late.flagged, true);
});

test("the age boundary is exclusive at exactly maxAgeMs", () => {
	assert.equal(classify(build(20 * MINUTE)).flagged, false);
	assert.equal(classify(build(20 * MINUTE + 1)).flagged, true);
	assert.equal(classify(sample({ elapsedMs: 5 * MINUTE })).flagged, false);
	assert.equal(classify(sample({ elapsedMs: 5 * MINUTE + 1 })).flagged, true);
});

test("classify is first-match: a llama path wins over the build rule", () => {
	const verdict = classify(sample({ command: "llama-bench -m model.gguf -p 512", elapsedMs: 12 * HOUR }));

	assert.equal(verdict.rule, "inference-server");
	assert.equal(verdict.flagged, false);
});

test("classify is first-match: an infrastructure process is not judged as a command", () => {
	const verdict = classify(sample({ command: "sshd: user@pts/3", ancestors: ["sshd"], foreground: true, elapsedMs: 12 * HOUR }));

	assert.equal(verdict.rule, "infrastructure");
	assert.equal(verdict.flagged, false);
});

test("classify is first-match: an agent that retitled its own process is never flagged", () => {
	// Retitled: no path in the command line, but node is an ancestor.
	const verdict = classify(sample({ command: "summarize the fleet", ancestors: ["node", "bash"], foreground: true, elapsedMs: 12 * HOUR }));

	assert.equal(verdict.rule, "agent-tui");
	assert.equal(verdict.flagged, false);
});

test("a foreground command with no agent ancestor falls through to the command rule", () => {
	const verdict = classify(sample({ command: "anything at all", ancestors: ["bash"], foreground: true, elapsedMs: 10 * HOUR }));

	assert.equal(verdict.rule, "command");
	assert.equal(verdict.flagged, true);
});

test("a custom rule table is honoured", () => {
	const only: Rule[] = [{ id: "never", why: "test rule", maxAgeMs: Number.POSITIVE_INFINITY, match: () => true }];
	const verdict = classify(sample({ elapsedMs: 10 * HOUR }), only);

	assert.equal(verdict.rule, "never");
	assert.equal(verdict.flagged, false);
});

test("an empty rule table flags nothing instead of throwing", () => {
	const ancient = sample({ elapsedMs: 30 * 24 * HOUR, cpuMs: 5000 });

	assert.doesNotThrow(() => classify(ancient, [], 5000));

	const verdict = classify(ancient, [], 5000);
	assert.equal(verdict.flagged, false);
	assert.equal(verdict.rule, "no-rule");
	assert.equal(verdict.why, "no rule matched this process");
	assert.equal(verdict.stalled, undefined);
});

test("stalled is true below 100ms of CPU progress on a flagged process", () => {
	const stuck = sample({ elapsedMs: 6 * MINUTE, cpuMs: 5000 });

	const hardlyMoved = classify(stuck, RULES, 4950);
	assert.equal(hardlyMoved.flagged, true);
	assert.equal(hardlyMoved.stalled, true);

	const frozen = classify(stuck, RULES, 5000);
	assert.equal(frozen.stalled, true);
});

test("stalled is false once the process made 100ms or more of progress", () => {
	const busy = sample({ elapsedMs: 6 * MINUTE, cpuMs: 5000 });

	assert.equal(classify(busy, RULES, 4900).stalled, false);
	assert.equal(classify(busy, RULES, 4000).stalled, false);
});

test("stalled is only reported for a flagged process", () => {
	const calm = sample({ elapsedMs: 1 * MINUTE, cpuMs: 5000 });
	const verdict = classify(calm, RULES, 5000);

	assert.equal(verdict.flagged, false);
	assert.equal(verdict.stalled, undefined);
});

test("stalled is not reported when no previous sample was supplied", () => {
	const verdict = classify(build(21 * MINUTE));

	assert.equal(verdict.flagged, true);
	assert.equal(verdict.stalled, undefined);
});

test("sampleProcesses returns real samples from /proc", () => {
	const samples = sampleProcesses();

	assert.ok(samples.length > 0, "expected at least one process");
	assert.ok(
		samples.some((s) => typeof s.pid === "number" && Number.isInteger(s.pid) && s.pid > 0),
		"expected at least one sample with a numeric pid",
	);
	for (const entry of samples) {
		assert.ok(Number.isInteger(entry.pid), `pid ${entry.pid} should be an integer`);
		assert.equal(typeof entry.command, "string");
		assert.ok(Number.isFinite(entry.cpuMs));
		assert.ok(Number.isFinite(entry.elapsedMs));
		assert.ok(Array.isArray(entry.ancestors));
	}
});
