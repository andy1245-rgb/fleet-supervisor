// The fleet overview and the pane detail — the two screens that read the record.
//
// The overview's job is one glance: which panes moved, which are quiet, and which claim
// does not match its pane. That means the counters matter more than the status word, and
// the verdict is carried as its own word rather than as a colour.
//
// Both builders read `record(ctx)` and nothing else. That is the whole point: the fleet
// screen, the lane view, the pane detail screen and `fleet-manager panes` are four
// renderings of one set of records, so four surfaces cannot disagree about a name, a
// verdict or a rank.

import { attentionItems } from "../attention.ts";
import { envelope, lagSecondsOf, tile } from "../envelope.ts";
import { applyFilter, filterCounts, record, rowsForPane, CONSEQUENCE_ORDER, COMPARATOR_PLAIN, FILTERS, type Rec } from "../record.ts";
import { fleetScale, paneListSource } from "../source.ts";
import { STATE_AGE_FORMULA, STATE_AGE_NO_ROWS, stateAgeFor } from "../state-age.ts";
import { noteOf, paneName } from "../name.ts";
import { tail } from "../reader.ts";
import type { Ctx, Doc, Source } from "../types.ts";
import { buildSwimlane } from "./swimlane.ts";

const VERDICT_TONE: Readonly<Record<string, string>> = { live: "ok", stale: "warn", orphaned: "bad", "never claimed": "dim" };

/** The only numbers allowed to colour a tile, and the line each one has to cross. A
 *  tile's left edge reads as urgency, so a tile is grey unless its number is past a
 *  threshold stated here. Seven of these eight tiles used to carry a coloured edge and
 *  most were coloured for being normal: a live claim is what a claim is supposed to be. */
const TILE_THRESHOLDS = {
	heldAsksAbove: 0,
	failuresAbove: 0,
	staleClaimsAbove: 0,
	orphanClaimsAbove: 0,
	/** Fallback only: the supervisor states its own daily cap on every tick row, and a
	 *  number the supervisor wrote about itself beats a number guessed here. Null is not
	 *  0 — "spent more than nothing" is not a fault. */
	dailyCostUsdAbove: null as number | null,
};

function past(value: unknown, threshold: number | null): boolean {
	return typeof threshold === "number" && typeof value === "number" && value > threshold;
}

/** At or past a threshold, for the one line here that is a cap rather than a symptom: the
 *  supervisor stops spending *at* its cap, not after it. */
function atOrPast(value: unknown, threshold: number | null): boolean {
	return typeof threshold === "number" && typeof value === "number" && value >= threshold;
}

function countVerdict(rows: Rec[], verdict: string): number {
	return rows.filter((row) => row.verdict === verdict).length;
}

/** Dollars at the width the number needs: a tick costs milli-cents, and printing $0.00
 *  for it would be a lie by rounding. */
function money(value: number): string {
	const abs = Math.abs(value);
	if (abs === 0) return "$0";
	if (abs < 0.01) return `$${value.toFixed(6)}`;
	if (abs < 1) return `$${value.toFixed(4)}`;
	return `$${value.toFixed(2)}`;
}

function decisionSpendNote(decisionUsd: number, decisionRows: number): string {
	if (decisionRows === 0) return "no decision rows in this window";
	return `+ ${money(decisionUsd)} on decision rows, not added`;
}

function prettyAge(ts: string, now: number): string {
	const seconds = lagSecondsOf(ts, now);
	if (seconds === null) return "age unknown";
	if (seconds < 90) return `${seconds}s ago`;
	if (seconds < 5400) return `${Math.round(seconds / 60)}m ago`;
	return `${(seconds / 3600).toFixed(1)}h ago`;
}

/** The failures in this window, as a partition that adds up to its own headline. */
function failureTally(ctx: Ctx): { total: number; refused: number; escalationFailed: number; filtered: number; decisions: number; actions: number; note: string; source: string; detail: string } {
	const decisions = ctx.events.filter((event) => event.kind === "decision");
	const actions = ctx.events.filter((event) => event.kind === "action");
	const refused = decisions.filter((decision) => decision.kind === "decision" && decision.refused === true);
	const escalationFailed = decisions.filter((decision) => decision.kind === "decision" && decision.escalationFailed === true);
	const filtered = actions.filter((action) => action.kind === "action" && action.disposition === "skipped");

	const alsoFailed = refused.filter((decision) => decision.kind === "decision" && decision.escalationFailed === true).length;
	const escalationOnly = escalationFailed.length - alsoFailed;
	const total = refused.length + escalationOnly + filtered.length;

	const parts = [
		`${refused.length} refused${alsoFailed > 0 ? ` (${alsoFailed} also failed escalation)` : ""}`,
		escalationOnly > 0 ? `${escalationOnly} escalation failed, not refused` : null,
		`${filtered.length} filtered`,
	];

	return {
		total,
		refused: refused.length,
		escalationFailed: escalationFailed.length,
		filtered: filtered.length,
		decisions: decisions.length,
		actions: actions.length,
		note: parts.filter((part) => part !== null).join(" · "),
		source: `events.jsonl, kind=decision and kind=action (${ctx.window})`,
		detail:
			"three disjoint groups: a refused decision, an escalation that failed without a refusal, and an action the rules filtered out before it could become one. A refused decision that also failed its escalation is one row and is counted once, in the parenthetical",
	};
}

/** What this window cost. The tick total and the decision total are not additive — a tick
 *  prices the whole ladder trail, a decision prices one model. */
function spendInWindow(ctx: Ctx): { tickUsd: number; decisionUsd: number; ticks: number; decisions: number } {
	const ticks = ctx.events.filter((event) => event.kind === "tick");
	const decisions = ctx.events.filter((event) => event.kind === "decision");
	return {
		tickUsd: ticks.reduce((sum, tick) => sum + (tick.kind === "tick" ? tick.costUsd : 0), 0),
		decisionUsd: decisions.reduce((sum, decision) => sum + (decision.kind === "decision" ? decision.costUsd : 0), 0),
		ticks: ticks.length,
		decisions: decisions.length,
	};
}

export function buildFleet(ctx: Ctx): Doc {
	const { source, now, opts } = ctx;
	const set = record(ctx);
	const filter = opts.filter ?? null;
	const selected = applyFilter(set, filter);
	const attentionCounts = Object.fromEntries(attentionItems(ctx).map((item) => [item.id, item.count]));
	const filters = filterCounts(set, attentionCounts);
	const ticks = ctx.allByKind("tick");
	const newestTick = ticks.length === 0 ? null : ticks.reduce((a, b) => (Date.parse(a.ts) >= Date.parse(b.ts) ? a : b));

	const rows = set.rows;
	const orphans = set.orphans;
	const verdictRows: { verdict: string }[] = [...rows, ...orphans];

	const byStatus: Record<string, number> = {};
	for (const row of rows) byStatus[row.status] = (byStatus[row.status] ?? 0) + 1;
	const byVerdict: Record<string, number> = {};
	for (const row of verdictRows) byVerdict[row.verdict] = (byVerdict[row.verdict] ?? 0) + 1;

	const claimSource = "claims dir";
	const claimSourceLong = `claims dir (${source.registryDir})`;
	const paneSource = paneListSource(source).label;
	const scale = fleetScale(source);
	const failures = failureTally(ctx);
	const spend = spendInWindow(ctx);

	const capUsd = newestTick !== null && newestTick.kind === "tick" && typeof newestTick.dailyCostCapUsd === "number" ? newestTick.dailyCostCapUsd : TILE_THRESHOLDS.dailyCostUsdAbove;
	const dayUsd = newestTick !== null && newestTick.kind === "tick" && typeof newestTick.dailyCostUsd === "number" ? newestTick.dailyCostUsd : null;
	const dayNote = capUsd === null || dayUsd === null ? null : `${money(dayUsd)} of the ${money(capUsd)} daily cap today`;
	const moved = newestTick !== null && newestTick.kind === "tick" ? newestTick.moved : null;
	const agents = newestTick !== null && newestTick.kind === "tick" ? newestTick.agents : null;

	const tiles = [
		tile({ id: "panes", label: "Panes", value: rows.length, n: rows.length, source: paneSource, detail: `the pane list this load read. The fleet it belongs to is stated once, above: ${scale.line}` }),
		tile({
			id: "moved",
			label: "Moved last tick",
			value: moved,
			n: newestTick === null ? 0 : 1,
			source: "events.jsonl (newest tick row)",
			nullReason: newestTick === null ? "no tick row in the log, so nothing has been observed yet" : null,
			note: newestTick === null ? null : `of ${agents ?? 0} agents, ${prettyAge(newestTick.ts, now)}`,
			detail: "agents whose completion counter advanced since the previous tick",
		}),
		tile({
			id: "queue",
			label: "Queue depth",
			value: source.asks.pending.length,
			n: source.asks.log.size,
			source: "asks.jsonl (folded)",
			tone: past(source.asks.pending.length, TILE_THRESHOLDS.heldAsksAbove) ? "warn" : "neutral",
			detail: "asks the gate parked: held actions nobody has released, each one naming the exact command that releases it",
		}),
		tile({ id: "failures", label: "Failures, this window", value: failures.total, n: failures.decisions + failures.actions, source: failures.source, tone: past(failures.total, TILE_THRESHOLDS.failuresAbove) ? "warn" : "neutral", note: failures.note, detail: failures.detail }),
		tile({
			id: "cost",
			label: `Cost, ${ctx.window}`,
			value: Number(spend.tickUsd.toFixed(6)),
			format: "usd",
			n: spend.ticks,
			source: `events.jsonl, kind=tick (${ctx.window})`,
			nullReason: spend.ticks === 0 ? "no tick row in this window, so nothing priced it" : null,
			tone: past(spend.tickUsd, capUsd) || atOrPast(dayUsd, capUsd) ? "warn" : "neutral",
			note: [decisionSpendNote(spend.decisionUsd, spend.decisions), dayNote].filter((part) => part !== null).join(" · "),
			detail:
				capUsd === null
					? "the tick row is the only row that prices a whole tick, ladder trails included. The decision rows are not added to it: they price one model each. No tick row in this log states a daily cap, so this tile has no threshold to cross and stays grey"
					: `the tick row is the only row that prices a whole tick. Coloured above the ${money(capUsd)} daily cap the supervisor states, from AGENTFLEET_DAILY_COST_CAP_USD. Two numbers can be over it and both are checked: this window's spend, and the day's`,
		}),
		tile({ id: "claimed", label: "Claims live", value: countVerdict(rows, "live"), n: verdictRows.length, source: claimSource, sourceLong: claimSourceLong, detail: "claim file present and newer than 3 ticks. Grey on purpose: a live claim is the normal case and colouring it says the calm half is news" }),
		tile({ id: "stale", label: "Claims stale", value: countVerdict(rows, "stale"), n: verdictRows.length, source: claimSource, sourceLong: claimSourceLong, tone: past(countVerdict(rows, "stale"), TILE_THRESHOLDS.staleClaimsAbove) ? "warn" : "neutral", detail: "pane is live but its claim is older than 3× the tick interval, or its `updated` will not parse" }),
		tile({ id: "orphaned", label: "Orphaned claims", value: orphans.length, n: verdictRows.length, source: claimSource, sourceLong: claimSourceLong, tone: past(orphans.length, TILE_THRESHOLDS.orphanClaimsAbove) ? "bad" : "neutral", detail: "a claim file whose pane is not in this pane list; nothing in this tree deletes one" }),
	];

	const withStateAge = rows.filter((row) => row.stateAge?.seconds !== null && row.stateAge?.seconds !== undefined).length;

	const notes: string[] = [];
	if (source.panes.origin !== "herdr") notes.push(`Pane list did not come from herdr: ${source.panes.reason ?? source.panes.origin}`);
	if (orphans.length > 0) notes.push(`${orphans.length} claim file(s) belong to panes that are no longer listed. Nothing in the tree deletes a claim, so this page shows them and leaves them alone.`);
	if (rows.some((row) => row.diverged)) notes.push("At least one pane claims `working` while herdr reports something else. That divergence is the case the supervisor exists to catch.");
	notes.push(
		`State age is derived for ${withStateAge} of ${rows.length} panes from the rows that record a status. ${withStateAge === rows.length ? "Every row here has one." : `The other ${rows.length - withStateAge} print a dash and say why in place of a number: ${STATE_AGE_NO_ROWS}, and the claim age is a different measurement so it is never printed there instead.`}`,
	);
	if (filter !== null) {
		const selectedFilter = filters.find((entry) => entry.id === filter);
		notes.push(
			`Filtered to \`${filter}\`${selectedFilter === undefined ? "" : ` (${selectedFilter.label})`}: ${selected.panesMatched} pane row(s) and ${selected.orphansMatched} orphan claim(s) of ${rows.length} panes and ${orphans.length} orphans. The count is the same computation as the chip: ${selectedFilter?.count ?? "unknown"}.`,
		);
	}

	return envelope(ctx, {
		route: "fleet",
		screen: "fleet",
		title: "Fleet overview",
		n: selected.panes.length,
		tiles,
		notes,
		counts: {
			panes: rows.length,
			matched: selected.panes.length,
			orphans: orphans.length,
			orphansMatched: selected.orphans.length,
			filter,
			claims: source.claims.claims.size,
			heldAsks: source.asks.pending.length,
		},
		data: {
			panes: selected.panes,
			orphans: selected.orphans,
			triage: {
				filter,
				filters,
				order: CONSEQUENCE_ORDER,
				comparator: COMPARATOR_PLAIN,
				available: FILTERS.map((entry) => entry.id),
				totals: { panes: rows.length, orphans: orphans.length, panesMatched: selected.panesMatched, orphansMatched: selected.orphansMatched, matched: selected.panesMatched + selected.orphansMatched },
				stateAge: {
					formula: STATE_AGE_FORMULA,
					derived: withStateAge,
					of: rows.length,
					unavailable: STATE_AGE_NO_ROWS,
					bounds: "seconds is a floor (the pane entered this state no later than that row) and atMostSeconds is a ceiling from the newest row that disagreed. atMostSeconds is null when no row in the log ever saw a different status, so the floor is the only bound there is.",
				},
			},
			lanes: buildSwimlane(ctx).data,
			summary: { byStatus, byVerdict },
			newestTick:
				newestTick !== null && newestTick.kind === "tick"
					? {
							ts: newestTick.ts,
							ageSeconds: lagSecondsOf(newestTick.ts, now),
							agents: newestTick.agents,
							moved: newestTick.moved,
							decisions: newestTick.decisions,
							held: newestTick.held,
							prompts: newestTick.prompts,
							dry: newestTick.dry,
							costUsd: newestTick.costUsd,
							durationMs: newestTick.durationMs,
							models: newestTick.models,
						}
					: null,
			tickSeries: ticks
				.filter((tick) => tick.kind === "tick")
				.slice()
				.sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts))
				.slice(-24)
				.map((tick) => ({ ts: tick.ts, moved: tick.kind === "tick" ? tick.moved : null, agents: tick.kind === "tick" ? tick.agents : null, decisions: tick.kind === "tick" ? tick.decisions : null, costUsd: tick.kind === "tick" ? tick.costUsd : null })),
			marks: source.marks,
			policy: source.policy,
			intervalMs: opts.intervalMs,
			staleAfterSeconds: Math.round(ctx.staleAfterMs / 1000),
			home: opts.home,
		},
	});
}

/** The pane detail: four blocks, plus the group's policy in the header, plus the two
 *  counts that must never merge — typed rows for this pane and untyped ones. */
export async function buildPane(ctx: Ctx, paneId: string, options: { tailLines?: number } = {}): Promise<Doc> {
	const { source, now, opts } = ctx;
	const tailLines = options.tailLines ?? 0;
	const set = record(ctx);
	const found = set.rows.find((row) => row.paneId === paneId);
	const claimEntry = source.claims.claims.get(paneId);
	const untypedForPane = source.events.untyped.filter((row) => row.paneId === paneId);
	const typedForPane = rowsForPane(ctx.allEvents, paneId).sort((a, b) => Date.parse(b.ts) - Date.parse(a.ts));
	const asksForPane = [...source.asks.log.values()].filter((record_) => record_.paneId === paneId);

	// A pane that has left the list can still have a claim, and a claim still has an
	// intent: the header keeps a name even when the row is gone.
	const name = found?.name ?? paneName({ note: noteOf(claimEntry?.claim), paneId });

	const paneRow = source.panes.panes.find((row) => row.pane_id === paneId);
	const stateAge = paneRow === undefined ? null : (stateAgeFor({ allEvents: ctx.allEvents, panes: [paneRow], now }).get(paneId) ?? null);

	const decisionRows = typedForPane.filter((event) => event.kind === "decision");
	const outcomeRows = typedForPane.filter((event) => event.kind === "outcome");
	const decisionCost = decisionRows.reduce((sum, row) => sum + (row.kind === "decision" ? row.costUsd : 0), 0);
	const group = found?.group ?? "";
	const policy = (source.policy[group] ?? source.policy.__default ?? null) as unknown;

	const tailRead =
		tailLines > 0
			? await tail({ paneId, lines: tailLines, ctx: { fixtureDir: source.mode === "fixture" ? source.stateDir : opts.fixtureDir, herdr: opts.herdr, mode: source.mode } })
			: { lines: null as string | null, reason: "not requested — the terminal tail is read on demand only, never polled", ts: null as string | null, origin: null as string | null };

	const claimSource = `claims dir (${source.registryDir})`;
	const paneList = paneListSource(source);
	const absentReason = `this pane is not in ${paneList.short}`;
	const status = paneRow?.agent_status ?? "not listed";
	const verdict = found?.verdict ?? (claimEntry === undefined ? "never claimed" : "orphaned");

	const tiles = [
		tile({ id: "status", label: "Status", value: status, n: paneRow === undefined ? 0 : 1, source: paneList.short, tone: status === "working" ? "ok" : status === "blocked" ? "bad" : "neutral", detail: "what the agent says about itself" }),
		tile({ id: "completion", label: "Completion seq", value: paneRow === undefined ? null : paneRow.completion_seq, n: paneRow === undefined ? 0 : 1, source: paneList.short, nullReason: absentReason, detail: "the cheap change detector; a bump means a turn completed" }),
		tile({ id: "stateChange", label: "State-change seq", value: paneRow === undefined ? null : paneRow.state_change_seq, n: paneRow === undefined ? 0 : 1, source: paneList.short, nullReason: absentReason, detail: "bumped on any lifecycle transition, including working→idle" }),
		tile({ id: "idleTicks", label: "Idle ticks", value: found?.idleTicks ?? null, n: found?.idleTicks === null || found?.idleTicks === undefined ? 0 : 1, source: "marks.json", nullReason: "no mark for this pane: it has not been observed resting since the last mark was written", detail: "consecutive resting ticks" }),
		tile({ id: "verdict", label: "Claim", value: verdict, n: claimEntry === undefined ? 0 : 1, source: claimSource, tone: VERDICT_TONE[verdict] ?? "neutral", nullReason: claimEntry === undefined ? "no claim file on disk for this pane" : null, detail: claimEntry === undefined ? null : claimEntry.claim.intent || "no intent recorded" }),
		tile({ id: "decisions", label: "Decisions", value: decisionRows.length, n: decisionRows.length, source: "events.jsonl (typed rows for this pane)", detail: "every ladder decision recorded against this pane" }),
		tile({ id: "cost", label: "Decision cost", value: Number(decisionCost.toFixed(6)), unit: "USD", n: decisionRows.length, source: "DecisionEvent.costUsd", nullReason: decisionRows.length === 0 ? "no decision row for this pane" : null, detail: "deciding model only; this is not this pane's share of a tick" }),
	];

	const notes: string[] = [];
	if (paneRow === undefined) notes.push(`This pane is not in ${paneList.short}. The claim, if there is one, is drawn as orphaned and left on disk.`);
	if (untypedForPane.length > 0) notes.push(`${untypedForPane.length} untyped legacy row(s) mention this pane under "events.jsonl" below. They are counted and named, never merged into an aggregate.`);
	notes.push("Typed history and untyped history are two different measurements from two different writers. They are shown apart on purpose.");

	const source_ = source as Source;
	return envelope(ctx, {
		route: "pane",
		screen: "pane",
		title: `Pane ${paneId}`,
		n: typedForPane.length,
		tiles,
		notes,
		counts: { typed: typedForPane.length, untyped: untypedForPane.length, decisions: decisionRows.length, outcomes: outcomeRows.length, asks: asksForPane.length },
		data: {
			paneId,
			name,
			session: found?.session ?? null,
			stateAge,
			now: found === undefined ? null : { ...found, stateAge },
			claim: found?.claim ?? (claimEntry === undefined ? null : { ...claimEntry.claim, fileName: claimEntry.name, present: true }),
			group: found?.group ?? null,
			policy,
			policySource: `policy.json[${group}]`,
			history: typedForPane.slice(0, 50).map((event) => ({
				ts: event.ts,
				kind: event.kind,
				op: fieldOfEvent(event, "op"),
				disposition: fieldOfEvent(event, "disposition"),
				outcomeKind: fieldOfEvent(event, "outcomeKind"),
				reason: fieldOfEvent(event, "reason"),
				argument: fieldOfEvent(event, "argument") ?? fieldOfEvent(event, "decision"),
				model: fieldOfEvent(event, "model"),
				costUsd: fieldOfEvent(event, "costUsd"),
				latencyMs: fieldOfEvent(event, "latencyMs"),
				confidence: fieldOfEvent(event, "confidence"),
				refused: fieldOfEvent(event, "refused"),
			})),
			historyTotal: typedForPane.length,
			untyped: untypedForPane.slice(0, 50),
			untypedTotal: untypedForPane.length,
			outcomes: outcomeRows.slice(0, 50).map((event) => ({
				ts: event.ts,
				op: fieldOfEvent(event, "op"),
				outcomeKind: fieldOfEvent(event, "outcomeKind"),
				ticksObserved: fieldOfEvent(event, "ticksObserved"),
				movedSinceDecision: fieldOfEvent(event, "movedSinceDecision"),
				status: fieldOfEvent(event, "status"),
			})),
			cost: { decisionRows: decisionRows.length, decisionCostUsd: Number(decisionCost.toFixed(6)) },
			asks: asksForPane.map((entry) => ({ id: entry.id, ts: entry.ts, op: entry.op, status: entry.status, argument: entry.argument })),
			tail: { ...tailRead, requestedLines: tailLines },
			paneListSource: paneList.short,
			fixture: source_.mode === "fixture",
		},
	});
}

function fieldOfEvent(event: object, key: string): unknown {
	return key in event ? (event as Record<string, unknown>)[key] : null;
}
