// The queue the operator acts on.
//
// Each card carries the four things the release decision needs and nothing else: the
// argument in full, the pane's tree, the forks with their severity, and the gate's own
// sentence. The id is on the card because the verb takes it, and the exact command is
// printed whether or not any button exists — with the write path disarmed the command is
// the whole answer, so it must be readable rather than a tooltip.
//
// Two rules hold the card together:
//
//   * a record is only judged against the pane list of its own load. `scopeOf` decides
//     that; on fixture data the answer is "these belong to the sample fleet" and never a
//     prediction about a write.
//   * a disabled release is a state, not an error. Every card says what the next step is
//     in the same neutral voice, and a sample card says there is nothing to release
//     instead of printing a command that cannot work.

import { envelope, lagSecondsOf, tile } from "../envelope.ts";
import { forkSummary } from "../asks.ts";
import { noteOf, paneName } from "../name.ts";
import { scopeOf } from "../source.ts";
import { answerVerb } from "../where.ts";
import type { Ctx, Doc, Row } from "../types.ts";
import type { AskRecord } from "../../manager/ask.ts";

/** The one sentence a card says about pane presence, and the reason it says it. Three
 *  outcomes, and the order matters: not comparable first (two different fleets), then
 *  sample (nothing to check), then the real fact. */
function scopeNoteFor(args: { scope: ReturnType<typeof scopeOf>; panePresent: boolean | null }): string | null {
	if (!args.scope.comparable) return `${args.scope.why}. This card is shown as it was written.`;
	if (args.panePresent === true) return null;
	if (args.scope.records === "fixture") return "this ask belongs to the sample fleet: its pane is not one of the sample panes, so there is nothing to check here.";
	return null;
}

/** The release block: what this surface can do about the ask, said as the next step rather
 *  than as a fault. `command` is null when running it would be a dead end. */
function releaseFor(args: {
	scope: ReturnType<typeof scopeOf>;
	panePresent: boolean | null;
	actionsEnabled: boolean;
	command: string;
	discard: string;
}): { state: string; line: string; command: string | null; discard: string | null; buttons: boolean } {
	if (args.scope.records === "fixture") {
		const panes = args.panePresent === false ? " and its pane is not in the sample pane list" : "";
		return { state: "sample", line: `Nothing to release: this is sample data${panes}, so no command is printed.`, command: null, discard: null, buttons: false };
	}
	if (!args.actionsEnabled) {
		return {
			state: "guarded",
			line: "Next step: run this command in a terminal. The release route stays off unless --enable-actions was given.",
			command: args.command,
			discard: args.discard,
			buttons: false,
		};
	}
	if (args.panePresent === false) {
		return {
			state: "pane-gone",
			line: "Next step: nothing to release from here. herdr is not listing this pane, so answer.ts would leave the ask pending without a prompt; the command prints that refusal.",
			command: args.command,
			discard: args.discard,
			buttons: false,
		};
	}
	return { state: "open", line: "Next step: release or discard. answer.ts writes one answered line and the document is re-read.", command: args.command, discard: args.discard, buttons: true };
}

interface AskCard {
	[key: string]: unknown;
	id: string;
	ageSeconds: number | null;
	paneTitle: string | null;
	release: { state: string; line: string; command: string | null; discard: string | null; buttons: boolean };
	forkCounts: { hard: number; soft: number; total: number };
}

function card(record: AskRecord, args: { now: number; pane: Row | undefined; scope: ReturnType<typeof scopeOf>; actionsEnabled: boolean; root: string }): AskCard {
	const panePresent = args.scope.comparable ? args.pane !== undefined : null;
	return {
		id: record.id,
		ts: record.ts,
		ageSeconds: lagSecondsOf(record.ts, args.now),
		paneId: record.paneId,
		group: record.group,
		op: record.op,
		argument: record.argument,
		why: record.why,
		cwd: record.cwd,
		forks: record.forks,
		forkCounts: forkSummary(record),
		status: record.status,
		/** `true` in this load's pane list, `false` absent from it, `null` when the two
		 *  sides cannot be compared at all. A `null` must never render as "pane not
		 *  listed": that would assert a check nobody ran. */
		panePresent,
		paneStatus: args.pane?.agent_status ?? null,
		paneTitle: args.pane?.terminal_title_stripped ?? args.pane?.terminal_title ?? null,
		name: paneName({ label: args.pane?.label ?? null, paneId: record.paneId }),
		scope: {
			records: args.scope.records,
			panes: args.scope.panes.kind,
			paneList: args.scope.panes.short,
			comparable: args.scope.comparable,
			note: scopeNoteFor({ scope: args.scope, panePresent }),
		},
		release: releaseFor({
			scope: args.scope,
			panePresent,
			actionsEnabled: args.actionsEnabled,
			command: answerVerb(args.root, record.id, "yes"),
			discard: answerVerb(args.root, record.id, "no"),
		}),
	};
}

export function buildAsks(ctx: Ctx): Doc {
	const { source, now, opts } = ctx;
	const scope = scopeOf(source);
	const panesById = new Map(source.panes.panes.map((pane) => [pane.pane_id, pane]));
	const claims = source.claims.claims;
	const actionsEnabled = opts.enableActions;

	const pending = source.asks.pending.map((record) => {
		const entry = claims.get(record.paneId);
		const named = card(record, { now, pane: panesById.get(record.paneId), scope, actionsEnabled, root: opts.agentFleetRoot });
		return { ...named, name: paneName({ label: named.paneTitle, note: noteOf(entry?.claim), paneId: record.paneId }) };
	});

	const answered = source.asks.answered.map((record) => ({
		id: record.id,
		ts: record.ts,
		answeredAt: record.answeredAt ?? null,
		paneId: record.paneId,
		group: record.group,
		op: record.op,
		argument: record.argument,
		why: record.why,
		answer: record.answer ?? null,
		applied: record.applied ?? null,
		ageSeconds: record.answeredAt === undefined ? null : lagSecondsOf(record.answeredAt, now),
		name: paneName({ label: panesById.get(record.paneId)?.label ?? null, note: noteOf(claims.get(record.paneId)?.claim), paneId: record.paneId }),
	}));

	const sourceName = "asks.jsonl (folded, last line per id wins)";
	const releasable = pending.filter((item) => item.release.buttons).length;
	const oldestSeconds = pending.length > 0 ? (pending[0]?.ageSeconds ?? null) : null;

	const tiles = [
		tile({ id: "pending", label: "Pending", value: pending.length, n: source.asks.log.size, source: sourceName, tone: pending.length > 0 ? "warn" : "ok", detail: "held actions nobody has released" }),
		tile({ id: "answered", label: "Answered", value: source.asks.answeredTotal, n: source.asks.log.size, source: sourceName, detail: "released or discarded, newest last" }),
		tile({
			id: "oldest",
			label: "Oldest pending",
			value: oldestSeconds,
			unit: "s",
			n: pending.length,
			source: sourceName,
			nullReason: "nothing is pending",
			tone: oldestSeconds !== null && oldestSeconds > 3600 ? "warn" : "neutral",
			detail: "how long the top of the queue has been waiting",
		}),
		tile({
			id: "hard",
			label: "Hard forks",
			value: pending.reduce((sum, item) => sum + item.forkCounts.hard, 0),
			n: pending.length,
			source: sourceName,
			tone: "warn",
			detail: "irreversible or cross-agent contests across the pending cards",
		}),
		tile({
			id: "actions",
			label: "Release route",
			value: actionsEnabled ? "buttons" : "terminal",
			n: 1,
			source: "flag --enable-actions",
			tone: actionsEnabled ? "warn" : "neutral",
			detail: actionsEnabled ? `the answer route runs answer.ts; ${releasable} of ${pending.length} cards can be released from the page` : "the page's buttons are off by default and each card prints the command instead; the next step is on every card",
		}),
	];

	const notes: string[] = [];
	notes.push("`yes` on a nudge sends the prompt for real; `yes` on a declare_done writes a done claim and stops the agent. A second answer to the same id is refused by answer.ts, not by this document.");
	if (scope.records === "fixture") notes.push("These asks are sample data. Nothing here can be released and no command is printed, because answer.ts acts on the real asks.jsonl and these ids exist only in fixtures/asks.jsonl.");
	else if (!actionsEnabled) notes.push("Release is by command on this server: the buttons are off, which is the default guard rather than a fault. Every card prints the exact command, and nothing here writes.");
	if (!scope.comparable) notes.push(`Pane presence is not checked here: ${scope.why}.`);

	return envelope(ctx, {
		route: "asks",
		screen: "asks",
		title: "Asks",
		n: pending.length + answered.length,
		tiles,
		notes,
		counts: { pending: pending.length, answered: answered.length, answeredTotal: source.asks.answeredTotal, logSize: source.asks.log.size, releasable },
		data: {
			pending,
			answered,
			actions: {
				enabled: actionsEnabled,
				allowRemoteWrites: opts.allowRemoteWrites,
				route: "POST /api/asks/:id/answer",
				body: { verdict: "yes | no", replacement: "optional string, nudge only" },
				command: "node src/manager/answer.ts <id> yes|no [\"replacement\"]",
				repo: opts.agentFleetRoot,
			},
			scope: { records: scope.records, panes: scope.panes.kind, paneList: scope.panes.short, comparable: scope.comparable },
			fold: { file: `${source.stateDir}/asks.jsonl`, lines: source.asks.lines, rejected: source.asks.rejected, logSize: source.asks.log.size },
		},
	});
}
