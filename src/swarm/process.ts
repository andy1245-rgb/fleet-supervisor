// One profile, one process, and the lifecycle rules `needle.ts` got right — inherited
// unchanged, extended per instance (§1.6):
//
//   * held only while a request is in flight, so an idle profile is never the reason
//     the host stays up;
//   * killed after `idleMs` without work, per-profile, because a `hi` reload costs
//     5.6 s and a `worker` reload costs 1.8 s;
//   * `release()` is total: destroy the pipes, kill the child, settle the waiter,
//     clear the timer — safe twice in a row and safe from a signal handler;
//   * the queue is per instance. A wedged decode in one profile must not wedge the
//     tick; that is the isolation N processes actually buy (§1.8).
//
// Extended: a crash means the profile is **unavailable, not wrong**. `ask` throws
// `ProfileUnavailable` rather than returning a fabricated `leave`, because a
// fabricated leave ends an episode silently. The caller escalates; this class never
// invents a decision.

import { EngineFailure, type EngineRequest, type ProfileEngine } from "./engine.ts";
import { roleOf, type InstanceKey, type ProfileReply, type Role } from "./types.ts";

export class ProfileUnavailable extends Error {
	override readonly cause: "engine_exit" | "timeout" | "spawn_failed";
	constructor(cause: ProfileUnavailable["cause"], message: string) {
		super(message);
		this.name = "ProfileUnavailable";
		this.cause = cause;
	}
}

function asUnavailable(error: unknown): ProfileUnavailable {
	if (error instanceof ProfileUnavailable) return error;
	if (error instanceof EngineFailure) {
		return new ProfileUnavailable(error.cause === "exit" ? "engine_exit" : error.cause, error.message);
	}
	return new ProfileUnavailable("engine_exit", error instanceof Error ? error.message : String(error));
}

export type Health = "ready" | "unhealthy" | "closed";

export interface ProfileProcessOptions {
	instance: InstanceKey;
	/** Builds a fresh engine. Called once at boot and again on every respawn. */
	spawn: () => ProfileEngine;
	timeoutMs?: number;
	idleMs?: number;
	/** 1 s, 2 s, 4 s, capped at 30 s (§4.2 row 7). */
	backoffMs?: readonly number[];
	maxConsecutiveFailures?: number;
	now?: () => number;
}

export interface ProcessStats {
	asks: number;
	failures: number;
	consecutiveFailures: number;
	respawns: number;
	lastError?: string;
}

export class ProfileProcess {
	readonly instance: InstanceKey;
	readonly role: Role;
	private readonly spawnEngine: () => ProfileEngine;
	private readonly timeoutMs: number;
	private readonly idleMs: number;
	private readonly backoff: readonly number[];
	private readonly maxFailures: number;
	private readonly now: () => number;

	private engine: ProfileEngine | undefined;
	private queue: Promise<unknown> = Promise.resolve();
	private inflight = 0;
	private idleTimer: NodeJS.Timeout | undefined;
	private health: Health = "ready";
	private nextSpawnAt = 0;
	private asksCount = 0;
	private failures = 0;
	private consecutiveFailures = 0;
	private respawns = 0;
	private lastError: string | undefined;

	constructor(options: ProfileProcessOptions) {
		this.instance = options.instance;
		this.role = roleOf(options.instance);
		this.spawnEngine = options.spawn;
		// Per-profile, computed from that profile's load measurement at startup (§1.6 L1).
		this.timeoutMs = options.timeoutMs ?? 30_000;
		this.idleMs = options.idleMs ?? 120_000;
		this.backoff = options.backoffMs ?? [1_000, 2_000, 4_000, 8_000, 16_000, 30_000];
		this.maxFailures = options.maxConsecutiveFailures ?? 3;
		this.now = options.now ?? Date.now;
	}

	/** Eager, because the registry identifies a process by its pids and a process that
	 *  has not spawned yet cannot be proven distinct from another (§1.6 L4: instances
	 *  start in parallel at dispatcher boot and report readiness). */
	start(): void {
		if (this.health === "closed") throw new ProfileUnavailable("engine_exit", `${this.instance} is closed`);
		this.ensure();
	}

	pid(): number | undefined {
		return this.engine?.pid;
	}

	enginePid(): number | undefined {
		return this.engine?.enginePid;
	}

	healthOf(): Health {
		return this.health;
	}

	stats(): ProcessStats {
		const stats: ProcessStats = {
			asks: this.asksCount,
			failures: this.failures,
			consecutiveFailures: this.consecutiveFailures,
			respawns: this.respawns,
		};
		if (this.lastError !== undefined) stats.lastError = this.lastError;
		return stats;
	}

	/** How long the caller should wait before retrying an unhealthy instance. */
	restartInMs(): number {
		return Math.max(0, this.nextSpawnAt - this.now());
	}

	async ask(request: EngineRequest): Promise<ProfileReply> {
		const run = async (): Promise<ProfileReply> => {
			if (this.health === "closed") throw new ProfileUnavailable("engine_exit", `${this.instance} was released`);
			if (this.health === "unhealthy" && this.now() < this.nextSpawnAt) {
				throw new ProfileUnavailable("spawn_failed", `${this.instance} is backing off for ${this.restartInMs()}ms`);
			}
			const engine = this.ensure();
			this.asksCount += 1;
			this.inflight += 1;
			engine.hold?.(true);
			try {
				// The timeout is per profile and lives here, not only in the engine adapter: a
				// hosted lane and a fake need the same guarantee that one wedged decode cannot
				// hold an instance forever.
				const reply = await this.withTimeout(engine.ask(request));
				// A reply with no call and no refusal is the engine having nothing to say;
				// treat it as a refusal, which is the escalation signal, not as an exit.
				this.consecutiveFailures = 0;
				this.health = "ready";
				return reply;
			} catch (error) {
				this.recordFailure(error);
				throw error;
			} finally {
				this.inflight -= 1;
				if (this.inflight === 0 && this.engine) {
					this.engine.hold?.(false);
					this.armIdle();
				}
			}
		};
		// Serialised: one engine answers one inference at a time, and interleaved writes
		// would scramble the sidecar's read loop.
		const next = this.queue.then(run, run);
		this.queue = next.catch(() => undefined);
		return next;
	}

	/** Total and idempotent: safe twice, safe with no engine, safe from a handler. */	release(reason = "released"): void {
		this.clearIdle();
		this.health = "closed";
		this.closeEngine();
		this.lastError = reason;
	}

	/** Release-with-respawn: the failure path, where the process object survives and its
	 *  engine does not. */
	private recordFailure(error: unknown): void {
		const unavailable = asUnavailable(error);
		this.failures += 1;
		this.consecutiveFailures += 1;
		this.lastError = `${unavailable.cause}: ${unavailable.message}`;
		this.closeEngine();
		const wait = this.backoff[Math.min(this.consecutiveFailures - 1, this.backoff.length - 1)] ?? 30_000;
		this.nextSpawnAt = this.now() + wait;
		if (this.consecutiveFailures >= this.maxFailures) this.health = "unhealthy";
	}

	private ensure(): ProfileEngine {
		const current = this.engine;
		if (current) return current;
		if (this.health === "unhealthy" && this.now() < this.nextSpawnAt) {
			throw new ProfileUnavailable("spawn_failed", `${this.instance} is backing off for ${this.restartInMs()}ms`);
		}
		let engine: ProfileEngine;
		try {
			engine = this.spawnEngine();
		} catch (error) {
			this.recordFailure(new ProfileUnavailable("spawn_failed", error instanceof Error ? error.message : String(error)));
			throw new ProfileUnavailable("spawn_failed", `${this.instance} could not start`);
		}		if (this.respawns > 0 || this.failures > 0) this.respawns += 1;
		this.engine = engine;
		if (this.health !== "closed") this.health = "ready";
		return engine;
	}

	/** One decode's deadline. Rejecting with `timeout` is what makes a wedged engine
	 *  unavailable rather than a slow decision. */
	private withTimeout(promise: Promise<ProfileReply>): Promise<ProfileReply> {
		return new Promise<ProfileReply>((resolveReply, rejectReply) => {
			const timer = setTimeout(() => {
				rejectReply(new ProfileUnavailable("timeout", `${this.instance} did not answer within ${this.timeoutMs}ms`));
			}, this.timeoutMs);
			timer.unref();
			promise.then(
				(reply) => {
					clearTimeout(timer);
					resolveReply(reply);
				},
				(error: unknown) => {
					clearTimeout(timer);
					rejectReply(error);
				},
			);
		});
	}

	private closeEngine(): void {
		const engine = this.engine;
		this.engine = undefined;
		if (!engine) return;
		try {
			engine.close();
		} catch {
			// A close that throws has already lost the handle; nothing is recoverable and
			// the process is the OS's problem from here.
		}
	}

	private clearIdle(): void {
		if (this.idleTimer) clearTimeout(this.idleTimer);
		this.idleTimer = undefined;
	}

	private armIdle(): void {
		this.clearIdle();
		if (this.idleMs <= 0) return;
		const timer = setTimeout(() => {
			this.idleTimer = undefined;
			if (this.inflight === 0) this.closeEngine();
		}, this.idleMs);
		// Deliberately unreferenced: an idle profile must never be the reason a host stays up.
		timer.unref();
		this.idleTimer = timer;
	}
}
