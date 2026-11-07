// Starting a conversation when there is nothing loaded, and the path guard in front of it.
//
// This takes a directory and a first message and hands both to `fleet-manager start` —
// the verb that already creates a labelled workspace, a `pi` agent in its root pane, and
// that message as the agent's subject. There is no second spawner here and this module
// deliberately has no herdr call of its own.
//
// **The path guard, and why it is core.** A web form that takes a filesystem path and
// hands it to a process is how a page becomes a remote shell. The rules are the narrowest
// that still do the job: the path is expanded, made absolute, and then it must land
// *inside the operator's home directory* — `relative(home, dir)` may not start with `..`
// and may not be absolute. No NUL, no newline, no `~user`, no length past a bound, and
// the directory must already exist. The rules live here because the CLI can reach
// `start /tmp` where the page cannot, and a divergence there is the lie the plan ranks
// first: the button refuses and the terminal does not. `allowOutsideHome` is the flag that
// restores local scratch behaviour, declared on the verb and never settable through a
// route.
//
// **No shell, ever.** `spawn` gets an argv array; the directory is one argv slot and the
// message is another. `fleet-manager start` is itself shell-free, so the two halves
// compose without a quoting layer to get wrong.

import { spawn } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { basename, isAbsolute, relative, resolve } from "node:path";

import { profilesFile, notesDir as defaultNotesDir, agentFleetRoot } from "./where.ts";
import { SEND_MAX, textProblem } from "./send.ts";
import type { Ctx, Source } from "./types.ts";

export const START_TIMEOUT_MS = 180_000;
export const DIR_MAX = 4096;

export interface StartPlan {
	kind: "start";
	dir: string;
	text: string;
	argv: string[];
	command: string;
	operator: string;
	timeoutMs: number;
	allowOutsideHome: boolean;
}

export type StartResult =
	| { ok: true; plan: StartPlan }
	| { ok: false; code: string; message: string; command?: string; next?: string };

function homeOf(home?: string): string {
	return resolve(typeof home === "string" && home !== "" ? home : (process.env.HOME ?? "/"));
}

export function startVerb(dir: string, text: string): string {
	return `fleet-manager start ${dir || "<directory>"} ${`'${String(text).replace(/'/g, `'\\''`)}'`}`;
}

export interface ResolvedDir {
	ok: boolean;
	dir?: string;
	code?: string;
	message?: string;
}

/**
 * Is this a directory a conversation may be started in? Returns `{ok: true, dir}` with the
 * resolved path, or `{ok: false, code, message}` with one sentence a person can act on.
 */
export function resolveStartDir(raw: unknown, options: { home?: string; allowOutsideHome?: boolean } = {}): ResolvedDir {
	const home = homeOf(options.home);
	if (typeof raw !== "string" || raw.trim() === "") {
		return { ok: false, code: "dir_required", message: "A directory is required: type a path under your home directory, or pick one of the projects listed." };
	}
	if (raw.length > DIR_MAX) return { ok: false, code: "dir_too_long", message: `That path is ${raw.length} characters; the limit is ${DIR_MAX}.` };
	if (raw.includes("\u0000") || raw.includes("\n") || raw.includes("\r")) {
		return { ok: false, code: "dir_bad_chars", message: "A directory path cannot contain a NUL byte or a newline." };
	}

	// `~` and `~/x` only. `~someone` is another user's home and is refused rather than
	// expanded, because "start an agent in Alice's directory" is not a thing this should
	// be able to say.
	let expanded = raw.trim();
	if (expanded === "~") expanded = home;
	else if (expanded.startsWith("~/")) expanded = resolve(home, expanded.slice(2));
	else if (expanded.startsWith("~")) {
		return {
			ok: false,
			code: "dir_home_only",
			message: `~${expanded.slice(1).split("/")[0] ?? ""} names another user's home directory. This only starts conversations under ${home}.`,
		};
	}

	if (!isAbsolute(expanded)) {
		return { ok: false, code: "dir_not_absolute", message: `“${raw}” is a relative path. Give the absolute directory, or a path starting with ~/.` };
	}

	const dir = resolve(expanded);
	if (options.allowOutsideHome !== true) {
		const rel = relative(home, dir);
		const inside = rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
		if (!inside) {
			return {
				ok: false,
				code: "dir_outside_home",
				message: `${dir} is outside ${home}. This only starts conversations under your home directory: a path from a form is not going to be a way to start an agent anywhere on the box. --allow-outside-home is the verb's own flag and is not reachable from a route.`,
			};
		}
	}

	if (!existsSync(dir)) {
		return { ok: false, code: "dir_missing", message: `There is no directory at ${dir}. This starts a conversation in a directory that already exists; it does not create one.` };
	}
	try {
		if (!statSync(dir).isDirectory()) return { ok: false, code: "dir_not_directory", message: `${dir} is a file, not a directory.` };
	} catch (error) {
		return { ok: false, code: "dir_unreadable", message: `${dir} could not be read (${error instanceof Error ? error.message : "unknown error"}).` };
	}
	return { ok: true, dir };
}

/** The directories worth offering, most-used first. "Recent projects" is answered from
 *  the fleet itself: the distinct `cwd`s of the panes herdr is running, counted. `$HOME`
 *  itself is dropped — thirty-six panes sit in it, and "start a conversation in your home
 *  directory" is the absence of a choice rather than one. */
export function startDirectoryOptions(
	source: Pick<Source, "panes"> | null | undefined,
	options: { home?: string; notesDir?: string | null; limit?: number } = {},
): { home: string; origin: string | null; reason: string | null; options: { dir: string; label: string; panes: number; source: string }[] } {
	const home = homeOf(options.home);
	const limit = options.limit ?? 8;
	const seen = new Map<string, { dir: string; label: string; panes: number; source: string }>();
	const panes = source?.panes?.origin === "herdr" ? source.panes.panes : [];
	for (const pane of panes) {
		const cwd = typeof pane.cwd === "string" && pane.cwd !== "" ? resolve(pane.cwd) : null;
		if (cwd === null || cwd === home) continue;
		const rel = relative(home, cwd);
		if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) continue;
		const entry = seen.get(cwd) ?? { dir: cwd, label: basename(cwd) || cwd, panes: 0, source: "a pane is running here (herdr api snapshot)" };
		entry.panes += 1;
		seen.set(cwd, entry);
	}
	const options_ = [...seen.values()].sort((a, b) => b.panes - a.panes || a.label.localeCompare(b.label)).slice(0, limit);
	const notes = options.notesDir;
	if (typeof notes === "string" && notes !== "" && existsSync(notes) && !seen.has(resolve(notes))) {
		options_.push({ dir: resolve(notes), label: basename(notes) || "notes", panes: 0, source: "the notes board" });
	}
	return {
		home,
		origin: source?.panes?.origin ?? null,
		reason: panes.length === 0 ? `no live pane list to read projects from (${source?.panes?.reason ?? source?.panes?.origin ?? "no source"})` : null,
		options: options_,
	};
}

/** The gate for the start route, kept pure for the same reason `sendRequest` is: every
 *  refusal is testable without a process existing. */
export function planStart(args: { dir: unknown; text: unknown; ctx: Ctx; allowOutsideHome?: boolean }): StartResult {
	const { ctx } = args;
	const command = startVerb(typeof args.dir === "string" ? args.dir : "<directory>", typeof args.text === "string" ? args.text : "<message>");
	const refuse = (code: string, message: string, next?: string): StartResult => ({ ok: false, code, message, command, next });

	if (ctx.opts.enableChat !== true) {
		return refuse(
			"chat_disabled",
			"Starting a conversation is off on this server: it creates a pane and types into it, so it sits behind the same flag as sending. Nothing was started, and the next step is the command below, in a terminal.",
			"run the command in a terminal, or restart with --enable-chat",
		);
	}

	const dir = resolveStartDir(args.dir, { home: ctx.opts.home, allowOutsideHome: args.allowOutsideHome === true });
	if (!dir.ok || dir.dir === undefined) return { ok: false, code: dir.code ?? "dir_invalid", message: dir.message ?? "that directory cannot be used", command };

	const problem = textProblem(args.text);
	if (problem !== null) {
		return { ok: false, code: "bad_text", message: problem, command, next: `the limit is ${SEND_MAX} characters` };
	}

	const root = ctx.opts.agentFleetRoot || agentFleetRoot();
	return {
		ok: true,
		plan: {
			kind: "start",
			dir: dir.dir,
			text: args.text as string,
			argv: [root, dir.dir, args.text as string],
			command,
			operator: "local",
			timeoutMs: START_TIMEOUT_MS,
			allowOutsideHome: args.allowOutsideHome === true,
		},
	};
}

export interface StartRun {
	ok: boolean;
	code: string;
	message: string | null;
	paneId: string | null;
	durationMs: number;
	stdout?: string | null;
}

/** Runs `fleet-manager start <dir> <text> --json`. No shell: one argv slot each. */
export async function runStart(plan: StartPlan): Promise<StartRun> {
	const started = Date.now();
	const root = plan.argv[0] ?? agentFleetRoot();
	const script = `${root}/src/cli.ts`;
	return new Promise((resolveRun) => {
		let child: ReturnType<typeof spawn>;
		try {
			child = spawn(process.execPath, ["--experimental-strip-types", script, "start", plan.dir, plan.text, "--json"], {
				stdio: ["ignore", "pipe", "pipe"],
				cwd: root,
			});
		} catch (error) {
			resolveRun({ ok: false, code: "spawn_failed", message: error instanceof Error ? error.message : "could not start fleet-manager", paneId: null, durationMs: Date.now() - started });
			return;
		}
		let stdout = "";
		let stderr = "";
		const timer = setTimeout(() => {
			child.kill("SIGKILL");
			resolveRun({ ok: false, code: "timeout", message: `fleet-manager start did not return within ${plan.timeoutMs}ms`, paneId: null, durationMs: Date.now() - started });
		}, plan.timeoutMs);
		child.stdout?.on("data", (chunk: Buffer) => {
			stdout += chunk.toString();
		});
		child.stderr?.on("data", (chunk: Buffer) => {
			stderr += chunk.toString();
		});
		child.on("error", (error) => {
			clearTimeout(timer);
			resolveRun({ ok: false, code: "spawn_failed", message: error.message, paneId: null, durationMs: Date.now() - started });
		});
		child.on("close", (code) => {
			clearTimeout(timer);
			let parsed: unknown = null;
			try {
				parsed = JSON.parse(stdout.trim()) as unknown;
			} catch {
				parsed = null;
			}
			const row = typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {};
			const paneId = typeof row.paneId === "string" ? row.paneId : null;
			if (code === 0) {
				resolveRun({ ok: true, code: "started", message: null, paneId, durationMs: Date.now() - started, stdout });
				return;
			}
			resolveRun({
				ok: false,
				code: typeof row.code === "string" ? row.code : code === 1 ? "refused" : "failed",
				message: typeof row.reason === "string" ? row.reason : stderr.trim() || stdout.trim() || `fleet-manager start exited ${code}`,
				paneId,
				durationMs: Date.now() - started,
				stdout,
			});
		});
	});
}

/** The plan as a document, for `--dry-run` and for the route's response. */
export function describeStart(plan: StartPlan): Record<string, unknown> {
	return { dir: plan.dir, command: plan.command, argv: plan.argv, timeoutMs: plan.timeoutMs, operator: plan.operator, allowOutsideHome: plan.allowOutsideHome };
}

/** Where the notes board lives, offered as a start directory. Re-exported so a caller
 *  does not reach for `where.ts` for one string. */
export function notesDirFor(): string {
	return defaultNotesDir();
}

export function profilesPathFor(home?: string): string {
	return profilesFile(home === undefined ? process.env : { ...process.env, HOME: home });
}
