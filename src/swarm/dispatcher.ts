// The dispatcher loop: one instruction boundary per `step`, and the seven stages
// `runtime-scaffold.md` §3.2 names — health, admit, render, decide, verify, act, record.
//
// The ordering rules that are load-bearing, and why:
//
//   * **the licence is chosen from the grant before the decode** (§3.4). A node that has
//     just spent its last unit cannot be handed the inner catalogue, and one that still
//     has budget must not be handed the leaf one. The choice is a *process*, so it
//     cannot be revisited after the decode.
//   * **the ask is written before the sidecar is awaited** (§1.6 L3). A crash mid-decode
//     then loses the outcome and never the question: a replay shows a decision that was
//     asked for and never answered, which is a fact, unlike a missing row.
//   * **a refusal is escalated, never substituted with `leave`.** A fabricated leave ends
//     an episode silently, and a silent end is indistinguishable from success.
//   * the model supplies a pointer. The dispatcher supplies the record, the route and the
//     grant — everything a hop needs, so no profile can address another profile and no
//     profile can carry content.

import { correctiveOp } from "./escalate.ts";
import type { Gate } from "./gate.ts";
import type { GrantBook } from "./grant.ts";
import type { InstanceRegistry } from "./instances.ts";
import { ProfileUnavailable } from "./process.ts";
import { capsOf, catalogueOf, systemOf, type ProfileTable } from "./profiles.ts";
import type { StructuredRecord } from "./records.ts";
import type { SwarmStore } from "./store.ts";
import {
	instanceFor,
	type Action,
	type ArtifactKind,
	type DispatchOutcome,
	type FailureCause,
	type InstanceKey,
	type Licence,
	type ProfileReply,
	type Role,
} from "./types.ts";
import { verifyCall, type Call } from "./verify.ts";
import type { ProfileEngine } from "./engine.ts";

export interface StepRequest {
	chainId: string;
	grantId: string;
	nodeId: string;
	/** Which role is being asked. The grant supplies depth and budget; this supplies
	 *  identity, and a mismatch with the grant is a dispatcher bug rather than a decision. */
	profile: Role;
	/** The node's state, rendered by the profile package into RG §8.1's block. */
	state: Record<string, unknown>;
	/** The record this node's action announces, when the effect publishes. Built by the
	 *  dispatcher from its work graph: the model supplies only the pointer. */
	payload?: { kind: ArtifactKind; record: StructuredRecord | null; summary?: string };
	/** Who a `steer` is addressed to, from the graph and never from an argument. */
	route?: Role;
	/** The previous call on this node, for the loop check. */
	last?: Call;
}

export interface StepDeps {
	gate: Gate;
	registry: InstanceRegistry;
	grants: GrantBook;
	profiles: ProfileTable;
	/** The profile package's renderer, so the corpus's exact bytes are what the model sees. */
	render: (role: Role, licence: Licence, state: Record<string, unknown>) => Promise<string>;
	/** The same grammar behind a different decision source: the hosted lane. Absent means
	 *  a re-ask is recorded as unavailable rather than silently skipped. */
	escalator?: ProfileEngine;
	now?: () => number;
}

export interface StepResult {
	instance: InstanceKey;
	licence: Licence;
	/** Steers released at this boundary. Zero is the normal case; a non-zero count is
	 *  the only place a hop is observable without reading the outbox. */
	delivered: number;
	/** Present unless no decode happened at all (a dead instance, a spent grant). */
	reply?: ProfileReply;
	outcome: DispatchOutcome;
	/** True when the primary decode was insufficient and the ladder was consulted. */
	escalated: boolean;
	/** A corrective action the escalation asked for, already through the gate. */
	corrective?: DispatchOutcome;
}

export async function step(request: StepRequest, deps: StepDeps): Promise<StepResult> {
	const grant = deps.grants.get(request.grantId);
	if (!grant) {
		// No grant, no decode: the chain this node belonged to is over.
		return {
			instance: instanceFor(request.profile, "leaf"),
			licence: "leaf",
			delivered: 0,
			outcome: deps.gate.reject({
				chainId: request.chainId,
				grantId: request.grantId,
				nodeId: request.nodeId,
				profile: request.profile,
				instance: instanceFor(request.profile, "leaf"),
				op: "unknown",
				cause: "grant_expired",
				detail: `grant ${request.grantId} is not in the book`,
			}),
			escalated: true,
		};
	}
	if (grant.profile !== request.profile) {
		return {
			instance: instanceFor(request.profile, "leaf"),
			licence: "leaf",
			delivered: 0,
			outcome: deps.gate.reject({
				chainId: request.chainId,
				grantId: request.grantId,
				nodeId: request.nodeId,
				profile: request.profile,
				instance: instanceFor(request.profile, "leaf"),
				op: "unknown",
				cause: "unparseable",
				detail: `node asks as ${request.profile} but grant ${grant.grantId} is a ${grant.profile} grant`,
			}),
			escalated: true,
		};
	}

	// The ceiling selects the process, not a prompt line (§3.4).
	const licence: Licence = grant.maySpawn ? "inner" : "leaf";
	const instance = instanceFor(grant.profile, licence);
	const process = deps.registry.get(instance);
	if (!process || !deps.registry.healthy(instance)) {
		return {
			instance,
			licence,
			delivered: 0,
			outcome: deps.gate.reject({
				chainId: request.chainId,
				grantId: request.grantId,
				nodeId: request.nodeId,
				profile: grant.profile,
				instance,
				op: "unknown",
				cause: "unavailable",
				detail: `${instance} has no healthy process; work is parked rather than rerouted`,
			}),
			escalated: true,
		};
	}

	// Stage 1: the instruction boundary. A steer is released here and nowhere else — no
	// mid-tool, no delta steers (§2.4 step 6).
	const delivered = deps.gate.intake(grant.profile, `loop-${deps.gate.store.log.count() + 1}`).length;

	const stateText = await deps.render(grant.profile, licence, request.state);
	const catalogue = catalogueOf(deps.profiles, grant.profile, licence);
	const system = systemOf(deps.profiles, grant.profile, licence);
	const rung = capsOf(deps.profiles, grant.profile).depth;

	// L3: the question before the answer.
	deps.gate.store.log.append({
		t: "decision_asked",
		chainId: request.chainId,
		grant: request.grantId,
		node: request.nodeId,
		profile: grant.profile,
		instance,
		depth: grant.depth,
		decidedBy: "needle",
	});

	let reply: ProfileReply;
	try {
		reply = await process.ask({ system, state: stateText });
	} catch (error) {
		return unavailable(request, grant.profile, instance, licence, error, deps);
	}

	recordDecision(deps.gate.store, request, grant.profile, instance, grant.depth, reply, "needle", rung);

	// A refusal is the escalation signal, not an error (§4.1). Suppression is a refusal
	// whose root cause is a corpus defect, so the row says so and the corpus owner is told.
	if (reply.refused || reply.suppressed > 0) {
		const cause: FailureCause = reply.refused ? "refusal" : "suppressed";
		const outcome = deps.gate.reject({
			chainId: request.chainId,
			grantId: request.grantId,
			nodeId: request.nodeId,
			profile: grant.profile,
			instance,
			op: reply.op ?? "none",
			cause,
			detail: refusalDetail(reply),
		});
		return escalateFrom(outcome, request, grant.profile, instance, licence, delivered, reply, deps, stateText, system, rung);
	}

	const verified = verifyCall(reply, { catalogue, stateText, last: request.last });
	if (!verified.ok) {
		const outcome = deps.gate.reject({
			chainId: request.chainId,
			grantId: request.grantId,
			nodeId: request.nodeId,
			profile: grant.profile,
			instance,
			op: reply.op ?? "none",
			cause: "unparseable",
			detail: verified.detail,
		});
		return {
			instance,
			licence,
			delivered,
			reply,
			outcome,
			escalated: true,
			corrective: await correctiveOf(outcome, request, deps),
		};
	}

	const outcome = await act(verified.call.op, verified.call.args, request, deps);
	return {
		instance,
		licence,
		delivered,
		reply,
		outcome,
		escalated: false,
		corrective: await correctiveOf(outcome, request, deps),
	};
}

/** One decision asked and answered. Two rows, one decision: what was asked for and what
 *  came back, so an unanswered ask is visible as such. */
function recordDecision(
	store: SwarmStore,
	request: StepRequest,
	profile: Role,
	instance: InstanceKey,
	depth: number,
	reply: ProfileReply,
	decidedBy: string,
	rung: string,
): void {
	const row: Parameters<SwarmStore["log"]["append"]>[0] = {
		t: "profile_decision",
		chainId: request.chainId,
		grant: request.grantId,
		node: request.nodeId,
		profile,
		instance,
		depth,
		op: reply.op,
		// The pointer, never the text behind it (§6.2).
		arg: reply.op ? (Object.values(reply.args)[0] ?? "") : "",
		confidence: reply.confidence,
		refused: reply.refused,
		suppressed: reply.suppressed,
		latencyMs: reply.latencyMs,
		decidedBy,
		rung,
	};
	if (reply.refused || reply.suppressed > 0) {
		// Logged only here: on a refusal the reasoning is the diagnostic, anywhere else it
		// is the largest field with the least to say (§6.4).
		if (reply.reasoning) row.reasoning = reply.reasoning;
	}
	store.log.append(row);
}

function refusalDetail(reply: ProfileReply): string {
	const reasoning = reply.reasoning ? `: ${reply.reasoning}` : "";
	if (reply.suppressed > 0) return `${reply.suppressed} suppressed call(s)${reasoning}`;
	return `the profile emitted no call${reasoning}`;
}

/** The dispatcher honours the escalation's action, and honours it through the same gate:
 *  a synthesized block is an action like any other, not a side effect of a failure. */
async function escalateFrom(
	outcome: DispatchOutcome,
	request: StepRequest,
	profile: Role,
	instance: InstanceKey,
	licence: Licence,
	delivered: number,
	/** The decode that was insufficient. It is still a decision — it consumed one — and a
	 *  step report that dropped it would undercount exactly the traffic a run is graded on. */
	reply: ProfileReply,
	deps: StepDeps,
	stateText: string,
	system: string,
	rung: string,
): Promise<StepResult> {
	if (outcome.kind !== "refused") return { instance, licence, delivered, reply, outcome, escalated: true };
	const escalation = outcome.escalation;
	if (escalation.action === "reask_once" || escalation.action === "escalate_lane") {
		const escalator = deps.escalator;
		if (!escalator) {
			// No lane to ask: the row already names the next actor, and inventing a decision
			// to keep the shape of the loop would be the failure this whole file avoids.
			return { instance, licence, delivered, reply, outcome, escalated: true };
		}
		let second: ProfileReply;
		try {
			second = await escalator.ask({ system, state: stateText });
		} catch {
			// The lane itself failed. The escalation row already says so; a second fabricated
			// decision here would be worse than the outage.
			deps.gate.store.log.append({ t: "profile_unhealthy", profile, instance, cause: "engine_exit", restartInMs: 0 });
			return { instance, licence, delivered, reply, outcome, escalated: true };
		}
		const depth = deps.grants.get(request.grantId)?.depth ?? 0;
		recordDecision(deps.gate.store, request, profile, instance, depth, second, "hosted", rung);
		if (second.refused || second.suppressed > 0) return { instance, licence, delivered, reply: second, outcome, escalated: true };
		const verified = verifyCall(second, {
			catalogue: catalogueOf(deps.profiles, profile, licence),
			stateText,
			last: request.last,
		});
		if (!verified.ok) return { instance, licence, delivered, reply: second, outcome, escalated: true };
		const acted = await act(verified.call.op, verified.call.args, request, deps);
		return {
			instance,
			licence,
			delivered,
			reply: second,
			outcome: acted,
			escalated: true,
			corrective: await correctiveOf(acted, request, deps),
		};
	}
	return {
		instance,
		licence,
		delivered,
		reply,
		outcome,
		escalated: true,
		corrective: await correctiveOf(outcome, request, deps),
	};
}

async function act(op: string, args: Record<string, string>, request: StepRequest, deps: StepDeps): Promise<DispatchOutcome> {
	const grant = deps.grants.get(request.grantId);
	const action: Action = {
		chainId: request.chainId,
		grantId: request.grantId,
		nodeId: request.nodeId,
		profile: request.profile,
		instance: instanceFor(request.profile, grant?.maySpawn ? "inner" : "leaf"),
		op,
		args,
	};
	if (request.payload) action.payload = request.payload;
	if (request.route) action.route = request.route;
	return await deps.gate.dispatch(action);
}

/** `synthesize_block` / `synthesize_drop`: the profile refused, so the dispatcher writes
 *  the return record the refusing profile never emitted. It goes through the gate, so a
 *  corrective action is still one gate and one row. */
async function correctiveOf(
	outcome: DispatchOutcome,
	request: StepRequest,
	deps: StepDeps,
): Promise<DispatchOutcome | undefined> {
	if (outcome.kind !== "refused") return undefined;
	const corrective = correctiveOp(outcome.escalation);
	if (!corrective) return undefined;
	const itemId = request.payload?.record?.kind === "assignment" ? request.payload.record.itemId : String(request.state.item ?? "");
	const payload = {
		kind: "return" as ArtifactKind,
		record: {
			kind: "return" as const,
			itemId,
			status: "blocked" as const,
			artifactIds: [],
			evidence: null,
			code: outcome.escalation.action === "synthesize_drop" ? "blocked" : "denied",
			tries: 1,
		},
	};
	return act(corrective.op, corrective.args, { ...request, payload }, deps);
}

function unavailable(
	request: StepRequest,
	profile: Role,
	instance: InstanceKey,
	licence: Licence,
	error: unknown,
	deps: StepDeps,
): StepResult {
	const cause: "engine_exit" | "timeout" | "spawn_failed" = error instanceof ProfileUnavailable ? error.cause : "engine_exit";
	deps.gate.store.log.append({
		t: "profile_unhealthy",
		profile,
		instance,
		cause,
		restartInMs: deps.registry.get(instance)?.restartInMs() ?? 0,
	});
	const outcome = deps.gate.reject({
		chainId: request.chainId,
		grantId: request.grantId,
		nodeId: request.nodeId,
		profile,
		instance,
		op: "unknown",
		cause: "unavailable",
		detail: error instanceof Error ? error.message : String(error),
	});
	return { instance, licence, delivered: 0, outcome, escalated: true };
}

export interface RunReport {
	steps: StepResult[];
	decisions: number;
	byProfile: Record<string, number>;
	refused: number;
	escalations: number;
	dropped: number;
	elapsedMs: number;
}
/** A sequence of steps with one `tick` row at the end: the aggregate that answers "is the
 *  box keeping up and which profile is the bottleneck" without reading every decision. */
export async function run(requests: readonly StepRequest[], deps: StepDeps): Promise<RunReport> {
	const started = Date.now();
	// Once per loop iteration, off the claim path (§2.3 step 4): a crashed holder's lease
	// and an outlived grant become rows before anything is decided under them.
	deps.gate.sweep();
	const steps: StepResult[] = [];
	const byProfile: Record<string, number> = {};
	let decisions = 0;
	let refused = 0;
	let escalations = 0;
	let dropped = 0;
	for (const request of requests) {
		const result = await step(request, deps);
		steps.push(result);
		const grant = deps.grants.get(request.grantId);
		if (result.reply) {
			decisions += 1;
			const role = grant?.profile ?? "orch";
			byProfile[role] = (byProfile[role] ?? 0) + 1;
		} else {
			dropped += 1;
		}
		if (result.reply?.refused) refused += 1;
		if (result.outcome.kind === "refused") escalations += 1;
	}
	deps.gate.store.log.append({
		t: "tick",
		decisions,
		byProfile,
		refused,
		escalations,
		dropped,
		elapsedMs: Date.now() - started,
	});
	return { steps, decisions, byProfile, refused, escalations, dropped, elapsedMs: Date.now() - started };
}
