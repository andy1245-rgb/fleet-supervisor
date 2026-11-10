// The corpus, fetched once through the CLI and cached on disk.
//
// Reading 1,981 sessions out of the index costs ~1.4 s each, so a miner that calls
// the CLI directly pays ~45 minutes on every run — including the runs that only
// change label logic. The cache turns that into one fetch and a fast re-read, and
// it is written under `mine/out/`, which is gitignored, so nothing here becomes a
// corpus this repo ships.
//
// It never writes to the pi corpus itself: every write is under the cache root.

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { listSessions, showSession, type Message, type Root, type SessionRow } from "./session-cli.ts";

const HERE = import.meta.dirname;
export const CACHE_ROOT = join(HERE, "out", "cli-cache");
const SHOW_DIR = join(CACHE_ROOT, "show");

const listPath = (root: Root): string => join(CACHE_ROOT, `sessions-${root}.json`);

/** `main` by default. The two roots are different populations — see `Root`. */
export const DEFAULT_ROOT: Root = "main";

export interface Session {
	session: SessionRow;
	messages: Message[];
}

function readJson<T>(path: string): T {
	return JSON.parse(readFileSync(path, "utf8")) as T;
}

function writeJson(path: string, value: unknown): void {
	mkdirSync(join(path, ".."), { recursive: true });
	writeFileSync(path, `${JSON.stringify(value)}\n`);
}

/** The session list, from cache unless `refresh`. */
export function sessionList(root: Root = DEFAULT_ROOT, refresh = false): SessionRow[] {
	const path = listPath(root);
	if (!refresh && existsSync(path)) return readJson<SessionRow[]>(path);
	const rows = listSessions(root, "all");
	writeJson(path, rows);
	return rows;
}

/** Every session's timeline. `limit` caps the fetch for a probe run and is
 *  reported by the caller, never silently applied. */
export function loadCorpus(options: { root?: Root; refresh?: boolean; limit?: number } = {}): Session[] {
	const refresh = options.refresh === true;
	const root = options.root ?? DEFAULT_ROOT;
	mkdirSync(SHOW_DIR, { recursive: true });
	const rows = sessionList(root, refresh);
	const wanted = options.limit !== undefined && options.limit > 0 ? rows.slice(0, options.limit) : rows;
	const sessions: Session[] = [];
	let fetched = 0;
	let cached = 0;
	wanted.forEach((row, index) => {
		const path = join(SHOW_DIR, `${row.sessionId}.json`);
		if (!refresh && existsSync(path)) {
			sessions.push(readJson<Session>(path));
			cached += 1;
			return;
		}
		const shown = showSession(row.sessionId);
		const session: Session = { session: shown.session, messages: shown.messages };
		writeJson(path, session);
		sessions.push(session);
		fetched += 1;
		if ((fetched + cached) % 100 === 0) {
			process.stderr.write(`session-cache: ${fetched + cached}/${wanted.length} (${fetched} fetched)\n`);
		}
	});
	process.stderr.write(`session-cache: ${sessions.length} sessions — ${cached} cached, ${fetched} fetched\n`);
	return sessions;
}

/** Sessions in the cache that the current list no longer names, for the caller to
 *  report rather than delete: a cached timeline is evidence, not scratch. */
export function cacheStats(root: Root = DEFAULT_ROOT): { cached: number; listed: number } {
	const path = listPath(root);
	const listed = existsSync(path) ? readJson<SessionRow[]>(path).length : 0;
	const cached = existsSync(SHOW_DIR) ? readdirSync(SHOW_DIR).filter((name) => name.endsWith(".json")).length : 0;
	return { cached, listed };
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
	const refresh = process.argv.includes("--refresh");
	const rootArg = process.argv.find((arg) => arg.startsWith("--root="));
	const root = (rootArg?.split("=")[1] ?? DEFAULT_ROOT) as Root;
	const sessions = loadCorpus({ refresh, root });
	const stats = cacheStats(root);
	process.stderr.write(`session-cache: ${stats.cached} cached, ${stats.listed} listed, ${sessions.length} loaded\n`);
}
