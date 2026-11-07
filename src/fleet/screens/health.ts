// Health: where every number came from, and how far behind it is.
//
// The tile that changes the reading is the lag. A document whose newest row is eleven
// minutes old must say so, because otherwise it reads as a calm fleet. The supervisor has
// no daemon socket and writes no heartbeat, so "is it running" is answered from file
// freshness alone: the newest `tick` row against 2× the tick interval. Past that it is
// stopped or failing, and the answer says so in plain English rather than leaving a colour
// to carry it.
//
// Two axes, never one: `mode` is the pane axis (did herdr answer) and `decisions` is the
// decision axis (how many typed decision rows exist). A live fleet with an empty decision
// log is `live` + `none yet`, and it used to report itself as the shipped fixture.

import { envelope, lagSecondsOf, tile } from "../envelope.ts";
import type { Ctx, Doc, SourceFile } from "../types.ts";

function newest(rows: readonly { ts: string }[]): string | null {
	let best: number | null = null;
	for (const row of rows) {
		const at = Date.parse(row.ts);
		if (Number.isFinite(at) && (best === null || at > best)) best = at;
	}
	return best === null ? null : new Date(best).toISOString();
}

function untypedKinds(rows: readonly { kind: string }[]): { kind: string; count: number }[] {
	const counts = new Map<string, number>();
	for (const row of rows) counts.set(row.kind, (counts.get(row.kind) ?? 0) + 1);
	return [...counts.entries()].map(([kind, count]) => ({ kind, count })).sort((a, b) => b.count - a.count);
}

export function buildHealth(ctx: Ctx, options: { host?: string | null } = {}): Doc {
	const { source, now, opts } = ctx;
	const host = options.host ?? null;
	const ticks = ctx.allByKind("tick");
	const lastTickTs = newest(ticks);
	const logLagSeconds = lastTickTs === null ? null : lagSecondsOf(lastTickTs, now);
	const stopAfterSeconds = Math.round(ctx.stopAfterMs / 1000);

	// On fixture data there is no supervisor to judge: the tick rows are the sample's own,
	// and their ages are shifted by the replay clock, so a verdict here would be the
	// document grading its own homework. `unknown` rather than "not running" on purpose.
	let appearsRunning: boolean | null;
	let runningReason: string;
	if (source.mode === "fixture") {
		appearsRunning = null;
		runningReason = "not measurable: this document is reading its own sample, so the tick rows and their ages are fixtures. Nothing here saw your supervisor";
	} else if (lastTickTs === null) {
		appearsRunning = false;
		runningReason = "no tick row has ever been written, so the supervisor has never completed a tick";
	} else if (logLagSeconds !== null && logLagSeconds <= stopAfterSeconds) {
		appearsRunning = true;
		runningReason = `the newest tick row is ${logLagSeconds}s old, inside the ${stopAfterSeconds}s window (2× the ${Math.round(opts.intervalMs / 1000)}s tick interval)`;
	} else {
		appearsRunning = false;
		runningReason = `the newest tick row is ${logLagSeconds}s old, past the ${stopAfterSeconds}s window (2× the ${Math.round(opts.intervalMs / 1000)}s tick interval): stopped or failing`;
	}

	const files = source.files.map((file: SourceFile) => ({
		name: file.name,
		path: file.path,
		role: file.role,
		exists: file.exists,
		bytes: file.bytes,
		mtime: file.mtime,
		rows: file.rows ?? null,
		untyped: file.untyped ?? null,
		rejected: file.rejected ?? null,
		unreadable: file.unreadable ?? null,
		error: file.error ?? null,
		lagSeconds: file.mtime === null ? null : lagSecondsOf(file.mtime, now),
	}));

	const missing = files.filter((file) => !file.exists);
	const biggest = files.reduce((max, file) => (file.bytes > max ? file.bytes : max), 0);
	const livePanes = source.meta?.liveFleetPanes ?? null;
	const fixturePanes = source.mode === "fixture" ? source.panes.panes.length : null;

	const tiles = [
		tile({
			id: "running",
			label: "Supervisor",
			value: appearsRunning === null ? "not measurable" : appearsRunning ? "running" : "not running",
			n: appearsRunning === null ? 0 : ticks.length,
			source: appearsRunning === null ? "nothing: this is sample data" : "events.jsonl (newest tick row)",
			tone: appearsRunning === null ? "neutral" : appearsRunning ? "ok" : "bad",
			note: runningReason,
			detail: appearsRunning === null ? "a verdict here would be the document grading its own fixtures" : "judged from file freshness alone: there is no daemon socket to ask",
		}),
		tile({
			id: "logLag",
			label: "Log lag",
			value: logLagSeconds,
			unit: "s",
			n: ticks.length,
			source: "events.jsonl",
			nullReason: "no tick row yet",
			tone: logLagSeconds !== null && logLagSeconds > stopAfterSeconds ? "bad" : "neutral",
			detail: "now minus the newest tick row's timestamp",
		}),
		tile({ id: "pageLag", label: "Page lag", value: ctx.lagSeconds, unit: "s", n: ctx.events.length, source: `events.jsonl rows inside ${ctx.window}`, nullReason: "no rows in this window", detail: "now minus the newest row this document holds" }),
		tile({
			id: "files",
			label: "Files read",
			value: files.filter((file) => file.exists).length,
			n: files.length,
			source: "every path below",
			tone: missing.length > 0 ? "warn" : "neutral",
			note: missing.length > 0 ? `${missing.length} absent: ${missing.map((file) => file.name).join(", ")}` : null,
			detail: "absent is a fact, not an error: a state file that was never written has no rows",
		}),
		tile({ id: "typed", label: "Typed rows", value: source.events.typed.length, n: source.events.typed.length, source: "events.jsonl", detail: "rows that pass parseEvent at schema 2" }),
		tile({ id: "rejected", label: "Rejected lines", value: source.events.rejected.count, n: source.events.typed.length + source.events.rejected.count, source: "events.jsonl", tone: source.events.rejected.count > 0 ? "bad" : "neutral", detail: "not rows of this schema: counted and skipped, never averaged" }),
		tile({ id: "untyped", label: "Untyped rows", value: source.events.untypedCount, n: source.events.untypedCount, source: "events.jsonl", tone: "dim", detail: "the other writer's human-readable lines. Named and shown, never aggregated" }),
		tile({
			id: "mode",
			label: "Panes",
			value: source.paneAxis.words,
			n: 1,
			source: source.sourceDetail,
			tone: source.mode === "fixture" ? "warn" : source.mode === "live" ? "ok" : "neutral",
			note: source.paneAxis.reason,
			detail: "the pane axis: whether herdr answered. Decided by the pane list, never by whether a log exists",
		}),
		tile({
			id: "decisions",
			label: "Decisions",
			value: source.decisions.words,
			n: source.decisions.count,
			source: "events.jsonl (typed decision rows)",
			tone: source.decisions.count > 0 ? "ok" : "neutral",
			nullReason: source.decisions.count === 0 ? source.decisions.reason : null,
			note: source.decisions.reason,
			detail: "the decision axis, separate on purpose: a live fleet with no decisions says none yet, and does not become sample data",
		}),
	];

	const notes: string[] = [];
	if (source.banner !== null) notes.push("This document is reading the shipped fixtures, not your files.");
	if (source.clock.rebase) notes.push(`Fixture replay: every timestamp was shifted by ${Math.round(source.clock.shiftMs / 1000)}s so the newest row reads as recent. The written timestamps are preserved in the fixtures; --no-fixture-rebase turns this off and shows the true age.`);
	if (missing.length > 0) notes.push(`${missing.length} of ${files.length} expected paths are absent. That is what the supervisor looks like before its first real tick.`);
	if (source.events.truncatedTail) notes.push("The last line of events.jsonl is incomplete. On an append-only file that is expected while a row is being written, and it is not counted as a rejection.");
	if (source.mode === "panes-absent") notes.push(`The pane list did not come from herdr, so pane presence is unknown: ${source.panes.reason ?? source.panes.origin}`);
	if (source.mode !== "fixture" && source.decisions.count === 0) notes.push(`${source.decisions.words}: ${source.decisions.reason}. A decision log with no rows is not a missing fleet.`);

	return envelope(ctx, {
		route: "health",
		screen: "health",
		title: "Health",
		n: files.length,
		tiles,
		notes,
		counts: { files: files.length, present: files.filter((file) => file.exists).length, typed: source.events.typed.length, untyped: source.events.untypedCount, rejected: source.events.rejected.count, ticks: ticks.length },
		data: {
			banner: source.banner,
			mode: { name: source.mode, words: source.paneAxis.words, reason: source.modeReason, detail: source.sourceDetail, decisions: source.decisions },
			clock: source.clock,
			supervisor: {
				appearsRunning,
				reason: runningReason,
				lastTickTs,
				logLagSeconds,
				stopAfterSeconds,
				intervalMs: opts.intervalMs,
				staleAfterSeconds: Math.round(ctx.staleAfterMs / 1000),
				lastTick: ticks.length === 0 ? null : ticks.reduce((a, b) => (Date.parse(a.ts) >= Date.parse(b.ts) ? a : b)),
			},
			files,
			biggestFileBytes: biggest,
			rejected: source.events.rejected,
			untypedKinds: untypedKinds(source.events.untyped),
			indexKind: "scan",
			indexNote: "this document reads the file directly; report.ts may answer the same question from a sqlite index, so its latency and this document's are not comparable",
			herdr: { origin: source.panes.origin, reason: source.panes.reason, panes: source.panes.panes.length },
			fleet: {
				livePanesOnThisBox: livePanes,
				fixturePanes,
				note: source.mode === "fixture" && livePanes !== null ? `the live box has ${livePanes as number} panes; this fixture is a ${fixturePanes ?? 0}-pane sample of them` : null,
			},
			host,
			writes: { answerRoute: opts.enableActions ? "enabled" : "disabled", flag: "--enable-actions", allowRemoteWrites: opts.allowRemoteWrites },
			stateDir: source.stateDir,
			registryDir: source.registryDir,
			paths: { events: `${source.stateDir}/events.jsonl`, asks: `${source.stateDir}/asks.jsonl`, marks: `${source.stateDir}/marks.json`, claims: source.registryDir },
		},
	});
}
