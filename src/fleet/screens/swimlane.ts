// The lane view: one lane per repo / worktree, one row per pane inside it.
//
// It answers the question a table cannot answer at a glance: which repo has how much work
// in it, where it is stalled, and which lanes have more than one pane reporting `working`
// at the same time.
//
// Two rules hold this together:
//
//   * the geometry is computed here, not in a browser, and it is a pure function of the
//     rows: the same data produces byte-identical lane and row order on every run. There
//     is no force-directed anything and no jitter on change.
//   * every mark is a row. A filled activity cell means the log carries a typed row for
//     that pane inside that tick's window; an empty cell means it does not. The per-tick
//     completion counter is not in the log, so it is not drawn.
//
// What the lanes omit is as much a decision as what they show: the two herdr counters, the
// model and confidence of the last decision, per-pane cost and the terminal tail all stay
// in the table and the pane screen. The overhead view is for "where is the work", not for
// "prove this number".

import { attentionItems } from "../attention.ts";
import { envelope, lagSecondsOf, tile } from "../envelope.ts";
import { applyFilter, compareRows, filterCounts, record, COMPARATOR_PLAIN, type Rec } from "../record.ts";
import { fleetScale, paneListSource } from "../source.ts";
import { answerVerb } from "../where.ts";
import type { Ctx, Doc } from "../types.ts";
import type { SchemaEvent } from "../../metrics/schema.ts";

const STATE_RANK: Readonly<Record<string, number>> = { blocked: 0, working: 1, unknown: 2, idle: 3, done: 4 };
const STATE_TONE: Readonly<Record<string, string>> = { blocked: "bad", working: "ok", unknown: "dim", idle: "neutral", done: "info" };
const MAX_CELLS = 12;

function stateRank(status: string): number {
	return STATE_RANK[status] ?? STATE_RANK.unknown ?? 2;
}

export interface TickWindow {
	ts: string;
	from: number;
	to: number;
	moved: number | null;
	agents: number | null;
}

/** The tick windows, newest last. A window runs from a tick's own timestamp to the next
 *  tick's, and the newest window is one interval long because nothing has closed it yet.
 *  With no tick row there is no axis at all, and the lanes say so rather than drawing an
 *  empty strip that reads as "nothing moved". */
export function tickWindows(tickRows: SchemaEvent[], intervalMs: number): TickWindow[] {
	const sorted = tickRows.slice().sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));
	const cells = sorted.slice(-MAX_CELLS);
	return cells.map((tick, index) => {
		const start = Date.parse(tick.ts);
		const next = index + 1 < cells.length ? Date.parse(cells[index + 1]?.ts ?? "") : start + intervalMs;
		return {
			ts: tick.ts,
			from: start,
			to: Number.isFinite(next) ? next : start + intervalMs,
			moved: tick.kind === "tick" ? tick.moved : null,
			agents: tick.kind === "tick" ? tick.agents : null,
		};
	});
}

/** Which windows each pane left a typed row in. `typedAt` is deliberately the per-pane
 *  timestamp list rather than a live comparison, so this stays a pure function of the log. */
export function activityByPane(rows: Rec[], events: SchemaEvent[], windows: TickWindow[]): Map<string, boolean[]> {
	const times = new Map<string, number[]>();
	for (const event of events) {
		if (!("paneId" in event)) continue;
		const paneId = (event as { paneId?: unknown }).paneId;
		if (typeof paneId !== "string") continue;
		const at = Date.parse(event.ts);
		if (!Number.isFinite(at)) continue;
		const list = times.get(paneId);
		if (list === undefined) times.set(paneId, [at]);
		else list.push(at);
	}
	const out = new Map<string, boolean[]>();
	for (const row of rows) {
		const list = times.get(row.paneId) ?? [];
		out.set(row.paneId, windows.map((window) => list.some((at) => at >= window.from && at < window.to)));
	}
	return out;
}

function lastOpOf(row: Rec): Record<string, unknown> | null {
	const decision = row.lastDecision;
	const action = row.lastAction;
	if (decision === null && action === null) return null;
	const decisionAt = decision === null ? -Infinity : Date.parse(String(decision.ts ?? ""));
	const actionAt = action === null ? -Infinity : Date.parse(String(action.ts ?? ""));
	const newer = decisionAt >= actionAt ? decision : action;
	if (newer === null) return null;
	return {
		op: newer.op ?? null,
		ts: newer.ts ?? null,
		from: decisionAt >= actionAt ? "decision" : "action",
		disposition: newer.disposition ?? null,
		refused: newer.refused === true,
	};
}

function laneRow(row: Rec, activity: boolean[] | null): Record<string, unknown> {
	return {
		paneId: row.paneId,
		name: row.name,
		href: `#/pane/${encodeURIComponent(row.paneId)}`,
		status: row.status,
		statusShape: row.status,
		verdict: row.verdict,
		session: row.session,
		idleTicks: row.idleTicks,
		claimState: row.claim.present ? (row.claim.state ?? null) : null,
		claimAgeSeconds: row.claim.present ? row.claim.ageSeconds : null,
		stateAge: row.stateAge,
		triage: row.triage,
		diverged: row.diverged,
		focused: row.focused,
		lastOp: lastOpOf(row),
		activity,
		activityRows: activity === null ? 0 : activity.filter(Boolean).length,
	};
}

function laneAggregate(rows: Rec[]): { worst: string; tone: string; counts: Record<string, number> } {
	const counts: Record<string, number> = { blocked: 0, working: 0, unknown: 0, idle: 0, done: 0 };
	for (const row of rows) {
		const key = row.status in counts ? row.status : "unknown";
		counts[key] = (counts[key] ?? 0) + 1;
	}
	const worst = Object.keys(counts).sort((a, b) => stateRank(a) - stateRank(b)).find((status) => (counts[status] ?? 0) > 0) ?? "unknown";
	return { worst, tone: STATE_TONE[worst] ?? "neutral", counts };
}

/**
 * Lanes, in the order the page draws them, with every number that decides the geometry
 * fixed here. A lane's place is the place of its worst row, so the lane holding the
 * blocked pane is first rather than the lane that happens to have the most panes. Inside a
 * class, the bigger lane first, then by name.
 */
export function layoutLanes(args: { rows: Rec[]; orphans: { triage: Rec["triage"] }[]; events: SchemaEvent[]; tickRows: SchemaEvent[]; intervalMs: number }): Record<string, unknown> {
	const windows = tickWindows(args.tickRows, args.intervalMs);
	const activity = windows.length === 0 ? null : activityByPane(args.rows, args.events, windows);

	const byGroup = new Map<string, { name: string; rows: Rec[] }>();
	for (const row of args.rows) {
		const key = row.group || "unknown";
		const lane = byGroup.get(key) ?? { name: key, rows: [] };
		lane.rows.push(row);
		byGroup.set(key, lane);
	}

	const lanes = [...byGroup.values()].map((lane) => {
		const sorted = lane.rows.slice().sort(compareRows);
		const drawn = sorted.map((row) => laneRow(row, activity === null ? null : (activity.get(row.paneId) ?? null)));
		const aggregate = laneAggregate(sorted);

		// The bracket is drawn over an adjacent run of `working` rows, and the caption says
		// how many of the lane's working panes that run holds, so it can never claim more
		// than it covers. It does not claim a file-level conflict: the log carries no lock data.
		let bracket: Record<string, unknown> | null = null;
		const firstWorking = drawn.findIndex((row) => row.status === "working");
		if (firstWorking >= 0) {
			let last = firstWorking;
			while (last + 1 < drawn.length && drawn[last + 1]?.status === "working") last += 1;
			const count = last - firstWorking + 1;
			const total = aggregate.counts.working ?? 0;
			if (count >= 2) {
				bracket = {
					from: firstWorking,
					to: last,
					count,
					caption: count === total ? `${count} working at once` : `${count} of ${total} working at once`,
					note: "same worktree, both report working. The log records no file-level locking, so this is co-presence, not proof of a conflict.",
				};
			}
		}

		return {
			name: lane.name,
			paneCount: drawn.length,
			state: aggregate,
			rank: sorted.length === 0 ? null : (sorted[0]?.triage.rank ?? null),
			rankLabel: sorted.length === 0 ? null : (sorted[0]?.triage.rankLabel ?? null),
			bracket,
			workingAtOnce: aggregate.counts.working ?? 0,
			rowsInLog: drawn.reduce((sum, row) => sum + (typeof row.activityRows === "number" ? row.activityRows : 0), 0),
			rows: drawn,
		};
	});

	lanes.sort((a, b) => {
		const rankA = a.rank === null ? Number.MAX_SAFE_INTEGER : a.rank;
		const rankB = b.rank === null ? Number.MAX_SAFE_INTEGER : b.rank;
		if (rankA !== rankB) return rankA - rankB;
		if (a.paneCount !== b.paneCount) return b.paneCount - a.paneCount;
		return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
	});

	return {
		lanes,
		orphans: args.orphans,
		windows,
		encoding: {
			position: "lane order and row order are computed here and are a pure function of the rows: same data, same geometry",
			size: "one row per pane, fixed height; the activity strip has one cell per tick window, newest right",
			colour: "lane aggregate and row status use the status palette; the word is always beside the colour",
			shape: "status glyph differs per state (filled disc, hollow ring, triangle, square, dashed ring) so colour is never the only channel",
			motion: "none. nothing animates, so nothing implies a change that did not happen",
			activity:
				windows.length === 0
					? "no tick row in the log, so no strip is drawn: an empty strip would read as 'nothing moved' when the truth is 'nothing observed'"
					: `a filled cell means the log carries a typed row for this pane inside that tick's window (${windows.length} window(s) shown). The per-tick completion counter is not in the log and is not drawn.`,
			omits: ["completion and state-change counters", "the deciding model, its confidence and its cost", "per-pane cost and token counts", "the terminal tail", "the full claim text"],
			omitsWhy: "those live in the row table and on the pane screen. The overhead view is for where the work is, not for proving a number.",
		},
		laneCount: lanes.length,
		orphanCount: args.orphans.length,
	};
}

function laneTiles(ctx: Ctx, layout: Record<string, unknown>, rows: Rec[]) {
	const paneSource = paneListSource(ctx.source).label;
	const scale = fleetScale(ctx.source);
	const lanes = layout.lanes as { bracket: unknown }[];
	const windows = layout.windows as unknown[];
	return [
		tile({ id: "lanes", label: "Repos", value: lanes.length, n: rows.length, source: paneSource, detail: "one lane per repo or worktree bucket" }),
		tile({ id: "panes", label: "Panes", value: rows.length, n: rows.length, of: scale.total === null ? null : { value: scale.total, source: scale.totalSource }, source: paneSource, detail: scale.why }),
		tile({
			id: "workingAtOnce",
			label: "Lanes with 2+ working",
			value: lanes.filter((lane) => lane.bracket !== null).length,
			n: lanes.length,
			source: paneSource,
			tone: lanes.some((lane) => lane.bracket !== null) ? "warn" : "neutral",
			detail: "lanes where more than one pane reports working in the same worktree. Co-presence, not a proven conflict",
		}),
		tile({ id: "blocked", label: "Blocked", value: rows.filter((row) => row.status === "blocked").length, n: rows.length, source: paneSource, tone: rows.some((row) => row.status === "blocked") ? "bad" : "neutral", detail: "panes that report blocked: the one status that will not resolve itself" }),
		tile({
			id: "activity",
			label: "Tick windows",
			value: windows.length === 0 ? null : windows.length,
			n: windows.length,
			source: "events.jsonl (tick rows)",
			nullReason: "no tick row in the log, so there is no time axis to draw",
			detail: "the last N tick windows the activity strip covers",
		}),
	];
}

/** The same builder serves the route and the dump, which is the rule for every screen.
 *  `filter` narrows the lanes to the rows one chip counts, so the same filter can be
 *  checked in both views. */
export function buildSwimlane(ctx: Ctx): Doc {
	const set = record(ctx);
	const filter = ctx.opts.filter ?? null;
	const selected = applyFilter(set, filter);
	const ticks = ctx.allByKind("tick");
	const layout = layoutLanes({ rows: selected.panes, orphans: selected.orphans, events: ctx.allEvents, tickRows: ticks, intervalMs: ctx.opts.intervalMs });
	const lanes = layout.lanes as { bracket: unknown }[];
	const windows = layout.windows as { ts: string }[];
	const filterCount = filterCounts(set, Object.fromEntries(attentionItems(ctx).map((item) => [item.id, item.count])));

	const notes: string[] = [];
	if (windows.length === 0) notes.push("No tick row in the log, so the activity strip is absent rather than empty. An empty strip would say 'nothing moved' when the truth is 'nothing observed'.");
	if ((layout.orphanCount as number) > 0) notes.push(`${layout.orphanCount as number} claim file(s) belong to panes that are not in this agent list. They are listed under the lanes and never merged into one.`);
	if (lanes.some((lane) => lane.bracket !== null)) notes.push("A bracket marks two or more panes in one worktree reporting `working` at the same time. That is co-presence from the same agent list, not evidence of a file-level conflict.");
	if (filter !== null) notes.push(`Filtered to \`${filter}\`: ${selected.panesMatched} of ${set.rows.length} panes are drawn. Lane order is still by consequence, so a lane that survives the filter keeps its place among its survivors.`);

	return envelope(ctx, {
		route: "swimlane",
		screen: "swimlane",
		title: "Lanes",
		n: selected.panes.length,
		tiles: laneTiles(ctx, layout, selected.panes),
		notes,
		counts: { lanes: layout.laneCount as number, panes: set.rows.length, matched: selected.panes.length, orphans: layout.orphanCount as number, windows: windows.length, filter },
		data: {
			lanes: layout.lanes,
			orphans: layout.orphans,
			windows: layout.windows,
			encoding: layout.encoding,
			triage: {
				filter,
				comparator: COMPARATOR_PLAIN,
				filters: filterCount,
				order: "a lane takes the rank of its worst row, so the lane holding the blocked pane is drawn first",
			},
			intervalMs: ctx.opts.intervalMs,
			askCommand: (layout.orphanCount as number) > 0 ? answerVerb(ctx.opts.agentFleetRoot || "", "<id>", "yes") : null,
			newestTickAge: windows.length === 0 ? null : lagSecondsOf(windows[windows.length - 1]?.ts ?? null, ctx.now),
		},
	});
}
