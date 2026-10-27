// The query layer over the event log.
//
// `events.jsonl` is the source of truth and it is append-only: the supervisor
// writes lines, nothing rewrites them. This module reads them and maintains a
// *derived* SQLite index next to the log, so the same file can be queried by
// time window and by group without re-parsing a year of ticks on every question.
//
// The invariant that makes the index trustworthy: it is only ever extended from
// the log's byte offset. Ingest reads complete lines from `offset`, inserts them
// and advances `offset` in the same transaction, so the index can lag the log but
// can never disagree with it. A log that shrinks or is replaced (a rotation, a
// restored backup) is detected by size and inode and rebuilt from zero rather
// than trusted.
//
// `node:sqlite` is available in this Node (24.x) and is loaded lazily through
// `createRequire`, so a runtime without it — or a database that cannot be opened
// — falls back to scanning the JSONL in memory and says so through `indexKind`
// instead of failing the report.

import { closeSync, existsSync, mkdirSync, openSync, readSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { parseEvent, type EventKind, type SchemaEvent } from "./schema.ts";

/** The windows a report may be asked for. `all` is the whole file. */
export type MetricsWindow = "1h" | "24h" | "all";

const WINDOW_MS: Readonly<Record<"1h" | "24h", number>> = { "1h": 3_600_000, "24h": 86_400_000 };

export function windowMs(window: MetricsWindow): number | null {
	return window === "all" ? null : WINDOW_MS[window];
}

export function isMetricsWindow(value: unknown): value is MetricsWindow {
	return value === "1h" || value === "24h" || value === "all";
}

export interface StoreQuery {
	/** Relative to `now`. Default `all`. */
	window?: MetricsWindow;
	/** Exact group key, as `src/fleet/groups.ts` names it. Events with no group
	 *  (tick summaries, watchdog findings) fall outside a group filter: they are
	 *  not that group's events. */
	group?: string;
	paneId?: string;
	kinds?: readonly EventKind[];
	/** Clock for the window cutoff. Default `Date.now()`. */
	now?: number;
}

export interface IngestResult {
	/** Bytes read from the log this call. */
	bytes: number;
	/** Events added to the index this call. */
	added: number;
	/** Lines skipped this call: not rows of this schema, or not JSON at all. */
	ignored: number;
	/** Lines skipped over the whole log, cumulative — the pre-schema backfill count. */
	ignoredTotal: number;
	/** Events indexed, cumulative. */
	rows: number;
	/** Byte offset the index now covers. */
	offset: number;
	/** True when the index was thrown away and rebuilt from zero. */
	rebuilt: boolean;
}

export interface Store {
	readonly logPath: string;
	/** The index file, or null when the index is in memory. */
	readonly indexPath: string | null;
	readonly indexKind: IndexKind;
	/** Reads whatever the log has added since the last call. Never re-reads. */
	ingest(): IngestResult;
	/** Drops the index and ingests the whole log again. */
	rebuild(): IngestResult;
	query(filter?: StoreQuery): SchemaEvent[];
	close(): void;
}

export type IndexKind = "sqlite" | "scan";

export interface StoreOptions {
	/** Overrides the derived index path. */
	indexPath?: string;
	/** Keep the index in memory: nothing is written next to the log. */
	memory?: boolean;
	/** Skip SQLite even where it is available. */
	forceScan?: boolean;
}

// ------------------------------------------------------------------- the log

interface LogRow {
	/** Byte offset of this line in the log. Records where a row came from. */
	byteStart: number;
	event: SchemaEvent;
}

interface LogRead {
	rows: LogRow[];
	/** Offset just past the last complete line read. A trailing partial line is
	 *  left for the next call: a tick writing right now must not be read as a
	 *  truncated event. */
	offset: number;
	/** Non-empty lines that are not rows of this schema. */
	ignored: number;
	bytes: number;
}

const CHUNK = 4 * 1024 * 1024;

const NEWLINE = 0x0a;

/** Reads complete lines from `from` to the end of the log. The only reader: the
 *  fallback index and the SQLite index must agree about what "the next rows" are,
 *  and the only way to guarantee that is one function. */
function readLog(logPath: string, from: number): LogRead {
	const rows: LogRow[] = [];
	let ignored = 0;
	let offset = from;
	let bytes = 0;

	let fd: number;
	try {
		fd = openSync(logPath, "r");
	} catch {
		return { rows, offset, ignored, bytes };
	}
	try {
		const size = statSync(logPath).size;
		const buffer = Buffer.alloc(CHUNK);
		let carry: Buffer = Buffer.alloc(0);
		for (let pos = from; pos < size; ) {
			let n: number;
			try {
				n = readSync(fd, buffer, 0, CHUNK, pos);
			} catch {
				break;
			}
			if (n <= 0) break;
			pos += n;
			bytes += n;

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
				const line = complete.toString("utf8", start, end);
				const event = parseEvent(line);
				if (event) rows.push({ byteStart: offset + start, event });
				else if (line.trim() !== "") ignored += 1;
				start = end + 1;
			}
			offset += complete.length;
		}
	} finally {
		closeSync(fd);
	}
	return { rows, offset, ignored, bytes };
}

/** Identity of the file the index was built against. A replaced log has a new
 *  inode even when its size grows, which is how a rotation is caught. */
function logIdentity(logPath: string): string | null {
	try {
		const stat = statSync(logPath);
		return `${stat.dev}:${stat.ino}`;
	} catch {
		return null;
	}
}

function logSize(logPath: string): number {
	try {
		return statSync(logPath).size;
	} catch {
		return 0;
	}
}

function groupOf(event: SchemaEvent): string | null {
	return "group" in event ? event.group : null;
}

function paneOf(event: SchemaEvent): string | null {
	return "paneId" in event ? event.paneId : null;
}

// ---------------------------------------------------------------- the index

interface ResolvedFilter {
	sinceMs: number | null;
	group: string | null;
	paneId: string | null;
	kinds: readonly EventKind[] | null;
}

interface Index {
	readonly kind: IndexKind;
	readonly path: string | null;
	offset(): number;
	rows(): number;
	ignored(): number;
	identity(): string | null;
	append(batch: readonly LogRow[], nextOffset: number, ignoredDelta: number, identity: string): void;
	query(filter: ResolvedFilter): SchemaEvent[];
	/** Moves the reported offset back to zero so the next ingest re-reads. */
	clear(): void;
	close(): void;
}

interface SqliteModule {
	DatabaseSync: new (path: string) => DatabaseSync;
}

function loadSqlite(): SqliteModule | undefined {
	try {
		const require = createRequire(import.meta.url);
		const mod = require("node:sqlite") as Partial<SqliteModule>;
		return typeof mod.DatabaseSync === "function" ? (mod as SqliteModule) : undefined;
	} catch {
		return undefined;
	}
}

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  byte_start INTEGER NOT NULL,
  ts_ms INTEGER NOT NULL,
  kind TEXT NOT NULL,
  group_key TEXT,
  pane_id TEXT,
  body TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS events_ts ON events (ts_ms);
CREATE INDEX IF NOT EXISTS events_kind ON events (kind);
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
`;

function createSqliteIndex(path: string, sqlite: SqliteModule): Index | undefined {
	let db: DatabaseSync;
	try {
		if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
		db = new sqlite.DatabaseSync(path);
		db.exec(SCHEMA_SQL);
	} catch {
		return undefined;
	}

	const insert = db.prepare(
		"INSERT INTO events (byte_start, ts_ms, kind, group_key, pane_id, body) VALUES (?, ?, ?, ?, ?, ?)",
	);
	const readMeta = db.prepare("SELECT value FROM meta WHERE key = ?");
	const writeMeta = db.prepare(
		"INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
	);
	const drop = db.prepare("DELETE FROM events");
	const clearMeta = db.prepare("DELETE FROM meta");

	function meta(key: string): string | undefined {
		const row = readMeta.get(key);
		if (row === undefined) return undefined;
		const value = row["value"];
		return typeof value === "string" ? value : undefined;
	}

	function metaNum(key: string): number {
		const value = meta(key);
		const n = value === undefined ? Number.NaN : Number(value);
		return Number.isFinite(n) ? n : 0;
	}

	function setMeta(key: string, value: string): void {
		writeMeta.run(key, value);
	}

	return {
		kind: "sqlite",
		path,
		offset: () => metaNum("offset"),
		rows: () => metaNum("rows"),
		ignored: () => metaNum("ignored"),
		identity: () => meta("identity") ?? null,

		append(batch, nextOffset, ignoredDelta, identity) {
			// One transaction: the rows and the offset they came from advance
			// together, so a crash leaves the index covering exactly what it holds.
			db.exec("BEGIN IMMEDIATE");
			try {
				for (const row of batch) {
					const event = row.event;
					insert.run(row.byteStart, Date.parse(event.ts), event.kind, groupOf(event), paneOf(event), JSON.stringify(event));
				}
				setMeta("offset", String(nextOffset));
				setMeta("rows", String(metaNum("rows") + batch.length));
				setMeta("ignored", String(metaNum("ignored") + ignoredDelta));
				setMeta("identity", identity);
				db.exec("COMMIT");
			} catch (e) {
				db.exec("ROLLBACK");
				throw e;
			}
		},

		query(filter) {
			const parts: string[] = [];
			const params: Array<string | number | null> = [];
			if (filter.sinceMs !== null) {
				parts.push("ts_ms >= ?");
				params.push(filter.sinceMs);
			}
			if (filter.group !== null) {
				parts.push("group_key = ?");
				params.push(filter.group);
			}
			if (filter.paneId !== null) {
				parts.push("pane_id = ?");
				params.push(filter.paneId);
			}
			const kinds = filter.kinds;
			if (kinds !== null && kinds.length > 0) {
				parts.push(`kind IN (${kinds.map(() => "?").join(", ")})`);
				for (const kind of kinds) params.push(kind);
			}
			const where = parts.length === 0 ? "" : ` WHERE ${parts.join(" AND ")}`;
			const statement = db.prepare(`SELECT body FROM events${where} ORDER BY seq`);
			const out: SchemaEvent[] = [];
			for (const row of statement.all(...params)) {
				const body = row["body"];
				if (typeof body !== "string") continue;
				const event = parseEvent(body);
				if (event) out.push(event);
			}
			return out;
		},

		clear() {
			drop.run();
			clearMeta.run();
		},

		close() {
			try {
				db.close();
			} catch {
				/* already closed */
			}
		},
	};
}

/** The fallback: the same rows, filtered in memory. `node:sqlite` missing, a
 *  database that will not open, and `--scan` all land here. */
function createScanIndex(): Index {
	let rows: SchemaEvent[] = [];
	let offset = 0;
	let ignored = 0;

	return {
		kind: "scan",
		path: null,
		offset: () => offset,
		rows: () => rows.length,
		ignored: () => ignored,
		identity: () => null,

		append(batch, nextOffset, ignoredDelta) {
			for (const row of batch) rows.push(row.event);
			offset = nextOffset;
			ignored += ignoredDelta;
		},

		query(filter) {
			const kinds = filter.kinds;
			return rows.filter((event) => {
				if (filter.sinceMs !== null && Date.parse(event.ts) < filter.sinceMs) return false;
				if (filter.group !== null && groupOf(event) !== filter.group) return false;
				if (filter.paneId !== null && paneOf(event) !== filter.paneId) return false;
				if (kinds !== null && kinds.length > 0 && !kinds.includes(event.kind)) return false;
				return true;
			});
		},

		clear() {
			rows = [];
			offset = 0;
			ignored = 0;
		},

		close() {
			/* nothing held */
		},
	};
}

// ---------------------------------------------------------------- the store

/** `<dir>/events.jsonl` → `<dir>/events.metrics.sqlite`. The index sits next to
 *  the log it derives from, so moving one means moving the other or rebuilding. */
export function metricsIndexPath(logPath: string): string {
	const base = logPath.endsWith(".jsonl") ? logPath.slice(0, -".jsonl".length) : logPath;
	return `${base}.metrics.sqlite`;
}

function resolveFilter(query: StoreQuery): ResolvedFilter {
	const now = query.now ?? Date.now();
	const span = windowMs(query.window ?? "all");
	return {
		sinceMs: span === null ? null : now - span,
		group: query.group ?? null,
		paneId: query.paneId ?? null,
		kinds: query.kinds ?? null,
	};
}

export function openStore(logPath: string, options: StoreOptions = {}): Store {
	const sqlite = options.forceScan === true ? undefined : loadSqlite();
	// No log means nothing to index: an in-memory index keeps a dry report from
	// creating a database file beside a file that does not exist.
	const memory = options.memory === true || !existsSync(logPath);
	const indexPath = memory ? null : (options.indexPath ?? metricsIndexPath(logPath));
	const index =
		(sqlite && indexPath ? createSqliteIndex(indexPath, sqlite) : undefined) ??
		(sqlite ? createSqliteIndex(":memory:", sqlite) : undefined) ??
		createScanIndex();

	function run(forceRebuild: boolean): IngestResult {
		const identity = logIdentity(logPath);
		const size = logSize(logPath);
		let rebuilt = forceRebuild;
		if (forceRebuild) index.clear();

		const stored = index.identity();
		// A log replaced under the index, deleted, or truncated is re-read from
		// zero. The alternative — trusting the offset — is an index that quietly
		// disagrees with the log it claims to describe.
		const replaced = stored !== null && stored !== identity;
		const vanished = stored === null && identity === null && index.offset() > 0;
		if (replaced || vanished || index.offset() > size) {
			index.clear();
			rebuilt = true;
		}

		const read = readLog(logPath, index.offset());
		if (read.rows.length > 0 || read.ignored > 0 || read.offset !== index.offset()) {
			index.append(read.rows, read.offset, read.ignored, identity ?? "absent");
		}
		return {
			bytes: read.bytes,
			added: read.rows.length,
			ignored: read.ignored,
			ignoredTotal: index.ignored(),
			rows: index.rows(),
			offset: index.offset(),
			rebuilt,
		};
	}

	return {
		logPath,
		indexPath: index.path,
		indexKind: index.kind,
		ingest: () => run(false),
		rebuild: () => run(true),
		query: (filter = {}) => index.query(resolveFilter(filter)),
		close: () => index.close(),
	};
}
