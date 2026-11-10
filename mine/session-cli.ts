// Adapter over the session-insights CLI: the only place this repo runs it, and the
// only place a payload's shape is asserted.
//
// The corpus is 1,981 sessions across two roots, and the CLI is the supported way
// to read it — the raw `.jsonl` files are an implementation detail the indexer owns,
// so a miner that reads them directly is measuring a different corpus than every
// `pi-sessions` answer does. `mine/decision-points.ts` reads the files, which is why
// it has only ever seen the one root it was pointed at (117 sessions, ~6% of the
// corpus) and missed `subforge/sessions` entirely.
//
// Two rules from the skill are enforced here rather than remembered at each call
// site: `--json` is always passed, and a `schema` string is compared for exact
// equality. A renamed key then fails loudly at the boundary instead of becoming an
// `undefined` that reads as a zero further in.

import { spawnSync } from "node:child_process";

const CLI = "/home/andrew/.pi/profiles/registry/session-insights/scripts/pi-sessions";

/** Verb → the one schema string that verb may return. Every read verb in this
 *  adapter is listed: an unlisted verb is a programming error, not a new shape. */
const SCHEMAS = {
	sessions: "pi-sessions/sessions@1",
	show: "pi-sessions/show@1",
	index: "pi-sessions/index@1",
} as const;

const ERROR_SCHEMA = "pi-sessions/error@1";

export type Verb = keyof typeof SCHEMAS;

/** `main` is the operator's own sessions; `sub` is every subagent run, whose
 *  "user" turns are dispatcher prompts rather than a human speaking. A supervisor
 *  learns from the first population, and mixing the second in teaches it that a
 *  machine ordering it around is a human doing so. */
export type Root = "main" | "sub" | "all";

export class CliError extends Error {
	readonly verb: string;
	readonly exit: number;
	readonly code: string;

	constructor(verb: string, exit: number, code: string, message: string) {
		super(`${verb}: ${code} — ${message}`);
		this.name = "CliError";
		this.verb = verb;
		this.exit = exit;
		this.code = code;
	}
}

export interface CliAnswer {
	payload: Record<string, unknown>;
	exit: number;
}

type Json = Record<string, unknown>;

function isObject(value: unknown): value is Json {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asObject(value: unknown): Json | undefined {
	return isObject(value) ? value : undefined;
}

export function asString(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

export function asNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function asArray(value: unknown): unknown[] {
	return Array.isArray(value) ? value : [];
}

function run(verb: Verb, args: readonly string[]): CliAnswer {
	// `--json` last so a caller cannot shadow it; no shell, so an argument with a
	// space or a quote is one argument.
	const result = spawnSync(CLI, [verb, ...args, "--json"], {
		encoding: "utf8",
		// A `show --full --limit 1000` payload carries 6,461-char texts per message.
		maxBuffer: 256 * 1024 * 1024,
	});
	if (result.error) throw new CliError(verb, 127, "spawn_failed", String(result.error));
	const stdout = result.stdout ?? "";
	const exit = result.status ?? -1;
	let parsed: unknown;
	try {
		parsed = JSON.parse(stdout);
	} catch {
		throw new CliError(verb, exit, "not_json", `stdout was not one JSON value: ${stdout.slice(0, 200)}`);
	}
	if (!isObject(parsed)) throw new CliError(verb, exit, "not_object", `payload was ${typeof parsed}`);
	const schema = parsed["schema"];
	if (schema === ERROR_SCHEMA) {
		const error = asObject(parsed["error"]) ?? {};
		throw new CliError(verb, exit, asString(error["code"]) ?? "unknown", asString(error["message"]) ?? "");
	}
	const expected = SCHEMAS[verb];
	if (schema !== expected) {
		throw new CliError(verb, exit, "schema_mismatch", `expected ${expected}, got ${String(schema)}`);
	}
	return { payload: parsed, exit };
}

/** Exit 3 is the index being stale, missing or locked — not a bad request. The
 *  skill's prescription is one reindex and one retry, and a second 3 is a real
 *  failure: every later call would pay the reindex again. */
export function answer(verb: Verb, args: readonly string[]): CliAnswer {
	const first = ((): CliAnswer | CliError => {
		try {
			return run(verb, args);
		} catch (error) {
			if (error instanceof CliError && error.exit === 3) return error;
			throw error;
		}
	})();
	if (!(first instanceof CliError) || first.exit !== 3) return first as CliAnswer;
	process.stderr.write(`session-cli: ${verb} exited 3 (${first.code}); running index once\n`);
	run("index", []);
	return run(verb, args);
}

export interface SessionRow {
	sessionId: string;
	path: string;
	root: string;
	cwd: string;
	startedTs: string;
	endedTs: string;
	nMsgs: number;
	nCalls: number;
	terminalStopReason: string | null;
	name: string | null;
	models: string[];
}

function sessionRow(item: Json): SessionRow {
	return {
		sessionId: asString(item["session_id"]) ?? "",
		path: asString(item["path"]) ?? "",
		root: asString(item["root"]) ?? "",
		cwd: asString(item["cwd"]) ?? "",
		startedTs: asString(item["started_ts"]) ?? "",
		endedTs: asString(item["ended_ts"]) ?? "",
		nMsgs: asNumber(item["n_msgs"]) ?? 0,
		nCalls: asNumber(item["n_calls"]) ?? 0,
		terminalStopReason: asString(item["terminal_stop_reason"]) ?? null,
		name: asString(item["name"]) ?? null,
		models: asArray(item["models"]).filter((model): model is string => typeof model === "string"),
	};
}

/** Every session under one root. `--limit` is paged because the verb caps a page
 *  at 1,000 and the corpus is past that. `root` is passed to the CLI rather than
 *  filtered here: it is a documented filter, and a filter applied twice is a
 *  difference waiting to happen. */
export function listSessions(root: Root, since = "all"): SessionRow[] {
	const rows: SessionRow[] = [];
	const page = 1000;
	for (let offset = 0; ; offset += page) {
		const { payload } = answer("sessions", ["--since", since, "--root", root, "--limit", String(page), "--offset", String(offset)]);
		for (const item of asArray(payload["items"])) {
			const row = asObject(item);
			if (row) rows.push(sessionRow(row));
		}
		const total = asNumber(payload["n_total"]) ?? 0;
		if (rows.length >= total || asArray(payload["items"]).length === 0) break;
	}
	return rows;
}

export interface Message {
	seq: number;
	ts: string;
	role: string;
	tool: string | null;
	isError: boolean;
	durMs: number | null;
	text: string;
	textTruncated: boolean;
}

export interface Shown {
	session: SessionRow;
	messages: Message[];
	/** True when the message list is a page, not the whole session. A window that
	 *  cannot see the following message cannot be labelled, so this must be false. */
	truncated: boolean;
}

function message(row: Json): Message {
	return {
		seq: asNumber(row["seq"]) ?? 0,
		ts: asString(row["ts"]) ?? "",
		role: asString(row["role"]) ?? "",
		tool: asString(row["tool"]) ?? null,
		isError: row["is_error"] === true,
		durMs: asNumber(row["dur_ms"]) ?? null,
		text: asString(row["text_head"]) ?? "",
		textTruncated: row["text_truncated"] === true,
	};
}

/** One session's whole message timeline. `--full` lifts the 400-character cap on
 *  `text_head`, which the tail and the human's label both need: a label decided on
 *  the first 400 characters of a long instruction is a label about a prefix. */
export function showSession(sessionId: string, page = 1000): Shown {
	const messages: Message[] = [];
	let session: SessionRow | undefined;
	let offset = 0;
	let truncated = true;
	while (truncated) {
		const { payload } = answer("show", [sessionId, "--limit", String(page), "--offset", String(offset), "--full"]);
		const head = asObject(payload["session"]);
		if (head && !session) session = sessionRow(head);
		const pageMessages = asArray(payload["messages"]).map(asObject).filter((row): row is Json => row !== undefined);
		for (const row of pageMessages) messages.push(message(row));
		truncated = payload["truncated"] === true;
		offset += pageMessages.length;
		if (pageMessages.length === 0) break;
	}
	if (!session) throw new CliError("show", 0, "no_session", `show ${sessionId} returned no session object`);
	return { session, messages, truncated: false };
}
