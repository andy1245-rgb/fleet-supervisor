// decision-points.jsonl -> needle training lines. The mined points carry a label
// and the two texts a pane showed; needle wants a query, the tool schemas, the
// exact call to emit, and one reasoning line deriving each argument from its span.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { SYSTEM, renderInput } from "../src/decision/prompt.ts";
import { OPS, type DecisionInput, type Op } from "../src/decision/types.ts";
import { LABEL_TO_OP, isLabel, type Label } from "../src/labeling/label-to-op.ts";

/** The mined label is the human's next instruction, not the op; the translation
 *  and the reasoning behind each row live in src/labeling/label-to-op.ts, which
 *  the benchmark imports too, so the corpus cannot train against a different
 *  definition of correct than the bench scores. */

/** The argument each tool takes, as declared in finetune/tools.py. */
const ARGUMENT_NAME: Readonly<Record<Op, string>> = {
	leave: "reason",
	nudge: "message",
	declare_done: "summary",
	flag: "problem",
};

interface Args {
	input: string;
	outDir: string;
	tools: string;
	valFraction: number;
	/** Cap on one rendered example in characters: system prompt + tools + state +
	 *  target. See the README's token budget for how this maps to --max-len.
	 *  1850 = the 333-token static prefix (1181 chars) plus ~670 chars of state and
	 *  target, which is what a 512-token window leaves once the prefix is paid for.
	 *  A smaller cap fits the window better, but the guard in toExample drops a row the
	 *  moment the reserved worst-case target stops fitting, so 1850 is the tightest
	 *  cap that keeps every mined point. */
	maxExampleChars: number;
	/** Cap on the terminal tail alone, before the query budget is applied. */
	maxTailChars: number;
	/** Cap on the human instruction alone (mined humanText reaches 2000 chars). */
	maxHumanChars: number;
	limit: number;
}

interface Example {
	query: string;
	tools: unknown;
	answers: { name: Op; arguments: Record<string, string> }[];
	reasoning: string;
}

interface Point {
	op: Op;
	label: Label;
	humanText: string;
	assistantText: string;
	cwd: string;
	toolCalls: string;
}

const DEFAULTS: Args = {
	input: "/home/andrew/agentFleet/mine/out/decision-points.jsonl",
	outDir: "/home/andrew/agentFleet/finetune/out",
	tools: "/home/andrew/agentFleet/finetune/out/tools.json",
	valFraction: 0.1,
	maxExampleChars: 1850,
	maxTailChars: 900,
	maxHumanChars: 320,
	limit: 0,
};

function parseArgs(argv: readonly string[]): Args {
	const args = { ...DEFAULTS };
	for (let i = 0; i < argv.length; i += 1) {
		const flag = argv[i];
		const value = argv[i + 1];
		const need = (): string => {
			if (value === undefined) throw new Error(`${flag} needs a value`);
			i += 1;
			return value;
		};
		switch (flag) {
			case "--input": args.input = need(); break;
			case "--out-dir": args.outDir = need(); break;
			case "--tools": args.tools = need(); break;
			case "--val-fraction": args.valFraction = Number(need()); break;
			case "--max-example-chars": args.maxExampleChars = Number(need()); break;
			case "--max-tail-chars": args.maxTailChars = Number(need()); break;
			case "--max-human-chars": args.maxHumanChars = Number(need()); break;
			case "--limit": args.limit = Number(need()); break;
			case "-h": case "--help":
				console.log("usage: node dataset.ts [--input path] [--out-dir dir] [--tools path]\n" +
					"                       [--val-fraction 0.1] [--max-example-chars 1850]\n" +
					"                       [--max-tail-chars 900] [--max-human-chars 320] [--limit N]");
				process.exit(0);
				break;
			default:
				throw new Error(`unknown flag ${flag ?? ""}`);
		}
	}
	if (!Number.isFinite(args.valFraction) || args.valFraction <= 0 || args.valFraction >= 1) {
		throw new Error("--val-fraction must be strictly between 0 and 1");
	}
	return args;
}

function text(value: unknown): string {
	return typeof value === "string" ? value.replace(/\s+/gu, " ").trim() : "";
}

/** Recent tool calls as one tail line: `tool(arg)` per call, so a value the model
 *  needs to quote stays in the text it can see. */
function callsLine(value: unknown): string {
	if (!Array.isArray(value)) return "";
	const parts: string[] = [];
	for (const call of value) {
		if (typeof call === "string") {
			parts.push(call);
			continue;
		}
		if (typeof call !== "object" || call === null) continue;
		const record = call as Record<string, unknown>;
		const name = text(record.name) || text(record.tool);
		if (!name) continue;
		const args = record.arguments ?? record.args;
		const rendered = typeof args === "string" ? args : JSON.stringify(args ?? {});
		parts.push(`${name}(${rendered})`);
	}
	return parts.length > 0 ? `tool calls: ${parts.join(" ")}` : "";
}

function readPoint(raw: unknown): Point | undefined {
	if (typeof raw !== "object" || raw === null) return undefined;
	const record = raw as Record<string, unknown>;
	const label = text(record.label);
	if (!isLabel(label)) return undefined;
	const humanText = text(record.humanText) || text(record.intent);
	const assistantText = text(record.assistantText) || text(record.tail);
	if (!humanText && !assistantText) return undefined;
	return {
		op: LABEL_TO_OP[label],
		label,
		humanText,
		assistantText,
		cwd: text(record.cwd) || text(record.paneId),
		toolCalls: callsLine(record.toolCalls),
	};
}

/** A prefix that never ends between the halves of a surrogate pair. The tokenizer
 *  refuses to encode a lone surrogate, so a tail cut on an emoji boundary is a row
 *  the trainer cannot read at all — one mined tail already ends mid-emoji. */
function cutPrefix(value: string, cap: number): string {
	const head = value.slice(0, cap);
	const last = head.charCodeAt(head.length - 1);
	return last >= 0xd800 && last <= 0xdbff ? head.slice(0, -1) : head;
}

/** The terminal tail: the agent's own output, plus any mined tool calls. */
function renderTail(point: Point, cap: number): string {
	const lines = [point.assistantText, point.toolCalls].filter((line) => line.length > 0);
	const joined = lines.join("\n") || "(empty)";
	return joined.length <= cap ? joined : `${cutPrefix(joined, cap)}…`;
}

/** Characters the state block spends before the instruction and the tail. */
function fixedStateChars(point: Point): number {
	return renderInput(decisionInput(point, "", 0)).length;
}

function decisionInput(point: Point, tail: string, humanCap: number): DecisionInput {
	return {
		paneId: "",
		cwd: point.cwd,
		status: point.humanText ? "working" : "idle",
		title: "",
		intent: point.humanText.length <= humanCap ? point.humanText : `${cutPrefix(point.humanText, humanCap)}…`,
		phase: "",
		claimState: "",
		last: "",
		idleTicks: 0,
		tail,
	};
}

/** A prefix of `value`, never longer than `cap`, cut on a word boundary and with
 *  no ellipsis: the engine's grounding gate checks the argument against the
 *  query text, so every character of it has to be there verbatim. */
function firstSentence(value: string, cap: number): string {
	const stop = value.search(/[.!?](\s|$)/u);
	const head = stop === -1 ? value : value.slice(0, stop + 1);
	if (head.length <= cap) return head;
	const cut = cutPrefix(head, cap);
	const space = cut.lastIndexOf(" ");
	return (space > cap * 0.6 ? cut.slice(0, space) : cut).trimEnd();
}

/** The argument, quoted from the text the query also shows: the engine's grounding
 *  gate rejects a value the input never states, and examples like these are what
 *  teach the model to keep its arguments inside the evidence. Both caps are the
 *  caps the state block renders with, so the argument is always a span of it. */
function argumentFor(point: Point, humanCap: number, tailCap: number):
	{ argument: string; span: string } | undefined {
	const tail = firstSentence(point.assistantText, tailCap);
	const goal = firstSentence(point.humanText, humanCap);
	const pick = (candidates: readonly string[]): { argument: string; span: string } | undefined => {
		for (const candidate of candidates) {
			if (candidate.length > 0) return { argument: candidate, span: candidate };
		}
		return undefined;
	};
	switch (point.op) {
		case "leave": return pick([tail, goal]);
		case "nudge": return pick([goal, tail]);
		case "declare_done": return pick([tail, goal]);
		case "flag": return pick([goal, tail]);
	}
}

const ARGUMENT_CHARS = 140;
/** Upper bound on the target: reasoning, a 140-character argument, and markers. */
const WORST_TARGET_CHARS = 340;

interface Built {
	example: Example;
	trimmed: boolean;
	size: number;
}

function toExample(point: Point, tools: unknown, args: Args): Built | { dropped: "noArgument" | "tooLong" } {
	const toolsChars = JSON.stringify(tools).length;
	// Budget with the target's worst case first, so the caps the argument is cut
	// to are the caps the state block is rendered with.
	const worst = SYSTEM.length + toolsChars + WORST_TARGET_CHARS + fixedStateChars(point);
	const variable = args.maxExampleChars - worst;
	if (variable < 120) return { dropped: "tooLong" };
	// A supervisor reads the instruction first and the agent's output second.
	let humanCap = Math.min(args.maxHumanChars, Math.max(60, Math.floor(variable * 0.4)));
	let tailCap = Math.min(args.maxTailChars, variable - humanCap);
	if (tailCap < 60) {
		humanCap = Math.max(40, variable - 60);
		tailCap = variable - humanCap;
	}
	const derived = argumentFor(point, Math.min(ARGUMENT_CHARS, humanCap),
		Math.min(ARGUMENT_CHARS, tailCap));
	if (!derived) return { dropped: "noArgument" };
	const span = derived.span.length > 60 ? `${derived.span.slice(0, 60).trimEnd()}…` : derived.span;
	const argumentName = ARGUMENT_NAME[point.op];
	const reasoning = `"${span}" -> ${argumentName}`;
	const answers = [{ name: point.op, arguments: { [argumentName]: derived.argument } }];
	// `<think>` markers, the reasoning, the call block, `</tool_call><|im_end|>`.
	const targetChars = reasoning.length + JSON.stringify(answers).length + 40;
	const state = (calls: string, cap: number): string =>
		renderInput(decisionInput({ ...point, toolCalls: calls }, renderTail(point, cap), humanCap));
	const overflowOf = (rendered: string): number =>
		SYSTEM.length + toolsChars + rendered.length + targetChars - args.maxExampleChars;
	let calls = point.toolCalls;
	let rendered = state(calls, tailCap);
	let overflow = overflowOf(rendered);
	if (overflow > 0) {
		// The mined tool-call line is the cheapest thing left to drop.
		calls = "";
		rendered = state(calls, tailCap);
		overflow = overflowOf(rendered);
	}
	if (overflow > 0) {
		tailCap = tailCap - overflow - 2;
		if (tailCap < 40) return { dropped: "tooLong" };
		rendered = state(calls, tailCap);
		overflow = overflowOf(rendered);
	}
	if (overflow > 0) return { dropped: "tooLong" };
	const trimmed = point.assistantText.length + point.toolCalls.length > tailCap ||
		point.humanText.length > humanCap || calls !== point.toolCalls;
	return {
		size: SYSTEM.length + toolsChars + rendered.length + targetChars,
		example: { query: `${SYSTEM}\n\n${rendered}`, tools, answers, reasoning },
		trimmed,
	};
}

/** FNV-1a: a split that survives a re-run, so val stays the same set across runs. */
function stableHash(value: string): number {
	let hash = 0x811c9dc5;
	for (let i = 0; i < value.length; i += 1) {
		hash ^= value.charCodeAt(i);
		hash = Math.imul(hash, 0x01000193) >>> 0;
	}
	return hash;
}

function loadTools(path: string): unknown {
	const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
	if (!Array.isArray(parsed) || parsed.length !== OPS.length) {
		throw new Error(`${path} must hold the ${OPS.length} tool schemas from finetune/tools.py`);
	}
	return parsed;
}

function writeSplit(path: string, examples: readonly Example[]): void {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, examples.map((example) => JSON.stringify(example)).join("\n") + "\n");
}

function main(argv: readonly string[]): void {
	const args = parseArgs(argv);
	let tools: unknown;
	try {
		tools = loadTools(args.tools);
	} catch (error) {
		throw new Error(`${(error as Error).message}\nrun \`make tools\` first`);
	}
	let source: string;
	try {
		source = readFileSync(args.input, "utf8");
	} catch (error) {
		throw new Error(`cannot read ${args.input} (${(error as Error).message}); the miner has not written it yet — \`make dry\` runs this converter against fixtures/sample-points.jsonl`);
	}
	const lines = source.split("\n").filter((line) => line.length > 0);
	const examples: Example[] = [];
	const seen = new Set<string>();
	const perClass: Record<Op, number> = { leave: 0, nudge: 0, declare_done: 0, flag: 0 };
	// Derived from the canonical map so a vocabulary change in label-to-op.ts
	// cannot leave a stale literal here.
	const perLabel = Object.fromEntries(Object.keys(LABEL_TO_OP).map((l) => [l, 0])) as Record<Label, number>;
	const counts = { unreadable: 0, duplicate: 0, noArgument: 0, tooLong: 0, trimmed: 0 };
	let longestExample = 0;
	for (const line of lines) {
		if (args.limit > 0 && examples.length >= args.limit) break;
		let raw: unknown;
		try {
			raw = JSON.parse(line);
		} catch {
			counts.unreadable += 1;
			continue;
		}
		const point = readPoint(raw);
		if (!point) {
			counts.unreadable += 1;
			continue;
		}
		const built = toExample(point, tools, args);
		if ("dropped" in built) {
			counts[built.dropped] += 1;
			continue;
		}
		const key = `${built.example.answers[0]?.name ?? ""}\u0000${built.example.query}`;
		if (seen.has(key)) {
			counts.duplicate += 1;
			continue;
		}
		seen.add(key);
		examples.push(built.example);
		perClass[point.op] += 1;
		perLabel[point.label] += 1;
		longestExample = Math.max(longestExample, built.size);
		if (built.trimmed) counts.trimmed += 1;
	}
	if (examples.length === 0) throw new Error(`no usable examples in ${args.input}`);

	const order = examples.map((_example, index) => index);
	const rank = new Map<number, number>();
	for (const index of order) rank.set(index, stableHash(examples[index]?.query ?? ""));
	const byHash = [...order].sort((a, b) => (rank.get(a) ?? 0) - (rank.get(b) ?? 0) || a - b);
	const valCount = Math.max(1, Math.min(Math.round(examples.length * args.valFraction), examples.length - 1));
	const valIndexes = new Set(byHash.slice(0, valCount));
	const train = examples.filter((_example, index) => !valIndexes.has(index));
	const val = examples.filter((_example, index) => valIndexes.has(index));
	writeSplit(join(args.outDir, "train.jsonl"), train);
	writeSplit(join(args.outDir, "val.jsonl"), val);

	const total = examples.length;
	const row = (name: string, body: string): void => console.log(`  ${name.padEnd(9)} ${body}`);
	row("input", args.input);
	row("read", `${lines.length} lines -> ${total} examples  (train ${train.length} / val ${val.length})`);
	row("classes", OPS.map((op) => `${op} ${perClass[op]}`).join("  "));
	row("labels", (Object.keys(perLabel) as Label[]).map((label) => `${label}:${LABEL_TO_OP[label]} ${perLabel[label]}`).join("  "));
	row("size", `longest example ${longestExample} chars, cap ${args.maxExampleChars}  (~${Math.round(longestExample / 3)} tokens at 3 chars/token)`);
	const skipped = Object.entries(counts).filter(([, n]) => n > 0);
	if (skipped.length > 0) row("skipped", skipped.map(([name, n]) => `${name} ${n}`).join("  "));
	row("wrote", `${join(args.outDir, "train.jsonl")}  ${join(args.outDir, "val.jsonl")}`);
}

main(process.argv.slice(2));
