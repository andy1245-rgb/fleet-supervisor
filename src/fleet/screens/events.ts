// The raw rows behind every other screen, and the only place the two writers are shown
// side by side without a chart in between.
//
// This is the screen you open when a number looks wrong: it prints the parsed rows exactly
// as `parseEvent` returned them, counts the ones it refused, and names the untyped rows by
// kind instead of dropping them. Nothing here is aggregated, so it is also the honest
// answer to "where did that tile get 3 from".

import { envelope, lagSecondsOf, tile } from "../envelope.ts";
import type { Ctx, Doc } from "../types.ts";

export const EVENT_KINDS: readonly string[] = Object.freeze(["decision", "tick", "trigger", "inspection", "action", "watchdog", "claim", "outcome"]);

export function buildEvents(ctx: Ctx): Doc {
	const { source, events, now } = ctx;
	const rows = events
		.slice()
		.sort((a, b) => Date.parse(b.ts) - Date.parse(a.ts))
		.slice(0, ctx.opts.limit)
		.map((event) => ({ ...event, ageSeconds: lagSecondsOf(event.ts, now) }));

	const byKind = EVENT_KINDS.map((kind) => ({ kind, all: ctx.allByKind(kind).length, inWindow: events.filter((event) => event.kind === kind).length })).filter((row) => row.all > 0);

	const untypedCounts = new Map<string, number>();
	for (const row of source.events.untyped) untypedCounts.set(row.kind, (untypedCounts.get(row.kind) ?? 0) + 1);
	const untyped = [...untypedCounts.entries()].map(([kind, count]) => ({ kind, count })).sort((a, b) => b.count - a.count);

	const tiles = [
		tile({ id: "rows", label: "Typed rows", value: events.length, n: events.length, source: `events.jsonl, ${ctx.window}`, note: `${ctx.allEvents.length} in the whole log`, detail: "rows that pass parseEvent at schema 2" }),
		tile({ id: "untyped", label: "Untyped rows", value: source.events.untypedCount, n: source.events.untypedCount, source: "events.jsonl", tone: "dim", note: untyped.length === 0 ? null : untyped.map((row) => `${row.kind} ×${row.count}`).join(", "), detail: "the other writer's lines. Counted and named, never aggregated" }),
		tile({ id: "rejected", label: "Rejected", value: source.events.rejected.count, n: source.events.rejected.count + source.events.typed.length, source: "events.jsonl", tone: source.events.rejected.count > 0 ? "bad" : "neutral", detail: "not JSON, or not schema 2: skipped so one bad row cannot poison an aggregate" }),
		tile({ id: "truncated", label: "Truncated tail", value: source.events.truncatedTail ? "yes" : "no", n: 1, source: "events.jsonl", tone: "dim", detail: "a partial final line is expected on an append-only file and is not a rejection" }),
	];

	return envelope(ctx, {
		route: "events",
		screen: "events",
		title: "Events",
		n: rows.length,
		tiles,
		notes: [
			"Untyped rows share this file with the typed ones and come from a different writer. They are shown apart because only one of the two is a measurement.",
			`Showing at most ${ctx.opts.limit} rows, newest first. --limit raises it.`,
		],
		counts: { typed: events.length, untyped: source.events.untypedCount, rejected: source.events.rejected.count, kinds: byKind.length },
		data: {
			rows,
			byKind,
			untyped,
			untypedSamples: source.events.untyped.slice(0, ctx.opts.limit),
			rejected: source.events.rejected,
			truncatedTail: source.events.truncatedTail,
			window: ctx.window,
			schemaVersion: 2,
		},
	});
}
