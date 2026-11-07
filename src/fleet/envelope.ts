// The envelope every route and every dump shares, and the one clock.
//
// Two structural rules are enforced here rather than trusted:
//
//   * a number without provenance is not returned. `tiles` is the only way a headline
//     figure reaches a document, and a tile cannot be built without saying which file it
//     came from and how many rows it was computed over. Null is a first-class value with a
//     reason, because "unknown" printed as 0 is the failure mode this whole surface exists
//     to prevent.
//   * `now` is the only clock. No builder calls `Date.now()`: `--now <epoch-ms>` makes two
//     runs of the same document byte-identical, which is what lets a golden pair compare
//     values instead of normalising the 64 clock-derived fields away.

import { attentionItems } from "./attention.ts";
import { fleetMix, fleetScale, newestTs } from "./source.ts";
import { decisionModeState } from "./settings.ts";
import type { Ctx, CtxOptions, Doc, Source, Tile, WindowName } from "./types.ts";

export const WINDOW_MS: Readonly<Record<WindowName, number | null>> = { "1h": 3_600_000, "24h": 86_400_000, all: null };

export const DEFAULT_LIMIT = 200;
export const DEFAULT_INTERVAL_MS = 60_000;
export const DEFAULT_TURNS = 20;

export function windowStart(window: WindowName, now: number): number | null {
	const span = WINDOW_MS[window];
	return span === null ? null : now - span;
}

export function inWindow<T extends { ts?: unknown }>(rows: T[], window: WindowName, now: number): T[] {
	const start = windowStart(window, now);
	if (start === null) return rows;
	return rows.filter((row) => {
		const parsed = Date.parse(typeof row.ts === "string" ? row.ts : "");
		return Number.isFinite(parsed) && parsed >= start;
	});
}

export function lagSecondsOf(ts: string | null | undefined, now: number): number | null {
	if (!ts) return null;
	const parsed = Date.parse(ts);
	return Number.isFinite(parsed) ? Math.max(0, Math.round((now - parsed) / 1000)) : null;
}

/** A headline figure, with the two things that make it checkable. `null` is allowed and
 *  must carry `nullReason`. `source` is the short form printed under the value;
 *  `sourceLong` is the full path, kept in the tooltip so the visible line stays one line
 *  wide. `of` is for the one figure that is a ratio of two populations. `format` is how
 *  the number is printed — `usd` exists because a tick costs milli-cents and
 *  `String(0.01024)` is not money. */
export function tile(args: {
	id: string;
	label: string;
	value: string | number | null;
	unit?: string;
	n: number;
	source: string;
	sourceLong?: string | null;
	note?: string | null;
	of?: { value: number; source: string } | null;
	format?: string | null;
	nullReason?: string | null;
	tone?: string;
	detail?: string | null;
}): Tile {
	const nullReason = args.nullReason ?? null;
	if (args.value === null && nullReason === null) throw new Error(`tile ${args.id}: a null needs a reason`);
	if (args.of !== undefined && args.of !== null && (typeof args.of.value !== "number" || typeof args.of.source !== "string")) {
		throw new Error(`tile ${args.id}: an \`of\` needs a number and the file it came from`);
	}
	return {
		id: args.id,
		label: args.label,
		value: args.value,
		unit: args.unit ?? "",
		n: args.n,
		source: args.source,
		sourceLong: args.sourceLong ?? null,
		note: args.note ?? null,
		of: args.of ?? null,
		format: args.format ?? null,
		nullReason,
		tone: args.tone ?? "neutral",
		detail: args.detail ?? null,
	};
}

export function provenanceOf(source: Source): Record<string, unknown> {
	return {
		mode: source.mode,
		modeReason: source.modeReason,
		files: source.files,
		rows: {
			typed: source.events.typed.length,
			untyped: source.events.untypedCount,
			rejected: source.events.rejected.count,
			truncatedTail: source.events.truncatedTail,
			asks: source.asks.log.size,
			asksPending: source.asks.pending.length,
			claims: source.claims.claims.size,
			panes: source.panes.panes.length,
			panesOrigin: source.panes.origin,
			panesReason: source.panes.reason,
		},
	};
}

/** The decision path the supervisor is on, read from the supervisor's own file by the
 *  same rules its module enforces. A read that fails is reported as a failure, never as a
 *  mode: the strip has to be able to say "could not read" instead of drawing a chip that
 *  might be the old value. */
function readDecisionModeFor(ctx: Ctx): Record<string, unknown> {
	try {
		const setting = decisionModeState(ctx.opts.dataDir ?? ctx.source.stateDir);
		return { mode: setting.mode, source: setting.source, note: setting.note ?? null, path: setting.path, updatedAt: setting.updatedAt };
	} catch (error) {
		return { mode: null, source: "unreadable", note: error instanceof Error ? error.message : "unreadable", path: null, updatedAt: null };
	}
}

export interface EnvelopeInput {
	route: string;
	screen: string;
	title: string;
	n: number;
	tiles: Tile[];
	notes?: string[];
	data?: Record<string, unknown>;
	counts?: Record<string, unknown>;
}

/** The document. Every key is computed here once, so two screens on the same request
 *  cannot disagree about the window, the lag or the fleet size. */
export function envelope(ctx: Ctx, input: EnvelopeInput): Doc {
	return {
		ok: true,
		route: input.route,
		screen: input.screen,
		title: input.title,
		source: ctx.source.mode,
		sourceDetail: ctx.source.sourceDetail,
		window: ctx.window,
		n: input.n,
		counts: input.counts ?? {},
		generatedAt: new Date(ctx.now).toISOString(),
		lagSeconds: ctx.lagSeconds,
		newestRowTs: ctx.newestRowTs,
		freshness: {
			asOf: new Date(ctx.now).toISOString(),
			newestRowTs: ctx.newestRowTs,
			lagSeconds: ctx.lagSeconds,
			staleAfterSeconds: Math.round(ctx.staleAfterMs / 1000),
			stopAfterSeconds: Math.round(ctx.stopAfterMs / 1000),
			isStale: ctx.lagSeconds !== null && ctx.lagSeconds > Math.round(ctx.stopAfterMs / 1000),
		},
		fleet: fleetScale(ctx.source),
		mix: fleetMix(ctx.source),
		mode: {
			name: ctx.source.mode,
			reason: ctx.source.modeReason,
			banner: ctx.source.banner,
			clock: ctx.source.clock,
			words: ctx.source.paneAxis.words,
			decisions: ctx.source.decisions,
			decision: readDecisionModeFor(ctx),
		},
		attention: attentionItems(ctx),
		tiles: input.tiles,
		notes: input.notes ?? [],
		provenance: provenanceOf(ctx.source),
		data: input.data ?? {},
	};
}

/** The per-request context every builder takes. Built once so two screens on the same
 *  request cannot disagree about what "now" or "this window" mean. */
export function buildContext(opts: CtxOptions, source: Source, now: number): Ctx {
	const allEvents = source.events.typed;
	const events = inWindow(allEvents, opts.window, now);
	const newest = newestTs(events) ?? newestTs(allEvents);
	const intervalMs = opts.intervalMs > 0 ? opts.intervalMs : DEFAULT_INTERVAL_MS;
	return {
		now,
		dataDir: opts.dataDir,
		host: null,
		port: null,
		window: opts.window,
		dump: null,
		fixture: source.mode === "fixture",
		herdr: opts.herdr,
		opts,
		source,
		events,
		allEvents,
		byKind: (kind: string) => events.filter((event) => event.kind === kind),
		allByKind: (kind: string) => allEvents.filter((event) => event.kind === kind),
		newestRowTs: newest === null ? null : new Date(newest).toISOString(),
		lagSeconds: newest === null ? null : lagSecondsOf(new Date(newest).toISOString(), now),
		staleAfterMs: 3 * intervalMs,
		stopAfterMs: 2 * intervalMs,
	};
}

/** The options a request is served with, defaults included. One place, so a flag's
 *  default cannot differ between the route and the dump. */
export function defaultOptions(overrides: Partial<CtxOptions> = {}): CtxOptions {
	return {
		dataDir: null,
		registryDir: null,
		fixtureDir: null,
		root: process.cwd(),
		window: "24h",
		limit: DEFAULT_LIMIT,
		intervalMs: DEFAULT_INTERVAL_MS,
		turns: DEFAULT_TURNS,
		herdr: true,
		live: false,
		forceFixture: false,
		fixtureRebase: true,
		fixtureAgeMs: 120_000,
		filter: null,
		enableActions: false,
		enableChat: false,
		enableSettings: false,
		allowRemoteWrites: false,
		agentFleetRoot: "",
		notesDir: null,
		home: process.env.HOME ?? "/",
		...overrides,
	};
}

/** Parses a `--now`/`?now=` value. Only an integer epoch in milliseconds is accepted:
 *  a caller that passes anything else gets `null` and keeps the real clock, because a
 *  half-parsed clock is worse than an unpinned one. */
export function parseNow(value: unknown): number | null {
	if (typeof value === "number" && Number.isFinite(value)) return Math.trunc(value);
	if (typeof value !== "string" || value.trim() === "") return null;
	if (!/^\d{10,}$/.test(value.trim())) return null;
	const parsed = Number(value.trim());
	return Number.isFinite(parsed) ? Math.trunc(parsed) : null;
}
