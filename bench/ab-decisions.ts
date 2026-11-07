// STEP 5: the same fixture through both decision paths, side by side.
//
//   node bench/ab-decisions.ts
//
// One input, two modes, real calls. Prints the chosen op, whether the text parsed,
// tokens, cost and latency for each, and the deltas. No live pane, no prompt.

import { readFileSync } from "node:fs";
import { commandcodeModel } from "../src/decision/adapters/commandcode.ts";
import { piModel } from "../src/decision/pi.ts";
import type { DecisionInput } from "../src/decision/types.ts";

const input = JSON.parse(readFileSync(new URL("./fixtures/decision-input-idle.json", import.meta.url), "utf8")) as DecisionInput;

interface Row {
	mode: string;
	op: string;
	refused: boolean;
	validJson: boolean;
	confidence: number;
	promptTokens: number;
	completionTokens: number;
	reasoningTokens: number;
	costUsd: number;
	latencyMs: number;
	wallMs: number;
	argument: string;
}

async function adapter(): Promise<Row> {
	const model = commandcodeModel({ model: "deepseek/deepseek-v4.1-flash", effort: "low", timeoutMs: 90_000 });
	const started = Date.now();
	const d = await model.decide(input);
	const ran = Date.now() - started;
	return {
		mode: "adapter",
		op: d.op,
		refused: d.refused,
		validJson: d.raw.trim().startsWith("{"),
		confidence: d.confidence,
		promptTokens: d.accounting.promptTokens,
		completionTokens: d.accounting.completionTokens,
		reasoningTokens: d.accounting.reasoningTokens,
		costUsd: d.costUsd,
		latencyMs: d.latencyMs,
		wallMs: ran,
		argument: d.argument,
	};
}

async function pi(): Promise<Row> {
	const model = piModel({ timeoutMs: 45_000 });
	const started = Date.now();
	const d = await model.decide(input);
	const ran = Date.now() - started;
	return {
		mode: "pi",
		op: d.op,
		refused: d.refused,
		validJson: d.raw.trim().startsWith("{"),
		confidence: d.confidence,
		promptTokens: d.accounting.promptTokens,
		completionTokens: d.accounting.completionTokens,
		reasoningTokens: d.accounting.reasoningTokens,
		costUsd: d.costUsd,
		latencyMs: d.latencyMs,
		wallMs: ran,
		argument: d.argument,
	};
}

const rows: Row[] = [];
for (const run of [adapter, pi]) {
	try {
		rows.push(await run());
	} catch (e) {
		console.error(`${run.name} threw: ${(e as Error).message}`);
	}
}

for (const row of rows) {
	console.log(
		`${row.mode.padEnd(8)} op=${row.op.padEnd(13)} json=${row.validJson ? "valid" : "INVALID"} refused=${row.refused} conf=${row.confidence.toFixed(2)} in=${String(row.promptTokens).padStart(4)} out=${String(row.completionTokens).padStart(3)} rsn=${String(row.reasoningTokens).padStart(3)} cost=$${row.costUsd.toFixed(6)} latency=${String(row.latencyMs).padStart(4)}ms wall=${String(row.wallMs).padStart(4)}ms`,
	);
	console.log(`         "${row.argument.slice(0, 150)}"`);
}
console.log(JSON.stringify(rows, null, "\t"));
