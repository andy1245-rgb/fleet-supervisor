// The process model, enforced. One process per profile, and this registry is what
// makes "cannot" a fact rather than a preference.
//
// `needle_init` installs the grammar as **process-global** state, so a second
// `needle_init` in one process *replaces* the first: two profiles in one process would
// answer every call with whichever archive was initialised last, against whichever
// grammar was built last. There is no way to ask the engine for anything else
// (`runtime-scaffold.md` §1.1), so a shared process is not a bug to work around — it is
// a configuration that does not mean anything.
//
// Six instances, not five: the orchestrator owns two catalogues, and because the tool
// set is fixed at `needle_init`, "at the ceiling the model is offered a tool set with
// no `spawn`" is a *different process* rather than a sentence in a prompt (§3.4).
// `orch.leaf` and `orch.inner` are two instances, and reusing one for the other is the
// same conflict as reusing one for `worker`.

import type { ProfileEngine } from "./engine.ts";
import { ProfileProcess, type ProfileProcessOptions } from "./process.ts";
import type { InstanceKey } from "./types.ts";

export class GrammarConflict extends Error {
	constructor(message: string) {
		super(message);
		this.name = "GrammarConflict";
	}
}

export class InstanceRegistry {
	private readonly bound = new Map<InstanceKey, ProfileProcess>();
	private readonly owners = new Map<ProfileProcess, InstanceKey>();
	/** Every pid a bound profile is known to hold: the sidecar and, for a tuned
	 *  archive, its engine child. */
	private readonly pidOwners = new Map<number, InstanceKey>();

	/** Binds a process to an instance, starting it if needed so its pids can be read.
	 *  Throws `GrammarConflict` — and deliberately does *not* release the duplicate —
	 *  because releasing it would kill the process that is legitimately hosting the
	 *  first profile. */
	bind(instance: InstanceKey, process: ProfileProcess): ProfileProcess {
		if (process.instance !== instance) {
			throw new GrammarConflict(`${process.instance} cannot answer for ${instance}: the instance is the process`);
		}
		const owner = this.owners.get(process);
		if (owner !== undefined && owner !== instance) {
			throw new GrammarConflict(`this process already hosts ${owner}; it cannot also host ${instance}`);
		}
		const existing = this.bound.get(instance);
		if (existing && existing !== process) {
			throw new GrammarConflict(`${instance} is already bound to another process`);
		}
		process.start();
		for (const pid of pidsOf(process)) {
			const pidOwner = this.pidOwners.get(pid);
			if (pidOwner !== undefined && pidOwner !== instance) {
				throw new GrammarConflict(
					`pid ${pid} already hosts ${pidOwner}; needle_init is process-global, so ${instance} needs its own process`,
				);
			}
		}
		for (const pid of pidsOf(process)) this.pidOwners.set(pid, instance);
		this.owners.set(process, instance);
		this.bound.set(instance, process);
		return process;
	}

	get(instance: InstanceKey): ProfileProcess | undefined {
		return this.bound.get(instance);
	}

	require(instance: InstanceKey): ProfileProcess {
		const process = this.bound.get(instance);
		if (!process) throw new GrammarConflict(`${instance} has no process`);
		return process;
	}

	/** A profile that is absent is unhealthy, not absent-minded: routing work to a
	 *  profile with no process would mean inventing a decision. */
	healthy(instance: InstanceKey): boolean {
		return this.bound.get(instance)?.healthOf() === "ready";
	}

	instances(): readonly InstanceKey[] {
		return [...this.bound.keys()];
	}

	close(): void {
		for (const process of this.bound.values()) process.release("registry closed");
		this.bound.clear();
		this.owners.clear();
		this.pidOwners.clear();
	}
}

function pidsOf(process: ProfileProcess): number[] {
	return [process.pid(), process.enginePid()].filter((pid): pid is number => typeof pid === "number" && pid > 0);
}

/** Bind every instance a set of factories covers. Boot order is the caller's: the spec
 *  has them start in parallel and report readiness (§1.6 L4), so what this does is
 *  bind, not serialise. */
export function createInstances(
	factories: Partial<Record<InstanceKey, () => ProfileEngine>>,
	options: Partial<Omit<ProfileProcessOptions, "instance" | "spawn">> = {},
): InstanceRegistry {
	const registry = new InstanceRegistry();
	for (const [instance, factory] of Object.entries(factories)) {
		if (!factory) continue;
		const process = new ProfileProcess({ ...options, instance: instance as InstanceKey, spawn: factory });
		registry.bind(instance as InstanceKey, process);
	}
	return registry;
}
