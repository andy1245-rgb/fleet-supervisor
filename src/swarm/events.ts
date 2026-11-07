// The append-only event log: one JSON object per line, `schema` on every row.
//
// The discipline is `src/metrics/schema.ts`'s — a versioned union, compile-guarded
// kind enums, and a parser that skips a row from another version rather than
// averaging it in — but the version is this runtime's own. Sharing `METRICS`'
// SCHEMA_VERSION would tie a supervisor's taxonomy to a swarm's, and the two move on
// different schedules.
//
// What the vocabulary is for (§6.1): a run must be reconstructible from the ledger
// plus the board *alone* — no prompts, no tails, no model output. So every row here is
// either a decision (op + pointer, never the text), a mutation (grant, claim,
// artifact, steer) or a failure (escalation, unhealthy). Two rows exist that a normal
// system would drop: `decision_asked`, written *before* the decode so a crash loses
// the outcome and never the question (§1.6 L3), and `escalation`, because the run's
// failure has to be as reconstructible as its success (§6.3).
//
// `EventLog` takes a sink rather than a path: only `store.ts` opens a file under the
// run root, which is what makes I1 checkable by inspection.

import type { ArtifactKind, EscalationAction, FailureCause, InstanceKey, NextActor, Role } from "./types.ts";

export const SWARM_SCHEMA = 1;

export const EVENT_KINDS = [
	"decision_asked",
	"profile_decision",
	"action",
	"grant_minted",
	"grant_revoked",
	"claim_acquired",
	"claim_denied",
	"claim_released",
	"claim_expired",
	"artifact_published",
	"steer_queued",
	"steer_delivered",
	"escalation",
	"profile_unhealthy",
	"tick",
] as const;
export type EventKind = (typeof EVENT_KINDS)[number];

interface Base {
	schema: typeof SWARM_SCHEMA;
	/** Monotonic per log, assigned here. Replay orders by it, never by file order. */
	seq: number;
	ts: string;
	runId: string;
}

/** Written before the sidecar is awaited. An unanswered ask is a fact; a missing row
 *  is a hole the replay cannot tell from a decision nobody wanted. */
export interface DecisionAskedEvent extends Base {
	t: "decision_asked";
	chainId: string;
	grant: string;
	node: string;
	profile: Role;
	instance: InstanceKey;
	depth: number;
	decidedBy: string;
}

export interface ProfileDecisionEvent extends Base {
	t: "profile_decision";
	chainId: string;
	grant: string;
	node: string;
	profile: Role;
	instance: InstanceKey;
	depth: number;
	/** The op, or null when the profile emitted no call at all. */
	op: string | null;
	/** The pointer the op named, never the text behind it. */
	arg: string;
	confidence: number;
	refused: boolean;
	suppressed: number;
	latencyMs: number;
	decidedBy: string;
	rung: string;
	/** What `needle_init` reported for this profile. Absent when the decision source is
	 *  not the engine (a hosted lane, a fake), because a made-up zero would read as drift. */
	prefixTokens?: number;
	/** Logged only when refused or suppressed (§6.4): there it is the diagnostic;
	 *  anywhere else it is the largest field with the least to say. */
	reasoning?: string;
}

/** One gated or ungated action's disposition. The row that makes "every action passed
 *  through one gate" a greppable fact. */
export interface ActionEvent extends Base {
	t: "action";
	chainId: string;
	grant: string;
	node: string;
	profile: Role;
	op: string;
	outcome: "performed" | "ungated" | "refused";
	cause?: FailureCause;
	detail?: string;
}

export interface GrantMintedEvent extends Base {
	t: "grant_minted";
	grant: string;
	parent: string | null;
	chainId: string;
	profile: Role;
	depth: number;
	budget: number;
	remaining: number;
	binRank: number;
	maySpawn: boolean;
	expiresAt: string;
}

export interface GrantRevokedEvent extends Base {
	t: "grant_revoked";
	grant: string;
	chainId: string;
	reason: "exhausted" | "ceiling" | "expired" | "abandoned" | "profile_degraded";
}

/** Four claim rows, one interface: they differ by which optional field is present,
 *  and splitting them would duplicate the path/holder pair four times. */
export interface ClaimEvent extends Base {
	t: "claim_acquired" | "claim_denied" | "claim_released" | "claim_expired";
	path: string;
	holder: string;
	claimId: string;
	expiresAt?: string;
	/** `claim_denied`: who holds it. */
	heldBy?: string;
	/** `claim_expired`: how stale the lease was. */
	ageMs?: number;
}

export interface ArtifactPublishedEvent extends Base {
	t: "artifact_published";
	artifact: string;
	kind: ArtifactKind;
	sha256: string;
	chain: string;
	depth: number;
	producer: Role;
	path: string | null;
	summary: string;
}

export interface SteerEvent extends Base {
	t: "steer_queued" | "steer_delivered";
	steerId: string;
	from: Role;
	to: Role;
	artifactIds: string[];
	words: number;
	/** `steer_delivered`: the loop iteration that was the instruction boundary. */
	boundary?: string;
}

export interface EscalationEvent extends Base {
	t: "escalation";
	chainId: string;
	profile: Role;
	from: string;
	to: NextActor;
	cause: FailureCause;
	action: EscalationAction;
	detail: string;
}

export interface UnhealthyEvent extends Base {
	t: "profile_unhealthy";
	profile: Role;
	instance: InstanceKey;
	cause: "engine_exit" | "timeout" | "spawn_failed" | "unhealthy";
	restartInMs: number;
}

export interface TickEvent extends Base {
	t: "tick";
	decisions: number;
	byProfile: Record<string, number>;
	refused: number;
	escalations: number;
	/** Requests the gate refused before a decode; the "ceilings are absences" count. */
	dropped: number;
	elapsedMs: number;
}

export type SwarmEvent =
	| DecisionAskedEvent
	| ProfileDecisionEvent
	| ActionEvent
	| GrantMintedEvent
	| GrantRevokedEvent
	| ClaimEvent
	| ArtifactPublishedEvent
	| SteerEvent
	| EscalationEvent
	| UnhealthyEvent
	| TickEvent;

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
/** What a caller supplies: the log stamps the four fields it owns. */
export type EventDraft = DistributiveOmit<SwarmEvent, "schema" | "seq" | "ts" | "runId">;

const KINDS: Readonly<Record<EventKind, true>> = {
	decision_asked: true,
	profile_decision: true,
	action: true,
	grant_minted: true,
	grant_revoked: true,
	claim_acquired: true,
	claim_denied: true,
	claim_released: true,
	claim_expired: true,
	artifact_published: true,
	steer_queued: true,
	steer_delivered: true,
	escalation: true,
	profile_unhealthy: true,
	tick: true,
};

export interface EventLogOptions {
	/** The only writer. `store.ts` passes `appendFileSync`; a test passes an array push. */
	sink: (line: string) => void;
	runId: string;
	/** Resume point for a log that already has rows. */
	startSeq?: number;
	now?: () => number;
}

export class EventLog {
	private readonly sink: (line: string) => void;
	private readonly runId: string;
	private readonly now: () => number;
	private seq: number;

	constructor(options: EventLogOptions) {
		this.sink = options.sink;
		this.runId = options.runId;
		this.now = options.now ?? Date.now;
		this.seq = options.startSeq ?? 0;
	}

	append(draft: EventDraft): SwarmEvent {
		this.seq += 1;
		const event = {
			schema: SWARM_SCHEMA,
			seq: this.seq,
			ts: new Date(this.now()).toISOString(),
			runId: this.runId,
			...draft,
		} as SwarmEvent;
		this.sink(eventLine(event));
		return event;
	}

	count(): number {
		return this.seq;
	}
}

export function eventLine(event: SwarmEvent): string {
	return `${JSON.stringify(event)}\n`;
}

/** A row from another version is counted and skipped, never coerced. */
export function parseEvent(value: unknown): SwarmEvent | undefined {
	if (typeof value !== "object" || value === null) return undefined;
	const row = value as Record<string, unknown>;
	if (row.schema !== SWARM_SCHEMA) return undefined;
	const kind = row.t;
	if (typeof kind !== "string" || !Object.hasOwn(KINDS, kind)) return undefined;
	if (typeof row.seq !== "number" || typeof row.ts !== "string" || typeof row.runId !== "string") return undefined;
	return row as unknown as SwarmEvent;
}

export interface ParsedLog {
	events: SwarmEvent[];
	/** Lines that were unparseable or from another schema. Quoted, not averaged. */
	skipped: number;
}

export function readEventText(text: string): ParsedLog {
	const events: SwarmEvent[] = [];
	let skipped = 0;
	for (const line of text.split("\n")) {
		if (line.trim() === "") continue;
		let raw: unknown;
		try {
			raw = JSON.parse(line);
		} catch {
			skipped += 1;
			continue;
		}
		const event = parseEvent(raw);
		if (event) events.push(event);
		else skipped += 1;
	}
	return { events, skipped };
}
