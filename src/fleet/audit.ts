// Who did it, in the one file the fleet already reads.
//
// `events.jsonl` is the supervisor's record, so a row this writes has to be a row the
// supervisor's parser cannot mistake for a measurement. It carries no `schema` field,
// which is exactly the shape `parseEvent` rejects: the row is counted as untyped, named
// as `operator`, and never enters an aggregate. Writing it as a `schema: 2` `action` row
// would put a human's click into the model's action denominator, which is the one thing
// an operator row must never do.
//
// `operator` is the field a tick cannot write: the supervisor has no notion of a person,
// so its presence is proof the row came from a session, not from the loop.
//
// Two rules about the file itself:
//
//   * the directory and the file are never created here. If `events.jsonl` does not exist
//     the supervisor has not run, and inventing the file would flip a whole surface from
//     fixture replay to an empty live fleet — a page lying about its own source is worse
//     than a missing audit line. The row goes to stderr instead.
//   * a failed append never fails the action. The write already happened; the audit line
//     reports itself as `{ok: false}` so the gap is visible.
//
// The bug this file closes: the HTTP routes appended an operator row and
// `fleet-manager answer` appended nothing, so the same act produced different state on
// the two surfaces. There is one row shape and one append, and both adapters call it.

import { appendFileSync, statSync } from "node:fs";

import { statePaths, stateDir as defaultStateDir } from "./where.ts";
import type { Ctx } from "./types.ts";

export const OPERATOR_KIND = "operator";

export interface AuditTarget {
	askId?: string;
	paneId?: string;
	op?: string;
	dir?: string;
}

export interface AuditFields {
	/** The act, in the verb vocabulary: `answer`, `send`, `start`, `fast`, `mode`, … */
	act: string;
	operator: string;
	source: "cli" | "gui" | "core";
	target: AuditTarget | string | null;
	before?: unknown;
	after?: unknown;
	result?: string;
	verdict?: string;
	detail?: string;
	now?: number;
}

export interface AuditRow {
	kind: string;
	ts: string;
	operator: string;
	actor: "human";
	source: string;
	verb: string;
	result: string;
	detail: string;
	askId?: string;
	paneId?: string;
	op?: string;
	verdict?: string;
	before?: unknown;
	after?: unknown;
}

function targetOf(target: AuditTarget | string | null): AuditTarget {
	if (target === null) return {};
	if (typeof target === "string") return { paneId: target };
	return target;
}

/** The row, without writing it. Split out so a test can assert the exact shape and so a
 *  `--dry-run` caller can show the row it would have written. */
export function auditRow(fields: AuditFields): AuditRow {
	const target = targetOf(fields.target);
	const row: AuditRow = {
		kind: OPERATOR_KIND,
		ts: new Date(fields.now ?? Date.now()).toISOString(),
		operator: fields.operator,
		actor: "human",
		source: fields.source,
		verb: fields.act,
		result: fields.result ?? "ok",
		detail: fields.detail ?? "",
	};
	if (target.askId !== undefined) row.askId = target.askId;
	if (target.paneId !== undefined) row.paneId = target.paneId;
	if (target.op !== undefined) row.op = target.op;
	if (fields.verdict !== undefined) row.verdict = fields.verdict;
	if (fields.before !== undefined) row.before = fields.before;
	if (fields.after !== undefined) row.after = fields.after;
	return row;
}

export interface AuditAppend {
	ok: boolean;
	path: string;
	reason?: string;
	row: AuditRow;
	line: string;
}

/** The audit path for a context: the same state dir every other file was read from. */
export function auditPath(ctx: { dataDir?: string | null; source?: { stateDir?: string } }): string {
	const dir = ctx.dataDir ?? ctx.source?.stateDir ?? defaultStateDir();
	return statePaths(dir).events;
}

/** Append, or say why not. `stream` exists so a caller that cannot write the file still
 *  records the row somewhere a person will see it. */
export function appendAudit(
	ctx: { dataDir?: string | null; source?: { stateDir?: string } } | Ctx,
	row: AuditRow,
	stream: { write(text: string): unknown } = process.stderr,
): AuditAppend {
	const path = auditPath(ctx as { dataDir?: string | null; source?: { stateDir?: string } });
	const line = `${JSON.stringify(row)}\n`;
	try {
		statSync(path);
	} catch {
		stream.write(line);
		return { ok: false, path, reason: `no ${path}; the supervisor has not written the log, so the row went to stderr instead of inventing the file`, row, line };
	}
	try {
		appendFileSync(path, line);
	} catch (error) {
		const code = typeof error === "object" && error !== null && "code" in error ? String((error as { code: unknown }).code) : "error";
		stream.write(line);
		return { ok: false, path, reason: `appending to ${path} failed (${code}); the row went to stderr instead`, row, line };
	}
	return { ok: true, path, row, line };
}
