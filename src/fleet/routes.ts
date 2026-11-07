// The route table, as a value the running server reads.
//
// D5 of PLAN-v1: `lib/router.mjs`'s hand-written `endpoints` array is deleted, not
// repaired. It had 20 entries, 1 duplicate and was missing 5 dispatched routes — the
// route whose job is to describe the system did not describe itself the same way twice,
// and the one route a reader would check first (`/api/routes`) shared 4 of its 13 keys
// with `--dump routes`.
//
// So this file is the source of truth, and three consumers read it: `buildScreen` (which
// builds a document per screen), the server's dispatcher (which matches a request), and
// `fleet-manager routes --json` (which prints it). A route carries the CLI binding beside
// the handler, so "every write has a verb" is a property of one array rather than a claim
// in a document.
//
// **Counting.** 2026-11-07: 24 distinct paths, 26 method/path pairs, 0 duplicates. The
// six that change state are the four writes below plus `POST /api/asks/:id/answer` and
// `POST /api/chat/:paneId/fast`. A read route answers `GET` only; `POST` on a read path is
// `405`, which is the contract the old server could not state while `route()` handed
// every `POST` to the screen branch.

export type Gate = "none" | "session" | "session+loopback";

export interface CliBinding {
	/** The verb a person types, if there is one. */
	verb?: string;
	/** The `--dump` name that prints this route's document, if there is one. */
	dump?: string;
	/** Positional arguments and flags, as the verb declares them. */
	args?: string[];
	/** Declared exception, printed on every parity run. */
	reason?: string;
}

export interface Route {
	method: "GET" | "POST";
	path: string;
	/** The screen name `buildScreen` dispatches on, or null for a route that is not a
	 *  screen document (the writes, and the auth endpoints). */
	screen: string | null;
	mutates: boolean;
	gate: Gate;
	/** Query parameters this route reads off the URL. */
	query: string[];
	/** Accepted body keys, and the verb flag each maps to. */
	body: Record<string, string>;
	cli: CliBinding;
}

const TABLE: Route[] = [
	{ method: "GET", path: "/api/fleet", screen: "fleet", mutates: false, gate: "session", query: ["filter", "window"], body: {}, cli: { verb: "fleet", dump: "fleet", args: ["[--filter <id>]", "[--window <w>]", "[--json]"] } },
	{ method: "GET", path: "/api/asks", screen: "asks", mutates: false, gate: "session", query: ["window"], body: {}, cli: { verb: "asks", dump: "asks", args: ["[--json]"] } },
	{ method: "GET", path: "/api/decisions", screen: "decisions", mutates: false, gate: "session", query: ["window", "limit"], body: {}, cli: { verb: "decisions", dump: "decisions", args: ["[--window <w>]", "[--limit <n>]", "[--json]"] } },
	{ method: "GET", path: "/api/cost", screen: "cost", mutates: false, gate: "session", query: ["window"], body: {}, cli: { verb: "cost", dump: "cost", args: ["[--window <w>]", "[--json]"] } },
	{ method: "GET", path: "/api/health", screen: "health", mutates: false, gate: "session", query: ["window"], body: {}, cli: { verb: "health", dump: "health", args: ["[--json]"] } },
	{ method: "GET", path: "/api/pane/:paneId", screen: "pane", mutates: false, gate: "session", query: ["tail", "window"], body: {}, cli: { verb: "read", dump: "pane", args: ["<paneId>", "[--lines <n>]", "[--json]"] } },
	{ method: "GET", path: "/api/conversations", screen: "conversations", mutates: false, gate: "session", query: ["turns"], body: {}, cli: { verb: "conversations", dump: "conversations", args: ["[--turns <n>]", "[--json]"] } },
	{ method: "GET", path: "/api/conversation/:paneId", screen: "conversation", mutates: false, gate: "session", query: ["turns"], body: {}, cli: { verb: "conversation", dump: "conversation", args: ["<paneId>", "[--turns <n>]", "[--json]"] } },
	{ method: "GET", path: "/api/settings", screen: "settings", mutates: false, gate: "session", query: [], body: {}, cli: { verb: "settings", dump: "settings", args: ["[--json]"] } },
	{ method: "GET", path: "/api/swimlane", screen: "swimlane", mutates: false, gate: "session", query: ["filter", "window"], body: {}, cli: { verb: "swimlane", dump: "swimlane", args: ["[--filter <id>]", "[--json]"] } },
	{ method: "GET", path: "/api/events", screen: "events", mutates: false, gate: "session", query: ["window", "limit"], body: {}, cli: { verb: "events", dump: "events", args: ["[--limit <n>]", "[--json]"] } },
	{ method: "GET", path: "/api/outcomes", screen: "outcomes", mutates: false, gate: "session", query: ["window", "limit"], body: {}, cli: { verb: "outcomes", dump: "outcomes", args: ["[--json]"] } },
	{ method: "GET", path: "/api/panes", screen: "panes", mutates: false, gate: "session", query: [], body: {}, cli: { verb: "panes", dump: "panes", args: ["[--json]"] } },
	{ method: "GET", path: "/api/pricing", screen: "pricing", mutates: false, gate: "session", query: [], body: {}, cli: { verb: "pricing", dump: "pricing", args: ["[--json]"] } },
	{ method: "GET", path: "/api/routes", screen: "routes", mutates: false, gate: "session", query: [], body: {}, cli: { verb: "routes", dump: "routes", args: ["[--json]"] } },

	{ method: "POST", path: "/api/asks/:id/answer", screen: null, mutates: true, gate: "session+loopback", query: [], body: { verdict: "--verdict", replacement: "[text]" }, cli: { verb: "answer", args: ["<id>", "yes|no", "[text]", "[--json]", "[--dry-run]"] } },
	{ method: "POST", path: "/api/chat/:paneId/send", screen: null, mutates: true, gate: "session+loopback", query: [], body: { text: "[text]" }, cli: { verb: "send", args: ["<paneId>", "<text>", "[--json]", "[--dry-run]"] } },
	{ method: "POST", path: "/api/chat/start", screen: null, mutates: true, gate: "session+loopback", query: [], body: { dir: "--dir", text: "[text]" }, cli: { verb: "start", args: ["<dir>", "<text>", "[--allow-outside-home]", "[--json]", "[--dry-run]"] } },
	{ method: "GET", path: "/api/settings/fast", screen: null, mutates: false, gate: "session", query: [], body: {}, cli: { verb: "fast", args: ["[--json]"] } },
	{ method: "POST", path: "/api/settings/fast", screen: null, mutates: true, gate: "session+loopback", query: [], body: { fast: "on|off" }, cli: { verb: "fast", args: ["on|off", "[--dry-run]"] } },
	{ method: "POST", path: "/api/settings/decision-mode", screen: null, mutates: true, gate: "session+loopback", query: [], body: { mode: "adapter|pi" }, cli: { verb: "mode", args: ["adapter|pi", "[--dry-run]"] } },
	{ method: "POST", path: "/api/chat/:paneId/fast", screen: null, mutates: true, gate: "session+loopback", query: [], body: { confirm: "--yes", paneId: "<paneId>" }, cli: { verb: "fast", args: ["resume", "<paneId>", "--yes", "[--dry-run]"] } },

	{ method: "GET", path: "/auth/health", screen: null, mutates: false, gate: "none", query: [], body: {}, cli: { reason: "AUTH_EXEMPT: liveness of the session module; a verb would advertise an operator capability that does not exist. Exercised by the harness as `api GET /auth/health` → `200 {ok:true}`." } },
	{ method: "GET", path: "/auth/login", screen: null, mutates: false, gate: "none", query: [], body: {}, cli: { reason: "AUTH_EXEMPT: page bytes (the 'how ui looks' carve-out)." } },
	{ method: "POST", path: "/auth/login", screen: null, mutates: false, gate: "none", query: [], body: { operator: "[name]", password: "[secret]" }, cli: { reason: "AUTH_EXEMPT: the surface is `fleet-manager api --as <name>`, which performs the login internally and never puts the secret on argv." } },
	{ method: "POST", path: "/auth/logout", screen: null, mutates: false, gate: "none", query: [], body: {}, cli: { reason: "AUTH_EXEMPT: the surface is `fleet-manager api --as <name>`; no cookie jar is kept." } },
];

export const ROUTES: readonly Route[] = Object.freeze(TABLE);

/** The paths, deduplicated, in table order: what `endpoints` in a route document counts. */
export function routePaths(): string[] {
	const seen: string[] = [];
	for (const route of ROUTES) if (!seen.includes(route.path)) seen.push(route.path);
	return seen;
}

/** The routes that change state. Six, by the count in the header; the table is the
 *  authority and a test asserts the number rather than trusting the comment. */
export function mutatingRoutes(): readonly Route[] {
	return ROUTES.filter((route) => route.mutates);
}

export interface Matched {
	route: Route;
	params: Record<string, string>;
}

function match(path: string, pattern: string): Record<string, string> | null {
	const pathParts = path.split("/").filter((part) => part !== "");
	const patternParts = pattern.split("/").filter((part) => part !== "");
	if (pathParts.length !== patternParts.length) return null;
	const params: Record<string, string> = {};
	for (let index = 0; index < patternParts.length; index += 1) {
		const expected = patternParts[index] ?? "";
		const actual = pathParts[index] ?? "";
		if (expected.startsWith(":")) {
			params[expected.slice(1)] = decodeURIComponent(actual);
			continue;
		}
		if (expected !== actual) return null;
	}
	return params;
}

/** `null` means "not a route" (`no_such_route`, exit 2). A path that exists with a
 *  different method is a different answer, so the method is part of the match and the
 *  caller reports `405` when the path matched and the method did not. */
export function matchRoute(method: string, pathname: string): Matched | null {
	for (const route of ROUTES) {
		if (route.method !== method) continue;
		const params = match(pathname, route.path);
		if (params !== null) return { route, params };
	}
	return null;
}

/** True when the path is a route at all, whatever the method: the discriminator between
 *  `405` ("the path exists and does not accept that method") and `404 no_such_route`. */
export function pathIsRoute(pathname: string): boolean {
	return ROUTES.some((route) => match(pathname, route.path) !== null);
}

/** The screen a route builds, if it builds one. */
export function screenOf(route: Route): string | null {
	return route.screen;
}

/** Every screen name a route answers. `--dump` accepts these plus `routes`. */
export function screenNames(): string[] {
	const names: string[] = [];
	for (const route of ROUTES) if (route.screen !== null && !names.includes(route.screen)) names.push(route.screen);
	return names;
}
