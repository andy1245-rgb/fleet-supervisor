// The route table, and the completeness property the whole workstream is about: no capability
// exists on one surface only.
//
// Three assertions, each of which would have failed before this file existed: every route has a
// CLI surface or a declared reason; every write has a verb; and the table is a value the
// dispatcher reads — so the count a document prints is the count the server answers.

import assert from "node:assert/strict";
import { test } from "node:test";

import { ROUTES, matchRoute, mutatingRoutes, pathIsRoute, routePaths, screenNames } from "../../src/fleet/routes.ts";

test("the table: 24 paths, 26 method/path pairs, no duplicates", () => {
	const paths = routePaths();
	assert.equal(paths.length, 24);
	assert.equal(new Set(paths).size, 24, "no path is listed twice");
	assert.equal(ROUTES.length, 26);
	const pairs = ROUTES.map((route) => `${route.method} ${route.path}`);
	assert.equal(new Set(pairs).size, pairs.length, "no method/path pair is listed twice");
});

test("six routes change state, and every one of them binds a verb", () => {
	const writes = mutatingRoutes();
	assert.equal(writes.length, 6);
	for (const route of writes) {
		assert.equal(route.cli.verb !== undefined, true, `${route.method} ${route.path} is a write with no verb`);
		assert.equal(route.gate, "session+loopback", `${route.path} must pass the one loopback gate`);
		assert.equal(Object.keys(route.body).length > 0, true, `${route.path} accepts no body key from a flag`);
	}
});

test("every route is reachable from a CLI surface, or says why it is not", () => {
	for (const route of ROUTES) {
		const hasSurface = route.cli.verb !== undefined || route.cli.dump !== undefined;
		const declared = typeof route.cli.reason === "string" && route.cli.reason.length > 0;
		assert.equal(hasSurface || declared, true, `${route.method} ${route.path} has neither a surface nor a declared reason`);
		if (declared) assert.match(route.cli.reason ?? "", /^(AUTH_EXEMPT|[A-Z_]+):/, `${route.path}'s reason must name its exception class`);
	}
});

test("the six paths that used to have no surface now do", () => {
	// The exact six from `before.txt`: three writes, `/auth/health`, and the two auth page
	// routes. The writes have verbs; the auth routes declare AUTH_EXEMPT with a reason.
	const byPath = new Map(ROUTES.map((route) => [route.path, route]));
	assert.equal(byPath.get("/api/settings/fast")?.cli.verb, "fast");
	assert.equal(byPath.get("/api/settings/decision-mode")?.cli.verb, "mode");
	assert.equal(byPath.get("/api/chat/:paneId/fast")?.cli.verb, "fast");
	assert.match(byPath.get("/auth/health")?.cli.reason ?? "", /^AUTH_EXEMPT/);
	assert.match(byPath.get("/auth/login")?.cli.reason ?? "", /^AUTH_EXEMPT/);
	assert.match(byPath.get("/auth/logout")?.cli.reason ?? "", /^AUTH_EXEMPT/);
});

test("a read route accepts GET only, which is what makes 405 a statement about the path", () => {
	for (const route of ROUTES.filter((entry) => !entry.mutates && entry.path.startsWith("/api/"))) {
		assert.equal(route.method, "GET", `${route.path} is a read route and must be GET`);
	}
	// `settings/fast` is the one path with both a read and a write.
	const fast = ROUTES.filter((route) => route.path === "/api/settings/fast").map((route) => route.method);
	assert.deepEqual(fast, ["GET", "POST"]);
});

test("the dispatcher matches the table, including the two parameterised reads", () => {
	const fleet = matchRoute("GET", "/api/fleet");
	assert.equal(fleet?.route.screen, "fleet");
	assert.deepEqual(fleet?.params, {});

	const pane = matchRoute("GET", "/api/pane/w46%3Ap1");
	assert.equal(pane?.route.screen, "pane");
	assert.deepEqual(pane?.params, { paneId: "w46:p1" });

	const answer = matchRoute("POST", "/api/asks/ask-1/answer");
	assert.equal(answer?.route.mutates, true);
	assert.deepEqual(answer?.params, { id: "ask-1" });

	assert.equal(matchRoute("POST", "/api/fleet"), null, "a read path does not answer POST");
	assert.equal(pathIsRoute("/api/fleet"), true, "the path exists, so POST is 405 rather than 404");
	assert.equal(pathIsRoute("/api/nope"), false, "the path does not exist, so the refusal is no_such_route");
	assert.equal(matchRoute("GET", "/api/conversation/w1%3Ap1")?.params.paneId, "w1:p1");
});

test("every screen a route builds is a name buildScreen answers", () => {
	const names = screenNames();
	// 14 readings plus `routes` itself: the route whose job is to describe the system is a
	// document like any other, which is the property that was broken when its body was built
	// inline in `server.mjs`.
	assert.equal(names.length, 15);
	assert.equal(names.includes("routes"), true);
	assert.equal(new Set(names).size, names.length, "no screen name is answered by two paths by accident");
});
