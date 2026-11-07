// One pass, one read, one record per conversation.
//
// This is the file the whole workstream exists for. Two row builders used to exist —
// the GUI's `pane-facts.mjs` + `fleet-rows.mjs` and `fleet-manager`'s `roster.ts` — and
// they disagreed on the one column a person reads first: the name. `roster.ts` used
// `terminal_title`, so four panes read `π - andrew` on the CLI and `unnamed` on the
// page, in the same minute, on the same box.
//
// A record is what both surfaces render: what herdr says, what the worker claims, what
// the counters did, what the supervisor last decided, which session is writing, and the
// name. Nothing here is invented for a pane with no claim, and nothing here reads a
// file: `source.ts` loaded everything, and this joins it.
//
// The counters matter more than the status word — status is what the agent says about
// itself, counters are what moved — and a claim that says `working` while herdr reports
// something else is the divergence the supervisor exists to catch, so it is a fact on
// the record rather than a comparison each renderer has to remember to make.

import { agentOf } from "../herdr/cli.ts";
import { groupOf as groupForAgent } from "./groups.ts";
import { claimAgeMs, describeClaim, verdictFor } from "./claims.ts";
import { sessionOf, sessionReason } from "./identity.ts";
import { noteOf, paneName, rejectionReason } from "./name.ts";
import { stateAgeFor } from "./state-age.ts";
import type { StateAge } from "./state-age.ts";
import type { SessionRecord } from "./identity.ts";
import type { NameRecord } from "./name.ts";
import type { Ctx, Mark, Row } from "./types.ts";
import { fieldOf, numField, strField } from "./types.ts";
import type { SchemaEvent } from "../metrics/schema.ts";
import type { AskRecord } from "../manager/ask.ts";

export interface ClaimFacts {
	present: boolean;
	state?: string;
	phase?: string;
	intent?: string;
	last?: string;
	updated?: string;
	ageMs: number | null;
	ageSeconds: number | null;
	acceptance?: string | null;
	budget?: unknown;
	group?: string | null;
	fileName?: string;
	description: string;
}

export interface Triage {
	classes: string[];
	rank: number | null;
	rankWhy?: string;
	rankLabel?: string | null;
}

export interface Rec {
	paneId: string;
	name: NameRecord;
	session: SessionRecord;
	sessionReason: string | null;
	labelRejection: string | null;
	agent: string;
	status: string;
	group: string;
	title: string;
	cwd: string;
	foregroundCwd: string;
	workspaceId: string;
	tabId: string;
	focused: boolean;
	completionSeq: number;
	stateChangeSeq: number;
	revision: number;
	terminalId: string;
	idleTicks: number | null;
	markStatus: string | null;
	mark: Mark | null;
	claim: ClaimFacts;
	verdict: string;
	claimStale: boolean;
	diverged: boolean;
	lastDecision: Record<string, unknown> | null;
	lastAction: Record<string, unknown> | null;
	lastPrompt: Record<string, unknown> | null;
	windows: Record<string, unknown>;
	stateAge: StateAge | null;
	triage: Triage;
	[key: string]: unknown;
}

export interface OrphanRec {
	paneId: string;
	name: NameRecord;
	session: SessionRecord;
	group: string | null;
	intent: string;
	state: string;
	phase: string;
	last: string;
	updated: string;
	ageMs: number | null;
	ageSeconds: number | null;
	fileName: string;
	verdict: string;
	description: string;
	triage: Triage;
	[key: string]: unknown;
}

export interface RecordSet {
	rows: Rec[];
	orphans: OrphanRec[];
	known: Set<string>;
	pendingAskPanes: Set<string>;
}

const RANK_OF_CLASS: Readonly<Record<string, number>> = { blocked: 0, diverged: 1, stale: 2, neverClaimed: 3 };
const RANK_WORKING = 4;
const RANK_QUIET = 5;

/** Worst first. `blocked` leads because it is the only status that cannot resolve
 *  itself; a claim that disagrees with its pane comes next, because the row is lying
 *  about what it is doing; a stale claim is third; a pane that never claimed anything is
 *  fourth; `working` is the healthy middle; resting is last. */
export const CONSEQUENCE_ORDER: readonly { rank: number; id: string; label: string; plain: string }[] = Object.freeze([
	{ rank: 0, id: "blocked", label: "blocked", plain: "a blocked pane is the only status that cannot resolve itself; it needs a person" },
	{ rank: 1, id: "diverged", label: "claim disagrees with its pane", plain: "the claim says working and the pane list does not, so the row is not doing what it says it is doing" },
	{ rank: 2, id: "stale", label: "stale claim", plain: "the claim file is older than three tick intervals, or its updated will not parse: nothing recent has said what this pane is doing" },
	{ rank: 3, id: "neverClaimed", label: "never claimed", plain: "no claim file at all: the pane is unaccounted for rather than reported on" },
	{ rank: 4, id: "working", label: "working", plain: "moving, and nothing is waiting on it" },
	{ rank: 5, id: "quiet", label: "idle, done or unobserved", plain: "resting, finished, or a status the pane list did not report: needs nothing from anybody" },
]);

export const COMPARATOR_PLAIN =
	"consequence first: blocked, then a claim that disagrees with its pane, then a stale claim, then never claimed, then working, then idle or done. Within one rank, the row that has been in its current state longest goes first (state age, longest first, rows with no derivable state age after the ones that have one), then the oldest claim file, then the pane id. A resting pane can never rank above a blocked one.";

export const FILTERS: readonly { id: string; label: string; one: string; source: string; detail: string }[] = Object.freeze([
	{ id: "asks", label: "asks waiting on you", one: "ask waiting on you", source: "asks.jsonl (folded) · paneId on the pending record", detail: "actions the gate parked and nobody has released. Each one names the exact command that releases it" },
	{ id: "blocked", label: "panes blocked", one: "pane blocked", source: "the pane list · agent_status", detail: "a blocked pane will not resolve itself: it is the only status that needs a person" },
	{ id: "diverged", label: "claims disagree with their panes", one: "claim disagrees with its pane", source: "claim files vs the pane list", detail: "the claim says working and the pane list does not report working. This is the case the supervisor exists to catch" },
	{ id: "stale", label: "stale claims", one: "stale claim", source: "claim files · older than three tick intervals", detail: "the claim file is older than three tick intervals, or its updated will not parse" },
	{ id: "orphans", label: "claims with no pane", one: "claim with no pane", source: "claim files vs the pane list", detail: "nothing in the tree deletes a claim, so these outlive their panes. The page shows them and leaves them on disk" },
]);

export const FILTER_IDS: readonly string[] = FILTERS.map((filter) => filter.id);

function rankOf(classes: string[], status: string): number {
	let rank = status === "working" ? RANK_WORKING : RANK_QUIET;
	for (const id of classes) {
		const candidate = RANK_OF_CLASS[id];
		if (candidate !== undefined && candidate < rank) rank = candidate;
	}
	return rank;
}

/** Attach the two facts the list is ordered and filtered by: the classes the row
 *  belongs to and the rank those classes imply. `stateAge` is carried through untouched
 *  so the comparator can break a tie on how long a row has been this bad. An orphan
 *  claim has no pane, so it has no place in the order and no rank. */
export function annotate<T extends { status: string; diverged: boolean; verdict: string }>(
	row: T,
	options: { stateAge?: StateAge | null; hasAsk?: boolean; orphan?: boolean } = {},
): T & { stateAge: StateAge | null; triage: Triage } {
	const stateAge = options.stateAge ?? null;
	const classes: string[] = [];
	if (options.orphan === true) {
		classes.push("orphans");
	} else {
		if (row.status === "blocked") classes.push("blocked");
		if (row.diverged === true) classes.push("diverged");
		if (row.verdict === "stale") classes.push("stale");
		if (row.verdict === "never claimed") classes.push("neverClaimed");
	}
	if (options.hasAsk === true) classes.push("asks");
	const rank = rankOf(classes, row.status);
	return {
		...row,
		stateAge,
		triage:
			options.orphan === true
				? { classes, rank: null, rankWhy: "an orphan claim has no pane in this agent list, so it is not in the pane order; it is drawn in its own list" }
				: { classes, rank, rankLabel: CONSEQUENCE_ORDER.find((entry) => entry.rank === rank)?.label ?? null },
	};
}

function ageCeiling(row: { stateAge: StateAge | null }): number | null {
	const seconds = row.stateAge?.seconds;
	return typeof seconds === "number" ? seconds : null;
}

function claimCeiling(row: { claim: ClaimFacts }): number | null {
	const seconds = row.claim.ageSeconds;
	return typeof seconds === "number" ? seconds : null;
}

function byPaneId(a: { paneId: string }, b: { paneId: string }): number {
	return a.paneId < b.paneId ? -1 : a.paneId > b.paneId ? 1 : 0;
}

export function compareRows(a: Rec, b: Rec): number {
	const rankA = a.triage.rank ?? RANK_QUIET;
	const rankB = b.triage.rank ?? RANK_QUIET;
	if (rankA !== rankB) return rankA - rankB;

	const ageA = ageCeiling(a);
	const ageB = ageCeiling(b);
	if (ageA !== ageB) {
		if (ageA === null) return 1;
		if (ageB === null) return -1;
		return ageB - ageA;
	}

	const claimA = claimCeiling(a);
	const claimB = claimCeiling(b);
	if (claimA !== claimB) {
		if (claimA === null) return 1;
		if (claimB === null) return -1;
		return claimB - claimA;
	}

	return byPaneId(a, b);
}

export function compareOrphans(a: OrphanRec, b: OrphanRec): number {
	const ageA = typeof a.ageSeconds === "number" ? a.ageSeconds : null;
	const ageB = typeof b.ageSeconds === "number" ? b.ageSeconds : null;
	if (ageA !== ageB) {
		if (ageA === null) return 1;
		if (ageB === null) return -1;
		return ageB - ageA;
	}
	return byPaneId(a, b);
}

/** Newest row of one kind, per pane. `allEvents` not `events`: "the last thing the
 *  supervisor decided about this pane" is a fact about now, not about the window the
 *  charts are drawn over. */
export function lastPerPane(events: SchemaEvent[], kind: string): Map<string, SchemaEvent> {
	const out = new Map<string, SchemaEvent>();
	for (const event of events) {
		if (event.kind !== kind) continue;
		const paneId = strField(event, "paneId");
		if (paneId === null) continue;
		const seen = out.get(paneId);
		if (seen === undefined || Date.parse(event.ts) > Date.parse(seen.ts)) out.set(paneId, event);
	}
	return out;
}

export function rowsForPane(events: SchemaEvent[], paneId: string): SchemaEvent[] {
	return events.filter((event) => strField(event, "paneId") === paneId);
}

/** The last prompt a pane was actually sent, and where that text came from. `action`
 *  rows carry no argument — they record that a nudge happened, not what it said — so the
 *  text is looked up in the ask log first and only then in the untyped rows, which are
 *  labelled as untyped because they are not a measurement. */
export function lastPromptFor(paneId: string, asks: Map<string, AskRecord>, untyped: { kind: string; ts: string | null; paneId: string | null; text: string | null }[]): Record<string, unknown> | null {
	let best: { at: number; ts: string; op: string; text: string; answer: string | null; id: string | null; textSource: string } | null = null;
	for (const record of asks.values()) {
		if (record.paneId !== paneId) continue;
		if (record.op !== "nudge" && record.op !== "declare_done") continue;
		const at = Date.parse(record.answeredAt ?? record.ts);
		if (!Number.isFinite(at)) continue;
		if (best === null || at > best.at) {
			best = {
				at,
				ts: new Date(at).toISOString(),
				op: record.op,
				text: record.argument,
				answer: record.answer ?? null,
				id: record.id,
				textSource: record.status === "answered" ? "asks.jsonl (answered)" : "asks.jsonl (pending)",
			};
		}
	}
	for (const row of untyped) {
		if (row.paneId !== paneId) continue;
		if (row.kind !== "nudge" && row.kind !== "nudge_dry" && row.kind !== "done") continue;
		const at = Date.parse(row.ts ?? "");
		if (!Number.isFinite(at)) continue;
		if (best === null || at > best.at) {
			best = {
				at,
				ts: new Date(at).toISOString(),
				op: row.kind === "done" ? "declare_done" : "nudge",
				text: row.text ?? "",
				answer: null,
				id: null,
				textSource: `events.jsonl (untyped \`${row.kind}\` row)`,
			};
		}
	}
	if (best === null) return null;
	const { at: _at, ...rest } = best;
	return rest;
}

function claimFacts(entry: { claim: { state: string; phase: string; intent: string; last: string; updated: string; acceptance?: string; budget?: unknown; group?: string }; name: string } | undefined, now: number): ClaimFacts {
	const claim = entry?.claim;
	if (entry === undefined || claim === undefined) return { present: false, ageMs: null, ageSeconds: null, description: describeClaim(undefined, null) };
	const ageMs = claimAgeMs(claim, now);
	return {
		present: true,
		state: claim.state,
		phase: claim.phase,
		intent: claim.intent,
		last: claim.last,
		updated: claim.updated,
		ageMs,
		ageSeconds: ageMs === null ? null : Math.round(ageMs / 1000),
		acceptance: claim.acceptance ?? null,
		budget: claim.budget ?? null,
		group: claim.group ?? null,
		fileName: entry.name,
		description: describeClaim(claim, ageMs),
	};
}

function decisionFacts(event: SchemaEvent | undefined): Record<string, unknown> | null {
	if (event === undefined) return null;
	return {
		ts: event.ts,
		op: strField(event, "op"),
		model: strField(event, "model"),
		confidence: numField(event, "confidence"),
		refused: fieldOf(event, "refused"),
		held: fieldOf(event, "held"),
		decision: strField(event, "decision"),
		costUsd: numField(event, "costUsd"),
		latencyMs: numField(event, "latencyMs"),
		policy: strField(event, "policy"),
	};
}

function actionFacts(event: SchemaEvent | undefined): Record<string, unknown> | null {
	if (event === undefined) return null;
	return {
		ts: event.ts,
		op: strField(event, "op"),
		disposition: strField(event, "disposition"),
		reason: strField(event, "reason"),
		gated: fieldOf(event, "gated"),
		policy: strField(event, "policy"),
	};
}

export interface RecordInputs {
	decisions: Map<string, SchemaEvent>;
	actions: Map<string, SchemaEvent>;
	stateAges: Map<string, StateAge>;
	windowRows: Map<string, number>;
	pendingAskPanes: Set<string>;
}

/** Everything one record needs, read once per request instead of once per row. */
export function recordInputs(ctx: Ctx): RecordInputs {
	const windowRows = new Map<string, number>();
	for (const event of ctx.events) {
		const paneId = strField(event, "paneId");
		if (paneId === null) continue;
		windowRows.set(paneId, (windowRows.get(paneId) ?? 0) + 1);
	}
	return {
		decisions: lastPerPane(ctx.allEvents, "decision"),
		actions: lastPerPane(ctx.allEvents, "action"),
		stateAges: stateAgeFor({ allEvents: ctx.allEvents, panes: ctx.source.panes.panes, now: ctx.now }),
		windowRows,
		pendingAskPanes: new Set(ctx.source.asks.pending.map((record) => record.paneId)),
	};
}

/** One record for one row. Exported so the pane screen can build a single record
 *  without sorting a fleet, and so a test can assert a row without a context. */
export function recordFor(ctx: Ctx, row: Row, inputs: RecordInputs = recordInputs(ctx)): Rec {
	const claimEntry = ctx.source.claims.claims.get(row.pane_id);
	const mark = ctx.source.marks[row.pane_id];
	const claim = claimEntry?.claim;
	const ageMs = claim === undefined ? null : claimAgeMs(claim, ctx.now);
	const verdict = verdictFor({ alive: true, claim, ageMs, staleAfterMs: ctx.staleAfterMs });
	const session = sessionOf(row, ctx);
	const name = paneName({ label: row.label, note: noteOf(claim), paneId: row.pane_id });

	return {
		paneId: row.pane_id,
		name,
		session,
		sessionReason: sessionReason(session),
		labelRejection: rejectionReason(name.rejected),
		agent: row.agent,
		status: row.agent_status,
		group: groupForAgent(agentOf(row), claim),
		title: row.terminal_title_stripped || row.terminal_title,
		cwd: row.cwd,
		foregroundCwd: row.foreground_cwd,
		workspaceId: row.workspace_id,
		tabId: row.tab_id,
		focused: row.focused,
		completionSeq: row.completion_seq,
		stateChangeSeq: row.state_change_seq,
		revision: row.revision,
		terminalId: row.terminal_id,
		idleTicks: typeof mark?.idleTicks === "number" ? mark.idleTicks : null,
		markStatus: typeof mark?.status === "string" ? mark.status : null,
		mark: mark ?? null,
		claim: claimFacts(claimEntry, ctx.now),
		verdict,
		claimStale: verdict === "stale",
		diverged: claim?.state === "working" && row.agent_status !== "working",
		lastDecision: decisionFacts(inputs.decisions.get(row.pane_id)),
		lastAction: actionFacts(inputs.actions.get(row.pane_id)),
		lastPrompt: lastPromptFor(row.pane_id, ctx.source.asks.log, ctx.source.events.untyped),
		windows: { has: Boolean(inputs.decisions.get(row.pane_id) ?? inputs.actions.get(row.pane_id)), claimed: claim !== undefined, rowsInWindow: inputs.windowRows.get(row.pane_id) ?? 0 },
		stateAge: inputs.stateAges.get(row.pane_id) ?? null,
		triage: { classes: [], rank: null },
	};
}

/** A claim with no pane in this load's pane list. The record shows it and never
 *  repairs it: nothing in the tree has a delete, and pruning is the operator's verb. */
export function orphanFor(ctx: Ctx, entry: { claim: { paneId: string; intent: string; state: string; phase: string; last: string; updated: string; group?: string }; name: string }): OrphanRec {
	const claim = entry.claim;
	const ageMs = claimAgeMs(claim, ctx.now);
	return {
		paneId: claim.paneId,
		name: paneName({ note: noteOf(claim), paneId: claim.paneId }),
		session: { state: "unlinked", linked: false, kind: null, path: null, id: null, source: null, firstLineId: null, reason: "no pane in this agent list" },
		group: claim.group ?? null,
		intent: claim.intent,
		state: claim.state,
		phase: claim.phase,
		last: claim.last,
		updated: claim.updated,
		ageMs,
		ageSeconds: ageMs === null ? null : Math.round(ageMs / 1000),
		fileName: entry.name,
		verdict: "orphaned",
		description: describeClaim(claim, ageMs),
		triage: { classes: ["orphans"], rank: null, rankWhy: "an orphan claim has no pane in this agent list, so it is not in the pane order; it is drawn in its own list" },
	};
}

/**
 * The whole set: one pass over the pane list, one sort, and the orphan claims in their
 * own list. Called once per request; every screen reads this result rather than
 * rebuilding rows, which is what makes the fleet screen, the lane view and the pane
 * detail screen unable to disagree.
 */
export function record(ctx: Ctx): RecordSet {
	const inputs = recordInputs(ctx);
	const panes = ctx.source.panes.panes;
	const rows = panes
		.map((pane) => annotate(recordFor(ctx, pane, inputs), { stateAge: inputs.stateAges.get(pane.pane_id) ?? null, hasAsk: inputs.pendingAskPanes.has(pane.pane_id) }))
		.sort(compareRows);

	const known = new Set(panes.map((pane) => pane.pane_id));
	const orphans = [...ctx.source.claims.claims.values()]
		.filter((entry) => !known.has(entry.claim.paneId))
		.map((entry) => {
			const orphan = orphanFor(ctx, entry);
			return { ...orphan, triage: { classes: ["orphans"], rank: null, rankWhy: orphan.triage.rankWhy }, hasAsk: inputs.pendingAskPanes.has(entry.claim.paneId) };
		})
		.sort(compareOrphans);

	return { rows, orphans, known, pendingAskPanes: inputs.pendingAskPanes };
}

/** One filter, over the same two lists the screen draws. Counting both is what makes
 *  the fifth chip exact: one of the pending asks can belong to a pane that is no longer
 *  listed. */
export function applyFilter(set: { rows: Rec[]; orphans: OrphanRec[] }, filterId: string | null = null): {
	filter: string | null;
	panes: Rec[];
	orphans: OrphanRec[];
	panesMatched: number;
	orphansMatched: number;
} {
	if (filterId === null) return { filter: null, panes: set.rows, orphans: set.orphans, panesMatched: set.rows.length, orphansMatched: set.orphans.length };
	const has = (triage: Triage | undefined): boolean => Array.isArray(triage?.classes) && triage.classes.includes(filterId);
	const panes = set.rows.filter((row) => has(row.triage));
	const orphans = set.orphans.filter((row) => has(row.triage));
	return { filter: filterId, panes, orphans, panesMatched: panes.length, orphansMatched: orphans.length };
}

/** The chip counts, computed from the rows themselves, so a chip cannot count one thing
 *  and filter another. */
export function filterCounts(
	set: { rows: Rec[]; orphans: OrphanRec[] },
	attentionCounts: Record<string, number> = {},
): { id: string; label: string; one: string; count: number; source: string; detail: string; attentionCount: number | null; agreesWithStrip: boolean | null; matches: string }[] {
	const rows: { triage: Triage }[] = [...set.rows, ...set.orphans];
	return FILTERS.map((filter) => {
		const count = rows.filter((row) => Array.isArray(row.triage.classes) && row.triage.classes.includes(filter.id)).length;
		const attention = attentionCounts[filter.id] ?? null;
		return {
			id: filter.id,
			label: filter.label,
			one: filter.one,
			count,
			source: filter.source,
			detail: filter.detail,
			attentionCount: attention,
			agreesWithStrip: attention === null ? null : attention === count,
			matches: `rows whose triage classes include "${filter.id}"`,
		};
	});
}
