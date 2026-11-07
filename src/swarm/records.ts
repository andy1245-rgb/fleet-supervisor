// Handoffs: a pointer plus a structured record, never a transcript.
//
// The three payloads are `role-grammars.md` §11.1 verbatim — they are what crosses a
// role boundary, and the measurement that justifies them is on §11.2 (155 tokens per
// round against 627 for the transcript form). Nothing in this file is allowed to grow
// a prose field: the instant a record carries a summary the record *is* a transcript.
//
// `wordsOf`/`MAX_STEER_WORDS`/`makeSteer` are mirrored from
// `~/swarmHarness/src/relay/envelope.ts`, which is already exactly the right shape:
// deterministic (no clock, no RNG) and with no content field, so "no artifact bytes
// inside an envelope" is a property of the type rather than a rule someone remembers.
// One addition: `issuedAt` is passed in, because this runtime has no step counter and
// wall clock is the only quantity a restart shares with its predecessor.

import type { Role } from "./types.ts";

export type Slot = "ACT" | "TARGET" | "LOCUS" | "CONSTRAINT" | "ACCEPTANCE";
export type QType = "Q_SCOPE" | "Q_REFERENT" | "Q_ACCEPTANCE";
export type SlotStatus = "FILLED" | "ABSENT" | "BLOCKED";

/** HI → orchestrator. Carries spans and slot states; never the human's words, never
 *  the buffer, never a rendered sentence. */
export interface BriefRecord {
	kind: "brief";
	briefId: string;
	/** Which human message; σ is versioned against it. */
	msgId: string;
	cites: Array<{ segId: string; slot: Slot; textStart: number; textEnd: number }>;
	status: Record<Slot, SlotStatus>;
	absentWhy: Partial<Record<Slot, "not_in_message" | "unresolved">>;
	question: { qtype: QType; slot: Slot } | null;
}

/** orchestrator → worker. Nothing a worker can use to guess at slots it does not
 *  serve. `task` is RG's `kind` field renamed: a record already has a `kind`, and a
 *  row cannot be two things. */
export interface AssignmentRecord {
	kind: "assignment";
	itemId: string;
	briefId: string;
	task: "read" | "write" | "verify" | "fetch" | "search";
	path: string | null;
	/** s3 for a fetch, a query id for a search. */
	sourceId: string | null;
	slots: { goal: string; done: string | null; limit: string | null };
	depth: number;
}

/** worker → orchestrator. A row, not a report: the same work as prose measures 90
 *  tokens, as a row it measures 5. */
export interface ReturnRecord {
	kind: "return";
	itemId: string;
	status: "done" | "blocked" | "partial";
	artifactIds: string[];
	/** The span from the state that satisfied `done`. */
	evidence: { segId: string } | null;
	/** Block code, or null. */
	code: string | null;
	tries: number;
}

export type StructuredRecord = BriefRecord | AssignmentRecord | ReturnRecord;

/** Inbound word cap for one steer. The relay refuses rather than trims, because a
 *  trimmed instruction is an instruction nobody wrote. */
export const MAX_STEER_WORDS = 120;

export function wordsOf(intent: string): number {
	const trimmed = intent.trim();
	return trimmed === "" ? 0 : trimmed.split(/\s+/).length;
}

/** A steer is a pointer plus a restatement of the record's intent. It has no content
 *  field, so it cannot carry an artifact, a state block, or a sentence a model wrote. */
export interface SteerEnvelope {
	steerId: string;
	from: Role;
	to: Role;
	artifactIds: readonly string[];
	intent: string;
	words: number;
	issuedAt: number;
	/** The loop iteration that released it; absent until delivered (§2.4 step 6). */
	boundary?: string;
}

/** Deterministic: every field comes from the arguments, and `seq` is the monotonic
 *  idempotency key. Throws above the word cap — an intent comes from a record the
 *  dispatcher built, so an over-cap intent is our bug and must be loud, not trimmed. */
export function makeSteer(
	input: { from: Role; to: Role; artifactIds: readonly string[]; intent: string; issuedAt: number },
	seq: number,
): SteerEnvelope {
	const words = wordsOf(input.intent);
	if (words > MAX_STEER_WORDS) {
		throw new Error(`steer intent is ${words} words; the relay refuses above ${MAX_STEER_WORDS}`);
	}
	return {
		steerId: `S${seq}`,
		from: input.from,
		to: input.to,
		artifactIds: [...input.artifactIds],
		intent: input.intent,
		words,
		issuedAt: input.issuedAt,
	};
}

/** RG §2.2's role table: which role a handoff of this kind is addressed to. It is a
 *  table and not an argument because no catalogue in the profile set contains a role
 *  argument — a profile cannot address another profile (§2.4). */
export function roleForTask(task: AssignmentRecord["task"]): Role {
	switch (task) {
		case "fetch":
			return "fetch";
		case "search":
			return "search";
		case "read":
		case "write":
		case "verify":
			return "worker";
	}
}
