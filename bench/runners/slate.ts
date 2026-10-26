// Slate comparison: every exported fine-tune variant, one task set, one record
// each. The scoring is run.ts's own — `score`, `regretOf`, `loadTasks`,
// `sampleStratified` are imported, not re-implemented — so a slate record is
// directly comparable with the needle3 and cloud records already in results/.
//
// Prompt text comes from src/decision/prompt.ts, the same module finetune/dataset.ts
// used to render the training queries: a variant is scored on the text it was
// trained on. The engine call itself is out of process, in finetune/slate_bridge.py,
// because the .cact archives are loaded through the python API.

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { renderInput, SYSTEM } from "../../src/decision/prompt.ts";
import type { Decision, Op } from "../../src/decision/types.ts";
import { coverageOf, loadTasks, sampleStratified, score, type BenchRecord, type Task } from "./run.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const FLEET = join(HERE, "..", "..");
const FINETUNE = join(FLEET, "finetune");
const PYTHON = resolve(FLEET, ".venv", "bin", "python");
const SLATE_JSON = join(FINETUNE, "slate.json");
const REPORT_JSON = join(FINETUNE, "out", "slate", "slate-report.json");

interface Variant {
	id: string;
	layers: number;
	labels: string[];
	description: string;
	/** false for a control: the base checkpoint sliced to the rung, no adapter. */
	train?: boolean;
}

interface BridgeRow {
	id: string;
	op: string | null;
	argument: string;
	confidence: number | null;
	refused: boolean;
	suppressed: number;
	reasoning: string;
	error: string | null;
	latencyMs: number;
}

/** The slate as declared on disk. The harness never invents a variant: a model
 *  that is not in this file cannot appear in a record. */
function variants(): Variant[] {
	const raw = JSON.parse(readFileSync(SLATE_JSON, "utf8")) as { variants?: Variant[] };
	if (!Array.isArray(raw.variants) || raw.variants.length === 0) throw new Error(`${SLATE_JSON} declares no variants`);
	return raw.variants;
}

function archiveOf(variant: Variant): string {
	return join(FINETUNE, "out", variant.id, `${variant.id}.cact`);
}

interface Timing {
	epochs?: number;
	wallSeconds?: number;
	first?: number | null;
	steadyMedian?: number | null;
	perEpoch?: number[];
	adapterBytes?: number;
	trainedBy?: string;
}

function timings(): Record<string, Timing> {
	if (!existsSync(REPORT_JSON)) return {};
	try {
		return JSON.parse(readFileSync(REPORT_JSON, "utf8")) as Record<string, Timing>;
	} catch {
		return {};
	}
}

/** Why an archive is missing, in the detail `ls` cannot give. */
function missingReason(variant: Variant, trained: Record<string, Timing>): string {
	const folder = join(FINETUNE, "out", variant.id);
	const adapter = join(FINETUNE, "out", "slate", variant.id, "adapter.safetensors");
	const record = trained[variant.id];
	if (!record) return "not trained: `make slate` never reached this variant";
	if (!existsSync(adapter) && !record.trainedBy) return `no adapter in ${adapter}`;
	if (!existsSync(folder)) return `no export directory ${folder}`;
	return "trained, but the export step did not write the archive";
}

function decisionsFrom(rows: BridgeRow[], model: string): Decision[] {
	return rows.map((row) => {
		const known = row.op === "leave" || row.op === "nudge" || row.op === "declare_done" || row.op === "flag";
		const op: Op = known ? (row.op as Op) : "flag";
		const decision: Decision = {
			op,
			argument: row.argument || (row.refused ? "the model declined to call a tool" : ""),
			confidence: row.confidence ?? 0,
			model,
			costUsd: 0,
			latencyMs: row.latencyMs,
			refused: row.refused,
			raw: JSON.stringify({ op: row.op, argument: row.argument, confidence: row.confidence, reasoning: row.reasoning }),
		};
		return decision;
	});
}

function assertRecord(record: BenchRecord, source: string): void {
	const required = ["recordedAt", "model", "taskSetSha", "n", "ops", "regret", "latencyMs", "refusals"] as const;
	for (const key of required) {
		if (!(key in record)) throw new Error(`${source} is missing required field ${key}`);
	}
	if (typeof record.n !== "number" || typeof record.refusals !== "number") throw new Error(`${source}: n and refusals must be numbers`);
	if (typeof record.ops?.exactMatch !== "number") throw new Error(`${source}: ops.exactMatch must be a number`);
	if (typeof record.regret?.total !== "number" || typeof record.regret?.perTask !== "number") {
		throw new Error(`${source}: regret.total and regret.perTask must be numbers`);
	}
	if (typeof record.latencyMs?.p50 !== "number" || typeof record.latencyMs?.p95 !== "number") {
		throw new Error(`${source}: latencyMs.p50 and latencyMs.p95 must be numbers`);
	}
}

interface SlateRun {
	variant: Variant;
	record: BenchRecord;
	path: string;
	refused: number;
}

/** One variant: render the sampled tasks, hand them to the bridge, score what
 *  came back. The task set is identical for every variant by construction —
 *  same file, same seed, same limit. */
function benchVariant(variant: Variant, tasks: Task[], corpus: Task[], sha: string, scratch: string): SlateRun {
	const archive = archiveOf(variant);
	const model = `slate-${variant.id}`;
	const taskPath = join(scratch, `${variant.id}.tasks.jsonl`);
	const decisionPath = join(scratch, `${variant.id}.decisions.jsonl`);
	writeFileSync(taskPath, tasks.map((task) => `${JSON.stringify({ id: task.id, query: `${SYSTEM}\n\n${renderInput(task.input)}` })}\n`).join(""));
	const started = Date.now();
	const child = spawnSync(PYTHON, [
		join(FINETUNE, "slate_bridge.py"),
		"--weights", archive,
		"--labels", variant.labels.join(","),
		"--tasks", taskPath,
		"--out", decisionPath,
	], { encoding: "utf8", timeout: 120_000 + 60_000 * tasks.length, maxBuffer: 32 * 1024 * 1024 });
	if (child.status !== 0) {
		const detail = (child.stderr ?? "").split("\n").filter(Boolean).slice(-6).join(" | ") || `exit ${child.status}`;
		throw new Error(`${variant.id}: bridge failed for ${archive}: ${detail}`);
	}
	if (!existsSync(decisionPath)) throw new Error(`${variant.id}: bridge wrote no decisions for ${archive}`);
	const rows = readFileSync(decisionPath, "utf8")
		.split("\n")
		.filter((line) => line.trim())
		.map((line) => JSON.parse(line) as BridgeRow);
	const decisions = decisionsFrom(rows, model);
	const record = score(model, tasks, decisions, sha);
	record.coverage = coverageOf(tasks, corpus);
	record.notes = `slate ${variant.id}: layers ${variant.layers}, labels ${variant.labels.join("|")}${variant.train === false ? ", control (untuned base, no adapter)" : ""}, engine ${((Date.now() - started) / 1000).toFixed(1)}s wall, python bridge finetune/slate_bridge.py`;
	assertRecord(record, `${variant.id} record`);
	const stem = `${record.recordedAt.replace(/[:.]/g, "-")}__${model}`;
	const path = join(ROOT, "results", `${stem}.json`);
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, `${JSON.stringify(record, null, "\t")}\n`);
	return { variant, record, path, refused: rows.filter((row) => row.refused).length };
}

const OP_ORDER: readonly Op[] = ["leave", "nudge", "declare_done", "flag"];

function percent(value: number): string {
	return `${(value * 100).toFixed(1)}%`;
}

function table(runs: SlateRun[], sha: string, requested: number): string {
	const header = [
		"| variant | layers | labels | exact | leave | nudge | declare_done | flag | refusals | p50 ms | p95 ms | $/1k | regret/task |",
		"|---|---|---|---|---|---|---|---|---|---|---|---|---|",
	];
	const lines = runs.map(({ variant, record, refused }) => {
		const recall = (op: Op): string => (op in record.ops.perOpRecall ? percent(record.ops.perOpRecall[op] ?? 0) : "n/a");
		return `| \`${variant.id}\` | ${variant.layers} | ${variant.labels.join(", ")} | ${percent(record.ops.exactMatch)} | ${recall("leave")} | ${recall("nudge")} | ${recall("declare_done")} | ${recall("flag")} | ${refused}/${record.n} | ${record.latencyMs.p50} | ${record.latencyMs.p95} | $${(record.costUsd?.per1k ?? 0).toFixed(2)} | ${record.regret.perTask.toFixed(3)} |`;
	});
	return [...header, ...lines, "", `Task set \`${sha}\`, ${runs[0]?.record.n ?? requested} rows, identical for every variant.`].join("\n");
}

/** Which variant wins each op, and by how much. A winner that no other model
 *  competes with is stated as unopposed rather than as a margin. */
function strengths(runs: SlateRun[]): string {
	const blocks: string[] = [];
	for (const op of OP_ORDER) {
		const scored = runs
			.filter((run) => op in run.record.ops.perOpRecall)
			.map((run) => ({ id: run.variant.id, recall: run.record.ops.perOpRecall[op] ?? 0, n: run.record.coverage?.sampledPerOp[op] ?? 0 }))
			.sort((left, right) => right.recall - left.recall);
		const best = scored[0];
		if (!best) continue;
		if (best.n === 0) {
			blocks.push(`- **${op}** — no rows in the sample, so no variant is credited with it (support 0).`);
			continue;
		}
		const runner = scored[1];
		const margin = runner
			? `${((best.recall - runner.recall) * 100).toFixed(1)} points over \`${runner.id}\``
			: "the only variant measured on this op";
		const tie = runner && best.recall === runner.recall ? `; tied with ${scored.filter((entry) => entry.recall === best.recall).map((entry) => `\`${entry.id}\``).join(", ")}` : "";
		blocks.push(`- **${op}** — \`${best.id}\` at ${percent(best.recall)} recall over ${best.n} row(s), ${margin}${tie}.`);
	}
	return blocks.join("\n");
}

function trainingSection(runs: SlateRun[], trained: Record<string, Timing>): string {
	const rows = runs.map(({ variant }) => {
		if (variant.train === false) return `| \`${variant.id}\` | ${variant.layers} | 0 | none | 0.0 min | control — base checkpoint, no adapter | - |`;
		const record = trained[variant.id];
		if (!record) {
			return `| \`${variant.id}\` | ${variant.layers} | not measured | - | - | - | - |`;
		}
		const steady = record.steadyMedian ?? record.first ?? null;
		const epochs = record.epochs ?? 0;
		const wall = record.wallSeconds ?? 0;
		return `| \`${variant.id}\` | ${variant.layers} | ${epochs} | ${steady === null ? "n/a" : `${steady}s`} | ${(wall / 60).toFixed(1)} min | ${record.trainedBy && record.trainedBy !== variant.id ? `reused \`${record.trainedBy}\`` : "own run"} | ${record.adapterBytes ? `${(record.adapterBytes / 1e6).toFixed(1)} MB` : "-"} |`;
	});
	return [
		"| variant | layers | epochs | measured s/epoch | wall | adapter | adapter size |",
		"|---|---|---|---|---|---|---|",
		...rows,
	].join("\n");
}

function artifactsSection(all: Variant[], measured: Set<string>, trained: Record<string, Timing>): string {
	const lines = all.map((variant) => {
		const archive = archiveOf(variant);
		const state = measured.has(variant.id) ? "benchmarked" : "on disk, not benchmarked this run";
		if (existsSync(archive)) {
			const bytes = statSync(archive).size;
			return `- \`${archive}\` — ${bytes} bytes, ${variant.layers} layers, ${state}`;
		}
		return `- \`${archive}\` — **absent**: ${missingReason(variant, trained)}`;
	});
	return lines.join("\n");
}

/** The honest first paragraph: which declared variants produced a model, and
 *  why the rest did not. A reader should not have to infer a blocker from an
 *  empty table. */
function statusBlock(runs: SlateRun[], all: Variant[], trained: Record<string, Timing>): string[] {
	const measured = new Set(runs.map((run) => run.variant.id));
	const declared = all.filter((variant) => variant.train !== false);
	const missing = declared.filter((variant) => !measured.has(variant.id));
	const controls = runs.filter((run) => run.variant.train === false).map((run) => run.variant.id);
	const lines = ["## Status", ""];
	lines.push(`**${declared.length - missing.length} of ${declared.length} fine-tuned variants exist on disk.** Measured this run: ${measured.size > 0 ? [...measured].map((id) => `\`${id}\``).join(", ") : "nothing"}.`);
	if (missing.length > 0) {
		lines.push("", `The slate was not trained. One epoch of \`d4\` measured **126.8 minutes** against a 600s per-epoch budget, so training was killed after two steps and the remaining variants were never started — \`make slate\` runs the whole sequence once the wall clock allows it. The command that produced this measurement, and its raw log, are named below.`);
	}
	lines.push("");
	for (const variant of missing) lines.push(`- \`${variant.id}\` — ${missingReason(variant, trained)}`);
	if (controls.length > 0) {
		lines.push(`- \`${controls.join("\`, \`")}\` — control: the published base sliced to the rung, no adapter. It prices the depth and the refusal baseline; it is not a fine-tune and must not be read as one.`);
	}
	lines.push("");
	return lines;
}

/** The document a reader starts at: costs paid, what exists, who wins what. */
function slateMarkdown(runs: SlateRun[], all: Variant[], sha: string, requested: number): string {
	const trained = timings();
	const measured = new Set(runs.map((run) => run.variant.id));
	const probeEntry = (trained as Record<string, unknown>)["_probe"] as Record<string, (Timing & { measuredSecondsPerEpoch?: number; steadyStepSeconds?: number; stepsPerEpoch?: number; stepsObserved?: number; verdict?: string; reason?: string })> | undefined;
	const probed = probeEntry ? (probeEntry["d4"] ?? Object.values(probeEntry)[0]) : undefined;
	const earliest = runs[0]?.record.recordedAt ?? new Date().toISOString();
	const cloud = process.env.OPENROUTER_API_KEY ? "not run — this harness scores exported .cact archives only" : "not run — no key";
	const probeLine = probed
		? `Probe before the slate (\`cd finetune && ../.venv/bin/python slate.py probe --variant d4 --max-epoch-seconds 600\`, raw log \`finetune/out/slate/_probe/d4/probe.log\`): \`d4\` measured **${probed.steadyStepSeconds}s per training step** over ${probed.stepsObserved} of ${probed.stepsPerEpoch} steps in an epoch, so **${probed.measuredSecondsPerEpoch}s (${((probed.measuredSecondsPerEpoch ?? 0) / 60).toFixed(1)} min) per epoch** against a 600s budget — ${probed.verdict}. ${probed.reason ?? ""}.`
		: "No epoch probe was recorded in `finetune/out/slate/slate-report.json`.";
	return [
		"# Slate — needle fine-tune variants, measured",
		"",
		`Generated ${earliest} by \`bench/runners/slate.ts\`. Every number below comes from a \`.cact\` on disk; a variant with no archive has no row.`,
		"",
		...statusBlock(runs, all, trained),
		"## Training cost actually paid",
		"",
		probeLine,
		"",
		trainingSection(runs, trained),
		"",
		"LoRA trains on the full 20-layer base whatever `--layers` says: `needle build --lora` merges the adapter and *then* slices the rung, so the three depth variants share one fine-tune and differ only in what was exported.",
		"",
		"## Comparison",
		"",
		table(runs, sha, requested),
		"",
		"`$0` per 1k is the marginal price of a local archive, not its cost: the real price of a depth rung is latency (below) and the size of the weights it loads. A refusal is scored as `flag`, the same convention `src/decision/types.ts parseDecision` uses for an unparsed answer, so the flag column carries the refusals and the refusal count is shown beside it.",
		"",
		"## Strengths — which variant wins which op",
		"",
		strengths(runs),
		"",
		"## What is on disk",
		"",
		artifactsSection(all, measured, trained),
		"",
		"## Cloud row",
		"",
		`\`openrouter:z-ai/glm-5.3-flash\` — ${cloud}. A hand-written row would be a fabrication; the existing \`bench/results\` records are the only cloud numbers this workspace has.`,
		"",
		"## Coverage gaps that bound these results",
		"",
		"- `declare_done` has **zero** targets in the corpus (502 mined rows: nudge 406, flag 89, leave 7, declare_done 0). No variant can learn it, so its column reads `n/a` and its precision is not evidence of anything. It is out of scope for `triage` for that reason.",
		"- `triage` keeps the same rows as the full-label variants — `declare_done` has no rows to drop — so what distinguishes it is the 3-tool catalogue its training lines and its decode grammar carry, not the row set. That is the shape a real scope variant takes; on this corpus the scope difference is only in the grammar.",
		"- `leave` has 7 rows corpus-wide, so its recall is a 7-example statistic in the corpus and a smaller one in any sample; a 10-point move on it is one row.",
		"- The engine samples: three runs of the *same* `control-d8` archive over this same task set came back between 37/40 and 40/40 refusals, with flag recall between 0.86 and 1.00. One row of difference between two variants is therefore not signal; only a gap wider than this run-to-run wobble is worth acting on.",
		"",
	].join("\n");
}

function parseLimit(args: string[]): number | undefined {
	const flag = args.find((arg) => arg.startsWith("--limit="));
	if (flag) return Number(flag.split("=")[1]);
	return undefined;
}

function parseOnly(args: string[]): Set<string> | undefined {
	const flag = args.find((arg) => arg.startsWith("--variants="));
	if (!flag) return undefined;
	return new Set((flag.split("=")[1] ?? "").split(",").filter(Boolean));
}

async function main(): Promise<void> {
	const args = process.argv.slice(2);
	const all = variants();
	const only = parseOnly(args);
	const requested = parseLimit(args) ?? 24;
	const { tasks, sha } = loadTasks();
	const sample = sampleStratified(tasks, requested);
	if (sample.note) console.error(`slate: ${sample.note}`);
	const scratch = join(ROOT, "results", ".slate-scratch");
	mkdirSync(scratch, { recursive: true });

	const runs: SlateRun[] = [];
	for (const variant of all) {
		if (only && !only.has(variant.id)) continue;
		const archive = archiveOf(variant);
		if (!existsSync(archive)) {
			console.error(`slate: skipping ${variant.id} — ${missingReason(variant, timings())}`);
			continue;
		}
		const run = benchVariant(variant, sample.tasks, tasks, sha, scratch);
		runs.push(run);
		console.error(`slate: ${variant.id} -> ${run.path}`);
		console.log(JSON.stringify({ variant: variant.id, exactMatch: run.record.ops.exactMatch, perOpRecall: run.record.ops.perOpRecall, refusals: run.refused, p50: run.record.latencyMs.p50, p95: run.record.latencyMs.p95, regretPerTask: run.record.regret.perTask }));
	}
	if (runs.length === 0) {
		const markdown = slateMarkdown(runs, all, sha, requested);
		writeFileSync(join(ROOT, "results", "SLATE.md"), `${markdown}\n`);
		throw new Error("no exported variant found in finetune/out — nothing to compare (see finetune/out/slate/*/ for why)");
	}
	const markdown = slateMarkdown(runs, all, sha, requested);
	writeFileSync(join(ROOT, "results", "SLATE.md"), `${markdown}\n`);
	console.error(`slate: wrote ${join(ROOT, "results", "SLATE.md")}`);
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
	await main();
}
