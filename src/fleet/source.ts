// One read of everything a surface can see, in one place, once per request.
//
// **Two axes, never one.** Whether the panes are live is a fact about `herdr`; whether
// there is any decision history is a fact about `events.jsonl`. They are independent: a
// box can have forty-three live panes and a supervisor that has never decided anything.
// The GUI decided both from the log's existence, so a live fleet with an empty decision
// log reported itself as "the shipped fixture" and the pane list was never even
// requested. That is the bug this file is shaped around:
//
//   `mode`      panes live (herdr answered) / panes absent (no herdr) / fixture
//   `decisions` none yet / n decisions — its own field, its own words
//
// Fixture mode is therefore a statement about *panes*: it may only be entered when
// nothing on the box is live. `forceFixture` refuses to run at all while herdr reports
// panes, because a sample banner in front of a real fleet is the exact lie this module
// exists to prevent.
//
// Panes come from `herdr api snapshot` in live mode and from `fixtures/panes.json` in
// fixture mode, so a fixture pane id can never be matched against a real pane.
//
// Fixture replay: a static fixture is honest and useless — after a day its newest row
// is a day old and every screen reads "the supervisor is stopped". So in fixture mode
// every timestamp is shifted by one constant offset, chosen so the newest row reads as
// recent. The shift is recorded and printed; what it never does is shift a live row.

import { join } from "node:path";

import { readClaimEntries } from "./claims.ts";
import { readAskFile, foldAsks } from "./asks.ts";
import { readEventLog } from "./events.ts";
import { readJson, readText, statFile } from "./fsio.ts";
import { isSamplePaneId } from "./identity.ts";
import { fixturePaths, statePaths, stateDir as defaultStateDir, registryDir as defaultRegistryDir } from "./where.ts";
import { fixturePanesOf } from "./reader.ts";
import { snapshot as herdrSnapshot } from "../herdr/cli.ts";
import type { CtxOptions, DecisionAxis, Mark, PaneAxis, PaneList, Source, SourceFile, SourceOrError } from "./types.ts";
import { num, str } from "./types.ts";

export const DEFAULT_WINDOW = "24h" as const;
export const PANE_CACHE_MS = 3000;

/** Resolves `sourceOf`'s first argument. The frozen call is `sourceOf(ctx)`; a ctx
 *  cannot exist before a source does, so both spellings are accepted: a partial
 *  context `{opts, now}` and the options object alone. */
type SourceInput = CtxOptions | { opts: CtxOptions; now?: number };

function inputOf(input: SourceInput, now?: number): { opts: CtxOptions; now: number } {
	if (typeof input === "object" && input !== null && "opts" in input) {
		return { opts: (input as { opts: CtxOptions }).opts, now: (input as { now?: number }).now ?? now ?? Date.now() };
	}
	return { opts: input as CtxOptions, now: now ?? Date.now() };
}

/** The one sentence every fixture screen carries, with the count it is about. */
export function fixtureBanner(count: number): string {
	return `${count} made-up conversation${count === 1 ? "" : "s"}. This is not a report about your fleet. Some of the names came from real panes once; none of these numbers is one.`;
}

/** How many typed `decision` rows this load holds. The second axis: `none yet` is not
 *  a fault, it is a supervisor that has not acted, and it must be printable without
 *  changing what the pane column says. */
export function decisionAxis(typed: { kind: string }[], options: { present: boolean; path: string; sample?: boolean }): DecisionAxis {
	const count = typed.filter((row) => row.kind === "decision").length;
	const words = count === 0 ? "none yet" : `${count} decision${count === 1 ? "" : "s"}`;
	let reason: string;
	if (count > 0) reason = `${words} in ${options.path}`;
	else if (options.present) reason = `${options.path} has no decision row: the supervisor has not acted yet`;
	else reason = `${options.path} does not exist yet: the supervisor has written nothing`;
	return { present: options.present === true, count, words, reason, sample: options.sample === true };
}

/** The first axis, from the pane list alone. */
export function paneAxis(panes: PaneList): PaneAxis {
	if (panes.origin === "herdr") {
		const count = panes.panes.length;
		return {
			name: "live",
			words: `${count} live pane${count === 1 ? "" : "s"}`,
			reason: `herdr answered with ${count} pane${count === 1 ? "" : "s"}`,
		};
	}
	return {
		name: panes.origin === "fixture" ? "fixture" : "panes-absent",
		words: panes.origin === "fixture" ? `${panes.panes.length} sample panes` : "panes absent",
		reason:
			panes.origin === "fixture"
				? "this is the shipped sample fleet, so no pane in it names a process"
				: `the pane list is unavailable (${panes.reason ?? panes.origin})`,
	};
}

/** The pane list behind this load, as a name and as a kind. `none` is a real kind:
 *  `--no-herdr` in live mode leaves the surface with records and no list to check them
 *  against, and that has to read differently from "this pane is gone". */
export function paneListSource(source: { panes?: PaneList } | null | undefined): {
	kind: "live" | "fixture" | "none";
	origin: string | null;
	short: string;
	label: string;
} {
	const origin = source?.panes?.origin ?? null;
	if (origin === "herdr") return { kind: "live", origin, short: "herdr api snapshot", label: "herdr api snapshot" };
	if (origin === "fixture") return { kind: "fixture", origin, short: "fixtures/panes.json", label: "fixtures/panes.json (fixture)" };
	return { kind: "none", origin, short: "no pane list (--no-herdr)", label: "no pane list (--no-herdr)" };
}

/** `fixture` or `live`: the mode this load's records came from. */
export function recordSource(source: { mode?: string } | null | undefined): "fixture" | "live" {
	return source?.mode === "fixture" ? "fixture" : "live";
}

/**
 * `comparable` is the only thing callers should branch on. It is true when the records
 * and the pane list came from the same source, which is the only state in which "this
 * pane is not in the list" is a fact about the fleet rather than about two files.
 */
export function scopeOf(source: { mode?: string; panes?: PaneList } | null | undefined): {
	records: "fixture" | "live";
	panes: ReturnType<typeof paneListSource>;
	comparable: boolean;
	why: string;
} {
	const panes = paneListSource(source);
	const records = recordSource(source);
	return {
		records,
		panes,
		comparable: (records === "live" && panes.kind === "live") || (records === "fixture" && panes.kind === "fixture"),
		why:
			panes.kind === "none"
				? "there is no pane list on this server, so pane presence cannot be checked"
				: `the records come from ${records === "live" ? "the live files" : "the fixtures"} and the pane list from ${panes.short}, so the two are not compared`,
	};
}

/** How big the fleet is. `observed` is what this load lists; `total` is the fleet the
 *  list belongs to — the same snapshot in live mode, and the count the fixture declares
 *  about the real fleet in fixture mode, labelled as a sample and never as a
 *  measurement this load made. */
export function fleetScale(source: Source): {
	observed: number;
	total: number | null;
	sample: boolean;
	totalSource: string;
	line: string;
	why: string;
	paneList: string;
} {
	const observed = source.panes.panes.length;
	const paneList = paneListSource(source);
	if (source.mode === "fixture") {
		const declared = source.meta?.liveFleetPanes;
		const total = typeof declared === "number" && Number.isFinite(declared) ? declared : null;
		return {
			observed,
			total,
			sample: true,
			totalSource: "fixtures/fixture.json (liveFleetPanes)",
			line: total === null ? `${observed} observed · the fixture declares no fleet size` : `${observed} observed · ${total} in fleet · sample`,
			why: "the fixture files are a sample of the fleet and declare the live count; nothing on this load measured the live machine",
			paneList: paneList.short,
		};
	}
	return {
		observed,
		total: observed,
		sample: false,
		totalSource: paneList.label,
		line: `${observed} observed · ${observed} in fleet`,
		why: "the list this load read is the whole live fleet: herdr answered with these panes",
		paneList: paneList.label,
	};
}

/** What the fleet is doing, in two dimensions that are each counted to closure: a
 *  pane's status (exhaustive, blocked included) and how many panes have no claim file
 *  (a count of panes, with its own denominator). Printed as one list they added to
 *  more than the fleet. */
export function fleetMix(source: Source): {
	panes: number;
	counts: Record<string, number>;
	statusTotal: number;
	neverClaimed: number;
	line: string;
	why: string;
} {
	const panes = source.panes.panes;
	const claims = source.claims.claims;
	const counts: Record<string, number> = { working: 0, idle: 0, blocked: 0, done: 0, unknown: 0 };
	let neverClaimed = 0;
	for (const pane of panes) {
		const key = pane.agent_status in counts ? pane.agent_status : "unknown";
		counts[key] = (counts[key] ?? 0) + 1;
		if (!claims.has(pane.pane_id)) neverClaimed += 1;
	}
	const statusTotal = Object.values(counts).reduce((sum, count) => sum + count, 0);
	const byStatus = ["working", "idle", "blocked", "done", "unknown"]
		.filter((status) => (counts[status] ?? 0) > 0)
		.map((status) => `${counts[status]} ${status}`);
	return {
		panes: panes.length,
		counts,
		statusTotal,
		neverClaimed,
		line:
			panes.length === 0
				? "no panes listed"
				: `status: ${byStatus.join(" · ")} = ${statusTotal} · ${neverClaimed} of ${panes.length} have no claim`,
		why: `two different counts over the same ${panes.length} panes, each closed: the status list adds to ${statusTotal}, and blocked is in it because a status breakdown that leaves blocked out cannot add up. "No claim" counts panes, not statuses, so it carries its own denominator`,
	};
}

// ------------------------------------------------------------------- the panes

/** One snapshot read, cached for three seconds so two tabs refreshing together do not
 *  each pay a fork. Reset exists for tests and for a caller that just wrote. */
let paneCache: { at: number; value: PaneList } | null = null;

export function resetPaneCache(): void {
	paneCache = null;
}

async function listPanes(opts: CtxOptions, now: number): Promise<PaneList> {
	if (!opts.herdr) return { origin: "disabled", panes: [], reason: "--no-herdr: the pane list was not read" };
	if (paneCache !== null && now - paneCache.at < PANE_CACHE_MS) return { ...paneCache.value, cached: true };
	const snap = await herdrSnapshot();
	const value: PaneList =
		snap.reason === null && snap.rows.length > 0
			? { origin: "herdr", panes: snap.rows, reason: null }
			: snap.reason === null
				? { origin: "herdr", panes: [], reason: null }
				: { origin: "herdr-failed", panes: [], reason: snap.reason };
	paneCache = { at: now, value };
	return { ...value, cached: false };
}

// ------------------------------------------------------------------- the load

function readStateFile(path: string): { value: unknown; error: string | null } {
	const json = readJson(path);
	return { value: json.value, error: json.error };
}

function fileEntry(name: string, path: string, stat: { exists: boolean; bytes: number; mtime: string | null; mtimeMs: number | null }, extra: Partial<SourceFile> = {}): SourceFile {
	return { name, path, exists: stat.exists, bytes: stat.bytes, mtime: stat.mtime, mtimeMs: stat.mtimeMs, role: "", ...extra };
}

function markMap(value: unknown): Record<string, Mark> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
	const out: Record<string, Mark> = {};
	for (const [paneId, mark] of Object.entries(value as Record<string, unknown>)) {
		if (typeof mark !== "object" || mark === null) continue;
		const row = mark as Record<string, unknown>;
		const entry: Mark = {};
		if (typeof row.idleTicks === "number") entry.idleTicks = row.idleTicks;
		if (typeof row.status === "string") entry.status = row.status;
		if (typeof row.firstSeen === "string") entry.firstSeen = row.firstSeen;
		if (typeof row.lastSeen === "string") entry.lastSeen = row.lastSeen;
		out[paneId] = entry;
	}
	return out;
}

function objectMap<T>(value: unknown): Record<string, T> {
	return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, T>) : {};
}

/** Widest `ts` over a set of rows, used as the replay anchor and by the envelope. */
export function newestTs(rows: { ts?: unknown }[]): number | null {
	let max: number | null = null;
	for (const row of rows) {
		const parsed = Date.parse(str(row.ts, ""));
		if (Number.isFinite(parsed) && (max === null || parsed > max)) max = parsed;
	}
	return max;
}

function shiftIso(value: unknown, shiftMs: number): unknown {
	if (typeof value !== "string") return value;
	const parsed = Date.parse(value);
	if (!Number.isFinite(parsed)) return value;
	return new Date(parsed + shiftMs).toISOString();
}

async function loadLive(opts: CtxOptions, now: number, preset?: PaneList): Promise<Source> {
	const state = statePaths(opts.dataDir ?? defaultStateDir());
	const registry = opts.registryDir ?? defaultRegistryDir();
	const events = readEventLog(state.events);
	const asks = readAskFile(state.asks);
	const claimEntries = readClaimEntries(registry);
	const panes = preset ?? (await listPanes(opts, now));
	const marksFile = readStateFile(state.marks);
	const policyFile = readStateFile(state.policy);
	const triggersFile = readStateFile(state.triggers);
	const cooldownsFile = readStateFile(state.cooldowns);
	const pendingFile = readStateFile(state.pending);
	const folded = foldAsks(asks.log);
	const axis = paneAxis(panes);
	const decisions = decisionAxis(events.typed, { present: events.stat.exists && events.stat.bytes > 0, path: state.events });
	const lastTs = newestTs(events.typed);

	return {
		mode: axis.name,
		modeReason: `${axis.reason}; ${decisions.reason}`,
		paneAxis: axis,
		decisions,
		sourceDetail: state.events,
		stateDir: state.dir,
		registryDir: registry,
		events,
		asks: { ...asks, ...folded },
		claims: claimEntries,
		panes,
		marks: markMap(marksFile.value),
		policy: objectMap(policyFile.value),
		triggers: triggersFile.value ?? null,
		cooldowns: {},
		pending: objectMap(pendingFile.value),
		banner: null,
		clock: { shiftMs: 0, rebase: false, anchorOriginal: null },
		files: [
			fileEntry("events.jsonl", state.events, events.stat, {
				role: "typed + untyped event rows",
				rows: events.typed.length,
				untyped: events.untypedCount,
				rejected: events.rejected.count,
				lastTs: lastTs === null ? null : new Date(lastTs).toISOString(),
			}),
			fileEntry("asks.jsonl", state.asks, asks.stat, { role: "the ask log, folded last-line-wins", rows: asks.lines, rejected: asks.rejected, lastTs: null }),
			fileEntry("marks.json", state.marks, readStateFileStat(state.marks), { role: "per-pane counters and idle ticks", error: marksFile.error }),
			fileEntry("triggers.json", state.triggers, readStateFileStat(state.triggers), { role: "claim history for the trigger rules", error: triggersFile.error }),
			fileEntry("cooldowns.json", state.cooldowns, readStateFileStat(state.cooldowns), { role: "per-pane nudge cooldown", error: cooldownsFile.error }),
			fileEntry("pending.json", state.pending, readStateFileStat(state.pending), { role: "decisions still being judged", error: pendingFile.error }),
			fileEntry("policy.json", state.policy, readStateFileStat(state.policy), { role: "the operator's per-group ask policy", error: policyFile.error }),
			fileEntry("claims/", registry, { exists: claimEntries.dirExists, bytes: 0, mtime: null, mtimeMs: null }, {
				role: "one claim file per pane, worker-authored",
				rows: claimEntries.claims.size,
				unreadable: claimEntries.files.filter((file) => file.error !== null).length,
				error: claimEntries.dirError,
			}),
			fileEntry("herdr api snapshot", "(subprocess)", { exists: panes.origin === "herdr", bytes: 0, mtime: null, mtimeMs: null }, {
				role: "the live pane list",
				rows: panes.panes.length,
				error: panes.reason,
			}),
		],
	};
}

function readStateFileStat(path: string): { exists: boolean; bytes: number; mtime: string | null; mtimeMs: number | null } {
	const stat = statFile(path);
	return { exists: stat.exists, bytes: stat.bytes, mtime: stat.mtime, mtimeMs: stat.mtimeMs };
}

function shiftMarks(marks: Record<string, Mark>, shiftMs: number): Record<string, Mark> {
	const out: Record<string, Mark> = {};
	for (const [paneId, mark] of Object.entries(marks)) {
		out[paneId] = {
			...mark,
			firstSeen: typeof mark.firstSeen === "string" ? (shiftIso(mark.firstSeen, shiftMs) as string) : undefined,
			lastSeen: typeof mark.lastSeen === "string" ? (shiftIso(mark.lastSeen, shiftMs) as string) : undefined,
		};
	}
	return out;
}

/** Fixture mode: the checked-in sample fleet, shifted so its newest row reads as
 *  recent. Every field that carries an instant is shifted by the same offset, so every
 *  age and every ordering is preserved exactly. */
async function loadFixture(opts: CtxOptions, now: number, reason: string): Promise<SourceOrError> {
	const dir = opts.fixtureDir ?? join(opts.root, "fixtures");
	const paths = fixturePaths(dir);
	const eventsRaw = readEventLog(paths.events);
	const anchor = newestTs(eventsRaw.typed) ?? newestTs(eventsRaw.untyped);
	const shiftMs = opts.fixtureRebase && anchor !== null ? now - opts.fixtureAgeMs - anchor : 0;

	const typed = shiftMs === 0 ? eventsRaw.typed : eventsRaw.typed.map((row) => ({ ...row, ts: shiftIso(row.ts, shiftMs) as string }));
	const untyped = shiftMs === 0 ? eventsRaw.untyped : eventsRaw.untyped.map((row) => ({ ...row, ts: shiftIso(row.ts, shiftMs) as string | null }));

	const asksFile = readAskFile(paths.asks);
	const log = new Map(
		[...asksFile.log.entries()].map(([id, record]) => [
			id,
			{
				...record,
				ts: shiftIso(record.ts, shiftMs) as string,
				...(record.answeredAt === undefined ? {} : { answeredAt: shiftIso(record.answeredAt, shiftMs) as string }),
			},
		]),
	);

	const marksFile = readStateFile(paths.marks);
	const policyFile = readStateFile(paths.policy);
	const triggersFile = readStateFile(paths.triggers);
	const cooldownsFile = readStateFile(paths.cooldowns);
	const pendingFile = readStateFile(paths.pending);

	const claimsRead = readClaimEntries(paths.claims);
	const claims = shiftMs === 0
		? claimsRead
		: {
				...claimsRead,
				claims: new Map(
					[...claimsRead.claims.entries()].map(([paneId, entry]) => [
						paneId,
						{ ...entry, claim: { ...entry.claim, updated: shiftIso(entry.claim.updated, shiftMs) as string } },
					]),
				),
			};

	const paneFixture = fixturePanesOf(paths.panes);
	const outsideNamespace = paneFixture.panes.filter((pane) => !isSamplePaneId(pane.pane_id));
	if (outsideNamespace.length > 0) {
		return {
			error: `${paths.panes}: ${outsideNamespace.length} fixture pane id${outsideNamespace.length === 1 ? " is" : "s are"} outside the sample namespace sample<n>:p<n>: ${outsideNamespace
				.slice(0, 4)
				.map((pane) => pane.pane_id)
				.join(", ")}${outsideNamespace.length > 4 ? ", …" : ""}. Renumber the fixture: a sample fleet must not carry ids this machine can issue.`,
		};
	}
	const panes: PaneList = opts.herdr
		? { ...paneFixture, origin: "fixture" }
		: { origin: "disabled", panes: [], reason: "--no-herdr: no pane list in fixture mode either" };

	const folded = foldAsks(log);
	const metaFile = readJson(paths.meta);
	const axis: PaneAxis = { name: "fixture", words: `${panes.panes.length} sample panes`, reason: "this is the shipped sample fleet, so no pane in it names a process" };
	const lastTs = newestTs(typed);

	return {
		mode: "fixture",
		modeReason: reason,
		paneAxis: axis,
		decisions: decisionAxis(typed, { present: eventsRaw.stat.exists, path: paths.events, sample: true }),
		sourceDetail: paths.dir,
		stateDir: paths.dir,
		registryDir: paths.claims,
		events: { ...eventsRaw, typed, untyped },
		asks: { ...asksFile, log, ...folded },
		claims,
		panes,
		marks: shiftMs === 0 ? markMap(marksFile.value) : shiftMarks(markMap(marksFile.value), shiftMs),
		policy: objectMap(policyFile.value),
		triggers: triggersFile.value ?? null,
		cooldowns: {},
		pending: objectMap(pendingFile.value),
		banner: fixtureBanner(panes.panes.length),
		clock: {
			shiftMs,
			rebase: shiftMs !== 0,
			anchorOriginal: anchor === null ? null : new Date(anchor).toISOString(),
			fixtureWrittenAt: typeof metaFile.value === "object" && metaFile.value !== null ? (str((metaFile.value as Record<string, unknown>).writtenAt) || null) : null,
		},
		meta: typeof metaFile.value === "object" && metaFile.value !== null ? (metaFile.value as Record<string, unknown>) : null,
		files: [
			fileEntry("events.jsonl", paths.events, eventsRaw.stat, {
				role: `fixture: typed rows, ${eventsRaw.untypedCount} untyped legacy rows`,
				rows: typed.length,
				untyped: eventsRaw.untypedCount,
				rejected: eventsRaw.rejected.count,
				lastTs: lastTs === null ? null : new Date(lastTs).toISOString(),
			}),
			fileEntry("asks.jsonl", paths.asks, asksFile.stat, { role: "fixture: the ask log", rows: asksFile.lines, rejected: asksFile.rejected }),
			fileEntry("marks.json", paths.marks, readStateFileStat(paths.marks), { role: "fixture: counters and idle ticks", error: marksFile.error }),
			fileEntry("triggers.json", paths.triggers, readStateFileStat(paths.triggers), { role: "fixture: claim history", error: triggersFile.error }),
			fileEntry("cooldowns.json", paths.cooldowns, readStateFileStat(paths.cooldowns), { role: "fixture: nudge cooldowns", error: cooldownsFile.error }),
			fileEntry("pending.json", paths.pending, readStateFileStat(paths.pending), { role: "fixture: open decisions", error: pendingFile.error }),
			fileEntry("policy.json", paths.policy, readStateFileStat(paths.policy), { role: "fixture: per-group ask policy", error: policyFile.error }),
			fileEntry("panes.json", paths.panes, readStateFileStat(paths.panes), { role: "fixture: the pane list herdr would answer with", rows: panes.panes.length, error: panes.reason }),
			fileEntry("claims/", paths.claims, { exists: claims.dirExists, bytes: 0, mtime: null, mtimeMs: null }, {
				role: "fixture: one claim file per pane",
				rows: claims.claims.size,
				unreadable: claims.files.filter((file) => file.error !== null).length,
				error: claims.dirError,
			}),
		],
	};
}

export interface SourceOf extends Source {
	/** The absolute paths this load read. Named so a caller can print provenance
	 *  without re-deriving a path (PLAN-v1 §2.0 names this field). */
	handles: {
		events: string;
		asks: string;
		marks: string;
		registryDir: string;
		paneList: string;
	};
}

/**
 * The axis decision, in one place: `--live` with nothing to read is an error;
 * `--force-fixture` in front of a live fleet is an error; a live log means live; a log
 * that does not exist means the *pane axis* decides the mode, not the log.
 */
export async function sourceOf(input: SourceInput, nowArg?: number): Promise<SourceOf | { error: string }> {
	const { opts, now } = inputOf(input, nowArg);
	const state = statePaths(opts.dataDir ?? defaultStateDir());
	const eventsStat = statFile(state.events);
	const hasLiveLog = eventsStat.exists && eventsStat.bytes > 0;

	if (opts.live && !hasLiveLog) {
		return { error: `--live was given but ${state.events} does not exist (or is empty). Nothing to read.` };
	}

	const panes = await listPanes(opts, now);
	const panesAreLive = panes.origin === "herdr";

	let source: SourceOrError;
	if (opts.forceFixture) {
		if (panesAreLive && panes.panes.length > 0) {
			return {
				error: `--force-fixture refusing to run: herdr reports ${panes.panes.length} live pane${panes.panes.length === 1 ? "" : "s"} on this box, and sample data must never be drawn in front of a live fleet. Drop --force-fixture to read the real files, or stop herdr first if you really mean to see the sample.`,
			};
		}
		source = await loadFixture(opts, now, `--force-fixture was given (a debug flag), so the fixtures were read even though nothing is live: ${panes.reason ?? panes.origin}`);
	} else if (hasLiveLog || panesAreLive) {
		source = await loadLive(opts, now, panes);
	} else {
		source = await loadFixture(
			opts,
			now,
			`nothing is live on this box: ${panes.reason ?? panes.origin}, and ${state.events} does not exist yet, so the shipped sample is being replayed`,
		);
	}

	if ("error" in source) return source;
	const paths = statePaths(source.stateDir);
	return {
		...source,
		handles: {
			events: paths.events,
			asks: paths.asks,
			marks: paths.marks,
			registryDir: source.registryDir,
			paneList: source.panes.origin === "herdr" ? "herdr api snapshot" : source.panes.origin,
		},
	};
}

/** A load that could not be made is not an empty fleet: the caller prints the reason
 *  and the page says so. This keeps the check in one place. */
export function sourceError(source: SourceOrError): string | null {
	return "error" in source ? source.error : null;
}

/** `intervals × 3` is the stale line and `× 2` the stopped line, as the GUI had them;
 *  kept here because two of the four constants a screen compares against are these. */
export function staleAfterMs(opts: { intervalMs: number }): number {
	return 3 * num(opts.intervalMs, 60_000);
}

export function stopAfterMs(opts: { intervalMs: number }): number {
	return 2 * num(opts.intervalMs, 60_000);
}
