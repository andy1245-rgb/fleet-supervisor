// Today's spend, read from the log cheaply enough to call on every tick.
//
// The cap this answers for is per local day, and it is the only limit in the
// supervisor that a single tick cannot satisfy. So the check runs before the
// tick's first model call, and it has to cost nothing worth noticing: the warm
// path is one `stat` and a map lookup, and only the bytes appended since the last
// call are parsed. Nothing here re-reads the log.
//
// Why the `tick` row and not every row that carries a `costUsd`: a decision row
// prices one model, an inspection row prices one inspection, and the tick row
// prices the whole tick — ladder trails and findings included. Adding the
// per-model rows to it would count the same money twice (`report.ts` says the
// same thing in its notes).
//
// Why raw JSON rather than `parseEvent`: `parseEvent` requires
// `schema === SCHEMA_VERSION`, and `events.jsonl` is append-only across schema
// versions, so a tick line written before the schema existed would be dropped.
// For a spend cap, under-counting is the unsafe direction — it is the only error
// that lets a runaway through — so this reader takes any row that says it is a
// tick and carries a finite `costUsd`.

import { closeSync, openSync, readSync, statSync } from "node:fs";

/** What one local day has cost so far, as the tick row records it. */
export interface DaySpend {
	/** The local day this answers for, `YYYY-MM-DD`. */
	day: string;
	/** `costUsd` summed over the day's tick rows. */
	spentUsd: number;
	/** Tick rows counted. Zero means nothing has priced this day yet. */
	ticks: number;
	/** Tick rows that skipped their model calls because of the cap. */
	cappedTicks: number;
	/** True once a capped tick has been written today: the operator has been told
	 *  once, and the rest of the day is silent rather than 1,440 more messages. */
	notified: boolean;
}

interface DayBucket {
	spentUsd: number;
	ticks: number;
	cappedTicks: number;
	notified: boolean;
}

interface LogCache {
	/** `dev:ino`, so a rotated or replaced log is rebuilt rather than trusted. */
	identity: string;
	/** Byte offset already counted. Only ever moves forward. */
	offset: number;
	/** One bucket per local day the log covers. A bucket is four numbers. */
	days: Map<string, DayBucket>;
}

const caches = new Map<string, LogCache>();

const CHUNK = 4 * 1024 * 1024;
const NEWLINE = 0x0a;

/** The operator's day, not UTC's. A cap that resets at 20:00 EDT is a cap the
 *  operator cannot reason about, and "today's spend" is his question. */
export function localDay(ms: number): string {
	const date = new Date(ms);
	const month = String(date.getMonth() + 1).padStart(2, "0");
	const day = String(date.getDate()).padStart(2, "0");
	return `${date.getFullYear()}-${month}-${day}`;
}

function bucketFor(cache: LogCache, day: string): DayBucket {
	const existing = cache.days.get(day);
	if (existing !== undefined) return existing;
	const created: DayBucket = { spentUsd: 0, ticks: 0, cappedTicks: 0, notified: false };
	cache.days.set(day, created);
	return created;
}

/** Folds one line into its day bucket. Anything that is not a priced tick row is
 *  not this module's business and is skipped in silence: the log is shared. */
function ingest(cache: LogCache, line: string): void {
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

	const bucket = bucketFor(cache, localDay(tsMs));
	bucket.spentUsd += costUsd;
	bucket.ticks += 1;
	if (bag.capped === true) {
		bucket.cappedTicks += 1;
		bucket.notified = true;
	}
}

function identityOf(logPath: string): string | undefined {
	try {
		const stat = statSync(logPath);
		return `${stat.dev}:${stat.ino}`;
	} catch {
		return undefined;
	}
}

function sizeOf(logPath: string): number {
	try {
		return statSync(logPath).size;
	} catch {
		return 0;
	}
}

/** Counts the complete lines from `cache.offset` to the end of the log. A
 *  trailing partial line is left for the next call: a tick writing right now must
 *  not be counted as half a row. */
function readNew(logPath: string, cache: LogCache): void {
	let fd: number;
	try {
		fd = openSync(logPath, "r");
	} catch {
		return;
	}
	try {
		const size = sizeOf(logPath);
		// Sized to what is actually left to read: a 4 MB buffer per tick to count one
		// appended line is an allocation the tick should not pay for. The cold read of a
		// large log still goes in CHUNK-sized pieces.
		const buffer = Buffer.alloc(Math.max(1, Math.min(CHUNK, size - cache.offset)));
		let carry: Buffer = Buffer.alloc(0);
		for (let pos = cache.offset; pos < size; ) {
			let n: number;
			try {
				n = readSync(fd, buffer, 0, buffer.length, pos);
			} catch {
				break;
			}
			if (n <= 0) break;
			pos += n;

			const piece = buffer.subarray(0, n);
			const data = carry.length === 0 ? piece : Buffer.concat([carry, piece]);
			const cut = data.lastIndexOf(NEWLINE);
			if (cut === -1) {
				carry = Buffer.from(data);
				continue;
			}
			const complete = data.subarray(0, cut + 1);
			carry = Buffer.from(data.subarray(cut + 1));

			let start = 0;
			for (;;) {
				const end = complete.indexOf(NEWLINE, start);
				if (end === -1) break;
				ingest(cache, complete.toString("utf8", start, end));
				start = end + 1;
			}
			cache.offset += complete.length;
		}
	} finally {
		closeSync(fd);
	}
}

/** Where the day stands. `nowMs` is the tick's own clock, so a test can put the
 *  supervisor either side of midnight without waiting for one. */
export function dailySpend(logPath: string, nowMs: number = Date.now()): DaySpend {
	const day = localDay(nowMs);
	const identity = identityOf(logPath);
	if (identity === undefined) {
		return { day, spentUsd: 0, ticks: 0, cappedTicks: 0, notified: false };
	}

	const size = sizeOf(logPath);
	let cache = caches.get(logPath);
	if (cache === undefined || cache.identity !== identity || cache.offset > size) {
		cache = { identity, offset: 0, days: new Map() };
		caches.set(logPath, cache);
		readNew(logPath, cache);
	} else if (size > cache.offset) {
		readNew(logPath, cache);
	}

	const bucket = cache.days.get(day);
	return {
		day,
		spentUsd: bucket?.spentUsd ?? 0,
		ticks: bucket?.ticks ?? 0,
		cappedTicks: bucket?.cappedTicks ?? 0,
		notified: bucket?.notified ?? false,
	};
}
