// File reads that never throw.
//
// A screen that dies because one file is being appended to is a screen that lies by
// omission. Every reader returns what it found and what went wrong, and the caller
// decides whether that is an empty state or an alert. The one thing none of these
// does is create, truncate or repair a file: every writer in this tree is elsewhere,
// and a reader that writes is a reader that can flip a fixture page into a live one.

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import type { EventFileStat } from "./types.ts";

function codeOf(error: unknown): string {
	if (typeof error === "object" && error !== null && "code" in error) {
		const code = (error as { code?: unknown }).code;
		return typeof code === "string" ? code : "error";
	}
	return "error";
}

export function statFile(path: string): EventFileStat {
	try {
		const stat = statSync(path);
		return { exists: true, bytes: stat.size, mtimeMs: stat.mtimeMs, mtime: new Date(stat.mtimeMs).toISOString(), error: null };
	} catch (error) {
		const code = codeOf(error);
		return { exists: false, bytes: 0, mtimeMs: null, mtime: null, error: code === "ENOENT" ? null : code };
	}
}

export function readText(path: string): { exists: boolean; text: string; error: string | null } {
	try {
		return { exists: true, text: readFileSync(path, "utf8"), error: null };
	} catch (error) {
		const code = codeOf(error);
		return { exists: false, text: "", error: code === "ENOENT" ? null : code };
	}
}

/** JSON, or undefined with a reason. A half-written state file is normal: every
 *  writer in the tree does tmp+rename, so a torn read means someone else's bug, and
 *  it is reported rather than swallowed. */
export function readJson(path: string): { exists: boolean; value: unknown; error: string | null } {
	const file = readText(path);
	if (!file.exists) return { exists: false, value: undefined, error: file.error };
	try {
		return { exists: true, value: JSON.parse(file.text) as unknown, error: null };
	} catch (error) {
		return { exists: true, value: undefined, error: `unparseable JSON: ${error instanceof Error ? error.message : "syntax error"}` };
	}
}

/** `*.json` files in one directory, non-recursive by construction. The claim dir is
 *  the only directory this project ever lists, and one file per pane is the whole of
 *  its structure, so a walk there would only ever be a mistake. */
export function listJsonFiles(dir: string): { files: { name: string; path: string }[]; error: string | null } {
	try {
		const files = readdirSync(dir)
			.filter((name) => name.endsWith(".json"))
			.sort()
			.map((name) => ({ name, path: join(dir, name) }));
		return { files, error: null };
	} catch (error) {
		const code = codeOf(error);
		return { files: [], error: code === "ENOENT" ? null : code };
	}
}
