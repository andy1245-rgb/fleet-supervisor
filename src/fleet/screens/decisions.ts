// Decisions and outcomes, and the narrower outcomes document.
//
// The two rules this pair exists to obey:
//
//   * no rate without its `n` beside it, and a rate the log cannot support is printed as
//     `insufficient data (n=…)` verbatim rather than as a number;
//   * a null is printed as a null — an accuracy decile with no labelled row is unknown,
//     not 0%.
//
// `accuracyByDecile` is null for every log written so far, because no decision row carries
// `labelOp`: the field exists and nothing fills it. The document says which field is
// missing instead of drawing a flat line at zero, because a flat line at zero reads as
// "the model is wrong" and the truth is "nobody recorded a label".
//
// Every aggregate here comes from `src/metrics/report.ts` — the same arithmetic that
// `report.ts --json` prints — rather than from a transcription of it. That is the whole
// reason screens moved into the core: the acceptance test for these two screens is that
// the number equals the report's over the same rows.

import { envelope, lagSecondsOf, tile } from "../envelope.ts";
import { noteOf, paneName } from "../name.ts";
import { coverageOf, decisionsReport, inspectionsReport, outcomesReport, ratio, triggersReport, MIN_SILENT_DECISIONS } from "../../metrics/report.ts";
import type { ActionEvent, DecisionEvent, InspectionEvent, OutcomeEvent, TickEvent, TriggerEvent } from "../../metrics/schema.ts";
import type { Ctx, Doc } from "../types.ts";

function pct(value: number | null): number | null {
	return value === null ? null : Number((value * 100).toFixed(1));
}

function decisionsOf(events: readonly { kind: string }[]): DecisionEvent[] {
	return events.filter((event): event is DecisionEvent => event.kind === "decision");
}

function outcomesOf(events: readonly { kind: string }[]): OutcomeEvent[] {
	return events.filter((event): event is OutcomeEvent => event.kind === "outcome");
}

function inspectionsOf(events: readonly { kind: string }[]): InspectionEvent[] {
	return events.filter((event): event is InspectionEvent => event.kind === "inspection");
}

function triggersOf(events: readonly { kind: string }[]): TriggerEvent[] {
	return events.filter((event): event is TriggerEvent => event.kind === "trigger");
}

export function buildDecisions(ctx: Ctx): Doc {
	const { source, events } = ctx;
	const decisions = decisionsOf(events);
	const panesById = new Map(source.panes.panes.map((pane) => [pane.pane_id, pane]));
	const outcomes = outcomesOf(events);
	const inspections = inspectionsOf(events);
	const triggers = triggersOf(events);
	const ticks = events.filter((event): event is TickEvent => event.kind === "tick");

	const report = decisionsReport(decisions);
	const outcomeReport = outcomesReport(outcomes);
	const inspectionReport = inspectionsReport(inspections, ticks);
	const triggerReport = triggersReport(triggers, ticks);
	const refused = decisions.filter((decision) => decision.refused).length;
	const degraded = inspections.filter((inspection) => inspection.degraded).length;

	const labelledTotal = report.accuracyByDecile === null ? 0 : report.accuracyByDecile.reduce((sum, bucket) => sum + bucket.labelled, 0);
	const labelledAccuracy =
		report.accuracyByDecile === null
			? null
			: ratio(
					report.accuracyByDecile.reduce((sum, bucket) => sum + bucket.correct, 0),
					labelledTotal,
				);

	const decisionSource = `events.jsonl, kind=decision (${ctx.window})`;
	const outcomeSource = `events.jsonl, kind=outcome (${ctx.window})`;
	const refusedPct = pct(ratio(refused, decisions.length));

	const tiles = [
		tile({ id: "decisions", label: "Decisions", value: decisions.length, n: decisions.length, source: decisionSource, detail: "one row per ladder decision, escalation included" }),
		tile({
			id: "silence",
			label: "Silent-decision precision",
			value: pct(outcomeReport.silence.precision),
			unit: outcomeReport.silence.precision === null ? "" : "%",
			n: outcomeReport.silence.decisions,
			source: outcomeSource,
			nullReason: outcomeReport.silence.precision === null ? outcomeReport.silence.precisionText : null,
			tone: outcomeReport.silence.precision === null ? "dim" : "ok",
			note: outcomeReport.silence.precisionText,
			detail: `of ${outcomeReport.silence.progressed} progressed and ${outcomeReport.silence.stalled} stalled after a silent decision; ${MIN_SILENT_DECISIONS} judged decisions are needed before this is quoted`,
		}),
		tile({
			id: "refused",
			label: "Refusals",
			value: refused,
			n: decisions.length,
			source: decisionSource,
			tone: decisions.length > 0 && refused / decisions.length > 0.5 ? "warn" : "neutral",
			note: refusedPct === null ? null : `${refusedPct}% of rows`,
			detail: "the model declined to commit to an op; a refusal is a routing fact, not a risk",
		}),
		tile({ id: "escalated", label: "Escalated", value: report.escalation.escalated, n: report.escalation.total, source: decisionSource, note: report.escalation.rate === null ? null : `${pct(report.escalation.rate)}% of rows`, detail: "decisions where the escalator was consulted" }),
		tile({
			id: "escalationFailed",
			label: "Escalation failed",
			value: report.escalation.failed,
			n: report.escalation.escalated,
			source: decisionSource,
			tone: report.escalation.failed > 0 ? "warn" : "neutral",
			nullReason: report.escalation.escalated === 0 ? "no escalation was attempted in this window, so there is no rate to quote" : null,
			note: report.escalation.failedRate === null ? null : `${pct(report.escalation.failedRate)}% of attempts`,
			detail: "attempted escalations that produced no decision",
		}),
		tile({
			id: "degraded",
			label: "Degraded inspections",
			value: degraded,
			n: inspections.length,
			source: `events.jsonl, kind=inspection (${ctx.window})`,
			tone: degraded > 0 ? "warn" : "neutral",
			note: inspectionReport.degraded.rate === null ? null : `${pct(inspectionReport.degraded.rate)}% of ${inspections.length}`,
			detail: "deep fell back to cheap, or the model call failed and the finding says so",
		}),
		tile({
			id: "accuracy",
			label: "Accuracy by decile",
			value: pct(labelledAccuracy),
			unit: labelledAccuracy === null ? "" : "%",
			n: labelledTotal,
			source: decisionSource,
			nullReason: report.accuracyByDecile === null ? "no decision row carries labelOp, so no decile has a labelled row and accuracy cannot be invented" : null,
			tone: "dim",
			note: report.accuracyByDecile === null ? "unknown" : `${labelledTotal} labelled rows`,
			detail: "a decile with 0 labelled rows is unknown, never 0%",
		}),
		tile({ id: "reopened", label: "Reopened", value: outcomeReport.byKind.find((row) => row.outcomeKind === "reopened")?.count ?? 0, n: outcomes.length, source: outcomeSource, note: "named even at zero: never reopened is a fact about the supervisor", detail: null }),
		tile({ id: "unobserved", label: "Unobserved", value: outcomeReport.byKind.find((row) => row.outcomeKind === "unobserved")?.count ?? 0, n: outcomes.length, source: outcomeSource, note: "judged silent decisions whose pane left the snapshot: no verdict, excluded from precision", detail: null }),
	];

	const recent = decisions
		.slice()
		.sort((a, b) => Date.parse(b.ts) - Date.parse(a.ts))
		.slice(0, ctx.opts.limit)
		.map((decision) => ({
			ts: decision.ts,
			ageSeconds: lagSecondsOf(decision.ts, ctx.now),
			paneId: decision.paneId,
			name: paneName({ label: panesById.get(decision.paneId)?.label ?? null, note: noteOf(source.claims.claims.get(decision.paneId)?.claim), paneId: decision.paneId }),
			group: decision.group,
			op: decision.op,
			model: decision.model,
			confidence: decision.confidence,
			refused: decision.refused,
			escalated: decision.escalated,
			escalationFailed: decision.escalationFailed,
			held: decision.held,
			latencyMs: decision.latencyMs,
			costUsd: decision.costUsd,
			policy: decision.policy,
			decision: decision.decision ?? null,
		}));

	const notes = ["No rate on this screen is quoted without its n. Where the count is too small the report's own sentence is printed instead of a number."];
	if (report.accuracyByDecile === null) notes.push("accuracyByDecile is null: no row carries labelOp. The decile chart draws that as unknown rather than as zero.");
	if (outcomeReport.silence.precision === null) notes.push(`Silent-decision precision needs ${MIN_SILENT_DECISIONS} judged silent decisions; this window has ${outcomeReport.silence.decisions}.`);
	if (decisions.length === 0) notes.push("No decision rows in this window. Try --window=all, or check that the supervisor has run a real tick.");

	return envelope(ctx, {
		route: "decisions",
		screen: "decisions",
		title: "Decisions & outcomes",
		n: decisions.length,
		tiles,
		notes,
		counts: { decisions: decisions.length, outcomes: outcomes.length, inspections: inspections.length, triggers: triggers.length, ticks: ticks.length, labelled: labelledTotal },
		data: {
			report,
			accuracyByDecile: report.accuracyByDecile,
			outcomes: outcomeReport,
			inspections: inspectionReport,
			triggers: triggerReport,
			coverage: coverageOf(events),
			recent,
			recentTotal: decisions.length,
			thresholds: { silentDecisions: MIN_SILENT_DECISIONS },
		},
	});
}

/** The same rows, narrowed to the one rate worth quoting and the verdicts behind it. Kept
 *  separate because the precision's `n` is the single figure a reader is most likely to
 *  misquote. */
export function buildOutcomes(ctx: Ctx): Doc {
	const outcomes = outcomesOf(ctx.events);
	const report = outcomesReport(outcomes);
	const silence = report.silence;
	const source = `events.jsonl, kind=outcome (${ctx.window})`;

	const tiles = [
		tile({
			id: "precision",
			label: "Silent-decision precision",
			value: silence.precision === null ? null : pct(silence.precision),
			unit: silence.precision === null ? "" : "%",
			n: silence.decisions,
			source,
			nullReason: silence.precision === null ? silence.precisionText : null,
			tone: silence.precision === null ? "dim" : "ok",
			note: silence.precisionText,
			detail: `${silence.progressed} progressed, ${silence.stalled} stalled, ${silence.dropped} unobserved; thresholds.silentDecisions is ${silence.threshold}`,
		}),
		tile({ id: "judged", label: "Silent decisions judged", value: silence.decisions, n: silence.decisions, source, detail: "progressed + stalled: the denominator of the precision above" }),
		tile({ id: "outcomes", label: "Outcome rows", value: outcomes.length, n: outcomes.length, source, detail: "one judgment per decision the supervisor re-observed" }),
		tile({ id: "reopened", label: "Reopened", value: report.byKind.find((row) => row.outcomeKind === "reopened")?.count ?? 0, n: outcomes.length, source, note: "printed at zero because never reopened is a fact" }),
		tile({ id: "unobserved", label: "Unobserved", value: report.byKind.find((row) => row.outcomeKind === "unobserved")?.count ?? 0, n: outcomes.length, source, note: "no verdict: the pane left the snapshot, so it is excluded from the precision" }),
	];

	return envelope(ctx, {
		route: "outcomes",
		screen: "outcomes",
		title: "Outcomes",
		n: outcomes.length,
		tiles,
		notes: [
			"Silence plus a still pane is the only direction that is evidence. A pane that moved after a nudge may have moved for any reason, so this rate is deliberately one-sided.",
			silence.precision === null ? `Precision is not quoted below ${silence.threshold} judged silent decisions: ${silence.precisionText}.` : silence.precisionText,
		],
		counts: { outcomes: outcomes.length, silenceDecisions: silence.decisions, progressed: silence.progressed, stalled: silence.stalled, dropped: silence.dropped },
		data: { ...report, threshold: silence.threshold, rows: outcomes.slice().sort((a, b) => Date.parse(b.ts) - Date.parse(a.ts)).slice(0, ctx.opts.limit) },
	});
}

/** Exported for tests: the closed set of kinds these screens read. */
export const DECISION_EVENT_KINDS = ["decision", "outcome", "inspection", "trigger", "tick", "action"] as const;
export type { ActionEvent };
