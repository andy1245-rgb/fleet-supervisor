// The event log, read the way `src/metrics/schema.ts` says to read it.
//
// This module does not parse a row: `parseEvent` in the schema module is the one
// parser, and it rejects any row whose `schema` is not 2. A row from an older
// supervisor is therefore counted and skipped, never averaged in beside measurements
// it is not comparable with. The GUI used to carry a transcription of that parser;
// this is the parser.
//
// The untyped rows (`nudge`, `nudge_dry`, `flag`, `trigger:divergence`, …) share the
// file and come from a different writer. They are counted, named and shown as history;
// they never enter an aggregate, and the operator's audit rows are among them — which
// is the point: a human's click must not be a denominator in the model's action rate.

import { readText, statFile } from "./fsio.ts";
import { parseEvent } from "../metrics/schema.ts";
import type { EventLog, UntypedRow } from "./types.ts";
import { isBag, str } from "./types.ts";

export { SCHEMA_VERSION } from "../metrics/schema.ts";

const SAMPLE_LIMIT = 5;

function untypedRow(bag: Record<string, unknown>): UntypedRow {
	return {
		kind: str(bag.kind, "unknown"),
		ts: typeof bag.ts === "string" ? bag.ts : null,
		paneId: typeof bag.paneId === "string" ? bag.paneId : null,
		group: typeof bag.group === "string" ? bag.group : null,
		reason: typeof bag.reason === "string" ? bag.reason : null,
		text: typeof bag.text === "string" ? bag.text : null,
		why: typeof bag.why === "string" ? bag.why : null,
		dry: bag.dry === true,
	};
}

/** Reads the whole log once per request. A 500-row log is 60 KB and reading it is not
 *  the cost; the ring buffer a poll loop would want is a later optimisation. */
export function readEventLog(path: string): EventLog {
	const stat = statFile(path);
	const file = readText(path);
	const typed: EventLog["typed"] = [];
	const untyped: UntypedRow[] = [];
	const rejected: EventLog["rejected"] = { count: 0, samples: [] };
	let untypedCount = 0;

	if (!file.exists) {
		return { typed, untyped, untypedCount: 0, rejected, stat, truncatedTail: false, exists: false };
	}

	const lines = file.text.split("\n");
	const trailingNewline = file.text.endsWith("\n") || file.text === "";
	const last = lines.length - 1;
	let truncatedTail = false;

	for (let index = 0; index < lines.length; index += 1) {
		const line = lines[index] ?? "";
		if (line.trim() === "") continue;
		let bag: unknown;
		try {
			bag = JSON.parse(line) as unknown;
		} catch {
			// A partial final line is the one parse failure that is expected on an
			// append-only file, so it is a truncation and not a rejection.
			if (index === last && !trailingNewline) {
				truncatedTail = true;
				continue;
			}
			rejected.count += 1;
			if (rejected.samples.length < SAMPLE_LIMIT) rejected.samples.push({ line: index + 1, reason: "not JSON", excerpt: line.slice(0, 160) });
			continue;
		}
		const event = parseEvent(line);
		if (event !== undefined) {
			typed.push(event);
			continue;
		}
		if (isBag(bag) && typeof bag.kind === "string") {
			untypedCount += 1;
			if (untyped.length < SAMPLE_LIMIT * 40) untyped.push(untypedRow(bag));
			continue;
		}
		rejected.count += 1;
		if (rejected.samples.length < SAMPLE_LIMIT) {
			const reason = isBag(bag) ? `schema ${String(bag.schema)} is not 2` : "not an object";
			rejected.samples.push({ line: index + 1, reason, excerpt: line.slice(0, 160) });
		}
	}

	return { typed, untyped, untypedCount, rejected, stat, truncatedTail, exists: true };
}
