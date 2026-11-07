// Today's spend, read from a log cheaply enough to call on every tick.
//
// The caps this answers for are per day, and they are the only limits in the
// supervisor that a single tick cannot satisfy. So the check runs before the tick's
// first model call, and it has to cost nothing worth noticing: the warm path is one
// `stat` and a map lookup, and only the bytes appended since the last call are
// parsed (see ./tail.ts). Nothing here re-reads the log.
//
// Two definitions of "day" live here, and both are needed in the same tick. The
// fleet's own cap is a *local*-day cap: a supervisor whose budget resets at 20:00 EDT
// is one the operator cannot reason about, and "today's spend" is his question. The
// global cap is a *UTC*-day cap, because what it measures is an account's spend
// across every agent, and an account's day is not a timezone's. They read the same
// `events.jsonl` through separate readers with separate offsets and separate
// buckets — `dayKey` names which — so the two folds can never mix.
//
// Why the `tick` row and not every row that carries a `costUsd`: a decision row
// prices one model, an inspection row prices one inspection, and the tick row prices
// the whole tick — ladder trails and findings included. Adding the per-model rows to
// it would count the same money twice (`report.ts` says the same thing in its notes).
//
// Why raw JSON rather than `parseEvent`: `parseEvent` requires
// `schema === SCHEMA_VERSION`, and `events.jsonl` is append-only across schema
// versions, so a tick line written before the schema existed would be dropped.
// For a spend cap, under-counting is the unsafe direction — it is the only error
// that lets a runaway through — so this reader takes any row that says it is a
// tick and carries a finite `costUsd`.

import { tailLines } from "./tail.ts";

/** What one day has cost so far, as the tick row records it. */
export interface DaySpend {
	/** The day this answers for, `YYYY-MM-DD`. */
	day: string;
	/** `costUsd` summed over the day's tick rows. */
	spentUsd: number;
	/** Tick rows counted. Zero means nothing has priced this day yet. */
	ticks: number;
	/** Tick rows that skipped their model calls because of either cap. */
	cappedTicks: number;
	/** Tick rows that were stopped by the *global* cap, so its own once-a-day
	 *  notification is counted against the UTC day it belongs to. */
	globalCappedTicks: number;
	/** Tick rows that recorded the global spend source as unreadable. The first of
	 *  them is what makes the day's warning-once rule work without any new state. */
	unavailableTicks: number;
	/** True once a fleet-capped tick has been written today: the operator has been
	 *  told once, and the rest of the day is silent rather than 1,440 more messages. */
	notified: boolean;
}

interface DayBucket {
	spentUsd: number;
	ticks: number;
	cappedTicks: number;
	globalCappedTicks: number;
	unavailableTicks: number;
	notified: boolean;
}

interface LogCache {
	/** One bucket per day the log covers. A bucket is six numbers and a flag. */
	days: Map<string, DayBucket>;
}

/** Which definition of "day" a fold uses. Spelled out at the call site, because a
 *  cap that silently reset on the wrong boundary would be a cap nobody can predict. */
export type DayKey = "local" | "utc";

const caches = new Map<string, LogCache>();

/** The operator's day, not UTC's. A cap that resets at 20:00 EDT is a cap the
 *  operator cannot reason about, and "today's spend" is his question. */
export function localDay(ms: number): string {
	const date = new Date(ms);
	const month = String(date.getMonth() + 1).padStart(2, "0");
	const day = String(date.getDate()).padStart(2, "0");
	return `${date.getFullYear()}-${month}-${day}`;
}

/** The account's day. What the global cap measures is spend across every agent and
 *  every account, and those rows are stamped in a log with no timezone of its own,
 *  so its day is UTC rather than the operator's. */
export function utcDay(ms: number): string {
	return new Date(ms).toISOString().slice(0, 10);
}

function dayOf(key: DayKey): (ms: number) => string {
	return key === "utc" ? utcDay : localDay;
}

function bucketFor(cache: LogCache, day: string): DayBucket {
	const existing = cache.days.get(day);
	if (existing !== undefined) return existing;
	const created: DayBucket = { spentUsd: 0, ticks: 0, cappedTicks: 0, globalCappedTicks: 0, unavailableTicks: 0, notified: false };
	cache.days.set(day, created);
	return created;
}

/** Folds one line into its day bucket. Anything that is not a priced tick row is
 *  not this module's business and is skipped in silence: the log is shared. */
function ingest(cache: LogCache, key: DayKey, line: string): void {
	if (line.trim() === "") return;
	let raw: unknown;
	try {
		raw = JSON.parse(line);
	} catch {
		return;
	}
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return;
	const bag = raw as Record<string, unknown>;
	if (bag.kind !== "tick") return;
	const costUsd = bag.costUsd;
	if (typeof costUsd !== "number" || !Number.isFinite(costUsd)) return;
	const ts = bag.ts;
	if (typeof ts !== "string") return;
	const tsMs = Date.parse(ts);
	if (Number.isNaN(tsMs)) return;

	const bucket = bucketFor(cache, dayOf(key)(tsMs));
	bucket.spentUsd += costUsd;
	bucket.ticks += 1;
	// A row written before the global cap existed carries no `capScope` and was
	// therefore a fleet-capped row, which is the correct reading of it.
	if (bag.capped === true) {
		bucket.cappedTicks += 1;
		if (bag.capScope === "global") bucket.globalCappedTicks += 1;
		else bucket.notified = true;
	}
	if (bag.globalSpendSource === "unavailable") bucket.unavailableTicks += 1;
}

/** Where the day stands. `nowMs` is the tick's own clock, so a test can put the
 *  supervisor either side of midnight without waiting for one. */
export function dailySpend(logPath: string, nowMs: number = Date.now(), key: DayKey = "local"): DaySpend {
	const day = dayOf(key)(nowMs);
	const cacheKey = `${key}\u0000${logPath}`;
	let cache = caches.get(cacheKey);
	if (cache === undefined) {
		cache = { days: new Map() };
		caches.set(cacheKey, cache);
	}
	const held = cache;
	tailLines({
		key: `day:${cacheKey}`,
		logPath,
		// The log was replaced or rewritten (a rotate, a prune): the buckets were built from
		// the file that is gone, so they are dropped before the new one is folded in.
		onRestart: () => held.days.clear(),
		onLine: (line) => ingest(held, key, line),
	});

	const bucket = held.days.get(day);
	return {
		day,
		spentUsd: bucket?.spentUsd ?? 0,
		ticks: bucket?.ticks ?? 0,
		cappedTicks: bucket?.cappedTicks ?? 0,
		globalCappedTicks: bucket?.globalCappedTicks ?? 0,
		unavailableTicks: bucket?.unavailableTicks ?? 0,
		notified: bucket?.notified ?? false,
	};
}
