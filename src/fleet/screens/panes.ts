// The pane list on its own, and the route index.
//
// `panes` is the narrow document: the records with no triage, no lanes and no counters
// narrative — what a verb can print in a table. It reads `record(ctx)` like every other
// screen, so its names, verdicts and session states are the same objects the fleet document
// carries rather than a second derivation of them.
//
// `routes` is the index, generated from `ROUTES`: the answer to "what can be asked here"
// with the CLI binding beside each answer. It replaced a hand-written array that had 20
// entries, 1 duplicate and was missing 5 dispatched routes.

import { envelope, tile } from "../envelope.ts";
import { record } from "../record.ts";
import { DUMP_NAMES, SCREENS } from "./index.ts";
import { routePaths } from "../routes.ts";
import { ROUTES } from "../routes.ts";
import type { Ctx, Doc } from "../types.ts";

export function buildPanes(ctx: Ctx): Doc {
	const set = record(ctx);
	const rows = set.rows.map((row) => ({
		paneId: row.paneId,
		name: row.name,
		session: row.session,
		agent: row.agent,
		status: row.status,
		verdict: row.verdict,
		group: row.group,
		title: row.title,
		cwd: row.cwd,
		foregroundCwd: row.foregroundCwd,
		workspaceId: row.workspaceId,
		tabId: row.tabId,
		focused: row.focused,
		label: row.name.raw,
		revision: row.revision,
		terminalId: row.terminalId,
		completionSeq: row.completionSeq,
		stateChangeSeq: row.stateChangeSeq,
		idleTicks: row.idleTicks,
		diverged: row.diverged,
		triage: row.triage,
	}));

	return envelope(ctx, {
		route: "panes",
		screen: "panes",
		title: "Panes",
		n: rows.length,
		tiles: [
			tile({ id: "panes", label: "Panes", value: rows.length, n: rows.length, source: ctx.source.panes.origin, detail: "one row per pane in this load" }),
			tile({ id: "orphans", label: "Orphan claims", value: set.orphans.length, n: set.orphans.length, source: `claims dir (${ctx.source.registryDir})`, tone: set.orphans.length > 0 ? "warn" : "neutral", detail: "claims whose pane is not in this pane list" }),
			tile({ id: "unnamed", label: "Unnamed", value: rows.filter((row) => row.name.source === "unnamed").length, n: rows.length, source: "the name chain (label → note intent → unnamed)", tone: "dim", detail: "rows with no usable label and no usable note: pi's chrome is not a name" }),
		],
		notes: ["Every row's name comes from one chain in `src/fleet/name.ts`, so this document and every other one name a pane the same way."],
		counts: { panes: rows.length, orphans: set.orphans.length, unnamed: rows.filter((row) => row.name.source === "unnamed").length },
		data: { panes: rows, orphans: set.orphans, origin: ctx.source.panes.origin, reason: ctx.source.panes.reason },
	});
}

/** The route index. One entry per route for the dispatcher's benefit, and one entry per
 *  distinct path for `endpoints` — the count a reader checks first. */
export function buildRoutes(ctx: Ctx): Doc {
	const paths = routePaths();
	return envelope(ctx, {
		route: "routes",
		screen: "routes",
		title: "Routes",
		n: SCREENS.length,
		tiles: [
			tile({ id: "paths", label: "Paths", value: paths.length, n: paths.length, source: "src/fleet/routes.ts", detail: "distinct paths the dispatcher answers" }),
			tile({ id: "writes", label: "Writes", value: ROUTES.filter((route) => route.mutates).length, n: ROUTES.length, source: "src/fleet/routes.ts", tone: "neutral", detail: "routes that change state; every one of them has a verb" }),
			tile({ id: "screens", label: "Screens", value: SCREENS.length, n: SCREENS.length, source: "src/fleet/screens/index.ts", detail: "documents buildScreen can build" }),
			tile({ id: "dumps", label: "Dump names", value: DUMP_NAMES.length, n: DUMP_NAMES.length, source: "src/fleet/screens/index.ts", detail: "names --dump accepts, the screens plus `routes` itself" }),
		],
		notes: [
			"`dump` is the command that prints this screen as JSON; `requires` is what that command cannot be called without and `accepts` is what narrows it.",
			"Every route carries its CLI binding beside its handler, so a write with no verb is a row in this table rather than a claim in a report.",
		],
		counts: { paths: paths.length, routes: ROUTES.length, screens: SCREENS.length, dumps: DUMP_NAMES.length },
		data: {
			screens: SCREENS.map((screen) => ({
				name: screen.name,
				label: screen.label,
				kind: screen.kind,
				hash: screen.hash,
				api: screen.api,
				dump: [`--dump`, screen.name, ...screen.requires].join(" "),
				requires: screen.requires,
				accepts: screen.accepts,
				question: screen.question,
			})),
			dumps: DUMP_NAMES,
			endpoints: paths.map((path) => {
				const routes = ROUTES.filter((route) => route.path === path);
				return {
					path,
					methods: routes.map((route) => route.method),
					screen: routes.find((route) => route.screen !== null)?.screen ?? null,
					mutates: routes.some((route) => route.mutates),
					gate: routes.map((route) => route.gate),
					cli: routes.map((route) => route.cli),
				};
			}),
			table: ROUTES.map((route) => ({
				method: route.method,
				path: route.path,
				screen: route.screen,
				mutates: route.mutates,
				gate: route.gate,
				query: route.query,
				body: route.body,
				cli: route.cli,
			})),
			note: "`endpoints` is one entry per distinct path; `table` is one entry per method/path pair, which is what the dispatcher reads. The two counts differ by design.",
		},
	});
}
