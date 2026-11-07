// The reader contract: a bounded backwards tail, one fold, and the mount guard.
//
// Two read paths, deliberately different: an authored transcript (roles and timestamps) and a
// rendered pane tail (neither). The one rule about meaning in the tail is the `$ ` one, and the
// folder's job is to keep that rule the only one — a chat surface whose speaker labels are
// guesses is worse than one that says "this is the pane's text".

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { DEFAULT_TURNS, MAX_MESSAGES, TAIL_CAVEAT, isMountPath, linesForTurns, pageMessages, parseTail, readTranscript, tail } from "../../src/fleet/reader.ts";

// The pane draws a border down the right edge only (the left edge belongs to the layout), and
// the two bars are the ones a real tail carries.
const TAIL = [
	"─── Working ───────────────────",
	"I will start by reading the file.",
	"",
	"$ node --test",
	"  ok 1 - a test",
	"",
	"Then I will change it.",
	"↑ 1.2k ↓ 340",
	"default · some footer",
	"",
].join("\n");

test("the tail is segmented, never reconstructed: chrome is counted and dropped", () => {
	const parsed = parseTail(TAIL, { source: "herdr agent read w1:p1" });
	assert.equal(parsed.dropped.spinner, 1);
	assert.equal(parsed.dropped.tokenbar, 1);
	assert.equal(parsed.dropped.identity, 1);
	assert.equal(parsed.messages.length, 3);
	// Every message from this path carries `role: null`: the tail does not contain one.
	assert.deepEqual(parsed.messages.map((message) => message.role), [null, null, null]);
	assert.equal(parsed.messages[0]?.kind, "message");
	assert.equal(parsed.messages[1]?.kind, "tool");
	assert.equal(parsed.messages[1]?.command, "node --test");
	assert.match(parsed.messages[1]?.text ?? "", /ok 1 - a test/);
	assert.ok(parsed.borders >= 0, "a right-edge border is counted rather than left in the text");

	// The right edge specifically: one trailing bar is stripped and counted.
	const bordered = parseTail("a line of prose│\n", {});
	assert.equal(bordered.borders, 1);
	assert.equal(bordered.messages[0]?.text, "a line of prose");
});

test("a `$` line with no space continues the command it is inside", () => {
	const parsed = parseTail("$ cut -f1\n$P show 01a17a46\noutput line\n");
	assert.equal(parsed.messages.length, 1);
	assert.equal(parsed.messages[0]?.kind, "tool");
	assert.equal(parsed.messages[0]?.command, "cut -f1\nP show 01a17a46");
});

test("a page never exceeds the cap, and a turn never splits from its answer", () => {
	const messages = Array.from({ length: 500 }, (_unused, index) => ({
		index,
		kind: "message" as const,
		role: (index % 2 === 0 ? "user" : "assistant") as "user" | "assistant",
		text: `m${index}`,
		command: null,
		ts: null,
		source: "fixture",
		collapsed: false,
	}));
	const page = pageMessages(messages, 1_000);
	assert.equal(page.messages.length <= MAX_MESSAGES, true);
	assert.equal(page.messages[0]?.role, "user", "the page starts at a turn boundary");
	assert.equal(page.hasEarlier, true);

	const blocks = pageMessages(
		messages.map((message) => ({ ...message, role: null })),
		DEFAULT_TURNS,
	);
	assert.equal(blocks.unit, "block", "a source with no user rows counts blocks");
	assert.equal(blocks.turnsShown, blocks.shown);
});

test("the line budget is bounded in both directions", () => {
	assert.equal(linesForTurns(1) >= 140, true);
	assert.equal(linesForTurns(10_000) <= 2000, true);
});

test("a fixture transcript is read by pane, with roles and timestamps kept", async () => {
	const dir = mkdtempSync(join(tmpdir(), "fleet-reader-"));
	try {
		writeFileSync(
			join(dir, "transcripts.json"),
			JSON.stringify({
				panes: {
					"sample1:p1": {
						capturedAt: "2026-01-01T00:00:00.000Z",
						messages: [
							{ role: "user", text: "do the thing", ts: "2026-01-01T00:00:01.000Z" },
							{ role: "assistant", text: "done", ts: "2026-01-01T00:00:02.000Z" },
							{ role: "system", text: "", ts: "not a timestamp" },
						],
					},
				},
			}),
		);
		const result = await readTranscript({ paneId: "sample1:p1", turns: 5, ctx: { fixtureDir: dir, herdr: false, mode: "fixture" } });
		assert.equal(result.ok, true);
		assert.equal(result.kind, "transcript");
		assert.equal(result.messages.length, 2, "an empty row with no tool is not a message");
		assert.equal(result.messages[0]?.role, "user");
		assert.equal(result.messages[1]?.ts, "2026-01-01T00:00:02.000Z");

		const missing = await readTranscript({ paneId: "nope:p1", turns: 5, ctx: { fixtureDir: dir, herdr: false, mode: "fixture" } });
		assert.equal(missing.ok, false);
		assert.match(missing.reason ?? "", /no entry/);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("the mount guard refuses a transcript on a mounted drive", () => {
	assert.equal(isMountPath("/home/andrew/mnt/dell321/x.jsonl"), true);
	assert.equal(isMountPath("/home/andrew/mnt"), true);
	assert.equal(isMountPath("/home/andrew/agentFleet/x.jsonl"), false);
	assert.equal(isMountPath("/home/andrew/mntx/y"), false);
});

test("a live load with no readable tail says so and shows no fixture text", async () => {
	const dir = mkdtempSync(join(tmpdir(), "fleet-reader-"));
	try {
		writeFileSync(join(dir, "transcripts.json"), JSON.stringify({ panes: { "w1:p1": { messages: [{ role: "user", text: "fixture text" }] } } }));
		const result = await readTranscript({ paneId: "w1:p1", turns: 3, ctx: { fixtureDir: dir, herdr: false, mode: "live" } });
		assert.equal(result.ok, false, "live mode never falls back to the fixture");
		assert.match(result.reason ?? "", /--no-herdr|tail/);
		assert.deepEqual(result.messages, []);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("the tail's own caveat is one sentence, exported rather than retyped", async () => {
	assert.match(TAIL_CAVEAT, /not a transcript/);
	assert.match(TAIL_CAVEAT, /a block starting with \$ is a command/);

	const dir = mkdtempSync(join(tmpdir(), "fleet-reader-"));
	try {
		writeFileSync(join(dir, "tails.json"), JSON.stringify({ "sample1:p1": "plain text" }));
		const read = await tail({ paneId: "sample1:p1", lines: 40, ctx: { fixtureDir: dir, herdr: false, mode: "fixture" } });
		assert.equal(read.lines, "plain text");
		assert.equal(read.origin, "fixtures/tails.json");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
