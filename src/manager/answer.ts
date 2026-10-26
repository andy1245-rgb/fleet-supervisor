// The answer channel for the ask gate, and the owner of `<state>/asks.jsonl`.
//
// `tick.ts` parks an action that the policy says must be asked about, appends one
// line here, and notifies with the id. This CLI is how the operator releases it:
//
//   node src/manager/answer.ts <id> yes|no ["replacement text"]
//
// The log is append-only, which is what makes a held action survive the
// supervisor dying: the record on disk is the whole of the pending state, so any
// later process can apply it. The last line for an id is that id's state, so
// answering the same id twice is refused instead of applied twice.
//
// Telegram replies are deliberately not polled yet — the CLI is the answer
// channel, and the notification says so.

import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { isOp, type Op } from "../decision/types.ts";
import { readClaims, writeClaim, type Claim } from "../fleet/registry.ts";
import { herdrPort } from "../herdr/cli.ts";
import type { HerdrPort } from "../herdr/types.ts";
import type { AskRecord, Fork } from "./ask.ts";
import { loadConfig, type Config } from "./config.ts";

function str(value: unknown, fallback = ""): string {
	return typeof value === "string" ? value : fallback;
}

function toForks(raw: unknown): Fork[] {
	if (!Array.isArray(raw)) return [];
	const out: Fork[] = [];
	for (const entry of raw) {
		if (typeof entry !== "object" || entry === null) continue;
		const r = entry as Record<string, unknown>;
		const reason = str(r.reason);
		if (!reason) continue;
		out.push({ reason, severity: r.severity === "hard" ? "hard" : "soft" });
	}
	return out;
}

/** The file is editable by hand, so every field is re-checked on the way in. */
function toRecord(raw: unknown): AskRecord | undefined {
	if (typeof raw !== "object" || raw === null) return undefined;
	const r = raw as Record<string, unknown>;
	const id = str(r.id);
	const paneId = str(r.paneId);
	if (!id || !paneId || !isOp(r.op)) return undefined;
	const record: AskRecord = {
		id,
		ts: str(r.ts),
		paneId,
		group: str(r.group),
		op: r.op,
		argument: str(r.argument),
		why: str(r.why),
		forks: toForks(r.forks),
		cwd: str(r.cwd),
		status: r.status === "answered" ? "answered" : "pending",
	};
	if (typeof r.answeredAt === "string") record.answeredAt = r.answeredAt;
	if (r.answer === "yes" || r.answer === "no") record.answer = r.answer;
	if (typeof r.applied === "string") record.applied = r.applied;
	return record;
}

/** Folds the append-only log: for each id, the last line written wins. */
export function parseAskLog(text: string): Map<string, AskRecord> {
	const out = new Map<string, AskRecord>();
	for (const line of text.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		let raw: unknown;
		try {
			raw = JSON.parse(trimmed) as unknown;
		} catch {
			continue;
		}
		const record = toRecord(raw);
		if (record) out.set(record.id, record);
	}
	return out;
}

export function readAskLog(path: string): Map<string, AskRecord> {
	try {
		return parseAskLog(readFileSync(path, "utf8"));
	} catch {
		return new Map();
	}
}

export function appendAsk(path: string, record: AskRecord): void {
	mkdirSync(dirname(path), { recursive: true });
	appendFileSync(path, `${JSON.stringify(record)}\n`);
}

/** What "the same ask" means when deciding whether to park a second copy. */
export function pendingKey(paneId: string, op: Op, argument: string): string {
	return `${paneId}\u0000${op}\u0000${argument}`;
}

/** The held actions still waiting on a human. A restart re-derives this from the
 *  log alone, which is why nothing about a pending ask lives in memory. */
export function pendingAsks(log: Map<string, AskRecord>): Set<string> {
	const out = new Set<string>();
	for (const record of log.values()) {
		if (record.status === "pending") out.add(pendingKey(record.paneId, record.op, record.argument));
	}
	return out;
}

export interface AnswerDeps {
	port: HerdrPort;
	config: Config;
	/** Claim registry a held `declare_done` is written to; defaults to the live one. */
	registry?: string;
}

export type AnswerResult = { ok: true; action: string } | { ok: false; reason: string };

function markAnswered(path: string, record: AskRecord, verdict: "yes" | "no", applied: string, now: Date): void {
	appendAsk(path, {
		...record,
		status: "answered",
		answeredAt: now.toISOString(),
		answer: verdict,
		applied,
	});
}

/** Applies, discards or refuses one held action. Idempotent by construction: an
 *  id that already has an `answered` line is never applied again. */
export async function answer(
	deps: AnswerDeps,
	id: string,
	verdict: "yes" | "no",
	replacement?: string,
	now: () => Date = () => new Date(),
): Promise<AnswerResult> {
	const path = deps.config.asksPath;
	const record = readAskLog(path).get(id);
	if (!record) return { ok: false, reason: `no ask "${id}" in ${path}` };
	if (record.status === "answered") {
		return {
			ok: false,
			reason: `ask "${id}" was already answered ${record.answer ?? "?"} at ${record.answeredAt ?? "?"} (${record.applied ?? "nothing"}) — refusing to apply it twice`,
		};
	}

	if (verdict === "no") {
		markAnswered(path, record, "no", "held action discarded", now());
		return { ok: true, action: `discarded ${record.op} for ${record.paneId}: ${record.argument}` };
	}

	if (record.op === "nudge") {
		const text = replacement !== undefined && replacement.trim() !== "" ? replacement : record.argument;
		let sent: Awaited<ReturnType<HerdrPort["prompt"]>>;
		try {
			sent = await deps.port.prompt(record.paneId, text);
		} catch (e) {
			return { ok: false, reason: `could not reach ${record.paneId}: ${(e as Error).message} — ask "${id}" stays pending` };
		}
		if (sent.disposition === "rejected") {
			return {
				ok: false,
				reason: `${record.paneId} refused the held prompt (${sent.reason ?? "unknown"}) — ask "${id}" stays pending`,
			};
		}
		markAnswered(path, record, "yes", `sent prompt: ${text.slice(0, 200)}`, now());
		return { ok: true, action: `sent to ${record.paneId}: ${text}` };
	}

	if (record.op === "declare_done") {
		const base = readClaims(deps.registry).get(record.paneId);
		const claim: Claim = {
			paneId: record.paneId,
			cwd: record.cwd || base?.cwd || "",
			intent: base?.intent ?? "",
			phase: "idle",
			state: "done",
			last: record.argument,
			updated: now().toISOString(),
		};
		if (base?.group) claim.group = base.group;
		if (base?.acceptance) claim.acceptance = base.acceptance;
		if (base?.budget) claim.budget = base.budget;
		writeClaim(claim, deps.registry);
		markAnswered(path, record, "yes", `wrote done claim: ${record.argument.slice(0, 200)}`, now());
		return { ok: true, action: `wrote done claim for ${record.paneId}: ${record.argument}` };
	}

	return { ok: false, reason: `${record.op} is not a held action` };
}

async function main(): Promise<void> {
	const [id, verdict, ...rest] = process.argv.slice(2);
	if (id === undefined || (verdict !== "yes" && verdict !== "no")) {
		console.error('usage: node src/manager/answer.ts <id> yes|no ["replacement text"]');
		process.exitCode = 2;
		return;
	}
	const replacement = rest.join(" ");
	const result = await answer(
		{ port: herdrPort(), config: loadConfig() },
		id,
		verdict,
		replacement === "" ? undefined : replacement,
	);
	if (!result.ok) {
		console.error(result.reason);
		process.exitCode = 1;
		return;
	}
	console.log(result.action);
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
	void main();
}
