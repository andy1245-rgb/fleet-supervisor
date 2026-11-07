// The audit row: what a human-caused write records, and that it must stay untyped.
//
// The row goes into `events.jsonl`, which is the supervisor's record, so the one thing it must
// never do is look like a measurement. It carries no `schema` field, which is exactly the shape
// `parseEvent` refuses: the row is counted as untyped, named `operator`, and never enters an
// aggregate. Writing it as a `schema: 2` action row would put a human's click into the model's
// action denominator.

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { OPERATOR_KIND, appendAudit, auditPath, auditRow } from "../../src/fleet/audit.ts";
import { readEventLog } from "../../src/fleet/events.ts";
import { parseEvent } from "../../src/metrics/schema.ts";

test("the row shape, and the fields a tick cannot write", () => {
	const row = auditRow({
		act: "answer",
		operator: "andrew",
		source: "cli",
		target: { askId: "ask-1", paneId: "w46:p1", op: "nudge" },
		before: "pending",
		after: "answered",
		verdict: "yes",
		now: 1_700_000_000_000,
	});
	assert.equal(row.kind, OPERATOR_KIND);
	assert.equal(row.ts, new Date(1_700_000_000_000).toISOString());
	assert.equal(row.operator, "andrew");
	assert.equal(row.actor, "human");
	assert.equal(row.source, "cli");
	assert.equal(row.verb, "answer");
	assert.equal(row.askId, "ask-1");
	assert.equal(row.paneId, "w46:p1");
	assert.equal(row.op, "nudge");
	assert.equal(row.verdict, "yes");
	assert.equal(row.before, "pending");
	assert.equal(row.after, "answered");

	// No `schema` key: that is what makes the supervisor's parser treat it as untyped.
	assert.equal("schema" in row, false);
	assert.equal(parseEvent(JSON.stringify(row)), undefined);
});

test("a target given as a bare string is a pane id", () => {
	const row = auditRow({ act: "send", operator: "andrew", source: "gui", target: "w46:p1" });
	assert.equal(row.paneId, "w46:p1");
	assert.equal("askId" in row, false);
});

test("appendAudit writes one untyped row, and the reader counts it as such", () => {
	const dir = mkdtempSync(join(tmpdir(), "fleet-audit-"));
	try {
		writeFileSync(join(dir, "events.jsonl"), "");
		const ctx = { dataDir: dir };
		assert.equal(auditPath(ctx), join(dir, "events.jsonl"));

		const result = appendAudit(ctx, auditRow({ act: "answer", operator: "andrew", source: "cli", target: { askId: "a1" }, now: 1_700_000_000_000 }));
		assert.equal(result.ok, true);
		const log = readEventLog(join(dir, "events.jsonl"));
		assert.equal(log.typed.length, 0, "an operator row is never a typed measurement");
		assert.equal(log.untypedCount, 1);
		assert.equal(log.untyped[0]?.kind, "operator");
		assert.equal(log.rejected.count, 0);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("with no events.jsonl the row goes to the stream instead of inventing the file", () => {
	const dir = mkdtempSync(join(tmpdir(), "fleet-audit-"));
	try {
		const written: string[] = [];
		const result = appendAudit({ dataDir: dir }, auditRow({ act: "answer", operator: "andrew", source: "cli", target: null }), {
			write: (text: string) => {
				written.push(text);
				return true;
			},
		});
		assert.equal(result.ok, false);
		assert.match(result.reason ?? "", /has not written the log/);
		// Inventing the file would flip a surface from fixture replay to an empty live fleet.
		assert.equal(written.length, 1);
		assert.equal(readFileSync(join(dir, "nope.json"), { flag: "a+" }).length, 0);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
