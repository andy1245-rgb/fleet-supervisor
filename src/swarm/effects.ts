// What the gate performs once it has admitted an action.
//
// Admitting and performing are two responsibilities, so they are two files. `gate.ts`
// decides whether an action may happen and what happens when it may not; this file does
// the happening, and every ordering that matters is recorded where it runs:
//
//   * `work` takes the claim **before** it publishes the assignment, because a worker
//     that spends a decode on a path another node owns is 23–36 core-seconds thrown away;
//   * `work` queues the steer **after** the artifact exists, because an envelope that
//     points at nothing is not a handoff;
//   * `publish` releases the claim the dispatcher took, on the same reasoning in reverse:
//     the component that knows the path is the component that writes, and the one that
//     knows the item is finished is the one that lets go of it.
//
// A refusal thrown from here is a *decision* — contested claim, ceiling, missing record —
// and the gate turns it into a row plus an escalation. It is never an exception a caller
// has to interpret.

import { resolve as resolveArtifact } from "./artifacts.ts";
import { claimLine, ttlFor } from "./claims.ts";
import { planSpawn, type Grant, type GrantBook } from "./grant.ts";
import { capsOf, type Ceilings, type ProfileTable } from "./profiles.ts";
import {
	makeSteer,
	roleForTask,
	type AssignmentRecord,
	type SteerEnvelope,
	type StructuredRecord,
} from "./records.ts";
import type { SwarmStore } from "./store.ts";
import type { Action, Effect, FailureCause } from "./types.ts";

/** Thrown inside an effect and caught at the gate's entry point, so an effect reads as a
 *  sequence rather than a pyramid of early returns. */
export class Refusal extends Error {
	override readonly cause: FailureCause;
	constructor(cause: FailureCause, detail: string) {
		super(detail);
		this.cause = cause;
	}
}

export interface EffectContext {
	store: SwarmStore;
	grants: GrantBook;
	profiles: ProfileTable;
	ceilings: Ceilings;
	now: () => number;
}

/** The shared mutation an op asks for. `none` is a report: a row and nothing else. */
export type EffectKind = "none" | "spawn" | "work" | "artifact" | "steer" | "revoke";

export async function perform(
	effect: EffectKind,
	action: Action,
	grant: Grant | undefined,
	ctx: EffectContext,
): Promise<Effect | undefined> {
	switch (effect) {
		case "none":
			return undefined;
		case "spawn":
			return await spawnChildren(action, requireGrant(grant), ctx);
		case "work":
			return await dispatchWork(action, requireGrant(grant), ctx);
		case "artifact":
			return publishArtifact(action, requireGrant(grant), ctx);
		case "steer":
			return steerToArtifact(action, ctx);
		case "revoke":
			return abandonNode(requireGrant(grant), ctx);
	}
}

/** The ceiling, in two halves: `planSpawn` contributes the arithmetic and the bin lattice,
 *  `profiles.common.may_spawn` contributes the verdict. The model supplied `k` and a bin
 *  name; nothing else, and neither a depth nor a budget transits it. */
async function spawnChildren(action: Action, grant: Grant, ctx: EffectContext): Promise<Effect> {
	const caps = capsOf(ctx.profiles, action.profile);
	if (!grant.maySpawn) {
		// A stale grant (§4.2 row 5). Decided at mint time, so this is not a re-decision: the
		// node is past a ceiling it was already told about.
		const cause: FailureCause = grant.depth >= caps.chainCeiling ? "chain_ceiling" : "bin_ceiling";
		throw new Refusal(
			cause,
			`grant ${grant.grantId} may not spawn: depth ${grant.depth}/${caps.chainCeiling}, remaining ${grant.remaining}`,
		);
	}
	const plan = planSpawn(grant, {
		k: Number.parseInt(action.args.k ?? "", 10),
		childBin: action.args.binId ?? "",
		chainCeiling: caps.chainCeiling,
		binCeiling: caps.binCeiling,
	});
	if (!plan.ok) throw new Refusal(plan.cause, plan.detail);
	const delegation = await ctx.ceilings.maySpawn(action.profile, grant.depth, grant.remaining, plan.childBudget);
	if (!delegation.allowed) {
		throw new Refusal(delegation.reason.startsWith("chain ceiling") ? "chain_ceiling" : "bin_ceiling", delegation.reason);
	}

	const children: string[] = [];
	for (let index = 0; index < plan.k; index += 1) {
		const child = ctx.grants.mint({
			chainId: action.chainId,
			profile: action.profile,
			agentId: `${action.chainId}/${action.nodeId}.${index + 1}`,
			depth: plan.childDepth,
			budget: plan.childBudget,
			bin: plan.childBin,
			chainCeiling: caps.chainCeiling,
			parent: grant,
			now: ctx.now(),
		});
		children.push(child.grantId);
		ctx.store.log.append({
			t: "grant_minted",
			grant: child.grantId,
			parent: grant.grantId,
			chainId: child.chainId,
			profile: child.profile,
			depth: child.depth,
			budget: child.budget,
			remaining: child.remaining,
			binRank: child.binRank,
			maySpawn: child.maySpawn,
			expiresAt: new Date(child.expiresAt).toISOString(),
		});
	}
	// A node spawns once: after the allocation `maySpawn` is false for good, which also
	// routes it to the leaf catalogue on its next decode (§3.4).
	ctx.grants.markSpawned(grant.grantId);
	return { grants: children };
}

async function dispatchWork(action: Action, grant: Grant, ctx: EffectContext): Promise<Effect> {
	const path = action.args.path;
	if (!path) throw new Refusal("unparseable", "dispatch names no path to claim");
	const target = assignmentOf(action);
	if (target.path !== path) {
		throw new Refusal("unparseable", `dispatch's path ${path} is not the item's path ${String(target.path)}`);
	}
	const holder = holderId(action);
	const claim = ctx.store.acquire({ path, holder, intent: `${action.profile} ${target.itemId}`, ttlMs: ttlFor("write") });
	if (!claim.granted) {
		// Not an error and not retried: the denial becomes a field of the profile's next
		// state, because the holder and the deadline are facts a model can act on.
		throw new Refusal("contested_claim", claimLine(claim));
	}
	const artifact = publishRecord(action, grant, target, path, ctx);
	const envelope = makeSteer(
		{
			from: action.profile,
			to: roleForTask(target.task),
			artifactIds: [artifact.artifactId],
			// Copied from the record's own fields, never composed: a steer carries a pointer
			// and one line, and the line is not prose.
			intent: artifact.summary,
			issuedAt: ctx.now(),
		},
		ctx.store.nextSteerSeq(),
	);
	ctx.store.queueSteer(envelope);
	return { artifactId: artifact.artifactId, claimId: claim.claimId, steerId: envelope.steerId };
}

function publishArtifact(action: Action, grant: Grant, ctx: EffectContext): Effect {
	const payload = action.payload;
	if (!payload) throw new Refusal("unparseable", `${action.op} carried no record to publish`);
	const path = payload.record?.kind === "assignment" ? payload.record.path : (action.args.path ?? null);
	const artifact = publishRecord(action, grant, payload.record, path, ctx, payload.summary);
	if (action.op === "submit" || action.op === "block" || action.op === "drop") {
		// The dispatcher releases what the dispatcher claimed; a worker never acquires a
		// claim and never releases one (RG §11.3's seam, applied in both directions).
		releaseItem(action.args.item, ctx);
	}
	return { artifactId: artifact.artifactId };
}

function steerToArtifact(action: Action, ctx: EffectContext): Effect {
	const to = action.route;
	if (!to) throw new Refusal("unparseable", "a steer arrives with no route: the dispatcher supplies it");
	const pointer = action.args.artifactIds ?? "";
	const target = resolveArtifact(ctx.store.artifacts(), pointer);
	if (!target) throw new Refusal("unparseable", `steer points at ${pointer}, which is not on the board`);
	const envelope: SteerEnvelope = makeSteer(
		{
			from: action.profile,
			to,
			artifactIds: [target.artifactId],
			intent: `${target.artifactId} ${target.kind} ${target.summary}`.trim(),
			issuedAt: ctx.now(),
		},
		ctx.store.nextSteerSeq(),
	);
	ctx.store.queueSteer(envelope);
	return { steerId: envelope.steerId, artifactId: target.artifactId };
}

function abandonNode(grant: Grant, ctx: EffectContext): Effect {
	revokeGrant(grant, "abandoned", ctx);
	return { revoked: grant.grantId };
}

function publishRecord(
	action: Action,
	grant: Grant,
	record: StructuredRecord | null,
	path: string | null,
	ctx: EffectContext,
	summary?: string,
): { artifactId: string; summary: string } {
	const artifact = ctx.store.publish({
		kind: action.payload?.kind ?? "return",
		path,
		record,
		bytes: JSON.stringify(record ?? { summary: summary ?? "" }),
		summary,
		provenance: {
			producer: action.profile,
			instance: action.instance,
			nodeId: action.nodeId,
			grantId: grant.grantId,
			chainId: action.chainId,
			depth: grant.depth,
			budget: grant.remaining,
		},
	});
	return { artifactId: artifact.artifactId, summary: artifact.summary };
}

function releaseItem(itemId: string | undefined, ctx: EffectContext): void {
	if (!itemId) return;
	const assignment = ctx.store
		.artifacts()
		.find((artifact) => artifact.record?.kind === "assignment" && artifact.record.itemId === itemId);
	if (assignment?.path) ctx.store.release(assignment.path);
}

/** Revocation is one row and one transition, wherever it is triggered from: an `abandon`,
 *  a spent budget, a ceiling the chain cannot cross, an expiry across a restart. */
export function revokeGrant(
	grant: Grant,
	reason: "abandoned" | "exhausted" | "expired" | "ceiling" | "profile_degraded",
	ctx: EffectContext,
): void {
	ctx.grants.revoke(grant.grantId);
	ctx.store.log.append({ t: "grant_revoked", grant: grant.grantId, chainId: grant.chainId, reason });
}

export function holderId(action: Action): string {
	return `${action.chainId}/${action.nodeId}`;
}

function requireGrant(grant: Grant | undefined): Grant {
	if (!grant) throw new Refusal("grant_expired", "the action's grant is not in the book");
	return grant;
}

function assignmentOf(action: Action): AssignmentRecord & { path: string } {
	const record = action.payload?.record;
	if (!record || record.kind !== "assignment") {
		throw new Refusal("unparseable", "dispatch carries no assignment record");
	}
	if (!record.path) throw new Refusal("unparseable", "a dispatched assignment names no path");
	return { ...record, path: record.path };
}
