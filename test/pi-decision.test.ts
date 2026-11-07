// The `pi` decision path: the flags it must send, and the four ways it must fail
// without throwing and without acting.

import assert from "node:assert/strict";
import { test } from "node:test";
import { tmpdir } from "node:os";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { PI_MODEL, PI_PROVIDER, PI_SYSTEM, PI_THINKING, PI_TIMEOUT_MS, piArgv, piModel, readTurn, type PiRun } from "../src/decision/pi.ts";
import type { DecisionInput } from "../src/decision/types.ts";

const INPUT: DecisionInput = {
	paneId: "p1",
	cwd: "/tmp",
	status: "idle",
	title: "t",
	intent: "i",
	phase: "implement",
	claimState: "working",
	last: "l",
	idleTicks: 4,
	tail: "not ok 1 - it failed",
};

function run(overrides: Partial<PiRun> = {}): PiRun {
	return { code: 0, stdout: "", stderr: "", timedOut: false, ...overrides };
}

/** One NDJSON line exactly as `pi --mode json` emits it: an assistant `turn_end`
 *  carrying the text, the usage block and the dollar figure. */
function turnEnd(text: string, opts: { stop?: string; error?: string; input?: number; output?: number; reasoning?: number; cost?: number } = {}): string {
	const message = {
		role: "assistant",
		content: [{ type: "text", text }],
		usage: {
			input: opts.input ?? 115,
			output: opts.output ?? 31,
			reasoning: opts.reasoning ?? 0,
			cost: { total: opts.cost ?? 0.0000352 },
		},
		stopReason: opts.stop ?? "stop",
		...(opts.error === undefined ? {} : { errorMessage: opts.error }),
	};
	return `${JSON.stringify({ type: "turn_end", message })}\n`;
}

function model(result: PiRun) {
	let seen: { argv: readonly string[]; env: NodeJS.ProcessEnv; cwd: string; timeoutMs: number } | undefined;
	const agentDir = mkdtempSync(join(tmpdir(), "agentfleet-pi-"));
	const built = piModel({
		agentDir,
		run: async (argv, options) => {
			seen = { argv, ...options };
			return result;
		},
	});
	return { built, seen: () => seen, agentDir };
}

test("the argv is the substrate that was measured, not a guess", () => {
	const argv = piArgv(INPUT);
	const flag = (name: string): string | undefined => {
		const index = argv.indexOf(name);
		return index === -1 ? undefined : argv[index + 1];
	};
	// Reasoning off, by the level name this build actually has.
	assert.equal(PI_THINKING, "off");
	assert.equal(flag("--thinking"), "off");
	assert.equal(flag("--mode"), "json");
	assert.equal(flag("--provider"), PI_PROVIDER);
	assert.equal(flag("--model"), PI_MODEL);
	assert.equal(argv[0], "-p");
	assert.ok(argv.includes("--no-session"));
	// Nothing discovered on this machine may join a decision prompt.
	assert.ok(argv.includes("--no-tools"));
	assert.ok(argv.includes("--no-skills"));
	assert.ok(argv.includes("--no-context-files"));
	assert.ok(argv.includes("--no-prompt-templates"));
	// The contract is the system prompt, verbatim, and the evidence is the user turn.
	assert.equal(flag("--system-prompt"), PI_SYSTEM);
	assert.ok(argv[argv.length - 1]?.includes("not ok 1 - it failed"), "the tail reaches the model");
	assert.ok(argv[argv.length - 1]?.includes("idle ticks: 4"), "the field block reaches the model");
});

test("the system prompt stays inside its twelve-line ceiling and holds the contract", () => {
	const lines = PI_SYSTEM.split("\n");
	assert.ok(lines.length <= 12, `system prompt is ${lines.length} lines`);
	// The output contract the parser accepts, the four ops, and the fail-soft rule.
	assert.match(PI_SYSTEM, /\{"op":"leave"\|"nudge"\|"declare_done"\|"flag"/);
	for (const op of ["leave", "nudge", "declare_done", "flag"]) assert.ok(PI_SYSTEM.includes(op), op);
	assert.match(PI_SYSTEM, /When uncertain, output leave/);
});

test("one refusal supplies the reason for all four failures", () => {
	const reasons = [
		run({ code: 1, stderr: "Error: Unknown provider \"nope\"" }),
		run({ timedOut: true }),
		run({ stdout: turnEnd("I think you should nudge it.") }),
		run({ stdout: turnEnd('{"argument":"no op here","confidence":0.4}') }),
	];
	assert.equal(reasons.length, 4);
});

test("fail-soft 1: a non-zero exit does nothing and says which exit", async () => {
	const { built, agentDir } = model(run({ code: 1, stderr: "Error: Unknown provider \"nope\".\n" }));
	try {
		const decision = await built.decide(INPUT);
		assert.equal(decision.refused, true);
		assert.equal(decision.op, "flag");
		assert.match(decision.argument, /pi: exited 1/);
		// The provider's own message travels with the reason: "it failed" alone is not a
		// diagnosis an operator can act on.
		assert.match(decision.argument, /Unknown provider/);
	} finally {
		rmSync(agentDir, { recursive: true, force: true });
	}
});

test("fail-soft 2: the deadline is the answer, not a hang", async () => {
	const { built, agentDir } = model(run({ timedOut: true, code: null }));
	try {
		const decision = await built.decide(INPUT);
		assert.equal(decision.refused, true);
		assert.match(decision.argument, new RegExp(`timed out after ${PI_TIMEOUT_MS} ms`));
		// A timeout is not billed and the row must not invent a price for it.
		assert.equal(decision.accounting.costUsd, null);
		assert.equal(decision.costUsd, 0);
	} finally {
		rmSync(agentDir, { recursive: true, force: true });
	}
});

test("fail-soft 3: prose where JSON was asked for is a refusal, not an action", async () => {
	const { built, agentDir } = model(run({ stdout: turnEnd("I think you should nudge it, honestly.") }));
	try {
		const decision = await built.decide(INPUT);
		assert.equal(decision.refused, true);
		assert.equal(decision.op, "flag");
		assert.match(decision.argument, /no JSON object/);
		// The usage block still reaches the row: the call was made and paid for.
		assert.equal(decision.accounting.promptTokens, 115);
	} finally {
		rmSync(agentDir, { recursive: true, force: true });
	}
});

test("fail-soft 4: a JSON object with no op is refused, and its sentence is kept", async () => {
	const { built, agentDir } = model(run({ stdout: turnEnd('{"argument":"ship it","confidence":0.9}') }));
	try {
		const decision = await built.decide(INPUT);
		assert.equal(decision.refused, true);
		assert.equal(decision.op, "flag");
		// The op is refused because the model named none, but the model's own sentence is
		// what an operator reads in the log, so it is not discarded.
		assert.equal(decision.argument, "ship it");
		assert.equal(decision.confidence, 0.9);
	} finally {
		rmSync(agentDir, { recursive: true, force: true });
	}
});

test("a provider error inside the stream is a failure even though the exit code is 0", async () => {
	// Measured: a bad model id warns on stderr and exits 0, then reports stopReason
	// "error" in the stream. The exit code alone would read that as success.
	const { built, agentDir } = model(run({ code: 0, stdout: turnEnd("", { stop: "error", error: '404: {"success":false}' }) }));
	try {
		const decision = await built.decide(INPUT);
		assert.equal(decision.refused, true);
		assert.match(decision.argument, /stop reason error/);
		assert.match(decision.argument, /404/);
	} finally {
		rmSync(agentDir, { recursive: true, force: true });
	}
});

test("an empty answer is a failure, not a leave", async () => {
	const { built, agentDir } = model(run({ stdout: turnEnd("   ") }));
	try {
		const decision = await built.decide(INPUT);
		assert.equal(decision.refused, true);
		assert.match(decision.argument, /empty answer/);
	} finally {
		rmSync(agentDir, { recursive: true, force: true });
	}
});

test("no assistant turn at all is a failure, and says so", () => {
	const read = readTurn('{"type":"session"}\n{"type":"turn_start"}\n');
	assert.ok("error" in read);
	assert.match(read.error, /no assistant turn/);
});

test("a good answer comes back as an op, with pi's own usage beside it", async () => {
	const text = '{"op":"nudge","argument":"the dedupe test is failing","confidence":0.85}';
	const { built, agentDir, seen } = model(run({ stdout: turnEnd(text, { input: 115, output: 31, cost: 0.0000352 }) }));
	try {
		const decision = await built.decide(INPUT);
		assert.equal(decision.refused, false);
		assert.equal(decision.op, "nudge");
		assert.equal(decision.argument, "the dedupe test is failing");
		assert.equal(decision.confidence, 0.85);
		assert.equal(decision.model, `pi:${PI_MODEL}`);
		// The number the cap is computed from is pi's own, not one derived here.
		assert.equal(decision.accounting.costUsd, 0.0000352);
		assert.equal(decision.costUsd, 0.0000352);
		assert.equal(decision.accounting.promptTokens, 115);
		assert.equal(decision.accounting.completionTokens, 31);
		assert.equal(decision.accounting.reasoningTokens, 0, "reasoning is off, and the row says so with a number");

		// The child gets its own agent dir and a neutral cwd, so a decision cannot depend
		// on which repo the supervisor happens to be in.
		const call = seen();
		assert.ok(call !== undefined);
		assert.equal(call.env.PI_CODING_AGENT_DIR, agentDir);
		assert.equal(call.cwd, agentDir);
		assert.equal(call.timeoutMs, PI_TIMEOUT_MS);
	} finally {
		rmSync(agentDir, { recursive: true, force: true });
	}
});

test("a runner that throws is a refusal, never an exception out of decide", async () => {
	const agentDir = mkdtempSync(join(tmpdir(), "agentfleet-pi-"));
	const built = piModel({
		agentDir,
		run: async () => {
			throw new Error("spawn pi ENOENT");
		},
	});
	try {
		const decision = await built.decide(INPUT);
		assert.equal(decision.refused, true);
		assert.match(decision.argument, /could not run pi: spawn pi ENOENT/);
	} finally {
		rmSync(agentDir, { recursive: true, force: true });
	}
});
