// Needle adapter: a long-lived python sidecar holding the loaded model, spoken to
// over JSON lines. Calls are serialised — one engine, one inference at a time —
// which is correct even though it caps throughput at ~1 decision per 1.5s.
//
// The sidecar is a process, so it is also a handle on the host's event loop, and
// a handle that is never released is a host that cannot exit: the child held the
// loop open forever, so a bench run or a supervisor tick that made one needle
// decision hung until something killed it. It is therefore referenced only while
// a request is in flight, unref'd the moment none is, killed outright after
// `idleMs` without work, and killed on exit or SIGINT so nothing is orphaned.

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { renderInput, SYSTEM } from "./prompt.ts";
import { isOp, parseDecision, type Decision, type DecisionInput, type DecisionModel } from "./types.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const SIDECAR = join(HERE, "needle_sidecar.py");
const DEFAULT_PYTHON = resolve(HERE, "..", "..", ".venv", "bin", "python");

interface SidecarReply {
	ok?: boolean;
	op?: unknown;
	argument?: unknown;
	confidence?: unknown;
	refused?: unknown;
	latency_ms?: unknown;
	suppressed?: unknown;
	reasoning?: unknown;
	error?: unknown;
}

type Reply = SidecarReply | { error: string };

export interface NeedleOptions {
	pythonPath?: string;
	timeoutMs?: number;
	/** How long the loaded model may sit unused before the child is killed. The
	 *  sidecar exists to avoid a 5.3s load per decision, not to keep 158MB of
	 *  weights resident between the ticks of a supervisor that asks once a minute. */
	idleMs?: number;
}

/** A stdio pipe is a socket at runtime and keeps the loop alive on its own, so
 *  unref'ing the child alone still leaves the host waiting on a reader that never
 *  fires again. The stream types do not admit that, hence the structural probe. */
function setReferenced(stream: unknown, referenced: boolean): void {
	if (typeof stream !== "object" || stream === null) return;
	const handle = stream as { ref?: () => void; unref?: () => void };
	const apply = referenced ? handle.ref : handle.unref;
	if (typeof apply === "function") apply.call(stream);
}

interface ExitHooks {
	exit: () => void;
	sigint: () => void;
	sigterm: () => void;
}

class Sidecar {
	private child: ChildProcessWithoutNullStreams | undefined;
	private queue: Promise<unknown> = Promise.resolve();
	private buffer = "";
	private pending: ((reply: Reply) => void) | undefined;
	/** Requests written but unanswered. The loop reference is held only while this
	 *  is above zero, so an idle sidecar can never keep the host alive. */
	private inflight = 0;
	private idleTimer: NodeJS.Timeout | undefined;
	private hooks: ExitHooks | undefined;

	// Written out rather than as constructor parameter properties: node's
	// strip-only TypeScript mode rejects them at runtime.
	private readonly python: string;
	private readonly timeoutMs: number;
	private readonly idleMs: number;

	constructor(python: string, timeoutMs: number, idleMs: number) {
		this.python = python;
		this.timeoutMs = timeoutMs;
		this.idleMs = idleMs;
	}

	private spawn(): ChildProcessWithoutNullStreams {
		const child = spawn(this.python, ["-u", SIDECAR], { stdio: ["pipe", "pipe", "pipe"] }) as ChildProcessWithoutNullStreams;
		this.buffer = "";
		child.stdout.on("data", (d: Buffer) => {
			if (this.child === child) this.onData(d.toString());
		});
		child.stderr.on("data", () => {
			/* sidecar readiness + engine diagnostics; not per-request */
		});
		child.on("error", (error: Error) => {
			// A spawn that fails (missing interpreter, EMFILE) never emits "exit",
			// so without this the waiter would sit there until its timeout fired.
			if (this.child !== child) return;
			this.release(`sidecar failed to start: ${error.message}`);
		});
		child.on("exit", () => {
			if (this.child !== child) return;
			this.release("sidecar exited");
		});
		this.child = child;
		this.hold(this.inflight > 0);
		this.watchExit();
		return child;
	}

	/** Ref or unref the child and all three of its pipes together: they are
	 *  independent loop handles, and any one of them left referenced pins the host. */
	private hold(referenced: boolean): void {
		const child = this.child;
		if (!child) return;
		if (referenced) child.ref();
		else child.unref();
		setReferenced(child.stdin, referenced);
		setReferenced(child.stdout, referenced);
		setReferenced(child.stderr, referenced);
	}

	/** Gives up the current child: settles any waiter with `error`, destroys its
	 *  pipes, kills it, and drops every handle it holds on the host loop. Safe when
	 *  there is no child, safe twice in a row, and safe from a signal handler. */
	private release(error = "sidecar released"): void {
		const child = this.child;
		this.child = undefined;
		this.clearIdle();
		this.buffer = "";
		const waiter = this.pending;
		this.pending = undefined;
		if (child) {
			// Destroying the pipes is what actually frees the loop; killing the
			// process is what frees the 158MB. Both, always.
			child.stdin.destroy();
			child.stdout.destroy();
			child.stderr.destroy();
			if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
		}
		this.unwatchExit();
		waiter?.({ error });
	}

	private onData(chunk: string): void {
		this.buffer += chunk;
		let idx: number;
		while ((idx = this.buffer.indexOf("\n")) !== -1) {
			const line = this.buffer.slice(0, idx).trim();
			this.buffer = this.buffer.slice(idx + 1);
			if (!line) continue;
			const waiter = this.pending;
			this.pending = undefined;
			if (!waiter) continue;
			try {
				waiter(JSON.parse(line) as SidecarReply);
			} catch {
				waiter({ error: `unparseable sidecar line: ${line.slice(0, 200)}` });
			}
		}
	}

	private ensure(): ChildProcessWithoutNullStreams {
		const current = this.child;
		if (current && current.exitCode === null && current.signalCode === null) return current;
		if (current) this.release();
		return this.spawn();
	}

	private clearIdle(): void {
		if (this.idleTimer) clearTimeout(this.idleTimer);
		this.idleTimer = undefined;
	}

	private armIdle(): void {
		this.clearIdle();
		const timer = setTimeout(() => {
			this.idleTimer = undefined;
			if (this.inflight === 0) this.release();
		}, this.idleMs);
		// Deliberately unreferenced: the sidecar must never be the reason a host
		// stays up. When nothing else does, the exit hook kills the child instead.
		timer.unref();
		this.idleTimer = timer;
	}

	private watchExit(): void {
		if (this.hooks) return;
		const exit = (): void => this.release();
		const sigint = (): void => this.signal("SIGINT");
		const sigterm = (): void => this.signal("SIGTERM");
		process.on("exit", exit);
		process.on("SIGINT", sigint);
		process.on("SIGTERM", sigterm);
		this.hooks = { exit, sigint, sigterm };
	}

	private unwatchExit(): void {
		const hooks = this.hooks;
		if (!hooks) return;
		this.hooks = undefined;
		process.removeListener("exit", hooks.exit);
		process.removeListener("SIGINT", hooks.sigint);
		process.removeListener("SIGTERM", hooks.sigterm);
	}

	private signal(signal: NodeJS.Signals): void {
		this.release();
		// Registering a handler suppresses node's own exit, so once ours is gone
		// the signal is re-raised: swallowing an interrupt would be a worse bug
		// than the orphan this hook exists to prevent.
		if (process.listenerCount(signal) === 0) process.kill(process.pid, signal);
	}

	private exchange(child: ChildProcessWithoutNullStreams, payload: string): Promise<Reply> {
		return new Promise<Reply>((resolveReply) => {
			const timer = setTimeout(() => {
				this.pending = undefined;
				// A wedged decode is not recoverable in-process: hand the engine back
				// to the OS and let the next request spawn a fresh one.
				this.release(`needle timeout after ${this.timeoutMs}ms`);
				resolveReply({ error: `needle timeout after ${this.timeoutMs}ms` });
			}, this.timeoutMs);
			this.pending = (reply) => {
				clearTimeout(timer);
				resolveReply(reply);
			};
			try {
				child.stdin.write(`${payload}\n`);
			} catch (e) {
				clearTimeout(timer);
				this.pending = undefined;
				resolveReply({ error: `sidecar write failed: ${(e as Error).message}` });
			}
		});
	}

	request(payload: string): Promise<Reply> {
		const run = async (): Promise<Reply> => {
			this.clearIdle();
			this.inflight += 1;
			if (this.inflight === 1) this.hold(true);
			try {
				return await this.exchange(this.ensure(), payload);
			} finally {
				this.inflight -= 1;
				if (this.inflight === 0 && this.child) {
					// Nothing pending: stop being the reason the host stays up, and
					// start the clock that gives the model back.
					this.hold(false);
					this.armIdle();
				}
			}
		};
		// Serialise: interleaved writes would scramble the sidecar's read loop.
		const next = this.queue.then(run, run);
		this.queue = next.catch(() => undefined);
		return next;
	}

	close(): void {
		this.release("sidecar closed");
	}
}

export function needleModel(options: NeedleOptions = {}): DecisionModel {
	const python = options.pythonPath ?? process.env.NEEDLE_PYTHON ?? DEFAULT_PYTHON;
	if (!existsSync(python)) {
		throw new Error(`needle python not found at ${python} — create the venv or set NEEDLE_PYTHON`);
	}
	const sidecar = new Sidecar(python, options.timeoutMs ?? 30_000, options.idleMs ?? 2_000);

	return {
		name: "needle3",
		costPerCallUsd: 0,

		async decide(input: DecisionInput): Promise<Decision> {
			const started = Date.now();
			const reply = await sidecar.request(JSON.stringify({ system: SYSTEM, user: renderInput(input) }));
			if ("error" in reply) {
				return parseDecision("", { model: "needle3", costUsd: 0, latencyMs: Date.now() - started });
			}
			const op = isOp(reply.op) ? reply.op : undefined;
			const confidence = typeof reply.confidence === "number" ? reply.confidence : 0;
			const argument = typeof reply.argument === "string" ? reply.argument : "";
			const latencyMs = typeof reply.latency_ms === "number" ? reply.latency_ms : Date.now() - started;
			const raw = JSON.stringify({ op: reply.op, argument, confidence, reasoning: reply.reasoning });

			if (!op) {
				return {
					op: "flag",
					argument: argument || "needle declined to call a tool",
					confidence,
					model: "needle3",
					costUsd: 0,
					latencyMs,
					refused: true,
					raw,
				};
			}
			return { op, argument, confidence, model: "needle3", costUsd: 0, latencyMs, refused: false, raw };
		},

		close(): void {
			sidecar.close();
		},
	};
}
