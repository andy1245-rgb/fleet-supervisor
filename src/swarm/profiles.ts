// The profile package, consumed across a process boundary.
//
// `profiles/` owns the tool catalogues, the state renderers and both ceilings; the
// runtime consumes them and never re-derives them. Three things cross, and each
// crosses for one reason:
//
//   * `snapshot()` — the catalogue and `CAPS` per role and licence. The catalogue is
//     what makes "a leaf has no `spawn`" a fact the gate can check: the answering
//     process's own tool list, not a table in this directory.
//   * `render()` — the state block. It stays the profile package's job, because the
//     corpus was built against its exact bytes; a TypeScript renderer would be a
//     second grammar.
//   * `maySpawn()` — `profiles/common.py:may_spawn` itself. The two ceilings are
//     defined once, in Python, and asked over the bridge; `grant.ts` supplies the
//     `child_budget` arithmetic that feeds it.
//
// The Python process is one-shot per call (~30 ms, no engine, nothing to keep warm).
// A render is measured against a decode of 1.5 s or more, and `maySpawn` fires at most
// a handful of times per chain, so the boundary costs nothing that matters. It also
// keeps the adapter injectable: every decision function in this directory takes a
// `ProfileTable` or a `Ceilings`, so the tests never spawn Python to test the gate.

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ROLES, type Licence, type Role } from "./types.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const BRIDGE = join(HERE, "profiles_bridge.py");
const REPO_ROOT = resolve(HERE, "..", "..");
const DEFAULT_PYTHON = join(REPO_ROOT, ".venv", "bin", "python");

export interface ToolArgSpec {
	name: string;
	/** Closed vocabulary, empty for a span argument. An enum member is legal by
	 *  construction; a span must be copied, which is what `verify.ts` checks. */
	enum: readonly string[];
}

export interface ToolSpec {
	name: string;
	args: readonly ToolArgSpec[];
}

export interface RoleCaps {
	maxNewTokens: number;
	depth: string;
	chainCeiling: number;
	binCeiling: number;
	window: number;
	totalChars: number;
}

export interface LicenceSurface {
	system: string;
	tools: readonly ToolSpec[];
}

export interface RoleSurface {
	caps: RoleCaps;
	licences: Partial<Record<Licence, LicenceSurface>>;
}

export interface ProfileTable {
	roles: Record<Role, RoleSurface>;
}

/** The answering process's catalogue. A missing licence falls back to `leaf`, which is
 *  the conservative direction: fewer tools, never more. */
export function catalogueOf(table: ProfileTable, role: Role, licence: Licence): readonly ToolSpec[] {
	const surface = table.roles[role];
	return (surface.licences[licence] ?? surface.licences.leaf)?.tools ?? [];
}

export function systemOf(table: ProfileTable, role: Role, licence: Licence): string {
	const surface = table.roles[role];
	return (surface.licences[licence] ?? surface.licences.leaf)?.system ?? "";
}

export function capsOf(table: ProfileTable, role: Role): RoleCaps {
	return table.roles[role].caps;
}

export interface Delegation {
	allowed: boolean;
	reason: string;
}

/** The ceiling predicate. `may_spawn(depth, parent_budget, child_budget, caps)`: `depth`
 *  is the *parent's* depth, so the child's is `depth + 1`. */
export interface Ceilings {
	maySpawn(role: Role, depth: number, parentBudget: number, childBudget: number): Promise<Delegation>;
}

export interface Profiles {
	table(): Promise<ProfileTable>;
	ceilings: Ceilings;
	render(role: Role, licence: Licence, state: Record<string, unknown>): Promise<string>;
}

export interface ProfilesOptions {
	/** Defaults to `.venv/bin/python`, then `python3`. `profiles/` has no third-party
	 *  import, so either works; the venv is preferred only because it is what the rest
	 *  of the repo uses. */
	pythonPath?: string;
	timeoutMs?: number;
}

export function pythonPath(explicit?: string): string {
	if (explicit) return explicit;
	if (process.env.SWARM_PYTHON) return process.env.SWARM_PYTHON;
	return existsSync(DEFAULT_PYTHON) ? DEFAULT_PYTHON : "python3";
}

async function askBridge(request: unknown, python: string, timeoutMs: number): Promise<unknown> {
	const stdout = await new Promise<string>((resolveCall, rejectCall) => {
		const child = execFile(
			python,
			["-u", BRIDGE],
			{ timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 },
			(error, out) => {
				if (error && out.trim() === "") {
					rejectCall(new Error(`profiles bridge failed: ${error.message}`));
					return;
				}
				resolveCall(out);
			},
		);
		child.stdin?.end(JSON.stringify(request));
	});
	const line = stdout.trim().split("\n").filter((l) => l.trim() !== "").pop() ?? "";
	let parsed: unknown;
	try {
		parsed = JSON.parse(line);
	} catch {
		throw new Error(`profiles bridge returned no JSON: ${line.slice(0, 200)}`);
	}
	if (typeof parsed === "object" && parsed !== null && "error" in parsed) {
		throw new Error(`profiles bridge: ${String((parsed as { error: unknown }).error)}`);
	}
	return parsed;
}

export function pythonProfiles(options: ProfilesOptions = {}): Profiles {
	const python = pythonPath(options.pythonPath);
	const timeoutMs = options.timeoutMs ?? 20_000;
	let cached: Promise<ProfileTable> | undefined;

	const table = (): Promise<ProfileTable> => {
		cached ??= askBridge({ op: "snapshot" }, python, timeoutMs)
			.then(asTable)
			// A transient failure (a python that was being installed, an OOM) must not poison
			// every later call: the next caller retries the bridge.
			.catch((error: unknown) => {
				cached = undefined;
				throw error;
			});
		return cached;
	};

	return {
		table,
		ceilings: {
			async maySpawn(role, depth, parentBudget, childBudget) {
				const reply = await askBridge({ op: "may_spawn", role, depth, parentBudget, childBudget }, python, timeoutMs);
				const row = reply as { allowed?: unknown; reason?: unknown };
				if (typeof row.allowed !== "boolean" || typeof row.reason !== "string") {
					throw new Error(`profiles bridge returned a malformed delegation: ${JSON.stringify(reply)}`);
				}
				return { allowed: row.allowed, reason: row.reason };
			},
		},
		async render(role, licence, state) {
			const reply = await askBridge({ op: "render", role, licence, state }, python, timeoutMs);
			const text = (reply as { text?: unknown }).text;
			if (typeof text !== "string") {
				throw new Error(`profiles bridge returned no rendered state for ${role}`);
			}
			return text;
		},
	};
}

/** The snapshot is another process's output, so it is read as `unknown` and checked.
 *  A missing role is a broken install, and saying so here beats a crash inside the gate. */
export function asTable(raw: unknown): ProfileTable {
	if (typeof raw !== "object" || raw === null || !("roles" in raw)) {
		throw new Error("profiles snapshot carried no roles");
	}
	const roles = (raw as { roles: unknown }).roles;
	if (typeof roles !== "object" || roles === null) throw new Error("profiles snapshot's roles is not an object");
	const built = {} as Record<Role, RoleSurface>;
	for (const role of ROLES) {
		const surface = (roles as Record<string, unknown>)[role];
		if (typeof surface !== "object" || surface === null) throw new Error(`profiles snapshot has no role ${role}`);
		const caps = (surface as { caps?: unknown }).caps;
		const licences = (surface as { licences?: unknown }).licences;
		if (typeof caps !== "object" || caps === null) throw new Error(`profiles snapshot has no caps for ${role}`);
		if (typeof licences !== "object" || licences === null) throw new Error(`profiles snapshot has no catalogue for ${role}`);
		const c = caps as Record<string, unknown>;
		if (typeof c.chainCeiling !== "number" || typeof c.binCeiling !== "number") {
			throw new Error(`profiles snapshot's caps for ${role} carry no ceilings`);
		}
		built[role] = {
			caps: {
				maxNewTokens: Number(c.maxNewTokens ?? 0),
				depth: String(c.depth ?? ""),
				chainCeiling: c.chainCeiling,
				binCeiling: c.binCeiling,
				window: Number(c.window ?? 0),
				totalChars: Number(c.totalChars ?? 0),
			},
			licences: licences as Partial<Record<Licence, LicenceSurface>>,
		};
	}
	return { roles: built };
}
