// The only module that shells out to herdr. Everything else takes a HerdrPort.
//
// Wire contract (herdr protocol 22, `herdr api schema --json`):
//   success → { id, result: { type: "...", ... } }
//   failure → { id, error: { code, message } }
// A rejected prompt is a *failure envelope*, not a thrown error: agent_blocked
// means "this agent needs a human", which is a decision input. So this module
// returns envelopes and never folds a code into an exception.

import { spawn } from "node:child_process";
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

/** Validates the wire shape here so no caller has to guess whether a field exists. */
function toAgent(raw: unknown): HerdrAgent | undefined {
	if (typeof raw !== "object" || raw === null) return undefined;
	const r = raw as Record<string, unknown>;
	const paneId = str(r.pane_id);
	if (!paneId) return undefined;
	const cwd = str(r.cwd);
	return {
		paneId,
		agent: str(r.agent, "unknown"),
		status: status(r.agent_status),
		cwd,
		foregroundCwd: str(r.foreground_cwd, cwd),
		workspaceId: str(r.workspace_id),
		tabId: str(r.tab_id),
		title: str(r.terminal_title_stripped, str(r.terminal_title)),
		completionSeq: num(r.completion_seq),
		stateChangeSeq: num(r.state_change_seq),
		focused: r.focused === true,
	};
}

function agentsFrom(result: unknown): HerdrAgent[] {
	if (typeof result !== "object" || result === null) return [];
	const list = (result as { agents?: unknown }).agents;
	if (!Array.isArray(list)) return [];
	return list.map(toAgent).filter((a): a is HerdrAgent => a !== undefined);
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
			return toAgent((res.result as { agent?: unknown }).agent);
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
				const parsed = toAgent(observed);
				return parsed ? { disposition: "accepted", observed: parsed.status } : { disposition: "accepted" };
			}
			if (REFUSALS.has(res.code)) return { disposition: "rejected", reason: res.code };
			throw new Error(`herdr agent prompt ${paneId}: ${res.code}: ${res.message}`);
		},
	};
}
