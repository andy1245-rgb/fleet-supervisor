// The shapes the core passes around: one context, one loaded source, one row.
//
// `Ctx` is the frozen name from PLAN-v1 §2.0, `{now, dataDir, host, port, window,
// dump, fixture, herdr}`, plus the loaded source and the four window helpers every
// builder reads. `now` is the only clock: no builder may call `Date.now()`, so
// `--now <epoch-ms>` makes two runs of the same document byte-identical.
//
// `Doc` is a document, not a screen: the builders return JSON and the adapters
// decide how to print it. Everything is `unknown` on the way out because a document
// is data; everything on the way in is typed, because a builder that guesses at a
// row is a builder that invents a field.

import type { SchemaEvent } from "../metrics/schema.ts";
import type { AskRecord } from "../manager/ask.ts";
import type { Claim } from "./registry.ts";

export type WindowName = "1h" | "24h" | "all";

/** What an adapter adds to a document, and the only thing it may add (I2). */
export interface Doc {
	ok: boolean;
	route: string;
	screen: string;
	title: string;
	source?: string | null;
	sourceDetail?: string | null;
	window?: WindowName;
	n?: number;
	counts?: Record<string, unknown>;
	generatedAt?: string;
	data?: Record<string, unknown>;
	[key: string]: unknown;
}

export interface Tile {
	id: string;
	label: string;
	value: string | number | null;
	unit: string;
	n: number;
	source: string;
	sourceLong: string | null;
	note: string | null;
	of: { value: number; source: string } | null;
	format: string | null;
	nullReason: string | null;
	tone: string;
	detail: string | null;
}

/** The flags a route or a dump was asked with. The CLI's flag names and the route's
 *  body keys map onto these one-to-one; the mapping is declared in `routes.ts`. */
export interface CtxOptions {
	dataDir: string | null;
	registryDir: string | null;
	fixtureDir: string | null;
	root: string;
	window: WindowName;
	limit: number;
	intervalMs: number;
	turns: number;
	herdr: boolean;
	live: boolean;
	forceFixture: boolean;
	fixtureRebase: boolean;
	fixtureAgeMs: number;
	filter: string | null;
	enableActions: boolean;
	enableChat: boolean;
	enableSettings: boolean;
	allowRemoteWrites: boolean;
	agentFleetRoot: string;
	notesDir: string | null;
	home: string;
}

export interface Ctx {
	now: number;
	dataDir: string | null;
	host: string | null;
	port: number | null;
	window: WindowName;
	dump: string | null;
	fixture: boolean;
	herdr: boolean;
	opts: CtxOptions;
	source: Source;
	events: SchemaEvent[];
	allEvents: SchemaEvent[];
	byKind(kind: string): SchemaEvent[];
	allByKind(kind: string): SchemaEvent[];
	newestRowTs: string | null;
	lagSeconds: number | null;
	staleAfterMs: number;
	stopAfterMs: number;
}

/** One pane, as herdr's snapshot reports it, with the agent counters merged in.
 *  `label` and `revision` are the two fields the old `toAgent` dropped, and
 *  `agent_session` is what `sessionOf` joins on, so the row is the join key. */
export interface Row {
	pane_id: string;
	workspace_id: string;
	tab_id: string;
	agent: string;
	agent_status: string;
	cwd: string;
	foreground_cwd: string;
	focused: boolean;
	label: string | null;
	revision: number;
	terminal_id: string;
	terminal_title: string;
	terminal_title_stripped: string;
	agent_session: AgentSession | null;
	completion_seq: number;
	state_change_seq: number;
}

/** The session a pane's agent reported, in herdr's own words. `kind: "path"` carries
 *  a transcript file; `kind: "id"` carries the id itself. */
export interface AgentSession {
	agent: string;
	kind: string;
	source: string;
	value: string;
}

export interface PaneList {
	origin: "herdr" | "herdr-failed" | "fixture" | "disabled" | "missing" | "error";
	panes: Row[];
	reason: string | null;
	cached?: boolean;
}

export interface Mark {
	idleTicks?: number;
	status?: string;
	firstSeen?: string;
	lastSeen?: string;
	completionSeq?: number;
	stateChangeSeq?: number;
}

export interface ClaimEntry {
	claim: Claim;
	name: string;
	path: string;
	mtimeMs: number | null;
	mtime: string | null;
}

export interface ClaimsRead {
	dir: string;
	dirExists: boolean;
	dirError: string | null;
	claims: Map<string, ClaimEntry>;
	files: { name: string; path: string; bytes: number; mtime: string | null; mtimeMs: number | null; error: string | null }[];
}

export interface UntypedRow {
	kind: string;
	ts: string | null;
	paneId: string | null;
	group: string | null;
	reason: string | null;
	text: string | null;
	why: string | null;
	dry: boolean;
}

export interface EventFileStat {
	exists: boolean;
	bytes: number;
	mtimeMs: number | null;
	mtime: string | null;
	error: string | null;
}

export interface EventLog {
	typed: SchemaEvent[];
	untyped: UntypedRow[];
	untypedCount: number;
	rejected: { count: number; samples: { line: number; reason: string; excerpt: string }[] };
	stat: EventFileStat;
	truncatedTail: boolean;
	exists: boolean;
}

export interface AskLog {
	log: Map<string, AskRecord>;
	stat: EventFileStat;
	exists: boolean;
	lines: number;
	rejected: number;
}

export interface AskFold {
	pending: AskRecord[];
	answered: AskRecord[];
	answeredTotal: number;
}

export interface PaneAxis {
	name: "live" | "panes-absent" | "fixture";
	words: string;
	reason: string;
}

export interface DecisionAxis {
	present: boolean;
	count: number;
	words: string;
	reason: string;
	sample: boolean;
}

export interface SourceFile {
	name: string;
	path: string;
	exists: boolean;
	bytes: number;
	mtime: string | null;
	mtimeMs: number | null;
	role: string;
	rows?: number | null;
	untyped?: number | null;
	rejected?: number | null;
	unreadable?: number | null;
	lastTs?: string | null;
	error?: string | null;
}

export interface SourceClock {
	shiftMs: number;
	rebase: boolean;
	anchorOriginal: string | null;
	fixtureWrittenAt?: string | null;
}

/** What one load saw. Both modes produce this shape, so no builder branches on the
 *  mode to know where a number came from: the source says. */
export interface Source {
	mode: "live" | "panes-absent" | "fixture";
	modeReason: string;
	paneAxis: PaneAxis;
	decisions: DecisionAxis;
	sourceDetail: string;
	stateDir: string;
	registryDir: string;
	events: EventLog;
	asks: AskLog & AskFold;
	claims: ClaimsRead;
	panes: PaneList;
	marks: Record<string, Mark>;
	policy: Record<string, unknown>;
	triggers: unknown;
	cooldowns: Record<string, number>;
	pending: Record<string, unknown>;
	banner: string | null;
	clock: SourceClock;
	files: SourceFile[];
	meta?: Record<string, unknown> | null;
}

export type SourceOrError = Source | { error: string };

// ------------------------------------------------------- JSON field access
//
// A document is data. These three read an optional field off a typed event without
// asserting a shape the parser already refused, so a builder never needs a cast at
// the point of use.

export function fieldOf(row: object, key: string): unknown {
	return key in row ? (row as Record<string, unknown>)[key] : undefined;
}

export function strField(row: object, key: string, fallback: string | null = null): string | null {
	const value = fieldOf(row, key);
	return typeof value === "string" ? value : fallback;
}

export function numField(row: object, key: string, fallback: number | null = null): number | null {
	const value = fieldOf(row, key);
	return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

export function boolField(row: object, key: string, fallback: boolean | null = null): boolean | null {
	const value = fieldOf(row, key);
	return typeof value === "boolean" ? value : fallback;
}

export function str(value: unknown, fallback = ""): string {
	return typeof value === "string" ? value : fallback;
}

export function num(value: unknown, fallback = 0): number {
	return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

export function isBag(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
