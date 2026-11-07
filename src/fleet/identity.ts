// Which session a pane's agent is writing, and whether that claim can be proved.
//
// One function, seven states, and `linked` earned rather than declared. The states are
// the ones `fleet-gui/tests/acceptance/model/rows.mjs` renders against, plus the
// seventh the design names and that file was missing:
//
//   linked          a report exists, its id is unambiguous, and the file's first line
//                   carries that id — the only state in which a row may be called
//                   "this conversation"
//   unlinked        a `pi` agent in the pane, no session report yet
//   unlinkedNotPi   herdr does not say pi is running here, so there is nothing to link
//   broken          a report whose id cannot be derived, or whose file is missing, or
//                   whose file disagrees with the id it reported
//   ambiguous       two panes report the same session id, so two processes may be
//                   writing one file
//   sample          a fixture pane id: it can never resolve to a live session
//   unresolved      the pane list was not read at all, so nothing can be said about
//                   this row. This is the state the GUI renders when the core seam
//                   cannot be loaded; modelling it here is what keeps that page from
//                   being a stack trace
//
// The join key is herdr's own `agent_session` object — `{agent, kind, source, value}`
// — which is why the row must carry it. `kind: "path"` names a transcript whose id is
// in the filename; `kind: "id"` carries the id directly. Reading `terminal_title` for
// it, as the four deleted chains did, produced a session id only by accident.

import { readFileSync } from "node:fs";

import type { AgentSession, Ctx, Row } from "./types.ts";

export type SessionState = "linked" | "unlinked" | "unlinkedNotPi" | "broken" | "ambiguous" | "sample" | "unresolved";

export const SESSION_STATES: readonly SessionState[] = Object.freeze([
	"linked",
	"unlinked",
	"unlinkedNotPi",
	"broken",
	"ambiguous",
	"sample",
	"unresolved",
]);

export interface SessionRecord {
	state: SessionState;
	linked: boolean;
	kind: string | null;
	path: string | null;
	id: string | null;
	source: string | null;
	firstLineId: string | null;
	reason: string | null;
}

/** The fixture namespace: a sample fleet may not carry an id this machine can issue. */
export const SAMPLE_ID = /^sample[0-9]+:p[0-9]+$/;

export function isSamplePaneId(paneId: string | null | undefined): boolean {
	return typeof paneId === "string" && SAMPLE_ID.test(paneId);
}

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

/** The session id in a transcript path. A pi session file is named
 *  `<iso>_<uuid>.jsonl`, so the uuid is in the basename and nowhere else. */
export function uuidOf(path: string | null | undefined): string | null {
	if (typeof path !== "string") return null;
	const base = path.slice(path.lastIndexOf("/") + 1);
	const found = UUID.exec(base);
	return found === null ? null : found[0].toLowerCase();
}

/** Ids that more than one pane reports, computed once per loaded pane list. A WeakMap
 *  keyed on the pane list keeps `sessionOf` pure from a caller's point of view while a
 *  fleet of 43 panes is not scanned 43 times. */
const sharedCache = new WeakMap<object, Set<string>>();

function sharedIds(ctx: Ctx): Set<string> {
	const panes = ctx.source.panes.panes;
	const cacheKey = panes as unknown as object;
	const cached = sharedCache.get(cacheKey);
	if (cached !== undefined) return cached;
	const seen = new Set<string>();
	const shared = new Set<string>();
	for (const pane of panes) {
		const id = idOf(pane.agent_session);
		if (id === null) continue;
		if (seen.has(id)) shared.add(id);
		seen.add(id);
	}
	sharedCache.set(cacheKey, shared);
	return shared;
}

function idOf(report: AgentSession | null): string | null {
	if (report === null) return null;
	if (report.kind === "path") return uuidOf(report.value);
	if (report.kind === "id") return typeof report.value === "string" && report.value !== "" ? report.value : null;
	return null;
}

/** The first line of a transcript, which carries its own id. A session file whose
 *  header disagrees with the id its name declares is `broken`, not `linked`: the
 *  whole point of opening it is that a name is not evidence. */
function firstLineId(path: string): { id: string | null; error: "missing" | "unparseable" | "no_id" | null } {
	let text: string;
	try {
		text = readFileSync(path, "utf8");
	} catch {
		return { id: null, error: "missing" };
	}
	const end = text.indexOf("\n");
	const line = end === -1 ? text : text.slice(0, end);
	try {
		const parsed = JSON.parse(line) as unknown;
		if (typeof parsed !== "object" || parsed === null) return { id: null, error: "no_id" };
		const id = (parsed as { id?: unknown }).id;
		return typeof id === "string" ? { id, error: null } : { id: null, error: "no_id" };
	} catch {
		return { id: null, error: "unparseable" };
	}
}

function empty(state: SessionState, reason: string | null): SessionRecord {
	return { state, linked: false, kind: null, path: null, id: null, source: null, firstLineId: null, reason };
}

/**
 * Identity for one row.
 *
 * `ctx.source.panes.origin` decides `unresolved` before anything else: a load whose
 * pane list was disabled, missing or unreadable has no fleet to join a session
 * against, and reporting every row as `unlinked` would turn "I could not ask" into "no
 * session exists".
 */
export function sessionOf(row: Row, ctx: Ctx): SessionRecord {
	if (isSamplePaneId(row.pane_id)) return empty("sample", "a made-up conversation: its pane id is in the fixture namespace");

	const origin = ctx.source.panes.origin;
	if (origin === "disabled" || origin === "error" || origin === "missing" || origin === "herdr-failed") {
		return empty("unresolved", `the pane list was not read (${ctx.source.panes.reason ?? origin}), so this row's session cannot be joined`);
	}

	const report = row.agent_session;
	if (report === null) {
		const isPi = row.agent === "pi";
		return isPi
			? empty("unlinked", "no session has reported this pane")
			: empty("unlinkedNotPi", "herdr does not say pi is running in this pane");
	}

	const id = idOf(report);
	const path = report.kind === "path" ? report.value : null;
	const header = path === null ? { id: null, error: "no_id" as const } : firstLineId(path);
	const base: SessionRecord = {
		state: "linked",
		linked: true,
		kind: report.kind,
		path,
		id,
		source: report.source ?? null,
		firstLineId: header.id,
		reason: null,
	};

	if (id === null) {
		return { ...base, state: "broken", linked: false, reason: "the report carries neither a path nor an id" };
	}
	if (sharedIds(ctx).has(id)) return { ...base, state: "ambiguous", linked: false, reason: "two processes may be writing that file" };
	if (header.error === "missing") return { ...base, state: "broken", reason: "the session file is missing" };
	if (header.error === "unparseable") return { ...base, state: "broken", linked: false, reason: "the session file's first line is not JSON" };
	if (header.id !== id) return { ...base, state: "broken", linked: false, reason: "the file's first line does not carry this id" };
	return base;
}

/** Line 2's session sentence, in the closed vocabulary `name.ts` declares. Kept here
 *  so a row and its name cannot disagree about which end is missing. */
export function sessionReason(session: SessionRecord): string | null {
	if (session.state === "unlinkedNotPi") return "no pi agent in this pane";
	if (session.state === "unlinked" || session.state === "unresolved") return "no session report yet";
	return session.reason;
}
