// One dispatcher, one document per screen — and the only name a caller needs.
//
// `buildScreen` is the function both adapters call: the server's request handler for a
// `GET`, and `--dump` / `fleet-manager <verb> --json` for a terminal. That is invariant I1,
// and it is why this file is the last place a new screen has to be declared: a screen with
// no case here is a name `DUMP_NAMES` must not advertise, and a test asserts the two sets
// match rather than trusting a comment.
//
// `SCREENS` carries what an index needs — the question each screen answers, the flags a dump
// requires and the flags that narrow it — so an index built from this table cannot promise a
// flag the parser rejects, and a flag the builder honours cannot be missing from the index.

import { buildAsks } from "./asks.ts";
import { buildConversation } from "./conversation.ts";
import { buildConversations } from "./conversations.ts";
import { buildCost } from "./cost.ts";
import { buildDecisions, buildOutcomes } from "./decisions.ts";
import { buildEvents } from "./events.ts";
import { buildFleet, buildPane } from "./fleet.ts";
import { buildHealth } from "./health.ts";
import { buildPanes, buildRoutes } from "./panes.ts";
import { buildPricing } from "./pricing.ts";
import { buildSettings } from "./settings.ts";
import { buildSwimlane } from "./swimlane.ts";
import type { Ctx, Doc } from "../types.ts";

export interface ScreenSpec {
	name: string;
	label: string;
	kind: "screen" | "diagnostic";
	hash: string | null;
	api: string;
	question: string;
	/** What a dump of this screen cannot be called without. */
	requires: string[];
	/** What narrows it. */
	accepts: string[];
}

/** The six screens plus the diagnostic views. `hash` is what the UI routes on; a view with
 *  no hash is drawn inside another screen rather than as a tab. */
export const SCREENS: readonly ScreenSpec[] = Object.freeze([
	{ name: "fleet", label: "Fleet", kind: "screen", hash: "#/fleet", api: "/api/fleet", question: "which panes moved, which are quiet, which claim does not match its pane", requires: [], accepts: ["--filter"] },
	{ name: "asks", label: "Asks", kind: "screen", hash: "#/asks", api: "/api/asks", question: "what is waiting on me, and exactly what am I releasing", requires: [], accepts: [] },
	{ name: "decisions", label: "Decisions", kind: "screen", hash: "#/decisions", api: "/api/decisions", question: "is the model worth its cost, and does silence do any harm", requires: [], accepts: [] },
	{ name: "cost", label: "Cost", kind: "screen", hash: "#/cost", api: "/api/cost", question: "what has this spent, and on what", requires: [], accepts: [] },
	{ name: "health", label: "Health", kind: "screen", hash: "#/health", api: "/api/health", question: "how far behind is this page, and is the supervisor running", requires: [], accepts: [] },
	{ name: "pane", label: "Pane", kind: "screen", hash: "#/pane/", api: "/api/pane/", question: "what is this pane doing and what has the supervisor done to it", requires: ["--pane <paneId>"], accepts: [] },
	{ name: "conversations", label: "Chat", kind: "screen", hash: "#/chat", api: "/api/conversations", question: "which conversations exist, which of them moved, and which can take a message", requires: [], accepts: ["--turns <n>"] },
	{ name: "conversation", label: "Conversation", kind: "screen", hash: "#/chat/", api: "/api/conversation/", question: "what has this conversation been saying, and what would sending to it do", requires: ["--pane <paneId>"], accepts: ["--turns <n>"] },
	{ name: "settings", label: "Settings", kind: "screen", hash: "#/settings", api: "/api/settings", question: "which decision path the supervisor is on, what each costs, and where the file", requires: [], accepts: [] },
	{ name: "swimlane", label: "Lanes", kind: "diagnostic", hash: null, api: "/api/swimlane", question: "which repo has how much work, where is it stalled, who is colliding", requires: [], accepts: ["--filter"] },
	{ name: "events", label: "Events", kind: "diagnostic", hash: null, api: "/api/events", question: "the raw typed and untyped rows, and the lines the parser refused", requires: [], accepts: [] },
	{ name: "outcomes", label: "Outcomes", kind: "diagnostic", hash: null, api: "/api/outcomes", question: "silent-decision precision and the verdicts behind it", requires: [], accepts: [] },
	{ name: "panes", label: "Panes", kind: "diagnostic", hash: null, api: "/api/panes", question: "the pane list on its own", requires: [], accepts: [] },
	{ name: "pricing", label: "Pricing", kind: "diagnostic", hash: null, api: "/api/pricing", question: "the verified card and the peak windows", requires: [], accepts: [] },
]);

/** Every name `--dump` accepts: the screens, every one of which has a case in
 *  `buildScreen`, plus this index itself. A parser reads this list rather than writing its
 *  own, because that is how `routes` came to be a name the parser accepted and the
 *  dispatcher had no answer for. */
export const DUMP_NAMES: readonly string[] = Object.freeze([...SCREENS.map((screen) => screen.name), "routes"]);

/** The names a build has a case for. `DUMP_NAMES` and this must be equal; a test asserts it
 *  rather than a reviewer. */
export const BUILT_NAMES: readonly string[] = Object.freeze([...SCREENS.map((screen) => screen.name), "routes"]);

export interface ScreenParams {
	paneId?: string | null;
	tail?: number;
	turns?: number;
	host?: string | null;
}

/**
 * The one dispatcher.
 *
 * `params.paneId` is required for `pane` and `conversation`, and its absence is `null` — the
 * caller decides whether that is a `400` or a refusal, because an exit code is a surface's
 * vocabulary and a document is not.
 */
export async function buildScreen(name: string, ctx: Ctx, params: ScreenParams = {}): Promise<Doc | null> {
	switch (name) {
		case "fleet":
			return buildFleet(ctx);
		case "swimlane":
			return buildSwimlane(ctx);
		case "asks":
			return buildAsks(ctx);
		case "decisions":
			return buildDecisions(ctx);
		case "outcomes":
			return buildOutcomes(ctx);
		case "cost":
			return buildCost(ctx);
		case "health":
			return buildHealth(ctx, { host: params.host ?? null });
		case "settings":
			return buildSettings(ctx);
		case "events":
			return buildEvents(ctx);
		case "pane":
			return params.paneId === undefined || params.paneId === null ? null : buildPane(ctx, params.paneId, { tailLines: params.tail ?? 0 });
		case "conversations":
			return buildConversations(ctx);
		case "conversation":
			return params.paneId === undefined || params.paneId === null ? null : buildConversation(ctx, params.paneId, { turns: params.turns ?? ctx.opts.turns });
		case "panes":
			return buildPanes(ctx);
		case "routes":
			return buildRoutes(ctx);
		case "pricing":
			return buildPricing(ctx);
		default:
			return null;
	}
}

/** The screen a name builds, or null. Used by a parser to reject a name before a load. */
export function screenNamed(name: string): ScreenSpec | null {
	return SCREENS.find((screen) => screen.name === name) ?? null;
}
