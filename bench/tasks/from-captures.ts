// Turns mined pi decision points into benchmark tasks.
//
// The proxy is explicit and deliberately shallow: a session transcript is not a
// fleet snapshot, so status and idleTicks are reconstructed, not observed. What
// *is* ground truth is expectedOp — it is the mapping of what the human actually
// did next, which is the only label in this system that is not a model's opinion.
// That mapping is src/labeling/label-to-op.ts and is not defined here.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { DecisionInput, Op } from "../../src/decision/types.ts";
import { LABEL_TO_OP, type Label } from "../../src/labeling/label-to-op.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");

interface Capture {
	sessionId: string;
	sessionPath: string;
	cwd: string;
	timestamp: string;
	assistantText: string;
	toolCalls: Array<{ name: string; summary: string }>;
	toolErrors: number;
	humanText: string;
	label: Label;
	labelReason: string;
}

export interface Task {
	id: string;
	input: DecisionInput;
	expectedOp: Op;
	humanText: string;
}

const TEST_TOOL = /\b(npm|pnpm|yarn|vitest|jest|pytest|cargo test|go test|tsc|node --test)\b/;
const MUTATE_TOOL = /\b(write|edit|apply|patch|commit)\b/;
const SEARCH_TOOL = /\b(grep|glob|search|read|fetch|web)\b/;

function inferPhase(capture: Capture): string {
	const names = capture.toolCalls.map((c) => c.name.toLowerCase()).join(" ");
	const commands = capture.toolCalls.map((c) => c.summary).join(" ");
	if (TEST_TOOL.test(commands)) return "verify";
	if (MUTATE_TOOL.test(names)) return "implement";
	if (SEARCH_TOOL.test(names)) return "research";
	return "unknown";
}

/** The tail a decision model sees: what the agent ran, then what it said. */
function buildTail(capture: Capture): string {
	const calls = capture.toolCalls.slice(-6).map((c) => `> ${c.name}: ${c.summary}`);
	if (capture.toolErrors > 0) calls.push(`> ${capture.toolErrors} tool call(s) errored`);
	const spoken = capture.assistantText.slice(-1200);
	return [...calls, spoken].filter(Boolean).join("\n");
}

export function toTask(capture: Capture, index: number): Task {
	const lastCall = capture.toolCalls[capture.toolCalls.length - 1];
	const input: DecisionInput = {
		paneId: `session:${capture.sessionId.slice(0, 8)}`,
		cwd: capture.cwd,
		// The human spoke, so the turn had ended: resting is observed, not guessed.
		status: "idle",
		title: capture.assistantText.slice(0, 80).replace(/\s+/g, " ").trim() || basename(capture.cwd),
		intent: `work in ${basename(capture.cwd)}`,
		phase: inferPhase(capture),
		claimState: "working",
		last: lastCall ? `${lastCall.name}: ${lastCall.summary}` : "no tool calls this turn",
		idleTicks: 0,
		tail: buildTail(capture),
	};
	return {
		id: `dp-${String(index).padStart(4, "0")}-${capture.sessionId.slice(0, 8)}`,
		input,
		expectedOp: LABEL_TO_OP[capture.label],
		humanText: capture.humanText,
	};
}

export function convert(capturesPath = join(ROOT, "..", "mine", "out", "decision-points.jsonl"), outPath = join(ROOT, "tasks", "tasks.jsonl")): number {
	const raw = readFileSync(capturesPath, "utf8");
	const captures = raw
		.split("\n")
		.filter((line) => line.trim())
		.map((line) => JSON.parse(line) as Capture);

	const tasks = captures.map(toTask);
	mkdirSync(dirname(outPath), { recursive: true });
	writeFileSync(outPath, `${tasks.map((t) => JSON.stringify(t)).join("\n")}\n`);

	const counts = new Map<string, number>();
	for (const task of tasks) counts.set(task.expectedOp, (counts.get(task.expectedOp) ?? 0) + 1);
	console.error(`tasks: ${tasks.length} written to ${outPath}`);
	for (const [op, count] of [...counts].sort((a, b) => b[1] - a[1])) console.error(`  ${op}: ${count}`);
	return tasks.length;
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
	const out = process.argv[2];
	convert(undefined, out);
}
