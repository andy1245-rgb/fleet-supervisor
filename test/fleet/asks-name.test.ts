// A pending ask's name is the pane's name, and a terminal title is never a name.
//
// The defect this file pins: `screens/asks.ts` built the pending card's name from
// `paneTitle` — herdr's `terminal_title_stripped`, which for an unlabelled pane is the
// shell prompt (`andrew@andrew-Lenovo-7-14IAL7: ~/2di4`). Every other surface asks
// `paneName({label, note, paneId})`, and for a pane herdr reports no `label` for, that
// call answers `unnamed`. So one surface named a row after chrome and the CLI named the
// same row `unnamed`, which is the disagreement `name.ts` exists to remove.
//
// The assertions are about agreement rather than spelling: the ask's name must equal
// what the shared call produces from the pane row and the claim, whoever computes it.

import assert from "node:assert/strict";
import { test } from "node:test";

import { buildAsks } from "../../src/fleet/screens/asks.ts";
import { buildContext, defaultOptions } from "../../src/fleet/envelope.ts";
import { paneName } from "../../src/fleet/name.ts";
import { noteOf } from "../../src/fleet/name.ts";
import type { AskRecord } from "../../src/manager/ask.ts";
import type { Claim } from "../../src/fleet/registry.ts";
import type { Ctx, Row, Source } from "../../src/fleet/types.ts";

/** The reported shell title: what herdr reports for a pane nobody labelled. */
const SHELL_TITLE = "andrew@andrew-Lenovo-7-14IAL7: ~/2di4";
const PANE_ID = "w1:p7";

function pane(overrides: Partial<Row> = {}): Row {
	return {
		pane_id: PANE_ID,
		workspace_id: "w1",
		tab_id: "w1:t1",
		agent: "pi",
		agent_status: "blocked",
		cwd: "/home/andrew/2di4",
		foreground_cwd: "/home/andrew/2di4",
		focused: false,
		/** herdr reports no `label` key at all for an unlabelled pane. */
		label: null,
		revision: 4,
		terminal_id: "term-7",
		terminal_title: SHELL_TITLE,
		terminal_title_stripped: SHELL_TITLE,
		agent_session: null,
		completion_seq: 2,
		state_change_seq: 2,
		...overrides,
	};
}

function ask(overrides: Partial<AskRecord> = {}): AskRecord {
	return {
		id: "ask-1",
		ts: "2026-01-01T00:00:00.000Z",
		paneId: PANE_ID,
		group: "2di4",
		op: "nudge",
		argument: "finish part B",
		why: "a hard fork",
		forks: [{ reason: "irreversible", severity: "hard" }],
		cwd: "/home/andrew/2di4",
		status: "pending",
		...overrides,
	};
}

function source(args: { claim?: Claim; askOverrides?: Partial<AskRecord>; row?: Partial<Row> } = {}): Source {
	const record = ask(args.askOverrides);
	const claim = args.claim;
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
			untyped: [],
			untypedCount: 0,
			rejected: { count: 0, samples: [] },
			stat: { exists: true, bytes: 10, mtimeMs: 1, mtime: "2026-01-01T00:00:00.000Z", error: null },
			truncatedTail: false,
			exists: true,
		},
		asks: {
			log: new Map([[record.id, record]]),
			pending: [record],
			answered: [],
			answeredTotal: 0,
			stat: { exists: true, bytes: 10, mtimeMs: 1, mtime: "2026-01-01T00:00:00.000Z", error: null },
			exists: true,
			lines: 1,
			rejected: 0,
		},
		claims: {
			dir: "/fixtures/claims",
			dirExists: true,
			dirError: null,
			claims:
				claim === undefined
					? new Map()
					: new Map([[claim.paneId, { claim, name: "w1-p7.json", path: "/fixtures/claims/w1-p7.json", mtimeMs: 1, mtime: "2026-01-01T00:00:00.000Z" }]]),
			files: [],
		},
		panes: { origin: "fixture", reason: null, panes: [pane(args.row)] },
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

function ctx(src: Source): Ctx {
	return buildContext(defaultOptions({ dataDir: "/fixtures", herdr: false, fixtureDir: "/fixtures", agentFleetRoot: "/home/andrew/agentFleet" }), src, 1_700_000_000_000);
}

interface Named {
	name: { text: string; source: string };
	paneTitle?: string | null;
}

function pendingName(src: Source): Named {
	const doc = buildAsks(ctx(src));
	const pending = doc.data?.pending as Named[] | undefined;
	assert.ok(pending !== undefined && pending.length === 1, "the fixture has exactly one pending ask");
	return pending[0] as Named;
}

test("an unlabelled pane's pending ask is named `unnamed`, not by its terminal title", () => {
	const src = source();
	const named = pendingName(src);
	assert.notEqual(named.name.text, SHELL_TITLE, "a terminal title is not a name");
	assert.equal(named.name.text, "unnamed");
	assert.equal(named.name.source, "unnamed");
});

test("the pending ask's name is the same call every other surface makes", () => {
	const src = source();
	const row = src.panes.panes[0] as Row;
	const expected = paneName({ label: row.label, note: noteOf(undefined), paneId: row.pane_id });
	assert.deepEqual(pendingName(src).name, expected);
});

test("an unlabelled pane with a note takes rung 2, still not the title", () => {
	const claim: Claim = {
		paneId: PANE_ID,
		cwd: "/home/andrew/2di4",
		group: "2di4",
		intent: "Lab 3 part B",
		phase: "implement",
		state: "working",
		last: "wrote the parser",
		updated: "2026-01-01T00:00:00.000Z",
	};
	const src = source({ claim });
	const named = pendingName(src);
	assert.equal(named.name.text, "Lab 3 part B");
	assert.equal(named.name.source, "note intent");
	assert.deepEqual(named.name, paneName({ label: null, note: noteOf(claim), paneId: PANE_ID }));
});

test("the title survives only in the card's display field, never in the name", () => {
	const named = pendingName(source());
	assert.equal(named.paneTitle, SHELL_TITLE, "the title may still be printed as the pane's title");
	assert.notEqual(named.name.text, named.paneTitle);
});
