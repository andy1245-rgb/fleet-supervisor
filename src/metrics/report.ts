// What the log means. Every number here is counted from rows, never estimated:
// if the rows a metric needs are not in the window, the metric is null and says
// so instead of reading zero.
//
// The organisation follows the questions the supervisor exists to answer:
//
//   decisions  — is the local model worth its latency, and what does it decide?
//   holds      — how often does the gate stop an action, and for which reason?
//   actions    — which ops go unanswered, and why (cooldown, cap, refusal)?
//   triggers   — which cross-agent conditions actually fire?
//   inspections— what fraction of a trigger yields something actionable, at what cost?
//   ticks      — what does one pass over the fleet cost, in time and money?
//   watchdog   — which rules keep reporting?
//
// `main` at the bottom is the CLI. It reads through ./store.ts so the numbers and
// the file can never come from different places.

import { loadConfig } from "../manager/config.ts";
import type { Op } from "../decision/types.ts";
import { SCHEMA_VERSION, type ActionEvent, type ClaimEvent, type DecisionEvent, type InspectionEvent, type SchemaEvent, type TickEvent, type TriggerEvent, type WatchdogEvent } from "./schema.ts";
import { isMetricsWindow, openStore, type MetricsWindow } from "./store.ts";
import { formatReport } from "./render.ts";

/** Version of the JSON this file produces. Bump when a key changes meaning, so
 *  an optimisation script can pin the contract it was written against. */
export const REPORT_SCHEMA = 1;

export interface FieldCoverage {
	kind: string;
	field: string;
	present: number;
	absent: number;
}

export interface SourceReport {
	logPath: string;
	indexPath: string | null;
	indexKind: "sqlite" | "scan";
	schemaVersion: number;
	/** Rows in this selection. */
	rows: number;
	/** Lines in the log that are not rows of this schema: pre-schema history, the
	 *  legacy human-readable kinds, and anything truncated. Cumulative over the log. */
	ignoredRows: number;
	firstTs: string | null;
	lastTs: string | null;
}

export interface Distribution {
	n: number;
	p50: number | null;
	p95: number | null;
	p99: number | null;
	max: number | null;
	mean: number | null;
}

export interface Decile {
	decile: number;
	low: number;
	high: number;
	count: number;
	share: number;
}

export interface AccuracyByDecile {
	decile: number;
	low: number;
	high: number;
	labelled: number;
	correct: number;
	/** Null for a decile no labelled row fell in: an empty bucket is unknown, not 0%. */
	accuracy: number | null;
}

export interface DecisionsReport {
	total: number;
	opMix: Array<{ op: Op; count: number; share: number }>;
	byGroup: Array<{ group: string; count: number }>;
	confidence: { n: number; mean: number | null; deciles: Decile[] };
	/** Null when no decision row carries `labelOp`: accuracy cannot be invented. */
	accuracyByDecile: AccuracyByDecile[] | null;
	escalation: {
		total: number;
		escalated: number;
		rate: number | null;
		failed: number;
		/** Failed escalations as a share of *attempted* escalations. */
		failedRate: number | null;
	};
	refusalByModel: Array<{ model: string; decisions: number; refused: number; rate: number | null }>;
	latencyByModel: Array<{ model: string; decisions: number } & Distribution>;
	cost: {
		totalUsd: number;
		byModel: Array<{ model: string; decisions: number; totalUsd: number; share: number }>;
		/** UTC day, from the row's timestamp. */
		byDay: Array<{ day: string; totalUsd: number }>;
	};
}

export interface ActionsReport {
	total: number;
	byDisposition: Array<{ disposition: string; count: number; share: number }>;
	byOp: Array<{ op: Op; total: number; sent: number; held: number; rejected: number; skipped: number; dry: number }>;
	skippedByReason: Array<{ reason: string; count: number }>;
	rejectedByReason: Array<{ reason: string; count: number }>;
	/** Round trip of the actions that reached the transport (nudges sent or refused). */
	latencyMs: Distribution;
	hold: {
		/** Actions for which the ask gate ran. The hold rate's denominator. */
		gated: number;
		held: number;
		rate: number | null;
		byPolicy: Array<{ policy: string; gated: number; held: number; rate: number | null }>;
		/** Gated actions carrying each fork kind, and how many of those were held.
		 *  An action with two kinds counts once per kind; an action with no fork is
		 *  in no bucket, so these need not sum to `gated`. */
		byForkKind: Array<{ kind: string; gated: number; held: number; rate: number | null }>;
	};
}

export interface TicksReport {
	total: number;
	agents: { max: number; mean: number | null };
	moved: { total: number; max: number; mean: number | null };
	decisions: { total: number; mean: number | null };
	inspected: { total: number; max: number; mean: number | null };
	prompts: { total: number; mean: number | null };
	held: { total: number; mean: number | null };
	durationMs: Distribution;
	costUsd: { total: number; mean: number | null };
	dry: number;
	/** Which models the tick actually consulted, and in how many ticks. */
	models: Array<{ model: string; ticks: number }>;
}

export interface TriggersReport {
	total: number;
	byKind: Array<{ kind: string; count: number; share: number }>;
	/** Triggers divided by tick rows in the same window; null with no tick rows. */
	perTick: number | null;
	/** Inspections divided by triggers, both summed from tick rows. */
	inspectedShare: number | null;
}

export interface InspectionsReport {
	total: number;
	byMode: Array<{ mode: string; count: number }>;
	byTriggerKind: Array<{ kind: string; count: number; proposed: number; rate: number | null }>;
	costUsd: { total: number; mean: number | null };
	latencyMs: Distribution;
	degraded: { count: number; rate: number | null };
	/** The yield question: inspections that produced an actionable finding. */
	proposed: { count: number; rate: number | null };
	perTick: number | null;
}

export interface WatchdogReport {
	total: number;
	byRule: Array<{ rule: string; count: number }>;
	/** `stalled` is only recorded by a re-sampling scan, so `tested` is usually 0. */
	stalled: { tested: number; stalled: number; rate: number | null };
}

export interface ClaimsReport {
	total: number;
	byState: Array<{ state: string; count: number; share: number }>;
	diverged: { count: number; rate: number | null };
	ageMs: Distribution;
}

export interface MetricsReport {
	reportSchema: number;
	window: MetricsWindow;
	group: string | null;
	paneId: string | null;
	generatedAt: string;
	source: SourceReport;
	/** Optional fields that were missing from some rows in this selection. A field
	 *  listed here is not zero — it is absent, and no aggregate below used it. */
	coverage: FieldCoverage[];
	decisions: DecisionsReport;
	actions: ActionsReport;
	ticks: TicksReport;
	triggers: TriggersReport;
	inspections: InspectionsReport;
	watchdog: WatchdogReport;
	claims: ClaimsReport;
	/** Plain-language caveats about this window: absent fields, null rates. */
	notes: string[];
}

export interface ReportInput {
	events: readonly SchemaEvent[];
	window: MetricsWindow;
	group?: string;
	paneId?: string;
	logPath: string;
	indexPath: string | null;
	indexKind: "sqlite" | "scan";
	ignoredRows: number;
	now?: number;
}

// ------------------------------------------------------------------- helpers

function ratio(count: number, total: number): number | null {
	return total === 0 ? null : count / total;
}

function share(count: number, total: number): number {
	return total === 0 ? 0 : count / total;
}

function mean(total: number, count: number): number | null {
	return count === 0 ? null : total / count;
}

function sorted(values: readonly number[]): number[] {
	return [...values].sort((a, b) => a - b);
}

/** Nearest-rank percentile: the smallest value at or above the p-th rank. No
 *  interpolation, so every number printed is a value that actually occurred. */
function percentile(ordered: readonly number[], p: number): number | null {
	if (ordered.length === 0) return null;
	const rank = Math.ceil(p * ordered.length) - 1;
	const index = Math.min(ordered.length - 1, Math.max(0, rank));
	return ordered[index] ?? null;
}

function distribution(values: readonly number[]): Distribution {
	const ordered = sorted(values);
	return {
		n: ordered.length,
		p50: percentile(ordered, 0.5),
		p95: percentile(ordered, 0.95),
		p99: percentile(ordered, 0.99),
		max: ordered.length === 0 ? null : (ordered[ordered.length - 1] ?? null),
		mean: mean(
			ordered.reduce((sum, value) => sum + value, 0),
			ordered.length,
		),
	};
}

function countBy<T>(items: readonly T[], key: (item: T) => string): Map<string, T[]> {
	const out = new Map<string, T[]>();
	for (const item of items) {
		const k = key(item);
		const list = out.get(k);
		if (list) list.push(item);
		else out.set(k, [item]);
	}
	return out;
}

/** Largest first, name as the tiebreak, so two runs over the same rows print the
 *  same tables in the same order. */
function ranked<T>(buckets: Map<string, T[]>): Array<{ key: string; items: T[] }> {
	return [...buckets.entries()]
		.map(([key, items]) => ({ key, items }))
		.sort((a, b) => b.items.length - a.items.length || a.key.localeCompare(b.key));
}

function dayOf(ts: string): string {
	return ts.slice(0, 10);
}

function sumBy<T>(items: readonly T[], value: (item: T) => number): number {
	return items.reduce((sum, item) => sum + value(item), 0);
}

function decileOf(confidence: number): number {
	return Math.min(9, Math.max(0, Math.floor(confidence * 10)));
}

const OPS: readonly Op[] = ["leave", "nudge", "declare_done", "flag"];
const DISPOSITIONS = ["sent", "held", "rejected", "skipped", "dry"] as const;

// --------------------------------------------------------------- aggregation

function decisionsReport(decisions: readonly DecisionEvent[]): DecisionsReport {
	const total = decisions.length;

	const opMix = OPS.map((op) => {
		const count = decisions.filter((decision) => decision.op === op).length;
		return { op, count, share: share(count, total) };
	});

	const byGroup = ranked(countBy(decisions, (decision) => decision.group)).map(({ key, items }) => ({ group: key, count: items.length }));

	const confidences = decisions.map((decision) => decision.confidence);
	const deciles: Decile[] = Array.from({ length: 10 }, (_unused, decile) => {
		const count = confidences.filter((confidence) => decileOf(confidence) === decile).length;
		return { decile, low: decile / 10, high: (decile + 1) / 10, count, share: share(count, total) };
	});

	// Only rows that carry ground truth can say whether the confidence was earned.
	const labelled = decisions.filter((decision) => decision.labelOp !== undefined);
	const accuracyByDecile =
		labelled.length === 0
			? null
			: Array.from({ length: 10 }, (_unused, decile) => {
					const rows = labelled.filter((decision) => decileOf(decision.confidence) === decile);
					const correct = rows.filter((decision) => decision.op === decision.labelOp).length;
					return { decile, low: decile / 10, high: (decile + 1) / 10, labelled: rows.length, correct, accuracy: ratio(correct, rows.length) };
				});

	const escalated = decisions.filter((decision) => decision.escalated).length;
	const failed = decisions.filter((decision) => decision.escalationFailed).length;

	const refusalByModel = ranked(countBy(decisions, (decision) => decision.model)).map(({ key, items }) => {
		const refused = items.filter((decision) => decision.refused).length;
		return { model: key, decisions: items.length, refused, rate: ratio(refused, items.length) };
	});

	const latencyByModel = ranked(countBy(decisions, (decision) => decision.model)).map(({ key, items }) => ({
		model: key,
		decisions: items.length,
		...distribution(items.map((decision) => decision.latencyMs)),
	}));

	const costTotal = sumBy(decisions, (decision) => decision.costUsd);
	const costByModel = ranked(countBy(decisions, (decision) => decision.model)).map(({ key, items }) => {
		const totalUsd = sumBy(items, (decision) => decision.costUsd);
		return { model: key, decisions: items.length, totalUsd, share: share(totalUsd, costTotal) };
	});
	const costByDay = [...countBy(decisions, (decision) => dayOf(decision.ts)).entries()]
		.map(([day, items]) => ({ day, totalUsd: sumBy(items, (decision) => decision.costUsd) }))
		.sort((a, b) => a.day.localeCompare(b.day));

	return {
		total,
		opMix,
		byGroup,
		confidence: { n: total, mean: mean(sumBy(confidences, (value) => value), total), deciles },
		accuracyByDecile,
		escalation: { total, escalated, rate: ratio(escalated, total), failed, failedRate: ratio(failed, escalated) },
		refusalByModel,
		latencyByModel,
		cost: { totalUsd: costTotal, byModel: costByModel, byDay: costByDay },
	};
}

function actionsReport(actions: readonly ActionEvent[]): ActionsReport {
	const total = actions.length;

	const byDisposition = DISPOSITIONS.map((disposition) => {
		const count = actions.filter((action) => action.disposition === disposition).length;
		return { disposition, count, share: share(count, total) };
	});

	const byOp = OPS.map((op) => {
		const rows = actions.filter((action) => action.op === op);
		return {
			op,
			total: rows.length,
			sent: rows.filter((action) => action.disposition === "sent").length,
			held: rows.filter((action) => action.disposition === "held").length,
			rejected: rows.filter((action) => action.disposition === "rejected").length,
			skipped: rows.filter((action) => action.disposition === "skipped").length,
			dry: rows.filter((action) => action.disposition === "dry").length,
		};
	});

	const skippedByReason = ranked(countBy(actions.filter((action) => action.disposition === "skipped"), (action) => action.reason)).map(({ key, items }) => ({ reason: key, count: items.length }));
	const rejectedByReason = ranked(countBy(actions.filter((action) => action.disposition === "rejected"), (action) => action.reason)).map(({ key, items }) => ({ reason: key, count: items.length }));

	// Latency is measured over the actions that made a transport call: a nudge that
	// was sent or refused. A `declare_done` writes a claim file and takes no round
	// trip, and a skipped action never happened — counting either as a fast action
	// is how a prompt median of 0 ms gets reported for a tick that prompted once.
	const transported = actions.filter((action) => action.op === "nudge" && (action.disposition === "sent" || action.disposition === "rejected"));

	const gated = actions.filter((action) => action.gated);
	const held = gated.filter((action) => action.disposition === "held");

	const byPolicy = ranked(countBy(gated, (action) => action.policy)).map(({ key, items }) => {
		const heldHere = items.filter((action) => action.disposition === "held").length;
		return { policy: key, gated: items.length, held: heldHere, rate: ratio(heldHere, items.length) };
	});

	const forkKinds = new Set<string>();
	for (const action of gated) for (const kind of action.forkKinds ?? []) forkKinds.add(kind);
	const byForkKind = [...forkKinds]
		.map((kind) => {
			const rows = gated.filter((action) => (action.forkKinds ?? []).includes(kind));
			const heldHere = rows.filter((action) => action.disposition === "held").length;
			return { kind, gated: rows.length, held: heldHere, rate: ratio(heldHere, rows.length) };
		})
		.sort((a, b) => b.gated - a.gated || a.kind.localeCompare(b.kind));

	return {
		total,
		byDisposition,
		byOp,
		skippedByReason,
		rejectedByReason,
		latencyMs: distribution(transported.map((action) => action.latencyMs)),
		hold: { gated: gated.length, held: held.length, rate: ratio(held.length, gated.length), byPolicy, byForkKind },
	};
}

function ticksReport(ticks: readonly TickEvent[]): TicksReport {
	const total = ticks.length;
	const models = new Map<string, number>();
	for (const tick of ticks) for (const model of tick.models) models.set(model, (models.get(model) ?? 0) + 1);

	return {
		total,
		agents: { max: ticks.reduce((max, tick) => Math.max(max, tick.agents), 0), mean: mean(sumBy(ticks, (tick) => tick.agents), total) },
		moved: {
			total: sumBy(ticks, (tick) => tick.moved),
			max: ticks.reduce((max, tick) => Math.max(max, tick.moved), 0),
			mean: mean(sumBy(ticks, (tick) => tick.moved), total),
		},
		decisions: { total: sumBy(ticks, (tick) => tick.decisions), mean: mean(sumBy(ticks, (tick) => tick.decisions), total) },
		inspected: {
			total: sumBy(ticks, (tick) => tick.inspected),
			max: ticks.reduce((max, tick) => Math.max(max, tick.inspected), 0),
			mean: mean(sumBy(ticks, (tick) => tick.inspected), total),
		},
		prompts: { total: sumBy(ticks, (tick) => tick.prompts), mean: mean(sumBy(ticks, (tick) => tick.prompts), total) },
		held: { total: sumBy(ticks, (tick) => tick.held), mean: mean(sumBy(ticks, (tick) => tick.held), total) },
		durationMs: distribution(ticks.map((tick) => tick.durationMs)),
		costUsd: { total: sumBy(ticks, (tick) => tick.costUsd), mean: mean(sumBy(ticks, (tick) => tick.costUsd), total) },
		dry: ticks.filter((tick) => tick.dry).length,
		models: [...models.entries()].map(([model, count]) => ({ model, ticks: count })).sort((a, b) => b.ticks - a.ticks || a.model.localeCompare(b.model)),
	};
}

function triggersReport(triggers: readonly TriggerEvent[], ticks: readonly TickEvent[]): TriggersReport {
	const byKind = ranked(countBy(triggers, (trigger) => trigger.triggerKind)).map(({ key, items }) => ({
		kind: key,
		count: items.length,
		share: share(items.length, triggers.length),
	}));
	return {
		total: triggers.length,
		byKind,
		perTick: ratio(triggers.length, ticks.length),
		// Summed from the tick rows rather than compared to `total`, because a tick
		// is what decides how many of the triggers it saw were investigated.
		inspectedShare: ratio(sumBy(ticks, (tick) => tick.inspected), sumBy(ticks, (tick) => tick.triggers)),
	};
}

function inspectionsReport(inspections: readonly InspectionEvent[], ticks: readonly TickEvent[]): InspectionsReport {
	const total = inspections.length;
	const byMode = ranked(countBy(inspections, (inspection) => inspection.mode)).map(({ key, items }) => ({ mode: key, count: items.length }));
	const byTriggerKind = ranked(countBy(inspections, (inspection) => inspection.triggerKind)).map(({ key, items }) => {
		const proposed = items.filter((inspection) => inspection.proposed).length;
		return { kind: key, count: items.length, proposed, rate: ratio(proposed, items.length) };
	});
	const degraded = inspections.filter((inspection) => inspection.degraded).length;
	const proposed = inspections.filter((inspection) => inspection.proposed).length;
	const costTotal = sumBy(inspections, (inspection) => inspection.costUsd);

	return {
		total,
		byMode,
		byTriggerKind,
		costUsd: { total: costTotal, mean: mean(costTotal, total) },
		latencyMs: distribution(inspections.map((inspection) => inspection.latencyMs)),
		degraded: { count: degraded, rate: ratio(degraded, total) },
		proposed: { count: proposed, rate: ratio(proposed, total) },
		perTick: ratio(total, ticks.length),
	};
}

function watchdogReport(findings: readonly WatchdogEvent[]): WatchdogReport {
	const byRule = ranked(countBy(findings, (finding) => finding.rule)).map(({ key, items }) => ({ rule: key, count: items.length }));
	const tested = findings.filter((finding) => finding.stalled !== undefined);
	const stalled = tested.filter((finding) => finding.stalled === true).length;
	return { total: findings.length, byRule, stalled: { tested: tested.length, stalled, rate: ratio(stalled, tested.length) } };
}

function claimsReport(claims: readonly ClaimEvent[]): ClaimsReport {
	const byState = ranked(countBy(claims, (claim) => claim.state)).map(({ key, items }) => ({ state: key, count: items.length, share: share(items.length, claims.length) }));
	const diverged = claims.filter((claim) => claim.diverged).length;
	const ages = claims.map((claim) => claim.ageMs).filter((age): age is number => age !== undefined);
	return { total: claims.length, byState, diverged: { count: diverged, rate: ratio(diverged, claims.length) }, ageMs: distribution(ages) };
}

function coverageOf(events: readonly SchemaEvent[]): FieldCoverage[] {
	const has = (event: SchemaEvent, key: string): boolean => (event as unknown as Record<string, unknown>)[key] !== undefined;
	const out: FieldCoverage[] = [];
	const probe = (kind: SchemaEvent["kind"], field: string): void => {
		const rows = events.filter((event) => event.kind === kind);
		if (rows.length === 0) return;
		const present = rows.filter((event) => has(event, field)).length;
		out.push({ kind, field, present, absent: rows.length - present });
	};

	probe("decision", "promptTokens");
	probe("decision", "completionTokens");
	probe("decision", "labelOp");
	probe("inspection", "model");
	probe("watchdog", "stalled");
	probe("claim", "ageMs");
	return out;
}

function notesFor(report: Omit<MetricsReport, "notes">): string[] {
	const notes: string[] = [];
	if (report.source.rows === 0) notes.push("no rows in this window: every table is empty rather than zero");

	const absent = (kind: string, field: string): boolean => report.coverage.some((entry) => entry.kind === kind && entry.field === field && entry.absent > 0);

	if (absent("decision", "promptTokens") || absent("decision", "completionTokens")) {
		notes.push("token counts are absent from some decision rows (no adapter reports usage), so no token metric is computed");
	}
	if (report.decisions.accuracyByDecile === null) {
		notes.push("accuracy by decile is null: no decision row carries labelOp, and accuracy cannot be inferred from confidence");
	}
	if (absent("watchdog", "stalled")) {
		notes.push("stalled is absent from watchdog rows: only a re-sampling scan records it, and the per-tick scan does not pay for one");
	}
	if (absent("claim", "ageMs")) {
		notes.push("claim ageMs is absent where the pane had no claim file");
	}
	if (report.ticks.total === 0) {
		notes.push("no tick rows: per-tick rates and the whole-tick cost are null, not zero");
	} else {
		notes.push("tick costUsd sums the whole ladder trail; the per-model decision cost prices only the deciding model, so the two totals are not additive");
	}
	if (report.actions.hold.held > 0 && report.actions.hold.byForkKind.length === 0) {
		notes.push("every hold here came from a policy that asks unconditionally: no held action carried a fork");
	}
	return notes;
}

/** The report, from rows. Pure apart from the clock, so a fixture can assert
 *  every aggregate in it. */
export function buildReport(input: ReportInput): MetricsReport {
	const events = [...input.events].sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));
	const decisions: DecisionEvent[] = [];
	const actions: ActionEvent[] = [];
	const ticks: TickEvent[] = [];
	const triggers: TriggerEvent[] = [];
	const inspections: InspectionEvent[] = [];
	const watchdog: WatchdogEvent[] = [];
	const claims: ClaimEvent[] = [];
	for (const event of events) {
		switch (event.kind) {
			case "decision":
				decisions.push(event);
				break;
			case "action":
				actions.push(event);
				break;
			case "tick":
				ticks.push(event);
				break;
			case "trigger":
				triggers.push(event);
				break;
			case "inspection":
				inspections.push(event);
				break;
			case "watchdog":
				watchdog.push(event);
				break;
			case "claim":
				claims.push(event);
				break;
		}
	}

	const withoutNotes: Omit<MetricsReport, "notes"> = {
		reportSchema: REPORT_SCHEMA,
		window: input.window,
		group: input.group ?? null,
		paneId: input.paneId ?? null,
		generatedAt: new Date(input.now ?? Date.now()).toISOString(),
		source: {
			logPath: input.logPath,
			indexPath: input.indexPath,
			indexKind: input.indexKind,
			schemaVersion: SCHEMA_VERSION,
			rows: events.length,
			ignoredRows: input.ignoredRows,
			firstTs: events[0]?.ts ?? null,
			lastTs: events[events.length - 1]?.ts ?? null,
		},
		coverage: coverageOf(events),
		decisions: decisionsReport(decisions),
		actions: actionsReport(actions),
		ticks: ticksReport(ticks),
		triggers: triggersReport(triggers, ticks),
		inspections: inspectionsReport(inspections, ticks),
		watchdog: watchdogReport(watchdog),
		claims: claimsReport(claims),
	};

	return { ...withoutNotes, notes: notesFor(withoutNotes) };
}

// ----------------------------------------------------------------------- CLI

const USAGE = `usage: node src/metrics/report.ts [--window=1h|24h|all] [--group=X] [--pane=X] [--json] [--log=path] [--index=path] [--scan]

  --window=1h|24h|all  time window relative to now (default 24h)
  --group=X            only events carrying this group key
  --pane=X             only events carrying this pane id
  --json               print the report object instead of tables
  --log=path           the events log to read (default: the supervisor's own)
  --index=path         where the derived index lives (default: next to the log)
  --scan               skip SQLite and scan the JSONL directly`;

interface CliOptions {
	window: MetricsWindow;
	group?: string;
	paneId?: string;
	json: boolean;
	log?: string;
	index?: string;
	scan: boolean;
}

function parseArgs(argv: readonly string[]): CliOptions | "help" | undefined {
	const options: CliOptions = { window: "24h", json: false, scan: false };
	for (let i = 0; i < argv.length; i += 1) {
		const arg = argv[i];
		if (arg === undefined) continue;
		const split = arg.startsWith("--") && arg.includes("=") ? arg.indexOf("=") : -1;
		const flag = split === -1 ? arg : arg.slice(0, split);
		const given = split === -1 ? undefined : arg.slice(split + 1);
		const value = (): string | undefined => {
			if (given !== undefined) return given;
			i += 1;
			return argv[i];
		};
		switch (flag) {
			case "--window": {
				const window = value();
				if (!isMetricsWindow(window)) return undefined;
				options.window = window;
				break;
			}
			case "--group":
				options.group = value();
				break;
			case "--pane":
				options.paneId = value();
				break;
			case "--log":
				options.log = value();
				break;
			case "--index":
				options.index = value();
				break;
			case "--json":
				options.json = true;
				break;
			case "--scan":
				options.scan = true;
				break;
			case "--help":
			case "-h":
				return "help";
			default:
				return undefined;
		}
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
		console.error("\nerror: unrecognised argument, or a --window that is not 1h, 24h or all");
		return 2;
	}

	// The supervisor's own config loader, so a report cannot read a state dir the
	// tick never writes to.
	const logPath = options.log ?? loadConfig().eventsPath;
	const store = openStore(logPath, { indexPath: options.index, forceScan: options.scan });
	const ingested = store.ingest();
	const events = store.query({ window: options.window, group: options.group, paneId: options.paneId });
	const report = buildReport({
		events,
		window: options.window,
		group: options.group,
		paneId: options.paneId,
		logPath,
		indexPath: store.indexPath,
		indexKind: store.indexKind,
		ignoredRows: ingested.ignoredTotal,
	});
	store.close();

	console.log(options.json ? JSON.stringify(report, null, "\t") : formatReport(report));
	return 0;
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
	process.exitCode = main(process.argv.slice(2));
}
