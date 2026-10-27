// Label quality harness. Nothing else in this repo measures whether a corpus label
// is right: the benchmark scores models against the labels, the fine-tune trains on
// them, and both inherit whatever the miner guessed. This prints a sample a human
// can audit in about a minute — label, the evidence the miner cited, the human's own
// words, and the tail of the assistant turn that preceded it — then a tally to fill
// verdicts into.
//
// Sampling is stratified across labels and seeded, so a run is reproducible and no
// label is starved by the corpus's majority class. Small labels are always included:
// `stop` is 3 rows out of 527, and a 25-row sample that never shows one cannot tell
// you anything about the op the regret matrix prices highest.
//
// The tail is what the human was reacting to. A row whose human text continues the
// assistant's own sentence is visible as such in the three lines below it, which is
// the check that catches a "new_task" that was really a follow-up.
//
// usage: node mine/review-labels.ts [--n 25] [--seed 1] [--label instruction] [--path file]

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { LABEL_TO_OP, isLabel, type Label } from "../src/labeling/label-to-op.ts";

interface Row {
	sessionId: string;
	cwd: string;
	timestamp: string;
	assistantText: string;
	humanText: string;
	label: string;
	labelReason: string;
}

interface Args {
	path: string;
	n: number;
	seed: number;
	label: Label | undefined;
}

const DEFAULT_PATH = join(import.meta.dirname, "out", "decision-points.jsonl");
const TAIL_LINES = 3;
const TAIL_CHARS = 160;
const HUMAN_CHARS = 320;

function fail(message: string): never {
	throw new Error(message);
}

function parseArgs(argv: readonly string[]): Args {
	const args: Args = { path: DEFAULT_PATH, n: 25, seed: 1, label: undefined };
	for (let i = 0; i < argv.length; i += 1) {
		const flag = argv[i];
		const value = argv[i + 1];
		switch (flag) {
			case "--path":
				if (value === undefined) fail("--path needs a value");
				args.path = value;
				i += 1;
				break;
			case "--n": {
				if (value === undefined) fail("--n needs a value");
				const n = Number(value);
				if (!Number.isInteger(n) || n < 1) fail("--n must be a positive integer");
				args.n = n;
				i += 1;
				break;
			}
			case "--seed": {
				if (value === undefined) fail("--seed needs a value");
				const seed = Number(value);
				if (!Number.isFinite(seed)) fail("--seed must be a number");
				args.seed = seed;
				i += 1;
				break;
			}
			case "--label":
				if (value === undefined) fail("--label needs a value");
				if (!isLabel(value)) fail(`--label must be one of ${Object.keys(LABEL_TO_OP).join(", ")}`);
				args.label = value;
				i += 1;
				break;
			case "-h":
			case "--help":
				console.log("usage: node mine/review-labels.ts [--n 25] [--seed 1] [--label <name>] [--path <file>]");
				process.exit(0);
				break;
			default:
				fail(`unknown flag ${flag ?? ""}`);
		}
	}
	return args;
}

function loadRows(path: string): Row[] {
	const rows: Row[] = [];
	for (const line of readFileSync(path, "utf8").split("\n")) {
		if (!line.trim()) continue;
		const parsed: unknown = JSON.parse(line);
		if (typeof parsed !== "object" || parsed === null) fail("corpus row is not an object");
		const record = parsed as Record<string, unknown>;
		const label = typeof record["label"] === "string" ? record["label"] : "";
		// An unknown label means the corpus predates the vocabulary; say so rather
		// than counting it under some other label.
		if (!isLabel(label)) fail(`corpus row has unknown label ${JSON.stringify(label)} — re-run node mine/decision-points.ts`);
		rows.push({
			sessionId: typeof record["sessionId"] === "string" ? record["sessionId"] : "",
			cwd: typeof record["cwd"] === "string" ? record["cwd"] : "",
			timestamp: typeof record["timestamp"] === "string" ? record["timestamp"] : "",
			assistantText: typeof record["assistantText"] === "string" ? record["assistantText"] : "",
			humanText: typeof record["humanText"] === "string" ? record["humanText"] : "",
			label,
			labelReason: typeof record["labelReason"] === "string" ? record["labelReason"] : "",
		});
	}
	return rows;
}

/** mulberry32: a seed is the only way a sample is worth re-running. */
function rng(seed: number): () => number {
	let state = seed >>> 0;
	return (): number => {
		state = (state + 0x6d2b79f5) >>> 0;
		let t = state;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

function shuffled<T>(items: readonly T[], random: () => number): T[] {
	const copy = [...items];
	for (let i = copy.length - 1; i > 0; i -= 1) {
		const j = Math.floor(random() * (i + 1));
		const a = copy[i];
		const b = copy[j];
		if (a === undefined || b === undefined) continue;
		copy[i] = b;
		copy[j] = a;
	}
	return copy;
}

/** Largest-remainder allocation with a floor of one per non-empty label, so a
 *  proportional sample of 25 cannot omit a label that has 3 rows. */
function allocate(counts: ReadonlyMap<Label, number>, total: number): Map<Label, number> {
	const quotas = new Map<Label, number>();
	const populated = [...counts].filter(([, count]) => count > 0).sort((a, b) => b[1] - a[1]);
	if (populated.length === 0) return quotas;
	const corpus = populated.reduce((sum, [, count]) => sum + count, 0);
	const budget = Math.min(total, corpus);

	if (budget <= populated.length) {
		for (const [label] of populated.slice(0, budget)) quotas.set(label, 1);
		return quotas;
	}

	const remainders: Array<{ label: Label; fraction: number }> = [];
	for (const [label, count] of populated) {
		const exact = (budget * count) / corpus;
		const whole = Math.max(1, Math.floor(exact));
		quotas.set(label, Math.min(whole, count));
		remainders.push({ label, fraction: exact - Math.floor(exact) });
	}

	let assigned = [...quotas.values()].reduce((sum, value) => sum + value, 0);
	remainders.sort((a, b) => b.fraction - a.fraction);
	for (const { label } of remainders) {
		if (assigned >= budget) break;
		const current = quotas.get(label) ?? 0;
		if (current >= (counts.get(label) ?? 0)) continue;
		quotas.set(label, current + 1);
		assigned += 1;
	}

	// The floor of one can overshoot a small --n. Take the overshoot back off the
	// largest quotas so the sample is the size that was asked for.
	while (assigned > budget) {
		const largest = [...quotas]
			.filter(([, quota]) => quota > 1)
			.sort((a, b) => b[1] - a[1])[0];
		if (!largest) break;
		quotas.set(largest[0], largest[1] - 1);
		assigned -= 1;
	}
	return quotas;
}

function oneLine(text: string): string {
	return text.replace(/\s+/g, " ").trim();
}

function clip(text: string, max: number): string {
	return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/** Last non-empty lines of the turn, oldest index first. */
function tailLines(text: string): string[] {
	const lines = text
		.split("\n")
		.map((line) => line.trimEnd())
		.filter((line) => line.trim().length > 0);
	return lines.slice(-TAIL_LINES).map((line) => clip(oneLine(line), TAIL_CHARS));
}

function printRow(row: Row, position: number, sampled: number, labelTotal: number, corpus: number): void {
	const share = ((labelTotal / corpus) * 100).toFixed(1);
	console.log(`\n── ${position}/${sampled}  ${row.label.toUpperCase()}  →  ${LABEL_TO_OP[row.label as Label]}`);
	console.log(`   label   ${row.label}   (this label: ${labelTotal}/${corpus} = ${share}% of corpus)`);
	console.log(`   reason  ${row.labelReason}`);
	console.log(`   human   ${clip(oneLine(row.humanText), HUMAN_CHARS)}`);
	const tail = tailLines(row.assistantText);
	if (tail.length === 0) {
		console.log("   tail    (no assistant text this turn)");
	} else {
		tail.forEach((line, index) => console.log(`   ${index === 0 ? "tail   " : "       "} ${line}`));
	}
	console.log(`   where   ${row.sessionId.slice(0, 8)}  ${row.timestamp}  ${row.cwd}`);
}

function printTally(sampled: ReadonlyMap<Label, number>, counts: ReadonlyMap<Label, number>, corpus: number): void {
	console.log("\n── tally ────────────────────────────────────────────────────────────");
	console.log("   label            sampled  corpus  correct  wrong  unsure");
	for (const label of Object.keys(LABEL_TO_OP) as Label[]) {
		const got = sampled.get(label) ?? 0;
		if (got === 0 && (counts.get(label) ?? 0) === 0) continue;
		const pad = label.padEnd(16);
		console.log(`   ${pad}${String(got).padStart(7)}${String(counts.get(label) ?? 0).padStart(8)}    ____   ____   ____`);
	}
	const total = [...sampled.values()].reduce((sum, value) => sum + value, 0);
	console.log(`   ${"total".padEnd(16)}${String(total).padStart(7)}${String(corpus).padStart(8)}    ____   ____   ____`);
	console.log("\n   A label is wrong when the human's message is better described by another");
	console.log("   label — a follow-up filed as a new task, a question filed as a halt. Write");
	console.log("   the wrong ones down with the label you would have given; that list is the");
	console.log("   only measurement this corpus has of its own accuracy.");
}

function main(): void {
	const args = parseArgs(process.argv.slice(2));
	const rows = loadRows(args.path);
	if (rows.length === 0) fail(`no corpus rows in ${args.path}`);

	const pool = args.label === undefined ? rows : rows.filter((row) => row.label === args.label);
	if (pool.length === 0) fail(`no rows labelled ${args.label ?? ""}`);

	const counts = new Map<Label, number>();
	for (const row of rows) {
		const label = row.label as Label;
		counts.set(label, (counts.get(label) ?? 0) + 1);
	}

	const byLabel = new Map<Label, Row[]>();
	for (const row of pool) {
		const label = row.label as Label;
		const bucket = byLabel.get(label);
		if (bucket) bucket.push(row);
		else byLabel.set(label, [row]);
	}

	const quotas = args.label === undefined
		? allocate(counts, args.n)
		: new Map<Label, number>([[args.label, Math.min(args.n, pool.length)]]);
	const random = rng(args.seed);
	const sample: Row[] = [];
	for (const [label, quota] of quotas) {
		const bucket = shuffled(byLabel.get(label) ?? [], random);
		sample.push(...bucket.slice(0, quota));
	}
	// Group the printout by label so an auditor judges like against like in one pass.
	sample.sort((a, b) => (a.label === b.label ? 0 : a.label < b.label ? -1 : 1));

	console.log(`corpus: ${rows.length} rows from ${args.path}`);
	console.log(`labels: ${[...counts].map(([label, count]) => `${label} ${count}`).join("  ")}`);
	console.log(`sampling ${sample.length} rows, seed ${args.seed}${args.label === undefined ? "" : `, label=${args.label}`}`);

	const sampled = new Map<Label, number>();
	sample.forEach((row, index) => {
		const label = row.label as Label;
		sampled.set(label, (sampled.get(label) ?? 0) + 1);
		printRow(row, index + 1, sample.length, counts.get(label) ?? 0, rows.length);
	});

	printTally(sampled, counts, rows.length);
}

main();
