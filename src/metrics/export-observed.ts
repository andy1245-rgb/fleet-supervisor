// Turn judged outcomes into candidate bench rows, the way from-captures.ts turns
// transcripts into rows. Same row shape, one extra key: `provenance: "observed"`.
//
// WHAT THIS IS: correlation, not causation. A judged outcome says what the fleet
// looked like some ticks after a decision; it does not say why the pane moved or
// did not. An agent may move after a nudge because the nudge worked, because the
// turn it was already in finished, because a test runner returned, or because a
// human typed into the pane. Nothing here observes a reason, so a nudge followed
// by movement can never become a positive label — that direction is
// unidentifiable, and no row this file writes claims it.
//
// WHAT IS DEFENSIBLE: the counterexample. The supervisor said nothing, the pane
// rested, and the window elapsed — `silent op + stalled`. Whatever the cause, the
// supervisor stayed out of the way of a pane that then needed something, and that
// is a row a transcript structurally cannot produce: the mined corpus is 524
// `nudge` and 3 `leave` because transcripts only record the moments a human
// spoke, and these are the decisions nobody types after. So the emitted rows are
// counterexamples first, and a `leave` that was followed by movement is a weaker
// second ('staying out of the way did not visibly cost anything'). Read them as
// candidates for review, not as drop-in training rows.
//
// The rows are also thin on purpose. `OutcomeEvent` carries the pane, the op, the
// verdict and the pane's state at judgement; it carries no terminal output, no
// claim, no intent. Those fields are therefore empty on the `input` below rather
// than reconstructed from a transcript this file does not have, and a row whose
// `tail` is empty is a row a decision model has very little to look at.
//
// Run: node src/metrics/export-observed.ts [--log=events.jsonl] [--out=path]

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { loadConfig } from "../manager/config.ts";
import type { DecisionInput, Op } from "../decision/types.ts";
import { isSilent, type OutcomeKind } from "./outcome.ts";
import { parseEvent, type OutcomeEvent } from "./schema.ts";

/** One candidate row, in the shape `bench/tasks/tasks.jsonl` uses. `humanText` is
 *  absent and stays absent: nobody typed anything, which is the entire reason
 *  these rows exist. */
export interface ObservedRow {
	id: string;
	input: DecisionInput;
	expectedOp: Op;
	provenance: "observed";
}

/** Why one outcome did or did not justify an op. */
export type Verdict = { emit: Op; why: string } | { skip: string };

/** The rule, in one place, for one outcome.
 *
 *  Only three pairs carry an op: silence plus stillness is the counterexample,
 *  silence plus movement is the weaker 'the silence cost nothing', and a
 *  declaration that was followed by movement is a premature stop. Every other
 *  pair is counted and skipped with its reason printed, never silently dropped. */
export function expectedOpFor(op: Op, outcomeKind: OutcomeKind): Verdict {
	if (isSilent(op)) {
		if (outcomeKind === "stalled") {
			return { emit: "nudge", why: "silence and a still pane: the supervisor said nothing and nothing moved" };
		}
		if (outcomeKind === "progressed") {
			return { emit: "leave", why: "silence and movement: staying out of the way did not visibly cost anything" };
		}
		return { skip: skipReason(op, outcomeKind) };
	}
	if (op === "declare_done") {
		if (outcomeKind === "reopened") {
			return { emit: "nudge", why: "a declared job that carried on: the stop was premature" };
		}
		return { skip: skipReason(op, outcomeKind) };
	}
	return { skip: skipReason(op, outcomeKind) };
}

/** The reason a pair is skipped. Keyed by verdict kind, because that is what the
 *  judge observed; the op only decides whether the pair was an emit above. A row
 *  the rule above never emits reaches here, which is the point: a log written by
 *  another build must produce a named skip, not an invented label. */
function skipReason(op: Op, outcomeKind: OutcomeKind): string {
	switch (outcomeKind) {
		case "unobserved":
			return "the pane left the snapshot: it was neither seen moving nor seen still";
		case "stalled":
			return "a nudge that produced no movement is a repair rate, not a label";
		case "satisfied":
			return "the declaration held: nothing was wrong, so there is no op to learn";
		case "reopened":
			return "only a declare_done followed by movement is a premature stop";
		case "progressed":
			return op === "declare_done"
				? "the pane kept going after a declaration: that is movement, not a verdict on silence"
				: "a nudge followed by movement cannot be attributed to the nudge, so no positive label is claimed";
	}
}

/** FNV-1a, hex. Only for a stable row id: two exports of the same log must
 *  produce the same ids, so a row can be diffed between runs. */
function shortHash(text: string): string {
	let hash = 0x811c9dc5;
	for (let index = 0; index < text.length; index += 1) {
		hash ^= text.charCodeAt(index);
		hash = Math.imul(hash, 0x01000193);
	}
	return (hash >>> 0).toString(16).padStart(8, "0");
}

/** What the outcome event actually observed, and nothing it did not. The
 *  worker-side fields — `intent`, `phase`, `claimState`, `last`, `tail` — are
 *  empty or unknown because this row recorded no claim and no terminal output,
 *  not because the pane had none. */
function toInput(event: OutcomeEvent): DecisionInput {
	return {
		paneId: event.paneId,
		cwd: event.cwd,
		status: event.status,
		title: event.title,
		intent: "",
		phase: "unknown",
		claimState: "unknown",
		last: "",
		idleTicks: event.idleTicks,
		tail: "",
	};
}

export interface ExportReport {
	/** Rows the exporter would write, in log order. */
	rows: ObservedRow[];
	/** Outcome rows read. `rows.length + skipped counts = outcomes`. */
	outcomes: number;
	emitted: Array<{ op: Op; outcomeKind: OutcomeKind; count: number }>;
	skipped: Array<{ op: Op; outcomeKind: OutcomeKind; count: number; reason: string }>;
}

function bump<K>(counts: Map<string, { count: number; value: K }>, key: string, value: K): void {
	const existing = counts.get(key);
	if (existing) existing.count += 1;
	else counts.set(key, { count: 1, value });
}

/** The whole export, from outcome events. Pure: no clock, no file system, so the
 *  include/skip decision is testable per kind. */
export function exportObserved(outcomes: readonly OutcomeEvent[]): ExportReport {
	const rows: ObservedRow[] = [];
	const emitted = new Map<string, { count: number; value: { op: Op; outcomeKind: OutcomeKind } }>();
	const skipped = new Map<string, { count: number; value: { op: Op; outcomeKind: OutcomeKind; reason: string } }>();

	for (const event of outcomes) {
		const verdict = expectedOpFor(event.op, event.outcomeKind);
		if ("emit" in verdict) {
			rows.push({
				id: `obs-${String(rows.length).padStart(4, "0")}-${shortHash(`${event.ts}\u0000${event.paneId}\u0000${event.op}`)}`,
				input: toInput(event),
				expectedOp: verdict.emit,
				provenance: "observed",
			});
			bump(emitted, `${event.op}:${event.outcomeKind}`, { op: event.op, outcomeKind: event.outcomeKind });
		} else {
			bump(skipped, `${event.op}:${event.outcomeKind}`, { op: event.op, outcomeKind: event.outcomeKind, reason: verdict.skip });
		}
	}

	const byCount = <T extends { count: number }>(a: T & { op: Op; outcomeKind: OutcomeKind }, b: T & { op: Op; outcomeKind: OutcomeKind }): number =>
		b.count - a.count || a.op.localeCompare(b.op) || a.outcomeKind.localeCompare(b.outcomeKind);

	return {
		rows,
		outcomes: outcomes.length,
		emitted: [...emitted.values()].map((entry) => ({ ...entry.value, count: entry.count })).sort(byCount),
		skipped: [...skipped.values()].map((entry) => ({ ...entry.value, count: entry.count })).sort(byCount),
	};
}

/** Every outcome row in an events log, in file order. A plain scan rather than
 *  ./store.ts: this is a one-shot export, and an index for a single pass over one
 *  file is a database built to be thrown away. `parseEvent` is still the reader,
 *  so a line this build does not know is skipped instead of guessed at. */
export function readOutcomes(logPath: string): OutcomeEvent[] {
	let source: string;
	try {
		source = readFileSync(logPath, "utf8");
	} catch {
		return [];
	}
	const out: OutcomeEvent[] = [];
	for (const line of source.split("\n")) {
		if (line.trim() === "") continue;
		const event = parseEvent(line);
		if (event && event.kind === "outcome") out.push(event);
	}
	return out;
}

export function writeRows(rows: readonly ObservedRow[], outPath: string): void {
	mkdirSync(dirname(outPath), { recursive: true });
	writeFileSync(outPath, rows.length === 0 ? "" : `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`);
}

/** Where the rows go by default: beside the log they were derived from, on the
 *  same principle as `pendingPath`, and never merged into
 *  `bench/tasks/tasks.jsonl`. A mined row and an observed row are different
 *  evidence, and a corpus that mixes them without a key cannot be told apart
 *  afterwards — which is why every row here carries `provenance`. */
export function observedPath(eventsPath: string): string {
	return join(dirname(eventsPath), "observed-tasks.jsonl");
}

const USAGE = `usage: node src/metrics/export-observed.ts [--log=path] [--out=path]

  --log=path   the events log to read (default: the supervisor's own)
  --out=path   where the rows are written (default: beside the log)

  Emits only outcomes that justify an op: a silent op followed by stillness
  (nudge), a silent op followed by movement (leave), and a declare_done the pane
  reopened (nudge). Everything else is counted and the reason printed.`;

interface CliOptions {
	log?: string;
	out?: string;
}

function parseArgs(argv: readonly string[]): CliOptions | "help" | undefined {
	const options: CliOptions = {};
	for (const arg of argv) {
		if (arg === "--help" || arg === "-h") return "help";
		const split = arg.startsWith("--") && arg.includes("=") ? arg.indexOf("=") : -1;
		if (split === -1) return undefined;
		const flag = arg.slice(0, split);
		const value = arg.slice(split + 1);
		if (value === "") return undefined;
		if (flag === "--log") options.log = value;
		else if (flag === "--out") options.out = value;
		else return undefined;
	}
	return options;
}

function main(argv: readonly string[]): number {
	const options = parseArgs(argv);
	if (options === "help") {
		console.log(USAGE);
		return 0;
	}
	if (options === undefined) {
		console.error(USAGE);
		console.error("\nerror: unrecognised argument");
		return 2;
	}

	const logPath = options.log ?? loadConfig().eventsPath;
	const outPath = options.out ?? observedPath(logPath);
	const report = exportObserved(readOutcomes(logPath));
	writeRows(report.rows, outPath);

	console.error(`${report.rows.length} rows from ${report.outcomes} judged outcomes → ${outPath}`);
	for (const entry of report.emitted) console.error(`  emitted ${entry.op}:${entry.outcomeKind}  ${entry.count}`);
	for (const entry of report.skipped) console.error(`  skipped ${entry.op}:${entry.outcomeKind}  ${entry.count} — ${entry.reason}`);
	console.error("correlation, not causation: a silent op followed by movement is weak evidence, and a nudge followed by movement is not evidence at all");
	return 0;
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
	process.exitCode = main(process.argv.slice(2));
}
