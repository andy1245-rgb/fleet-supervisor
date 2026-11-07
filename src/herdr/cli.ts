// The only module that shells out to herdr. Everything else takes a HerdrPort.
//
// Wire contract (herdr protocol 22, `herdr api schema --json`):
//   success → { id, result: { type: "...", ... } }
//   failure → { id, error: { code, message } }
// A rejected prompt is a *failure envelope*, not a thrown error: agent_blocked
// means "this agent needs a human", which is a decision input. So this module
// returns envelopes and never folds a code into an exception.

import { spawn } from "node:child_process";
import type { AgentSession, Row } from "../fleet/types.ts";
import type { AgentStatus, HerdrAgent, HerdrPort, PromptResult } from "./types.ts";

const DEFAULT_TIMEOUT_MS = 10_000;
const STATUSES: ReadonlySet<string> = new Set(["idle", "working", "blocked", "done", "unknown"]);

export type Call =
	| { ok: true; result: unknown }
	| { ok: false; code: string; message: string };

function bin(env: NodeJS.ProcessEnv): string {
	return env.HERDR_BIN_PATH || "herdr";
}

function spawnText(args: string[], timeoutMs: number): Promise<string> {
	return new Promise((resolve, reject) => {
		const child = spawn(bin(process.env), args, { stdio: ["ignore", "pipe", "pipe"] });
		let stdout = "";
		let stderr = "";
		let settled = false;
		const timer = setTimeout(() => {
			if (settled) return;
			settled = true;
			child.kill("SIGKILL");
			reject(new Error(`herdr ${args.slice(0, 2).join(" ")}: timeout after ${timeoutMs}ms`));
		}, timeoutMs + 1_000);

		child.stdout.on("data", (d: Buffer) => {
			stdout += d.toString();
		});
		child.stderr.on("data", (d: Buffer) => {
			stderr += d.toString();
		});
		child.on("error", (e) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			reject(new Error(`herdr ${args.slice(0, 2).join(" ")}: ${e.message}`));
		});
		child.on("close", (code) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			const out = stdout.trim();
			// Errors are reported as envelopes on stdout; only fall back to exit
			// status when stdout carried nothing parseable.
			if (out) resolve(out);
			else if (code !== 0) reject(new Error(`herdr ${args.slice(0, 2).join(" ")} exited ${code}: ${stderr.trim().slice(0, 300)}`));
			else resolve("");
		});
	});
}

export async function call(args: string[], timeoutMs = DEFAULT_TIMEOUT_MS): Promise<Call> {
	const out = await spawnText(args, timeoutMs);
	if (!out) return { ok: true, result: undefined };
	let env: { result?: unknown; error?: { code?: unknown; message?: unknown } };
	try {
		env = JSON.parse(out) as typeof env;
	} catch {
		return { ok: false, code: "non_json_response", message: out.slice(0, 300) };
	}
	if (env.error) {
		return {
			ok: false,
			code: typeof env.error.code === "string" ? env.error.code : "unknown_error",
			message: typeof env.error.message === "string" ? env.error.message : JSON.stringify(env.error).slice(0, 300),
		};
	}
	return { ok: true, result: env.result };
}

function status(value: unknown): AgentStatus {
	return typeof value === "string" && STATUSES.has(value) ? (value as AgentStatus) : "unknown";
}

function str(value: unknown, fallback = ""): string {
	return typeof value === "string" ? value : fallback;
}

function num(value: unknown, fallback = 0): number {
	return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

/** `agent_session`'s own object: the pane's transcript, in herdr's words. */
function sessionOf(raw: unknown): AgentSession | null {
	if (typeof raw !== "object" || raw === null) return null;
	const r = raw as Record<string, unknown>;
	const value = str(r.value);
	if (!value) return null;
	return { agent: str(r.agent), kind: str(r.kind, "path"), source: str(r.source), value };
}

/** The one wire validator. `pane` is snapshotted "panes" row (`label`, `revision`,
 *  `terminal_id`) and `agent` is the same pane's `agents` row (`completion_seq`,
 *  `state_change_seq`, `agent_session`). Anything either of them carries is kept, so
 *  no caller has to guess whether a field exists.
 *
 * The four fields this keeps that the old `toAgent` dropped are the prerequisite for
 * the name chain and the identity join: `label` is rung 1 of `nameOf`, `revision` is
 * what makes a change observable without a second read, `terminal_id` is the pane's
 * own handle, and `agent_session` is what `sessionOf` joins on. */
export function toRow(pane: unknown, agent?: unknown): Row | undefined {
	const p = typeof pane === "object" && pane !== null ? (pane as Record<string, unknown>) : {};
	const a = typeof agent === "object" && agent !== null ? (agent as Record<string, unknown>) : {};
	const paneId = str(p.pane_id) || str(a.pane_id);
	if (!paneId) return undefined;
	const cwd = str(p.cwd) || str(a.cwd);
	const label = typeof p.label === "string" && p.label.trim() !== "" ? p.label : null;
	return {
		pane_id: paneId,
		workspace_id: str(p.workspace_id) || str(a.workspace_id),
		tab_id: str(p.tab_id) || str(a.tab_id),
		agent: str(p.agent) || str(a.agent, "unknown"),
		agent_status: status(str(p.agent_status) || str(a.agent_status)),
		cwd,
		foreground_cwd: str(p.foreground_cwd) || str(a.foreground_cwd, cwd),
		focused: p.focused === true || a.focused === true,
		label,
		revision: num(p.revision, num(a.revision)),
		terminal_id: str(p.terminal_id) || str(a.terminal_id),
		terminal_title: str(p.terminal_title) || str(a.terminal_title),
		terminal_title_stripped: str(p.terminal_title_stripped) || str(a.terminal_title_stripped),
		agent_session: sessionOf(a.agent_session ?? p.agent_session),
		completion_seq: num(a.completion_seq),
		state_change_seq: num(a.state_change_seq),
	};
}

/** The port's own shape, derived from the row so there is one validator and not two. */
export function agentOf(row: Row): HerdrAgent {
	return {
		paneId: row.pane_id,
		agent: row.agent,
		status: status(row.agent_status),
		cwd: row.cwd,
		foregroundCwd: row.foreground_cwd || row.cwd,
		workspaceId: row.workspace_id,
		tabId: row.tab_id,
		title: row.terminal_title_stripped || row.terminal_title,
		completionSeq: row.completion_seq,
		stateChangeSeq: row.state_change_seq,
		focused: row.focused,
	};
}

function agentsFrom(result: unknown): HerdrAgent[] {
	if (typeof result !== "object" || result === null) return [];
	const list = (result as { agents?: unknown }).agents;
	if (!Array.isArray(list)) return [];
	return list.map((raw) => toRow(raw)).filter((row): row is Row => row !== undefined).map(agentOf);
}

/** One `herdr api snapshot`: the whole fleet, panes and agents, in one call.
 *
 * `panes` carries what the sidebar shows (`label`, `revision`, `terminal_id`);
 * `agents` carries the counters and the session report; neither carries both, so the
 * rows every caller wants are the join of the two on `pane_id`. `revision` is the
 * highest pane revision in the snapshot: a monotone counter that bumps when anything
 * about any pane changes, which is what a change detector needs.
 *
 * A herdr without `api snapshot` falls back to `agent list` rather than failing: the
 * supervisor's own read path predates the snapshot and must keep working. The
 * fallback is recorded (`origin`, `reason`) instead of being hidden, because a row
 * with no `label` is the difference between `unnamed` and pi's chrome. */
export interface Snapshot {
	revision: number;
	panes: Row[];
	agents: Row[];
	rows: Row[];
	focusedPaneId: string | null;
	focusedWorkspaceId: string | null;
	focusedTabId: string | null;
	protocol: number | null;
	version: string | null;
	origin: "snapshot" | "agents";
	reason: string | null;
}

function rowsOf(list: unknown): Row[] {
	if (!Array.isArray(list)) return [];
	return list.map((raw) => toRow(raw)).filter((row): row is Row => row !== undefined);
}

export async function snapshot(timeoutMs = DEFAULT_TIMEOUT_MS): Promise<Snapshot> {
	const empty: Snapshot = {
		revision: 0,
		panes: [],
		agents: [],
		rows: [],
		focusedPaneId: null,
		focusedWorkspaceId: null,
		focusedTabId: null,
		protocol: null,
		version: null,
		origin: "snapshot",
		reason: null,
	};

	let envelope: Call;
	try {
		envelope = await call(["api", "snapshot"], timeoutMs);
	} catch (error) {
		envelope = { ok: false, code: "transport", message: error instanceof Error ? error.message : "spawn failed" };
	}

	if (envelope.ok) {
		const result = typeof envelope.result === "object" && envelope.result !== null ? (envelope.result as Record<string, unknown>) : {};
		const snap = typeof result.snapshot === "object" && result.snapshot !== null ? (result.snapshot as Record<string, unknown>) : result;
		const panes = rowsOf(snap.panes);
		const agents = rowsOf(snap.agents);
		const byPane = new Map(agents.map((agent) => [agent.pane_id, agent]));
		const rows = panes.length > 0
			? panes.map((pane) => {
				const agent = byPane.get(pane.pane_id);
				return agent === undefined ? pane : { ...pane, completion_seq: agent.completion_seq, state_change_seq: agent.state_change_seq, agent_session: agent.agent_session };
			})
			: agents;
		return {
			...empty,
			revision: panes.reduce((max, pane) => (pane.revision > max ? pane.revision : max), 0),
			panes,
			agents,
			rows,
			focusedPaneId: str(snap.focused_pane_id) || null,
			focusedWorkspaceId: str(snap.focused_workspace_id) || null,
			focusedTabId: str(snap.focused_tab_id) || null,
			protocol: typeof snap.protocol === "number" ? snap.protocol : null,
			version: str(snap.version) || null,
		};
	}

	const reason = `herdr api snapshot: ${envelope.code}: ${envelope.message}`;
	const listed = await call(["agent", "list"], timeoutMs);
	if (!listed.ok) return { ...empty, origin: "agents", reason: `${reason}; herdr agent list: ${listed.code}: ${listed.message}` };
	const rows = rowsOf(typeof listed.result === "object" && listed.result !== null ? (listed.result as Record<string, unknown>).agents : undefined);
	return {
		...empty,
		origin: "agents",
		reason,
		agents: rows,
		rows,
		revision: rows.reduce((max, row) => (row.revision > max ? row.revision : max), 0),
	};
}

/** The TUI pads every line to the pane width, so a naive read is mostly spaces. */
function stripPadding(raw: string): string {
	return raw
		.split("\n")
		.map((line) => line.replace(/\s+$/, ""))
		.join("\n")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
}

/** Codes that mean "the prompt was refused", as opposed to a transport failure. */
const REFUSALS: ReadonlySet<string> = new Set(["agent_blocked", "agent_prompt_stalled", "timeout"]);

export function herdrPort(): HerdrPort {
	return {
		async list(): Promise<HerdrAgent[]> {
			const res = await call(["agent", "list"]);
			if (!res.ok) throw new Error(`herdr agent list: ${res.code}: ${res.message}`);
			return agentsFrom(res.result);
		},

		async get(paneId: string): Promise<HerdrAgent | undefined> {
			const res = await call(["agent", "get", paneId]);
			if (!res.ok) return undefined;
			if (typeof res.result !== "object" || res.result === null) return undefined;
			const row = toRow((res.result as { agent?: unknown }).agent);
			return row === undefined ? undefined : agentOf(row);
		},

		async read(paneId: string, lines: number): Promise<string> {
			const out = await spawnText(
				["agent", "read", paneId, "--source", "recent-unwrapped", "--lines", String(lines)],
				DEFAULT_TIMEOUT_MS,
			);
			return stripPadding(out);
		},

		/** Confirms the turn actually started: --until working returns as soon as
		 *  herdr observes motion, so a landed nudge costs ~1s, not a whole turn. */
		async prompt(paneId: string, text: string, confirmMs = 10_000): Promise<PromptResult> {
			const res = await call(
				["agent", "prompt", paneId, text, "--wait", "--until", "working", "--timeout", String(confirmMs)],
				confirmMs,
			);
			if (res.ok) {
				const observed = typeof res.result === "object" && res.result !== null ? (res.result as { agent?: unknown }).agent : undefined;
				const parsed = toRow(observed);
				return parsed ? { disposition: "accepted", observed: agentOf(parsed).status } : { disposition: "accepted" };
			}
			if (REFUSALS.has(res.code)) return { disposition: "rejected", reason: res.code };
			throw new Error(`herdr agent prompt ${paneId}: ${res.code}: ${res.message}`);
		},
	};
}
