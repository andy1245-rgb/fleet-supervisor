// One conversation: what it has been saying, and what sending to it would do.
//
// The document carries the transcript (or the honest statement that there is not one), the
// composer's gate, and the same row the rail draws — built by the same function, so a
// conversation cannot be sendable here and unsendable in the rail.
//
// The two read paths are deliberately different and the document says which one answered:
// `fixtures/transcripts.json` is a transcript (roles, timestamps), `herdr agent read` is the
// pane's rendered text (no roles, no timestamps, segmented by one rule). A live pane with no
// readable tail never quietly shows fixture text.

import { envelope, lagSecondsOf, tile } from "../envelope.ts";
import { promptVerb, sendRequest } from "../send.ts";
import { tail, readTranscript, readFixtureTranscriptIndex, DEFAULT_TURNS, MAX_TURNS, TAIL_CAVEAT } from "../reader.ts";
import { startVerb, startDirectoryOptions } from "../start.ts";
import { conversationRows, listWorkspaces } from "./conversations.ts";
import type { Ctx, Doc } from "../types.ts";

export async function buildConversation(ctx: Ctx, paneId: string, options: { turns?: number } = {}): Promise<Doc> {
	const turns = Math.max(1, Math.min(options.turns ?? ctx.opts.turns ?? DEFAULT_TURNS, MAX_TURNS));
	const workspaces = await listWorkspaces(ctx);
	const transcripts = ctx.source.mode === "fixture" ? readFixtureTranscriptIndex(ctx.opts.fixtureDir ?? ctx.source.stateDir) : null;
	const list = conversationRows(ctx, { workspaces, transcripts, enableChat: ctx.opts.enableChat });
	const rail = list.rows.find((row) => row.paneId === paneId) ?? null;
	const pane = ctx.source.panes.panes.find((row) => row.pane_id === paneId) ?? null;

	const transcript = await readTranscript({
		paneId,
		turns,
		ctx: { fixtureDir: ctx.opts.fixtureDir ?? (ctx.source.mode === "fixture" ? ctx.source.stateDir : null), herdr: ctx.opts.herdr, mode: ctx.source.mode },
	});

	// The send gate, asked the same question the route asks. `ok` here means "the route
	// would accept this text for this pane", with the same code the refusal would carry.
	const gate = sendRequest({ paneId, text: " ", ctx });

	const tailRead = ctx.opts.herdr || ctx.source.mode === "fixture"
		? await tail({ paneId, lines: Math.max(1, Math.min(turns * 26, 40)), ctx: { fixtureDir: ctx.opts.fixtureDir ?? (ctx.source.mode === "fixture" ? ctx.source.stateDir : null), herdr: ctx.opts.herdr, mode: ctx.source.mode } })
		: { lines: null as string | null, reason: "no-herdr", origin: null as string | null, ts: null as string | null };

	const tiles = [
		tile({
			id: "messages",
			label: "Messages",
			value: transcript.page === null ? null : transcript.page.shown,
			n: transcript.page === null ? 0 : transcript.page.total,
			source: transcript.origin ?? "no source",
			nullReason: transcript.ok ? null : (transcript.reason ?? "the conversation could not be read"),
			tone: transcript.ok ? "neutral" : "warn",
			detail: transcript.kind === "tail" ? TAIL_CAVEAT : "authored rows with a role and a timestamp",
		}),
		tile({
			id: "activity",
			label: "Last activity",
			value: rail === null ? null : ((rail.activity as { ageSeconds: number | null }).ageSeconds ?? null),
			unit: "s",
			n: rail === null ? 0 : 1,
			source: rail === null ? "no rail row for this pane" : String((rail.activity as { lastSource: string }).lastSource),
			nullReason: rail === null ? `no pane ${paneId} in this load` : ((rail.activity as { ageSeconds: number | null }).ageSeconds === null ? "no claim, no event row, no ask and no transcript for this pane" : null),
			detail: "now minus the newest claim, event, ask or transcript row for this pane",
		}),
		tile({
			id: "sendable",
			label: "Send",
			value: gate.ok ? "allowed" : "refused",
			n: 1,
			source: "the send gate (src/fleet/send.ts)",
			tone: gate.ok ? "warn" : "neutral",
			note: gate.ok ? "the route would accept a message for this pane" : gate.code,
			detail: gate.ok ? "armed, live pane list, pi agent, not blocked" : gate.message,
		}),
		tile({
			id: "session",
			label: "Session",
			value: rail === null ? null : String((rail.session as { state: string }).state),
			n: 1,
			source: "herdr agent_session, joined by sessionOf",
			nullReason: rail === null ? `no pane ${paneId} in this load` : null,
			detail: "linked means the report's id and the file's own first line agree",
		}),
	];

	const start = startDirectoryOptions(ctx.source, { home: ctx.opts.home, notesDir: ctx.opts.notesDir });
	const notes: string[] = [];
	if (transcript.kind === "tail") notes.push(TAIL_CAVEAT);
	if (!transcript.ok) notes.push(`The conversation could not be read: ${transcript.reason ?? "no reason given"}. Nothing is invented to fill the gap.`);
	if (rail === null) notes.push(`Pane ${paneId} is not in this load's pane list. A conversation can be read for a pane that has gone, but nothing can be sent to it.`);
	notes.push("The claim is shown and never consulted: it is the supervisor's bookkeeping about a pane, not a lock on the operator's own agent.");

	return envelope(ctx, {
		route: "conversation",
		screen: "conversation",
		title: rail === null ? `Conversation ${paneId}` : String((rail.name as { text: string }).text),
		n: transcript.page === null ? 0 : transcript.page.shown,
		tiles,
		notes,
		counts: {
			messages: transcript.page === null ? 0 : transcript.page.total,
			shown: transcript.page === null ? 0 : transcript.page.shown,
			turns: turns,
			panePresent: pane === null ? 0 : 1,
		},
		data: {
			paneId,
			rail,
			name: rail?.name ?? null,
			line2: rail?.line2 ?? null,
			session: rail?.session ?? null,
			claim: rail?.claim ?? null,
			verdict: rail?.verdict ?? null,
			transcript: {
				ok: transcript.ok,
				source: transcript.source,
				kind: transcript.kind ?? null,
				origin: transcript.origin,
				reason: transcript.reason ?? null,
				capturedAt: transcript.capturedAt ?? null,
				note: transcript.note ?? null,
				dropped: transcript.dropped ?? null,
				borders: transcript.borders ?? 0,
				messages: transcript.messages,
				page: transcript.page,
				earlier: transcript.earlier ?? null,
				lines: transcript.lines,
				caveat: TAIL_CAVEAT,
			},
			panel: {
				tail: { ...tailRead, caveat: TAIL_CAVEAT, ageSeconds: lagSecondsOf(tailRead.ts, ctx.now) },
				composer: {
					enabled: ctx.opts.enableChat === true,
					route: "POST /api/chat/:paneId/send",
					command: promptVerb(paneId, "<text>"),
					gate: gate.ok ? { ok: true, code: "sendable" } : { ok: false, code: gate.code, message: gate.message, next: gate.next ?? null },
				},
				start: { route: "POST /api/chat/start", command: startVerb("<directory>", "<message>"), options: start.options, home: start.home },
			},
			turnsNotice: `asked for ${turns} turn(s); a page never exceeds 400 messages`,
		},
	});
}
