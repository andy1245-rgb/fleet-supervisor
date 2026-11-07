// The content-addressed board.
//
// Mirrored from `~/swarmHarness/src/blackboard/artifacts.ts` (`createBlackboard`):
// `publish` assigns `A{n}` and records the producer, and the read helpers are
// `byPath` and `isComplete`, kept under the same names so the sim's tests read as the
// file-backed store's tests. What is replaced is the storage and two fields the
// runtime needs (SA §5.2, scaffold §2.2): `sha256`, so a pointer can be verified
// after the fact, and `provenance.chain` (chainId, depth, budget) copied from the
// grant — never from the model, never from a record a model could have influenced.
//
// Content addressing is what makes a pointer honest: the bytes live at
// `blobs/<sha256>`, so two artifacts with the same content share one blob and an
// artifact id that names a blob cannot name a different blob later. Immutability is
// a property of the layout rather than a promise in a comment.
//
// This module is pure. `store.ts` owns the files.

import { createHash } from "node:crypto";
import type { StructuredRecord } from "./records.ts";
import type { ArtifactKind, InstanceKey, Role } from "./types.ts";

export interface Provenance {
	/** Who produced it, which process, and under which node of which chain. */
	producer: Role;
	instance: InstanceKey;
	nodeId: string;
	grantId: string;
	chainId: string;
	depth: number;
	budget: number;
}

export interface Artifact {
	artifactId: string;
	kind: ArtifactKind;
	/** The path this artifact is about, when the item had one. `null` for a fetch's
	 *  page and a search's query, which are about a source rather than a file. */
	path: string | null;
	sha256: string;
	/** ≤ 1KB: what a reader decides on before opening the blob. Copied from the
	 *  record, never generated (RG §8b rule 3). */
	summary: string;
	/** The structured handoff, when this artifact is one. A page or a report has none:
	 *  its content is the blob, and its pointer is the artifact id. */
	record: StructuredRecord | null;
	provenance: Provenance;
	publishedAt: number;
}

export const SUMMARY_MAX = 1024;

export function sha256(bytes: string | Uint8Array): string {
	return createHash("sha256").update(bytes).digest("hex");
}

export function nextArtifactId(count: number): string {
	return `A${count + 1}`;
}

/** The summary is *copied* from the record's own fields — an id, a status, a path —
 *  never written by a model. A derived value is never emitted, it is copied. */
export function summaryOf(record: StructuredRecord | null, fallback = ""): string {
	const text = record === null ? fallback : renderSummary(record);
	return text.length <= SUMMARY_MAX ? text : text.slice(0, SUMMARY_MAX);
}

function renderSummary(record: StructuredRecord): string {
	switch (record.kind) {
		case "return":
			return [`${record.itemId} ${record.status}`, record.code, record.artifactIds.join(",")]
				.filter((part) => part !== null && part !== "")
				.join(" ");
		case "assignment":
			return `${record.itemId} ${record.task} ${record.path ?? record.sourceId ?? ""}`.trim();
		case "brief": {
			const filled = Object.values(record.status).filter((s) => s === "FILLED").length;
			const question = record.question ? ` q=${record.question.qtype}:${record.question.slot}` : "";
			return `${record.briefId} cites=${record.cites.length} filled=${filled}${question}`;
		}
	}
}

export function findById(artifacts: readonly Artifact[], artifactId: string): Artifact | undefined {
	return artifacts.find((artifact) => artifact.artifactId === artifactId);
}

export function byPath(artifacts: readonly Artifact[], path: string): readonly Artifact[] {
	return artifacts.filter((artifact) => artifact.path === path);
}

/** Has this work item produced a return? The board's notion of completion is a
 *  return record for the item, not a rendered claim from any party. */
export function isComplete(artifacts: readonly Artifact[], workId: string): boolean {
	return artifacts.some((artifact) => artifact.record?.kind === "return" && artifact.record.itemId === workId);
}

/** Resolve an argument to the artifact it names. §2.4 step 3: a pointer that does not
 *  resolve is a refusal, not an empty read — the difference between "the model
 *  hallucinated an id" and "the board lost an artifact" is the whole diagnosis. */
export function resolve(artifacts: readonly Artifact[], pointer: string): Artifact | undefined {
	const byId = findById(artifacts, pointer);
	if (byId) return byId;
	const onPath = byPath(artifacts, pointer);
	return onPath.length > 0 ? onPath[onPath.length - 1] : undefined;
}
