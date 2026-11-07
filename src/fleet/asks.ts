// `asks.jsonl`, folded the way `src/manager/answer.ts` folds it.
//
// The log is append-only and the last line for an id wins, which is the whole
// contract: it is what makes answering an id twice impossible and what lets a pending
// ask outlive the supervisor. `toRecord` and `parseAskLog` are imported from the
// module that answers the ask, rather than re-derived here, because the page and the
// verb must not disagree about what a pending ask is.

import { readText, statFile } from "./fsio.ts";
import { parseAskLog, toRecord } from "../manager/answer.ts";
import type { AskLog, AskFold } from "./types.ts";
import type { AskRecord } from "../manager/ask.ts";

export function readAskFile(path: string): AskLog {
	const stat = statFile(path);
	const file = readText(path);
	if (!file.exists) return { log: new Map(), stat, exists: false, lines: 0, rejected: 0 };
	let lines = 0;
	let rejected = 0;
	for (const line of file.text.split("\n")) {
		if (line.trim() === "") continue;
		lines += 1;
		try {
			if (toRecord(JSON.parse(line) as unknown) === undefined) rejected += 1;
		} catch {
			rejected += 1;
		}
	}
	return { log: parseAskLog(file.text), stat, exists: true, lines, rejected };
}

/** Pending oldest first — the order they should be worked in. Answered newest first,
 *  capped, because that list is history rather than a queue. */
export function foldAsks(log: Map<string, AskRecord>, options: { answeredLimit?: number } = {}): AskFold {
	const limit = options.answeredLimit ?? 50;
	const pending: AskRecord[] = [];
	const answered: AskRecord[] = [];
	for (const record of log.values()) {
		if (record.status === "pending") pending.push(record);
		else answered.push(record);
	}
	const byTs = (a: AskRecord, b: AskRecord): number => Date.parse(a.ts || "0") - Date.parse(b.ts || "0");
	pending.sort(byTs);
	answered.sort((a, b) => byTs(b, a));
	return { pending, answered: answered.slice(0, limit), answeredTotal: answered.length };
}

/** The gate's sentence is the reason to hold; the forks are the parts. Splitting them
 *  is what lets a card show severity per fork instead of one blob. */
export function forkSummary(record: AskRecord): { hard: number; soft: number; total: number } {
	const hard = record.forks.filter((fork) => fork.severity === "hard").length;
	const soft = record.forks.filter((fork) => fork.severity === "soft").length;
	return { hard, soft, total: record.forks.length };
}
