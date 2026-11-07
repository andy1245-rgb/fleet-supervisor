// The document builders: one dispatcher, one document per screen, and the two properties a
// caller depends on — every advertised name has a case, and the document's envelope is the same
// shape whoever asked for it.

import assert from "node:assert/strict";
import { test } from "node:test";

import { BUILT_NAMES, DUMP_NAMES, SCREENS, buildScreen, screenNamed } from "../../src/fleet/screens/index.ts";
import { buildContext, defaultOptions } from "../../src/fleet/envelope.ts";
import type { Ctx, Source } from "../../src/fleet/types.ts";

function fixtureSource(): Source {
	return {
		mode: "fixture",
		modeReason: "a test fixture",
		paneAxis: { name: "fixture", words: "1 sample pane", reason: "sample" },
		decisions: { present: true, count: 0, words: "none yet", reason: "no decision row", sample: true },
		sourceDetail: "/fixtures",
		stateDir: "/fixtures",
		registryDir: "/fixtures/claims",
		events: {
			typed: [],
			untyped: [{ kind: "nudge", ts: "2026-01-01T00:00:00.000Z", paneId: "sample1:p1", group: null, reason: null, text: "hi", why: null, dry: false }],
			untypedCount: 1,
			rejected: { count: 0, samples: [] },
			stat: { exists: true, bytes: 10, mtimeMs: 1, mtime: "2026-01-01T00:00:00.000Z", error: null },
			truncatedTail: false,
			exists: true,
		},
		asks: {
			log: new Map(),
			pending: [],
			answered: [],
			answeredTotal: 0,
			stat: { exists: false, bytes: 0, mtimeMs: null, mtime: null, error: null },
			exists: false,
			lines: 0,
			rejected: 0,
		},
		claims: { dir: "/fixtures/claims", dirExists: true, dirError: null, claims: new Map(), files: [] },
		panes: {
			origin: "fixture",
			reason: null,
			panes: [
				{
					pane_id: "sample1:p1",
					workspace_id: "sample1",
					tab_id: "sample1:t1",
					agent: "pi",
					agent_status: "idle",
					cwd: "/home/andrew/work",
					foreground_cwd: "/home/andrew/work",
					focused: false,
					label: "Reviewing Documents",
					revision: 1,
					terminal_id: "term",
					terminal_title: "π - andrew",
					terminal_title_stripped: "π - andrew",
					agent_session: null,
					completion_seq: 1,
					state_change_seq: 1,
				},
			],
		},
		marks: {},
		policy: {},
		triggers: null,
		cooldowns: {},
		pending: {},
		banner: "1 made-up conversation. This is not a report about your fleet.",
		clock: { shiftMs: 0, rebase: false, anchorOriginal: null },
		files: [],
		meta: null,
	};
}

function ctx(): Ctx {
	return buildContext(defaultOptions({ dataDir: "/fixtures", herdr: false, fixtureDir: "/fixtures", agentFleetRoot: "/home/andrew/agentFleet" }), fixtureSource(), 1_700_000_000_000);
}

test("the advertised names and the built names are the same set", () => {
	assert.deepEqual([...DUMP_NAMES].sort(), [...BUILT_NAMES].sort());
	assert.equal(DUMP_NAMES.length, SCREENS.length + 1, "the screens plus `routes` itself");
});

test("every advertised name builds a document with the shared envelope", async () => {
	const context = ctx();
	for (const name of DUMP_NAMES) {
		const doc = await buildScreen(name, context, { paneId: "sample1:p1", turns: 2 });
		assert.notEqual(doc, null, `${name} advertised but not built`);
		if (doc === null) continue;
		assert.equal(doc.ok, true, `${name} is not ok`);
		assert.equal(doc.screen, name);
		assert.equal(typeof doc.generatedAt, "string");
		assert.equal(doc.generatedAt, new Date(1_700_000_000_000).toISOString(), `${name} must read the pinned clock, not the wall clock`);
		for (const key of ["source", "sourceDetail", "window", "n", "counts", "tiles", "notes", "data", "attention", "fleet", "mix", "mode", "provenance", "freshness"]) {
			assert.equal(key in doc, true, `${name} is missing ${key}`);
		}
		assert.equal(Array.isArray(doc.tiles), true);
		assert.equal((doc.tiles as unknown[]).length > 0, true, `${name} has no tiles`);
	}
});

test("a screen that needs a pane id refuses without one rather than inventing a pane", async () => {
	const context = ctx();
	assert.equal(await buildScreen("pane", context, {}), null);
	assert.equal(await buildScreen("conversation", context, {}), null);
	assert.equal(await buildScreen("nope", context, {}), null);
	assert.equal(screenNamed("fleet")?.api, "/api/fleet");
	assert.equal(screenNamed("nope"), null);
});

test("the two axes are on every document", async () => {
	const doc = await buildScreen("health", ctx(), {});
	assert.equal(doc?.mode !== null, true);
	const mode = doc?.mode as { name: string; words: string; decisions: { words: string } };
	assert.equal(mode.name, "fixture");
	assert.equal(mode.words, "1 sample pane");
	assert.equal(mode.decisions.words, "none yet");
});

test("the routes document counts its own table", async () => {
	const doc = await buildScreen("routes", ctx(), {});
	const data = doc?.data as { endpoints: unknown[]; table: unknown[]; dumps: string[] };
	assert.equal(data.endpoints.length, 24, "one entry per distinct path");
	assert.equal(data.table.length, 26, "one entry per method/path pair");
	assert.equal(data.dumps.length, DUMP_NAMES.length);
});
