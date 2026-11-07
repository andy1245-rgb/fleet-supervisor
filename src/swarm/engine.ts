// An engine handle: one process holding one archive, spoken to over JSON lines.
//
// The interface is deliberately narrow because the process model is what the runtime
// enforces and the engine is what it cannot see. `pid` is the sidecar; `enginePid` is
// the engine child, which exists only for a tuned archive — `Needle(weights=path)`
// forks its own worker and the weights live *there*, not in the sidecar (§1.2). Two
// pids, therefore, and the registry refuses a second profile on either of them.
//
// `hold()` exists because a child process and its three pipes are each an event-loop
// handle: any one left referenced pins the host, and a handle left unreferenced during
// an in-flight request lets node exit with a request pending. `needle.ts` learned this
// the expensive way; the rule is copied rather than rediscovered.
//
// A rejection from `ask` means the handle is gone — never that the model declined. A
// refusal is a *reply* (`refused: true`) and is the escalation signal; a dead pipe is a
// dead process and must not be dressed as a decision.

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { refusal, type ProfileReply } from "./types.ts";

export interface EngineRequest {
	system: string;
	state: string;
}

/** Why an engine stopped being usable. It lives here rather than in `process.ts` so the
 *  engine does not import its own supervisor. */
export class EngineFailure extends Error {
	override readonly cause: "timeout" | "exit" | "spawn_failed";
	constructor(cause: EngineFailure["cause"], message: string) {
		super(message);
		this.name = "EngineFailure";
		this.cause = cause;
	}
}

export interface ProfileEngine {
	/** Which decision source answered: `needle`, a hosted lane, or a test fake. */
	readonly kind: string;
	readonly pid: number;
	readonly enginePid?: number;
	ask(request: EngineRequest): Promise<ProfileReply>;
	/** Ref or unref the child and its pipes together. Optional: a fake has no handles. */
	hold?(referenced: boolean): void;
	close(): void;
}

/** The defensive parse every adapter needs (mirroring `parseDecision`'s discipline in
 *  `src/decision/types.ts`): a supervisor must never act on a call it did not
 *  successfully parse, so anything malformed becomes a refusal, which is the
 *  escalation signal rather than a crash. */
export function parseReply(raw: string, latencyMs: number): ProfileReply {
	const start = raw.indexOf("{");
	const end = raw.lastIndexOf("}");
	if (start === -1 || end === -1 || end <= start) {
		return { ...refusal(latencyMs), reasoning: `no JSON object in ${raw.slice(0, 200)}` };
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw.slice(start, end + 1));
	} catch {
		return { ...refusal(latencyMs), reasoning: `unparseable JSON: ${raw.slice(0, 200)}` };
	}
	if (typeof parsed !== "object" || parsed === null) {
		return { ...refusal(latencyMs), reasoning: "reply was not an object" };
	}
	const row = parsed as Record<string, unknown>;
	const op = typeof row.op === "string" ? row.op : null;
	const args: Record<string, string> = {};
	if (typeof row.args === "object" && row.args !== null) {
		for (const [key, value] of Object.entries(row.args as Record<string, unknown>)) {
			if (typeof value === "string") args[key] = value;
			else if (typeof value === "number") args[key] = String(value);
		}
	}
	const confidence = typeof row.confidence === "number" && Number.isFinite(row.confidence) ? row.confidence : 0;
	const suppressed = typeof row.suppressed === "number" ? row.suppressed : 0;
	const refused = row.refused === true || op === null;
	const reply: ProfileReply = {
		op,
		args,
		confidence: Math.max(0, Math.min(1, confidence)),
		refused,
		suppressed,
		latencyMs,
	};
	if (typeof row.reasoning === "string") reply.reasoning = row.reasoning;
	return reply;
}

export interface StdioEngineOptions {
	timeoutMs?: number;
}

/** A child process that answers one JSON line per request. This is the shape a profile
 *  sidecar has; it is not the needle engine itself, and nothing in this directory
 *  loads one — the tests inject a fake, and production wiring supplies an
 *  implementation of `ProfileEngine` backed by the real sidecar. */
export function stdioEngine(command: string, args: readonly string[], options: StdioEngineOptions = {}): ProfileEngine {
	const timeoutMs = options.timeoutMs ?? 30_000;
	const child: ChildProcessWithoutNullStreams = spawn(command, [...args], { stdio: ["pipe", "pipe", "pipe"] });
	let buffer = "";
	let started = Date.now();
	let waiter: ((result: ProfileReply | Error) => void) | undefined;

	const settle = (result: ProfileReply | Error): void => {
		const waiting = waiter;
		waiter = undefined;
		waiting?.(result);
	};

	child.stdout.on("data", (chunk: Buffer) => {
		buffer += chunk.toString();
		const index = buffer.indexOf("\n");
		if (index === -1) return;
		const line = buffer.slice(0, index).trim();
		buffer = buffer.slice(index + 1);
		if (line !== "") settle(parseReply(line, Date.now() - started));
	});
	child.on("exit", () => settle(new EngineFailure("exit", "the engine process exited")));
	child.on("error", (error: Error) => settle(new EngineFailure("spawn_failed", error.message)));

	const engine: ProfileEngine = {
		kind: "stdio",
		pid: child.pid ?? -1,
		ask(request: EngineRequest): Promise<ProfileReply> {
			return new Promise<ProfileReply>((resolveReply, rejectReply) => {
				started = Date.now();
				let settled = false;
				const timer = setTimeout(() => {
					if (settled) return;
					settled = true;
					waiter = undefined;
					// A wedged decode is not recoverable in-process: hand the engine back to the OS
					// and let the next request spawn a fresh one.
					engine.close();
					rejectReply(new EngineFailure("timeout", `no reply within ${timeoutMs}ms`));
				}, timeoutMs);
				waiter = (result) => {
					if (settled) return;
					settled = true;
					clearTimeout(timer);
					if (result instanceof Error) {
						rejectReply(result);
						return;
					}
					resolveReply(result);
				};
				engine.hold?.(true);
				child.stdin.write(`${JSON.stringify({ system: request.system, state: request.state })}\n`);
			});
		},
		hold(referenced: boolean): void {
			const apply = referenced ? child.ref : child.unref;
			apply.call(child);
			setReferenced(child.stdin, referenced);
			setReferenced(child.stdout, referenced);
			setReferenced(child.stderr, referenced);
		},
		close(): void {
			child.stdin.destroy();
			child.stdout.destroy();
			child.stderr.destroy();
			if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
		},
	};

	return engine;
}

/** A pipe is a socket at runtime and keeps the loop alive on its own, so unref'ing the
 *  child alone still leaves the host waiting on a reader that never fires again. The
 *  stream types do not admit that, hence the structural probe (same as `needle.ts`). */
function setReferenced(stream: unknown, referenced: boolean): void {
	if (typeof stream !== "object" || stream === null) return;
	const handle = stream as { ref?: () => void; unref?: () => void };
	const apply = referenced ? handle.ref : handle.unref;
	if (typeof apply === "function") apply.call(stream);
}
