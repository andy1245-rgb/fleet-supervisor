// The conversation rail: one row per conversation, grouped by workspace.
//
// The rail is the left-hand list, and every fact on it is decided here rather than in the
// browser: the name (from the one chain), line 2 (from the name's own rejection record),
// the group (a workspace label when there is a usable one, else the cwd basename), the
// freshest activity with its source, whether the pane moved since the supervisor's last
// tick, and whether a message could be sent to it.
//
// `role` is the one classification the rail makes: a workspace whose label names the
// manager (`agentManager`) is the umbrella agent, and it is drawn first because it is the
// thing the operator talks to about the rest. When nothing matches there is no manager
// group rather than a wrong one.

import { envelope, lagSecondsOf, tile } from "../envelope.ts";
import { lastPerPane, record, type Rec } from "../record.ts";
import { noteOf, paneName, REASONS, rejectionReason } from "../name.ts";
import { isSamplePaneId } from "../identity.ts";
import { paneSendable, promptVerb, sourceSendable } from "../send.ts";
import { readFixtureTranscriptIndex } from "../reader.ts";
import { startDirectoryOptions, startVerb } from "../start.ts";
import { call } from "../../herdr/cli.ts";
import type { Ctx, Doc, Row } from "../types.ts";
import { str } from "../types.ts";

/** The labels the umbrella agent's workspace can carry. */
export const MANAGER_LABELS: readonly string[] = ["agentmanager", "agent manager", "fleet-manager", "fleetmanager", "agentmanager.sh"];

const USELESS_LABELS: ReadonlySet<string> = new Set(["", "~", "-", "/"]);
const STATUS_RANK: Readonly<Record<string, number>> = { working: 0, blocked: 1, idle: 2, done: 3, unknown: 4 };

export interface Workspace {
	workspaceId: string;
	label: string;
	topic: string | null;
	number: number | null;
}

export function isManagerWorkspace(workspace: Workspace | null): boolean {
	if (workspace === null) return false;
	return MANAGER_LABELS.includes(workspace.label.trim().toLowerCase());
}

function usableLabel(workspace: Workspace | null): string | null {
	if (workspace === null) return null;
	const label = workspace.label.trim();
	return USELESS_LABELS.has(label) ? null : label;
}

function toWorkspace(raw: unknown): Workspace | undefined {
	if (typeof raw !== "object" || raw === null) return undefined;
	const row = raw as Record<string, unknown>;
	const workspaceId = str(row.workspace_id) || str(row.id);
	if (workspaceId === "") return undefined;
	return {
		workspaceId,
		label: str(row.label),
		topic: typeof row.topic === "string" ? row.topic : null,
		number: typeof row.number === "number" ? row.number : null,
	};
}

/** The workspace list, from herdr or from the fixture file. Never cached across requests:
 *  the rail's grouping is a fact about the load, and a stale label would move a row. */
export async function listWorkspaces(ctx: Ctx): Promise<{ origin: string; workspaces: Workspace[]; reason: string | null }> {
	if (!ctx.opts.herdr) return { origin: "disabled", workspaces: [], reason: "--no-herdr: no workspace list" };
	if (ctx.source.mode === "fixture") {
		const dir = ctx.opts.fixtureDir ?? ctx.source.stateDir;
		const path = `${dir}/workspaces.json`;
		try {
			const { readText } = await import("../fsio.ts");
			const file = readText(path);
			if (!file.exists) return { origin: "missing", workspaces: [], reason: `no workspace fixture at ${path}` };
			const parsed = JSON.parse(file.text) as unknown;
			const list = Array.isArray(parsed) ? parsed : (parsed as { workspaces?: unknown }).workspaces;
			if (!Array.isArray(list)) return { origin: "error", workspaces: [], reason: `${path}: no workspaces array` };
			return { origin: "fixture", workspaces: list.map(toWorkspace).filter((entry): entry is Workspace => entry !== undefined), reason: null };
		} catch (error) {
			return { origin: "error", workspaces: [], reason: `${path}: ${error instanceof Error ? error.message : "unparseable"}` };
		}
	}
	try {
		const result = await call(["workspace", "list"]);
		if (!result.ok) return { origin: "herdr-failed", workspaces: [], reason: `herdr workspace list: ${result.code}: ${result.message}` };
		const bag = typeof result.result === "object" && result.result !== null ? (result.result as Record<string, unknown>) : {};
		const list = Array.isArray(bag.workspaces) ? bag.workspaces : [];
		return { origin: "herdr", workspaces: list.map(toWorkspace).filter((entry): entry is Workspace => entry !== undefined), reason: null };
	} catch (error) {
		return { origin: "herdr-failed", workspaces: [], reason: error instanceof Error ? error.message : "herdr workspace list failed" };
	}
}

function tsOf(value: unknown): number | null {
	const parsed = typeof value === "string" ? Date.parse(value) : Number.NaN;
	return Number.isFinite(parsed) ? parsed : null;
}

function newest(candidates: ({ at: number | null; ts: string | null; source: string } | null)[]): { at: number; ts: string; source: string } | null {
	let best: { at: number; ts: string; source: string } | null = null;
	for (const candidate of candidates) {
		if (candidate === null || candidate.at === null || !Number.isFinite(candidate.at)) continue;
		if (best === null || candidate.at > best.at) best = { at: candidate.at, ts: candidate.ts ?? new Date(candidate.at).toISOString(), source: candidate.source };
	}
	return best;
}

/** Line 2: the row's own gap, or the note's last line. The reason comes from the name
 *  chain's rejection record, so line 2 cannot blame the label for something the chain did
 *  not refuse. */
function line2For(args: { row: Rec; pane: Row }): { position: string | null; reason: string | null; text: string; title: string | null } {
	const position = args.pane.workspace_id === "" ? null : args.pane.workspace_id;
	if (args.row.name.source === "unnamed") {
		const reason = rejectionReason(args.row.name.rejected) ?? (args.pane.agent === "pi" ? "no session report yet" : "no pi agent in this pane");
		return { position, reason, text: reason, title: REASONS[reason]?.detail ?? null };
	}
	if (isSamplePaneId(args.pane.pane_id)) {
		return { position, reason: "made-up conversation", text: "made-up conversation", title: REASONS["made-up conversation"]?.detail ?? null };
	}
	const last = args.row.claim.present === true && typeof args.row.claim.last === "string" && args.row.claim.last.trim() !== "" ? args.row.claim.last.trim() : null;
	if (args.row.name.source === "note intent") {
		return { position: null, reason: null, text: last === null ? "note · no last line" : `note · ${last}`, title: "the note named this row, so line 2 marks which authority it was" };
	}
	return { position: null, reason: null, text: last ?? "no note yet", title: last === null ? (REASONS["no note yet"]?.detail ?? null) : "the claim's own last line" };
}

export interface RailRow {
	[key: string]: unknown;
	paneId: string;
	name: ReturnType<typeof paneName>;
	line2: ReturnType<typeof line2For>;
	status: string;
	role: string;
	agent: string;
	sample: boolean;
	title: string;
	cwd: string;
	groupId: string;
	groupLabel: string;
	groupSource: string;
	workspace: { id: string; label: string; topic: string | null; number: number | null } | null;
	claim: Rec["claim"];
	verdict: string;
	diverged: boolean;
	idleTicks: number | null;
	session: Rec["session"];
	transcript: { source: string; kind: string | null; present: boolean | null; count: number | null; lastTs: string | null; reason: string | null };
	activity: { lastAt: string | null; lastSource: string; ageSeconds: number | null; fresh: boolean; freshWindowSeconds: number; moved: { changed: boolean; detail: string; source: string } | null };
	send: { ok: boolean; code: string; reason: string | null };
	sort: { statusRank: number; lastAt: number };
}

export interface RailTotals {
	conversations: number;
	groups: number;
	manager: number;
	working: number;
	blocked: number;
	fresh: number;
	moved: number;
	claimed: number;
	neverClaimed: number;
	sendable: number;
}

export function conversationRows(ctx: Ctx, options: { workspaces: { origin: string; workspaces: Workspace[]; reason: string | null }; transcripts?: Map<string, { origin: string; kind: string; count: number; lastTs: string | null }> | null; freshMs?: number; enableChat?: boolean }): {
	rows: RailRow[];
	groups: Record<string, unknown>[];
	totals: RailTotals;
	workspaces: { origin: string; reason: string | null; count: number };
	announce: string;
} {
	const freshMs = options.freshMs ?? 900_000;
	const now = ctx.now;
	const workspaceById = new Map(options.workspaces.workspaces.map((workspace) => [workspace.workspaceId, workspace]));
	const set = record(ctx);
	const decisions = lastPerPane(ctx.allEvents, "decision");
	const actions = lastPerPane(ctx.allEvents, "action");
	const sourceGate = sourceSendable(ctx.source);

	const newestEvent = new Map<string, { at: number; ts: string; source: string }>();
	for (const event of ctx.allEvents) {
		if (!("paneId" in event)) continue;
		const paneId = (event as { paneId?: unknown }).paneId;
		if (typeof paneId !== "string") continue;
		const at = tsOf(event.ts);
		if (at === null) continue;
		const seen = newestEvent.get(paneId);
		if (seen === undefined || at > seen.at) newestEvent.set(paneId, { at, ts: event.ts, source: "events.jsonl: newest row for this pane" });
	}
	const newestAsk = new Map<string, { at: number; ts: string; source: string }>();
	for (const ask of ctx.source.asks.log.values()) {
		const at = tsOf(ask.answeredAt ?? ask.ts);
		if (at === null) continue;
		const seen = newestAsk.get(ask.paneId);
		if (seen === undefined || at > seen.at) newestAsk.set(ask.paneId, { at, ts: ask.answeredAt ?? ask.ts, source: `asks.jsonl: ask ${ask.id}` });
	}

	const rows: RailRow[] = set.rows.map((row) => {
		const pane = ctx.source.panes.panes.find((entry) => entry.pane_id === row.paneId);
		const workspace = pane === undefined ? null : (workspaceById.get(pane.workspace_id) ?? null);
		const label = usableLabel(workspace);
		const transcript = options.transcripts?.get(row.paneId) ?? null;

		const candidates = [
			row.claim.present && typeof row.claim.updated === "string" ? { at: tsOf(row.claim.updated), ts: row.claim.updated, source: `claim file ${row.claim.fileName ?? ""}`.trim() } : null,
			row.lastDecision === null ? null : { at: tsOf(row.lastDecision.ts), ts: str(row.lastDecision.ts) || null, source: "events.jsonl: last decision row" },
			row.lastAction === null ? null : { at: tsOf(row.lastAction.ts), ts: str(row.lastAction.ts) || null, source: "events.jsonl: last action row" },
			row.lastPrompt === null ? null : { at: tsOf(row.lastPrompt.ts), ts: str(row.lastPrompt.ts) || null, source: str(row.lastPrompt.textSource, "asks.jsonl") },
			newestEvent.get(row.paneId) ?? null,
			newestAsk.get(row.paneId) ?? null,
			transcript === null ? null : { at: tsOf(transcript.lastTs), ts: transcript.lastTs, source: transcript.origin },
			decisions.get(row.paneId) === undefined ? null : { at: tsOf(decisions.get(row.paneId)?.ts), ts: str(decisions.get(row.paneId)?.ts) || null, source: "events.jsonl: decision" },
			actions.get(row.paneId) === undefined ? null : { at: tsOf(actions.get(row.paneId)?.ts), ts: str(actions.get(row.paneId)?.ts) || null, source: "events.jsonl: action" },
		];
		const last = newest(candidates);
		const ageSeconds = last === null ? null : Math.max(0, Math.round((now - last.at) / 1000));
		const fresh = ageSeconds !== null && ageSeconds * 1000 <= freshMs;

		// "Moved" is the supervisor's own comparison: the counters in the snapshot against
		// the ones `marks.json` recorded at the last tick. No mark, no claim to a move —
		// `null`, not `false`.
		const mark = ctx.source.marks[row.paneId];
		let moved: { changed: boolean; detail: string; source: string } | null = null;
		if (mark !== undefined && typeof mark.completionSeq === "number") {
			const byCompletion = row.completionSeq - mark.completionSeq;
			const byState = typeof mark.stateChangeSeq === "number" ? row.stateChangeSeq - mark.stateChangeSeq : 0;
			moved = {
				changed: byCompletion !== 0 || byState !== 0,
				detail: `completion_seq ${mark.completionSeq} → ${row.completionSeq}, state_change_seq ${mark.stateChangeSeq ?? "?"} → ${row.stateChangeSeq}`,
				source: "marks.json vs the pane snapshot",
			};
		}

		const sendable = pane === undefined ? { ok: false, code: "unknown_pane", reason: "that pane is not in this load's snapshot" } : paneSendable(pane);
		const enableChat = options.enableChat === true;
		const manager = isManagerWorkspace(workspace);
		const name = paneName({ label: pane?.label ?? null, note: noteOf(ctx.source.claims.claims.get(row.paneId)?.claim), paneId: row.paneId });

		return {
			paneId: row.paneId,
			name,
			line2: pane === undefined ? { position: null, reason: null, text: "not in the pane list", title: null } : line2For({ row, pane }),
			sample: isSamplePaneId(row.paneId),
			status: row.status,
			agent: row.agent,
			role: manager ? "manager" : "orchestrator",
			title: row.title,
			cwd: row.cwd,
			groupId: label === null ? `dir:${row.group}` : `ws:${pane?.workspace_id ?? row.workspaceId}`,
			groupLabel: label ?? row.group,
			groupSource: label === null ? "cwd basename (the workspace label is empty or `~`)" : "herdr workspace label",
			workspace: workspace === null ? null : { id: workspace.workspaceId, label: workspace.label, topic: workspace.topic, number: workspace.number },
			claim: row.claim,
			verdict: row.verdict,
			diverged: row.diverged,
			idleTicks: row.idleTicks,
			session: row.session,
			activity: {
				lastAt: last === null ? null : new Date(last.at).toISOString(),
				lastSource: last === null ? "no claim, no event row, no ask and no transcript for this pane" : last.source,
				ageSeconds,
				fresh,
				freshWindowSeconds: Math.round(freshMs / 1000),
				moved,
			},
			transcript: {
				source: transcript !== null ? transcript.origin : ctx.source.mode === "fixture" ? "fixtures/transcripts.json" : "herdr agent read",
				kind: transcript?.kind ?? null,
				present: transcript !== null ? true : ctx.source.mode === "fixture" ? false : null,
				count: transcript?.count ?? null,
				lastTs: transcript?.lastTs ?? null,
				reason: transcript !== null ? null : ctx.source.mode === "fixture" ? `fixtures/transcripts.json has no entry for ${row.paneId}` : "read on demand from the pane",
			},
			send: {
				ok: enableChat && sourceGate.ok && sendable.ok,
				code: !enableChat ? "chat_disabled" : !sourceGate.ok ? sourceGate.code : sendable.code,
				reason: !enableChat ? "sending is off: the write path was not armed" : !sourceGate.ok ? sourceGate.reason : sendable.reason,
				source: sourceGate,
				pane: sendable,
				claim: { verdict: row.verdict, gatesSend: false },
			},
			sort: { statusRank: STATUS_RANK[row.status] ?? 9, lastAt: last === null ? 0 : last.at },
		};
	});

	rows.sort((a, b) => a.sort.statusRank - b.sort.statusRank || b.sort.lastAt - a.sort.lastAt || a.name.text.localeCompare(b.name.text));

	const groups = new Map<string, Record<string, unknown>>();
	for (const row of rows) {
		const group =
			groups.get(row.groupId) ??
			{
				id: row.groupId,
				label: row.groupLabel,
				source: row.groupSource,
				workspaceId: (row.workspace as { id?: string } | null)?.id ?? null,
				manager: row.role === "manager",
				rows: [] as RailRow[],
				counts: { total: 0, working: 0, blocked: 0, idle: 0, done: 0, fresh: 0, manager: 0 },
				newestAt: null as string | null,
			};
		(group.rows as RailRow[]).push(row);
		const counts = group.counts as Record<string, number>;
		counts.total = (counts.total ?? 0) + 1;
		counts[row.status] = (counts[row.status] ?? 0) + 1;
		if (row.activity.fresh) counts.fresh = (counts.fresh ?? 0) + 1;
		if (row.role === "manager") {
			group.manager = true;
			counts.manager = (counts.manager ?? 0) + 1;
		}
		const newestAt = group.newestAt as string | null;
		if (row.activity.lastAt !== null && (newestAt === null || Date.parse(row.activity.lastAt) > Date.parse(String(newestAt)))) group.newestAt = row.activity.lastAt;
		groups.set(row.groupId, group);
	}

	const ordered = [...groups.values()].sort((a, b) => {
		if (a.manager !== b.manager) return a.manager === true ? -1 : 1;
		const aAt = a.newestAt === null ? 0 : Date.parse(String(a.newestAt));
		const bAt = b.newestAt === null ? 0 : Date.parse(String(b.newestAt));
		return bAt - aAt || String(a.label).localeCompare(String(b.label));
	});

	// Two workspaces labelled the same thing are two groups with one name. Merging them
	// would be a lie about the topology, so the header keeps the label and adds the
	// workspace id for the ones that collide.
	const labelCounts = new Map<string, number>();
	for (const group of ordered) labelCounts.set(String(group.label), (labelCounts.get(String(group.label)) ?? 0) + 1);
	for (const group of ordered) group.disambiguator = (labelCounts.get(String(group.label)) ?? 0) > 1 ? group.workspaceId : null;

	const totals: RailTotals = {
		conversations: rows.length,
		groups: ordered.length,
		manager: rows.filter((row) => row.role === "manager").length,
		working: rows.filter((row) => row.status === "working").length,
		blocked: rows.filter((row) => row.status === "blocked").length,
		fresh: rows.filter((row) => row.activity.fresh).length,
		moved: rows.filter((row) => (row.activity.moved as { changed?: boolean } | null)?.changed === true).length,
		claimed: rows.filter((row) => row.verdict === "live").length,
		neverClaimed: rows.filter((row) => row.verdict === "never claimed").length,
		sendable: rows.filter((row) => row.send.ok).length,
	};

	return {
		rows,
		groups: ordered,
		totals,
		workspaces: { origin: options.workspaces.origin, reason: options.workspaces.reason, count: workspaceById.size },
		announce: announceFresh(rows, freshMs),
	};
}

/** The one sentence the rail prints above the list: how much of it moved, and over what
 *  window "fresh" was measured. Both numbers are counted from the rows in hand with the
 *  same predicates the dots use. */
export function announceFresh(rows: RailRow[], freshMs: number): string {
	const moved = rows.filter((row) => (row.activity.moved as { changed?: boolean } | null)?.changed === true);
	const fresh = rows.filter((row) => row.activity.fresh);
	const minutes = Math.round(freshMs / 60_000);
	if (rows.length === 0) return "no conversations: this load's pane list is empty, so there is nothing on the left";
	const bits = [`${rows.length} conversation${rows.length === 1 ? "" : "s"}`];
	bits.push(moved.length === 0 ? "none moved since the supervisor's last tick" : `${moved.length} moved since the supervisor's last tick (${moved.map((row) => row.paneId).join(", ")})`);
	bits.push(`${fresh.length} with activity in the last ${minutes}m`);
	return bits.join(" \u00b7 ");
}

/** The short lines the rail's footer prints, so it says what it could not read rather than
 *  drawing a shorter list without comment. */
export function railNotes(list: ReturnType<typeof conversationRows>, ctx: Ctx): string[] {
	const notes: string[] = [];
	if (list.workspaces.origin !== "herdr" && list.workspaces.origin !== "fixture") {
		notes.push(`workspace labels unavailable (${list.workspaces.reason ?? list.workspaces.origin}), so groups fall back to directory names`);
	}
	if (ctx.source.panes.origin !== "herdr" && ctx.source.panes.origin !== "fixture") {
		notes.push(`the pane list is unavailable (${ctx.source.panes.reason ?? ctx.source.panes.origin}); the rail is empty because there is nothing to read`);
	}
	if (list.totals.neverClaimed > 0) notes.push(`${list.totals.neverClaimed} pane${list.totals.neverClaimed === 1 ? "" : "s"} without a claim: the supervisor has not taken them`);
	return notes;
}

export async function buildConversations(ctx: Ctx): Promise<Doc> {
	const workspaces = await listWorkspaces(ctx);
	const transcripts = ctx.source.mode === "fixture" ? readFixtureTranscriptIndex(ctx.opts.fixtureDir ?? ctx.source.stateDir) : null;
	const list = conversationRows(ctx, { workspaces, transcripts, enableChat: ctx.opts.enableChat });
	const start = startDirectoryOptions(ctx.source, { home: ctx.opts.home, notesDir: ctx.opts.notesDir });

	const tiles = [
		tile({ id: "conversations", label: "Conversations", value: list.totals.conversations, n: list.totals.conversations, source: "the pane list", detail: "one row per pane in this load" }),
		tile({ id: "groups", label: "Groups", value: list.totals.groups, n: list.totals.groups, source: "herdr workspace labels, else cwd basenames", detail: "the rail's groups, in the order it draws them" }),
		tile({ id: "fresh", label: "Fresh", value: list.totals.fresh, n: list.totals.conversations, source: "claims, events, asks and transcripts", detail: "rows with any activity inside the fresh window" }),
		tile({ id: "moved", label: "Moved since last tick", value: list.totals.moved, n: list.totals.conversations, source: "marks.json vs the pane snapshot", detail: "rows whose counters advanced since the supervisor last looked" }),
		tile({ id: "sendable", label: "Sendable", value: list.totals.sendable, n: list.totals.conversations, source: "the send gate", tone: list.totals.sendable > 0 ? "warn" : "neutral", detail: "rows a message could reach right now: armed, live list, pi agent, not blocked" }),
	];

	return envelope(ctx, {
		route: "conversations",
		screen: "conversations",
		title: "Chat",
		n: list.rows.length,
		tiles,
		notes: [list.announce, ...railNotes(list, ctx)],
		counts: { ...list.totals },
		data: {
			rows: list.rows,
			groups: list.groups,
			totals: list.totals,
			workspaces: list.workspaces,
			announce: list.announce,
			start: {
				home: start.home,
				origin: start.origin,
				reason: start.reason,
				options: start.options,
				command: startVerb("<directory>", "<message>"),
				gated: ctx.opts.enableChat !== true,
			},
			composer: {
				enabled: ctx.opts.enableChat === true,
				route: "POST /api/chat/:paneId/send",
				startRoute: "POST /api/chat/start",
				command: promptVerb("<paneId>", "<text>"),
			},
		},
	});
}

/** The message log a caller can print without a pane id: not part of the contract, kept
 *  because `lagSecondsOf` is used by the conversation document too. */
export function ageOf(ts: string | null, now: number): number | null {
	return lagSecondsOf(ts, now);
}
