// Needle adapter: a long-lived python sidecar holding the loaded model, spoken to
// over JSON lines. Calls are serialised — one engine, one inference at a time —
// which is correct even though it caps throughput at ~1 decision per 1.5s.

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

export interface NeedleOptions {
	pythonPath?: string;
	timeoutMs?: number;
}

class Sidecar {
	private child: ChildProcessWithoutNullStreams | undefined;
	private queue: Promise<unknown> = Promise.resolve();
	private buffer = "";
	private pending: ((reply: SidecarReply | { error: string }) => void) | undefined;

	// Written out rather than as constructor parameter properties: node's
	// strip-only TypeScript mode rejects them at runtime.
	private readonly python: string;
	private readonly timeoutMs: number;

	constructor(python: string, timeoutMs: number) {
		this.python = python;
		this.timeoutMs = timeoutMs;
	}

	private ensure(): ChildProcessWithoutNullStreams {
		if (this.child && this.child.exitCode === null) return this.child;
		const child = spawn(this.python, ["-u", SIDECAR], { stdio: ["pipe", "pipe", "pipe"] }) as ChildProcessWithoutNullStreams;
		child.stdout.on("data", (d: Buffer) => this.onData(d.toString()));
		child.stderr.on("data", () => {
			/* sidecar readiness + engine diagnostics; not per-request */
		});
		child.on("exit", () => {
			this.child = undefined;
			this.pending?.({ error: "sidecar exited" });
			this.pending = undefined;
		});
		this.child = child;
		return child;
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

	request(payload: string): Promise<SidecarReply | { error: string }> {
		const run = async (): Promise<SidecarReply | { error: string }> => {
			const child = this.ensure();
			return new Promise((resolveReply) => {
				const timer = setTimeout(() => {
					this.pending = undefined;
					this.kill();
					resolveReply({ error: `needle timeout after ${this.timeoutMs}ms` });
				}, this.timeoutMs);
				this.pending = (reply) => {
					clearTimeout(timer);
					resolveReply(reply);
				};
				child.stdin.write(`${payload}\n`);
			});
		};
		// Serialise: interleaved writes would scramble the sidecar's read loop.
		const next = this.queue.then(run, run);
		this.queue = next.catch(() => undefined);
		return next;
	}

	kill(): void {
		this.child?.kill("SIGKILL");
		this.child = undefined;
	}
}

export function needleModel(options: NeedleOptions = {}): DecisionModel {
	const python = options.pythonPath ?? process.env.NEEDLE_PYTHON ?? DEFAULT_PYTHON;
	if (!existsSync(python)) {
		throw new Error(`needle python not found at ${python} — create the venv or set NEEDLE_PYTHON`);
	}
	const sidecar = new Sidecar(python, options.timeoutMs ?? 30_000);

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
	};
}
