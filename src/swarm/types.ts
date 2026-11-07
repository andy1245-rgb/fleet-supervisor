// The runtime's shared vocabulary: which profile, which process, what it emitted,
// what a failure is called, and who acts next after one.
//
// Deliberately absent: the tool catalogues (they are `profiles.tools()` — a second
// copy here would be a second definition of the grammar), the grant arithmetic
// (`grant.ts`), and the claim/artifact records (`claims.ts`, `artifacts.ts`).
//
// The process model is a hard constraint, not a convention: `needle_init` installs
// the grammar as process-global state and a second call *replaces* the first, so
// every (role, licence) pair is a separate process. `INSTANCES` is therefore the
// unit of identity everywhere in this directory — an `Action` names the instance
// that answered it, and the gate checks the op against *that* instance's catalogue.

import type { StructuredRecord } from "./records.ts";

export const ROLES = ["hi", "orch", "worker", "fetch", "search"] as const;
export type Role = (typeof ROLES)[number];

/** A leaf node has no `spawn` production at all; only `orch` has two catalogues. */
export type Licence = "leaf" | "inner";

export const INSTANCES = ["hi", "orch.leaf", "orch.inner", "worker", "fetch", "search"] as const;
export type InstanceKey = (typeof INSTANCES)[number];

export function roleOf(instance: InstanceKey): Role {
	const dot = instance.indexOf(".");
	return (dot === -1 ? instance : instance.slice(0, dot)) as Role;
}

export function licenceOf(instance: InstanceKey): Licence {
	return instance === "orch.inner" ? "inner" : "leaf";
}

/** The process a node routes to. The licence is chosen from the grant *before* the
 *  decode and cannot be revisited after it (`hi-orchestrator.md` §7.4). */
export function instanceFor(role: Role, licence: Licence): InstanceKey {
	return role === "orch" && licence === "inner" ? "orch.inner" : role === "orch" ? "orch.leaf" : role;
}

export type ArtifactKind = "brief" | "assignment" | "return" | "page" | "query" | "report";

/** One decode's result. This is the needle sidecar's reply shape (`needle.ts`),
 *  with `args` instead of a single `argument` because the grammars have tools with
 *  two and three arguments and a call is what the gate must admit. */
export interface ProfileReply {
	/** null when the profile emitted no call at all: the engine suppressed it, the
	 *  JSON did not parse, or the model declined. */
	op: string | null;
	/** Tool arguments. Every one is a string by grammar: ids, enum members, spans. */
	args: Record<string, string>;
	confidence: number;
	refused: boolean;
	/** Grounding-gate suppressions the engine reported for this decode. */
	suppressed: number;
	latencyMs: number;
	reasoning?: string;
}

/** A refusal is not an error — it is the escalation signal (§4.1), so it gets a
 *  constructor rather than being spelled as an empty reply at each call site. */
export function refusal(latencyMs = 0, suppressed = 0): ProfileReply {
	return { op: null, args: {}, confidence: 0, refused: true, suppressed, latencyMs };
}

/** What a profile's call becomes once the dispatcher has attached the context the
 *  model cannot influence: its chain, its grant, and the record it hands on. */
export interface Action {
	chainId: string;
	grantId: string;
	profile: Role;
	/** The process that answered. The licence check reads this, never the op. */
	instance: InstanceKey;
	nodeId: string;
	op: string;
	args: Readonly<Record<string, string>>;
	/** The structured record this action announces, built by the dispatcher from
	 *  its work graph. The model supplies the pointer; it never supplies a record
	 *  (`runtime-scaffold.md` §2.4 step 5). Required when the op's effect publishes. */
	payload?: { kind: ArtifactKind; record: StructuredRecord | null; summary?: string };
	/** Who a `steer` is addressed to, from the dispatcher's graph and never from an
	 *  argument: no catalogue in the profile set has a role argument, so a profile
	 *  cannot address another profile (§2.4). */
	route?: Role;
}

/** What a performed action changed. Ids only: the gate hands back pointers, and no
 *  caller gets to mutate the board itself. */
export interface Effect {
	artifactId?: string;
	claimId?: string;
	steerId?: string;
	/** Child grants minted by a `spawn`. */
	grants?: readonly string[];
	/** Grant revoked by an `abandon` or by exhaustion. */
	revoked?: string;
}

export type DispatchOutcome =
	| { kind: "performed"; nodeId: string; op: string; gated: boolean; effect: Effect }
	| { kind: "ungated"; nodeId: string; op: string }
	| {
			kind: "refused";
			nodeId: string;
			op: string;
			cause: FailureCause;
			detail: string;
			/** Never absent: a refusal with no next actor is how a run dies silently. */
			escalation: Escalation;
	  };

/** The seven conditions the failure matrix names, plus the two the grant ledger
 *  adds (a spent budget, a grant that outlived its dispatcher). */
export const FAILURE_CAUSES = [
	"refusal",
	"unparseable",
	"suppressed",
	"contested_claim",
	"chain_ceiling",
	"bin_ceiling",
	"budget",
	"grant_expired",
	"unavailable",
] as const;
export type FailureCause = (typeof FAILURE_CAUSES)[number];

export const NEXT_ACTORS = [
	"ladder",
	"hosted",
	"oneB",
	"requestor",
	"parent",
	"orchestrator",
	"profile",
	"dispatcher",
	"corpus_owner",
	"human",
] as const;
export type NextActor = (typeof NEXT_ACTORS)[number];

export const ESCALATION_ACTIONS = [
	"reask_once",
	"escalate_lane",
	"synthesize_block",
	"synthesize_drop",
	"partial_result",
	"reroute",
	"park",
	"revoke_grant",
	"respawn",
	"flag_human",
] as const;
export type EscalationAction = (typeof ESCALATION_ACTIONS)[number];

/** One failure's disposition. `alsoNotifies` exists for the grounding-gate row,
 *  whose runtime behaviour is the refusal's but whose *fix* belongs to the corpus
 *  owner (§4.2 row 3) — the runtime can only report that failure, never repair it. */
export interface Escalation {
	cause: FailureCause;
	role: Role;
	nextActor: NextActor;
	action: EscalationAction;
	detail: string;
	alsoNotifies?: NextActor;
}
