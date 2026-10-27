// The human report. Tables, not prose: the operator reads this to decide what to
// change, and a rate with no denominator next to it is how a metric lies.
//
// Everything printed here comes from a field of MetricsReport — this file does no
// arithmetic beyond formatting, so the table and the JSON can never disagree.
// A null is printed as an em dash, never as zero: "no rows" and "zero" are
// different facts about a supervisor.

import type { ActionsReport, ClaimsReport, DecisionsReport, Distribution, InspectionsReport, MetricsReport, TicksReport, TriggersReport, WatchdogReport } from "./report.ts";

const DASH = "—";
const INDENT = "  ";

type Cell = string | number;

function indent(lines: readonly string[]): string[] {
	return lines.map((line) => (line === "" ? "" : `${INDENT}${line}`));
}

function looksNumeric(text: string): boolean {
	return /^-?\$?\d[\d,]*(\.\d+)?%?$/.test(text);
}

function pad(text: string, width: number, right: boolean): string {
	return right ? text.padStart(width) : text.padEnd(width);
}

/** Columns sized to their content, numeric columns right-aligned, no borders:
 *  this is read in a terminal, not printed. */
function table(headers: readonly string[], rows: readonly (readonly Cell[])[]): string[] {
	const body = rows.map((row) => row.map((cell) => String(cell)));
	const widths = headers.map((header, column) => {
		let width = header.length;
		for (const row of body) width = Math.max(width, (row[column] ?? "").length);
		return width;
	});
	const right = headers.map((_header, column) => {
		const cells = body.map((row) => row[column] ?? "").filter((cell) => cell !== DASH && cell !== "");
		return cells.length > 0 && cells.every(looksNumeric);
	});
	const render = (cells: readonly string[]): string =>
		cells
			.map((cell, column) => pad(cell, widths[column] ?? cell.length, right[column] === true))
			.join("  ")
			.trimEnd();
	return [render(headers), ...body.map(render)];
}

function num(value: number | null): string {
	return value === null ? DASH : String(value);
}

function int(value: number | null): string {
	return value === null ? DASH : String(Math.round(value));
}

function pct(value: number | null): string {
	return value === null ? DASH : `${(value * 100).toFixed(1)}%`;
}

function usd(value: number | null): string {
	return value === null ? DASH : `$${value.toFixed(6)}`;
}

function ratioText(count: number, total: number, rate: number | null): string {
	return total === 0 ? DASH : `${count}/${total} (${pct(rate)})`;
}

function dist(distribution: Distribution): Array<string | number> {
	return [distribution.n, int(distribution.p50), int(distribution.p95), int(distribution.p99), int(distribution.max)];
}

function distHeaders(first: string): string[] {
	return [first, "n", "p50", "p95", "p99", "max"];
}

function heading(text: string): string {
	return text;
}

// ---------------------------------------------------------------- the sections

function headerBlock(report: MetricsReport): string[] {
	const source = report.source;
	const index = source.indexPath === null ? `${source.indexKind} (in memory)` : `${source.indexPath} (${source.indexKind})`;
	return [
		heading(`fleet metrics · window ${report.window} · group ${report.group ?? "all"} · pane ${report.paneId ?? "all"}`),
		`${INDENT}log    ${source.logPath}`,
		`${INDENT}index  ${index}`,
		`${INDENT}rows   ${source.rows} in this selection · ${source.ignoredRows} line${source.ignoredRows === 1 ? "" : "s"} skipped (pre-schema, legacy or unreadable) · schema v${source.schemaVersion}`,
		`${INDENT}time   ${source.firstTs ?? DASH} → ${source.lastTs ?? DASH} · generated ${report.generatedAt}`,
	];
}

function decisionsSection(report: DecisionsReport): string[] {
	const lines: string[] = [heading(`decisions · ${report.total}`)];

	const opRows = report.opMix.map((entry) => [entry.op, entry.count, pct(entry.share)]);
	lines.push(...indent(table(["op", "count", "share"], opRows)));
	if (report.byGroup.length > 0) {
		lines.push(...indent(["by group", ...indent(table(["group", "count"], report.byGroup.map((entry) => [entry.group, entry.count])))]));
	}

	lines.push(
		...indent([
			`confidence  mean ${report.confidence.mean === null ? DASH : report.confidence.mean.toFixed(3)} · n ${report.confidence.n}`,
			...indent(table(["decile", "range", "count", "share"], report.confidence.deciles.map((decile) => [decile.decile, `${decile.low.toFixed(1)}–${decile.high.toFixed(1)}`, decile.count, pct(decile.share)]))),
		]),
	);

	if (report.accuracyByDecile === null) {
		lines.push(`${INDENT}${INDENT}accuracy by decile  not available: no decision row carries labelOp`);
	} else {
		lines.push(
			...indent([
				"accuracy by decile",
				...indent(table(["decile", "range", "labelled", "correct", "accuracy"], report.accuracyByDecile.map((entry) => [entry.decile, `${entry.low.toFixed(1)}–${entry.high.toFixed(1)}`, entry.labelled, entry.correct, pct(entry.accuracy)]))),
			]),
		);
	}

	lines.push(...indent([`escalation  ${ratioText(report.escalation.escalated, report.escalation.total, report.escalation.rate)} · failed escalations ${ratioText(report.escalation.failed, report.escalation.escalated, report.escalation.failedRate)}`]));

	if (report.refusalByModel.length > 0) {
		lines.push(...indent(["refusal by model", ...indent(table(["model", "decisions", "refused", "rate"], report.refusalByModel.map((entry) => [entry.model, entry.decisions, entry.refused, pct(entry.rate)])))]));
	}
	if (report.latencyByModel.length > 0) {
		lines.push(...indent(["latency by model (ms)", ...indent(table(distHeaders("model"), report.latencyByModel.map((entry) => [entry.model, ...dist(entry)])))]));
	}

	lines.push(...indent([`cost  total ${usd(report.cost.totalUsd)}`]));
	if (report.cost.byModel.length > 0) {
		lines.push(...indent(table(["model", "decisions", "usd", "share"], report.cost.byModel.map((entry) => [entry.model, entry.decisions, usd(entry.totalUsd), pct(entry.share)]))));
	}
	if (report.cost.byDay.length > 0) {
		lines.push(...indent(table(["utc day", "usd"], report.cost.byDay.map((entry) => [entry.day, usd(entry.totalUsd)]))));
	}
	return lines;
}

function actionsSection(report: ActionsReport): string[] {
	const lines: string[] = [heading(`actions · ${report.total}`)];

	lines.push(...indent(table(["disposition", "count", "share"], report.byDisposition.map((entry) => [entry.disposition, entry.count, pct(entry.share)]))));

	lines.push(
		...indent([
			"by op",
			...indent(
				table(
					["op", "total", "sent", "held", "rejected", "skipped", "dry"],
					report.byOp.map((entry) => [entry.op, entry.total, entry.sent, entry.held, entry.rejected, entry.skipped, entry.dry]),
				),
			),
		]),
	);

	if (report.skippedByReason.length > 0) {
		lines.push(...indent(["skipped by reason", ...indent(table(["reason", "count"], report.skippedByReason.map((entry) => [entry.reason, entry.count])))]));
	}
	if (report.rejectedByReason.length > 0) {
		lines.push(...indent(["rejected by reason", ...indent(table(["reason", "count"], report.rejectedByReason.map((entry) => [entry.reason, entry.count])))]));
	}

	lines.push(...indent(["prompt latency (ms)", ...indent(table(distHeaders("actions"), [["sent/refused", ...dist(report.latencyMs)]]))]));

	const hold = report.hold;
	lines.push(...indent([`hold  ${ratioText(hold.held, hold.gated, hold.rate)} of gated actions`]));
	if (hold.byPolicy.length > 0) {
		lines.push(...indent(["by policy", ...indent(table(["policy", "gated", "held", "rate"], hold.byPolicy.map((entry) => [entry.policy, entry.gated, entry.held, pct(entry.rate)])))]));
	}
	if (hold.byForkKind.length > 0) {
		lines.push(...indent(["by fork kind", ...indent(table(["fork", "gated", "held", "rate"], hold.byForkKind.map((entry) => [entry.kind, entry.gated, entry.held, pct(entry.rate)])))]));
	}
	return lines;
}

function ticksSection(report: TicksReport): string[] {
	const lines: string[] = [heading(`ticks · ${report.total}${report.dry > 0 ? ` (${report.dry} dry)` : ""}`)];
	lines.push(
		...indent(
			table(
				["per tick", "total", "mean", "max"],
				[
					["agents", DASH, report.agents.mean === null ? DASH : report.agents.mean.toFixed(2), report.agents.max],
					["moved", report.moved.total, report.moved.mean === null ? DASH : report.moved.mean.toFixed(2), report.moved.max],
					["decisions", report.decisions.total, report.decisions.mean === null ? DASH : report.decisions.mean.toFixed(2), DASH],
					["inspected", report.inspected.total, report.inspected.mean === null ? DASH : report.inspected.mean.toFixed(2), report.inspected.max],
					["prompts", report.prompts.total, report.prompts.mean === null ? DASH : report.prompts.mean.toFixed(2), DASH],
					["held", report.held.total, report.held.mean === null ? DASH : report.held.mean.toFixed(2), DASH],
				],
			),
		),
	);
	lines.push(...indent([`duration  ${distSummary(report.durationMs)} ms`]));
	lines.push(...indent([`cost  total ${usd(report.costUsd.total)} · mean ${usd(report.costUsd.mean)} per tick`]));
	if (report.models.length > 0) {
		lines.push(...indent(["models consulted", ...indent(table(["model", "ticks"], report.models.map((entry) => [entry.model, entry.ticks])))]));
	}
	return lines;
}

function distSummary(distribution: Distribution): string {
	return `n ${distribution.n} · p50 ${int(distribution.p50)} · p95 ${int(distribution.p95)} · p99 ${int(distribution.p99)} · max ${int(distribution.max)}`;
}

function triggersSection(report: TriggersReport): string[] {
	const lines: string[] = [heading(`triggers · ${report.total}`)];
	if (report.byKind.length > 0) {
		lines.push(...indent(table(["kind", "count", "share"], report.byKind.map((entry) => [entry.kind, entry.count, pct(entry.share)]))));
	}
	lines.push(...indent([`per tick ${report.perTick === null ? DASH : report.perTick.toFixed(3)} · inspected share ${pct(report.inspectedShare)}`]));
	return lines;
}

function inspectionsSection(report: InspectionsReport): string[] {
	const lines: string[] = [heading(`inspections · ${report.total}`)];
	if (report.byMode.length > 0) {
		lines.push(...indent(table(["mode", "count"], report.byMode.map((entry) => [entry.mode, entry.count]))));
	}
	if (report.byTriggerKind.length > 0) {
		lines.push(...indent(table(["trigger", "inspected", "proposed", "yield"], report.byTriggerKind.map((entry) => [entry.kind, entry.count, entry.proposed, pct(entry.rate)]))));
	}
	lines.push(...indent([`proposed  ${ratioText(report.proposed.count, report.total, report.proposed.rate)} · degraded ${ratioText(report.degraded.count, report.total, report.degraded.rate)}`]));
	lines.push(...indent([`cost  total ${usd(report.costUsd.total)} · mean ${usd(report.costUsd.mean)} per inspection · per tick ${report.perTick === null ? DASH : report.perTick.toFixed(3)}`]));
	lines.push(...indent([`latency  ${distSummary(report.latencyMs)} ms`]));
	return lines;
}

function watchdogSection(report: WatchdogReport): string[] {
	const lines: string[] = [heading(`watchdog · ${report.total}`)];
	if (report.byRule.length > 0) {
		lines.push(...indent(table(["rule", "count"], report.byRule.map((entry) => [entry.rule, entry.count]))));
	}
	lines.push(...indent([`stalled  ${ratioText(report.stalled.stalled, report.stalled.tested, report.stalled.rate)} of tested (only a re-sampling scan tests)`]));
	return lines;
}

function claimsSection(report: ClaimsReport): string[] {
	const lines: string[] = [heading(`claims · ${report.total}`)];
	if (report.byState.length > 0) {
		lines.push(...indent(table(["state", "count", "share"], report.byState.map((entry) => [entry.state, entry.count, pct(entry.share)]))));
	}
	lines.push(...indent([`diverged  ${ratioText(report.diverged.count, report.total, report.diverged.rate)} · age ${distSummary(report.ageMs)} ms`]));
	return lines;
}

function coverageSection(report: MetricsReport): string[] {
	const missing = report.coverage.filter((entry) => entry.absent > 0);
	if (missing.length === 0) return [];
	return [heading("field coverage · absent in this selection"), ...indent(table(["kind", "field", "present", "absent"], missing.map((entry) => [entry.kind, entry.field, entry.present, entry.absent])))];
}

/** The whole report as text, in section order. */
export function formatReport(report: MetricsReport): string {
	const blocks: string[][] = [
		headerBlock(report),
		decisionsSection(report.decisions),
		actionsSection(report.actions),
		ticksSection(report.ticks),
		triggersSection(report.triggers),
		inspectionsSection(report.inspections),
		watchdogSection(report.watchdog),
		claimsSection(report.claims),
		coverageSection(report),
	];

	if (report.notes.length > 0) blocks.push([heading("notes"), ...report.notes.map((note) => `${INDENT}- ${note}`)]);

	return `${blocks
		.filter((block) => block.length > 0)
		.map((block) => block.join("\n"))
		.join("\n\n")}\n`;
}
