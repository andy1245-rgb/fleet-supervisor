// How long each pane has been in the status it is in now.
//
// Nothing in the tree records the instant a pane changed state. `state_change_seq` is a
// counter, not a time, and `marks.json` holds only the status the supervisor last saw
// with the counters beside it. So the derivation is an interval assembled from the rows
// that do carry a status for a pane:
//
//   * `outcome.status` — the herdr status at the moment a decision was scored.
//   * `trigger` / `inspection` with `triggerKind: "blocked"` — the blocked rule matched
//     these panes, which it only does when herdr reports them blocked, so the row proves
//     the status even though the status is not one of its fields.
//
// Nothing else records a status: `claim` rows carry the claim state (`working` /
// `waiting` / `done` / `none`), a different vocabulary about a different thing, and
// reading one as the other is the substitution this module exists to refuse.
//
// What comes out is therefore two bounds, both true:
//
//   the pane entered its current status AFTER the newest row that disagreed
//   the pane entered its current status NO LATER THAN the oldest row of the trailing
//   run that agreed
//
// A pane with no agreeing row gets `seconds: null` and a sentence. It never gets the
// decision age or the claim age in its place.

import type { SchemaEvent } from "../metrics/schema.ts";
import type { Row } from "./types.ts";
import { fieldOf, numField, strField } from "./types.ts";

const FORMULA =
	"now minus the timestamp of the oldest row in the trailing run of rows that record this pane's status (outcome.status, or a blocked trigger / blocked inspection, in events.jsonl)";

const NO_ROWS =
	"no row in the log records this pane's status: only an outcome row, or the blocked trigger and the inspection it spawns, carry one";

export interface StateAge {
	status: string;
	observations: number;
	sources: string[];
	seconds: number | null;
	atMostSeconds: number | null;
	since: string | null;
	sinceFrom: string | null;
	beforeTs: string | null;
	formula: string;
	reason: string | null;
}

interface Observation {
	at: number;
	ts: string;
	status: string;
	from: string;
}

/** Every status the log states about a pane. The two multi-pane kinds are expanded
 *  because a trigger names its panes in a list. */
function readObservations(event: SchemaEvent): { paneId: string; status: string; from: string }[] | null {
	if (event.kind === "outcome") {
		const status = strField(event, "status");
		return status === null ? null : [{ paneId: event.paneId, status, from: "outcome.status" }];
	}
	if (event.kind === "trigger" && event.triggerKind === "blocked") {
		return event.paneIds.map((paneId) => ({ paneId, status: "blocked", from: "trigger.blocked" }));
	}
	if (event.kind === "inspection" && event.triggerKind === "blocked") {
		return event.paneIds.map((paneId) => ({ paneId, status: "blocked", from: "inspection.blocked" }));
	}
	return null;
}

function secondsBetween(fromMs: number, now: number): number {
	return Math.max(0, Math.round((now - fromMs) / 1000));
}

function observationsByPane(allEvents: SchemaEvent[]): Map<string, Observation[]> {
	const out = new Map<string, Observation[]>();
	for (const event of allEvents) {
		const at = Date.parse(event.ts);
		if (!Number.isFinite(at)) continue;
		const found = readObservations(event);
		if (found === null) continue;
		for (const observation of found) {
			const list = out.get(observation.paneId) ?? [];
			list.push({ at, ts: event.ts, status: observation.status, from: observation.from });
			out.set(observation.paneId, list);
		}
	}
	for (const list of out.values()) list.sort((a, b) => a.at - b.at);
	return out;
}

function stateAgeOf(args: { status: string; observations: Observation[]; now: number }): StateAge {
	const sources = [...new Set(args.observations.map((observation) => observation.from))].sort();
	const base: StateAge = {
		status: args.status,
		observations: args.observations.length,
		sources,
		seconds: null,
		atMostSeconds: null,
		since: null,
		sinceFrom: null,
		beforeTs: null,
		formula: FORMULA,
		reason: null,
	};

	if (args.observations.length === 0) return { ...base, reason: NO_ROWS };

	const newest = args.observations[args.observations.length - 1];
	if (newest === undefined) return { ...base, reason: NO_ROWS };
	if (newest.status !== args.status) {
		return {
			...base,
			beforeTs: newest.ts,
			atMostSeconds: secondsBetween(newest.at, args.now),
			reason: `the newest row that records this pane's status is ${newest.ts} and says ${newest.status}, not ${args.status}; nothing since records the change, so only an upper bound is known`,
		};
	}

	let start = args.observations.length - 1;
	while (start > 0 && args.observations[start - 1]?.status === args.status) start -= 1;

	const since = args.observations[start];
	if (since === undefined) return { ...base, reason: NO_ROWS };
	const before = start > 0 ? (args.observations[start - 1] ?? null) : null;
	return {
		...base,
		seconds: secondsBetween(since.at, args.now),
		atMostSeconds: before === null ? null : secondsBetween(before.at, args.now),
		since: since.ts,
		sinceFrom: since.from,
		beforeTs: before === null ? null : before.ts,
	};
}

/** One entry per pane handed in, keyed by pane id. `allEvents`, not the windowed rows:
 *  a state age that restarted at the window edge would be an artefact of the chart's
 *  range rather than a fact about the pane. */
export function stateAgeFor(args: { allEvents: SchemaEvent[]; panes: Row[]; now: number }): Map<string, StateAge> {
	const byPane = observationsByPane(args.allEvents);
	const out = new Map<string, StateAge>();
	for (const pane of args.panes) {
		out.set(pane.pane_id, stateAgeOf({ status: pane.agent_status, observations: byPane.get(pane.pane_id) ?? [], now: args.now }));
	}
	return out;
}

export const STATE_AGE_FORMULA = FORMULA;
export const STATE_AGE_NO_ROWS = NO_ROWS;

/** Reading one field of a typed event is how the blocked rules' own status is quoted;
 *  exported so the screens do not each re-derive it. */
export function observationStatuses(event: SchemaEvent): string[] {
	const found = readObservations(event);
	return found === null ? [] : found.map((row) => row.status);
}

/** `outcome.status` and the two blocked kinds are the only readers; named so a test can
 *  assert the closed set rather than trusting a comment. */
export const OBSERVATION_FIELDS = ["outcome.status", "trigger.blocked", "inspection.blocked"] as const;

/** Reads `op`/`costUsd` and friends off a union member without asserting a shape. */
export { fieldOf, numField };
