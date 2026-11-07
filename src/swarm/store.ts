// The run root. **The only module in this directory that opens a file** — which is
// what makes `runtime-scaffold.md`'s invariant I1 ("no other module writes to
// `<runRoot>/.swarm/`") checkable by inspection, and by a test that greps this
// directory's imports.
//
// Layout (§2.2), with one substitution that content addressing forces:
//
//   <runRoot>/.swarm/
//     board/<artifactId>.json          the record: kind, path, sha256, summary, provenance
//     blobs/<sha256>.blob              the bytes, immutable and deduped by content
//     claims/<path-slug>.<holder>.claim.json
//     relay/outbox/<steerId>.json      envelopes awaiting an instruction boundary
//     ledger/events.jsonl              append-only, one JSON object per line
//
// The spec names the blob `board/<artifactId>.blob`; storing it under the digest
// instead is what makes "an artifact id cannot name different bytes later" a property
// of the layout rather than a promise. The record is the pointer, and it is the thing
// a handoff carries.
//
// Every mutation appends its own row before returning. That is deliberate: a mutation
// with no row is the one failure mode a ledger cannot detect afterwards.

import {
	appendFileSync,
	existsSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { nextArtifactId, sha256, summaryOf, type Artifact, type Provenance } from "./artifacts.ts";
import { decideClaim, claimFile, sweepable, type ClaimDecision, type ClaimRecord } from "./claims.ts";
import { EventLog, readEventText, type SwarmEvent } from "./events.ts";
import type { SteerEnvelope } from "./records.ts";
import type { ArtifactKind, Role } from "./types.ts";
import type { StructuredRecord } from "./records.ts";

export interface SwarmStoreOptions {
	/** The run root. `.swarm/` is created beneath it. */
	root: string;
	runId?: string;
	now?: () => number;
}

export interface PublishInput {
	kind: ArtifactKind;
	path: string | null;
	record: StructuredRecord | null;
	/** The artifact's bytes. A record-only handoff still has bytes: its JSON. */
	bytes: string;
	provenance: Provenance;
	/** Required when `record` is null (a page's or a report's one line). */
	summary?: string;
}

export class SwarmStore {
	readonly root: string;
	readonly runId: string;
	readonly log: EventLog;
	private readonly now: () => number;
	private readonly boardDir: string;
	private readonly blobDir: string;
	private readonly claimDir: string;
	private readonly outboxDir: string;
	private readonly ledgerFile: string;

	constructor(options: SwarmStoreOptions) {
		this.root = join(options.root, ".swarm");
		this.now = options.now ?? Date.now;
		this.runId = options.runId ?? "r1";
		this.boardDir = join(this.root, "board");
		this.blobDir = join(this.root, "blobs");
		this.claimDir = join(this.root, "claims");
		this.outboxDir = join(this.root, "relay", "outbox");
		this.ledgerFile = join(this.root, "ledger", "events.jsonl");
		for (const dir of [this.boardDir, this.blobDir, this.claimDir, this.outboxDir, join(this.root, "ledger")]) {
			mkdirSync(dir, { recursive: true });
		}
		this.log = new EventLog({
			runId: this.runId,
			now: this.now,
			startSeq: this.countRows(),
			sink: (line) => appendFileSync(this.ledgerFile, line),
		});
	}

	// ------------------------------------------------------------------ board

	publish(input: PublishInput): Artifact {
		const digest = sha256(input.bytes);
		const blob = join(this.blobDir, `${digest}.blob`);
		if (!existsSync(blob)) writeFileSync(blob, input.bytes);
		const artifact: Artifact = {
			artifactId: nextArtifactId(this.artifacts().length),
			kind: input.kind,
			path: input.path,
			sha256: digest,
			summary: summaryOf(input.record, input.summary ?? ""),
			record: input.record,
			provenance: input.provenance,
			publishedAt: this.now(),
		};
		writeAtomically(join(this.boardDir, `${artifact.artifactId}.json`), JSON.stringify(artifact));
		this.log.append({
			t: "artifact_published",
			artifact: artifact.artifactId,
			kind: artifact.kind,
			sha256: artifact.sha256,
			chain: artifact.provenance.chainId,
			depth: artifact.provenance.depth,
			producer: artifact.provenance.producer,
			path: artifact.path,
			summary: artifact.summary,
		});
		return artifact;
	}

	artifacts(): readonly Artifact[] {
		const names = readdirSync(this.boardDir).filter((name) => name.endsWith(".json"));
		const parsed: Artifact[] = [];
		for (const name of names) {
			try {
				parsed.push(JSON.parse(readFileSync(join(this.boardDir, name), "utf8")) as Artifact);
			} catch {
				// A half-written record is not a record. Atomic rename means this should not
				// happen; reading around it keeps one bad file from blinding the run.
			}
		}
		return parsed.sort((a, b) => idNumber(a.artifactId) - idNumber(b.artifactId));
	}

	blob(digest: string): string | undefined {
		const path = join(this.blobDir, `${digest}.blob`);
		return existsSync(path) ? readFileSync(path, "utf8") : undefined;
	}

	// ----------------------------------------------------------------- claims

	claims(): readonly ClaimRecord[] {
		const names = readdirSync(this.claimDir).filter((name) => name.endsWith(".claim.json"));
		const records: ClaimRecord[] = [];
		for (const name of names) {
			try {
				records.push(JSON.parse(readFileSync(join(this.claimDir, name), "utf8")) as ClaimRecord);
			} catch {
				/* a corrupt lease file blocks nobody; the sweep will not see it either */
			}
		}
		return records;
	}

	/** Deny-don't-block: a denied claim is returned, never retried and never thrown. */
	acquire(request: { path: string; holder: string; intent: string; ttlMs?: number }): ClaimDecision {
		const now = this.now();
		const records = this.claims();
		const decision = decideClaim(records, { ...request, now });
		if (!decision.granted) {
			this.log.append({
				t: "claim_denied",
				path: request.path,
				holder: request.holder,
				claimId: decision.claimId,
				heldBy: decision.heldBy,
				expiresAt: new Date(decision.expiresAt).toISOString(),
			});
			return decision;
		}
		if (!decision.renewed) {
			const record: ClaimRecord = {
				claimId: decision.claimId,
				path: request.path,
				holder: request.holder,
				intent: request.intent,
				acquiredAt: now,
				expiresAt: decision.expiresAt,
				state: "held",
			};
			const file = join(this.claimDir, claimFile(request.path, request.holder));
			const body = JSON.stringify(record);
			try {
				// `wx` is O_EXCL: a same-holder re-acquire over its own released record is the
				// one case where the exclusive create is the wrong tool for a file we own.
				writeFileSync(file, body, { flag: "wx" });
			} catch (error) {
				if (!isEEXIST(error)) throw error;
				writeAtomically(file, body);
			}
		}
		this.log.append({
			t: "claim_acquired",
			path: request.path,
			holder: request.holder,
			claimId: decision.claimId,
			expiresAt: new Date(decision.expiresAt).toISOString(),
		});
		return decision;
	}

	/** The pre-commit guard (§2.3 step 2): the only thing standing between an expired
	 *  lease and a stomped file. `none` means nothing claimed the path, which is not a
	 *  conflict — advisory means advisory. */
	guard(path: string, holder: string): { ok: boolean; heldBy?: string } {
		const active = this.claims().find((record) => record.path === path && record.state === "held" && record.expiresAt > this.now());
		if (!active) return { ok: true };
		return active.holder === holder ? { ok: true } : { ok: false, heldBy: active.holder };
	}

	release(path: string): ClaimRecord | undefined {
		const active = this.claims().find(
			(record) => record.path === path && record.state === "held" && record.expiresAt > this.now(),
		);
		if (!active) return undefined;
		const released: ClaimRecord = { ...active, state: "released", releasedAt: this.now() };
		writeAtomically(join(this.claimDir, claimFile(active.path, active.holder)), JSON.stringify(released));
		this.log.append({ t: "claim_released", path: active.path, holder: active.holder, claimId: active.claimId });
		return released;
	}

	/** Off the claim path, once per loop iteration. The crashed-holder path. */
	sweep(): readonly ClaimRecord[] {
		const now = this.now();
		const expiring = sweepable(this.claims(), now);
		for (const record of expiring) {
			const expired: ClaimRecord = { ...record, state: "expired" };
			writeAtomically(join(this.claimDir, claimFile(record.path, record.holder)), JSON.stringify(expired));
			this.log.append({
				t: "claim_expired",
				path: record.path,
				holder: record.holder,
				claimId: record.claimId,
				ageMs: now - record.acquiredAt,
			});
		}
		return expiring;
	}

	// ------------------------------------------------------------------ relay

	queueSteer(envelope: SteerEnvelope): SteerEnvelope {
		writeAtomically(join(this.outboxDir, `${envelope.steerId}.json`), JSON.stringify(envelope));
		this.log.append({
			t: "steer_queued",
			steerId: envelope.steerId,
			from: envelope.from,
			to: envelope.to,
			artifactIds: [...envelope.artifactIds],
			words: envelope.words,
		});
		return envelope;
	}

	/** FIFO per target, released only at an instruction boundary (§2.4 step 6). */	drainSteers(to: Role, boundary: string): readonly SteerEnvelope[] {
		const names = readdirSync(this.outboxDir).filter((name) => name.endsWith(".json"));
		const queued: SteerEnvelope[] = [];
		for (const name of names) {
			const file = join(this.outboxDir, name);
			let envelope: SteerEnvelope;
			try {
				envelope = JSON.parse(readFileSync(file, "utf8")) as SteerEnvelope;
			} catch {
				rmSync(file);
				continue;
			}
			if (envelope.to !== to) continue;
			rmSync(file);
			queued.push({ ...envelope, boundary });
			this.log.append({
				t: "steer_delivered",
				steerId: envelope.steerId,
				from: envelope.from,
				to: envelope.to,
				artifactIds: [...envelope.artifactIds],
				words: envelope.words,
				boundary,
			});
		}
		return queued.sort((a, b) => a.steerId.localeCompare(b.steerId, "en"));
	}

	/** A steer id that stays unique across a restart: derived from the ledger rather
	 *  than a counter in memory, because a restarted dispatcher re-queues into the same
	 *  outbox and a repeat id would overwrite an undelivered envelope. */
	nextSteerSeq(): number {
		return this.events().filter((event) => event.t === "steer_queued").length + 1;
	}

	// ------------------------------------------------------------------ ledger

	events(): readonly SwarmEvent[] {
		return readEventFile(this.ledgerFile);
	}

	private countRows(): number {
		return this.events().length;
	}
}

export function readEventFile(path: string): readonly SwarmEvent[] {
	if (!existsSync(path)) return [];
	return readEventText(readFileSync(path, "utf8")).events;
}

function writeAtomically(path: string, body: string): void {
	const tmp = `${path}.${process.pid}.tmp`;
	writeFileSync(tmp, body);
	renameSync(tmp, path);
}

function isEEXIST(error: unknown): boolean {
	return typeof error === "object" && error !== null && (error as NodeJS.ErrnoException).code === "EEXIST";
}

function idNumber(artifactId: string): number {
	const n = Number.parseInt(artifactId.slice(1), 10);
	return Number.isFinite(n) ? n : 0;
}
