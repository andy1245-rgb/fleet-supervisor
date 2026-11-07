// The toggle: one file, two values, and a fallback that is loud about itself.

import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	DECISION_MODES,
	DEFAULT_DECISION_MODE,
	decisionModePath,
	isDecisionMode,
	readDecisionMode,
	writeDecisionMode,
} from "../src/decision/mode.ts";

async function withDir(fn: (dir: string) => Promise<void> | void): Promise<void> {
	const dir = mkdtempSync(join(tmpdir(), "agentfleet-mode-"));
	try {
		await fn(dir);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

test("both modes are named, and the default is the one that existed first", () => {
	assert.deepEqual([...DECISION_MODES], ["adapter", "pi"]);
	assert.equal(DEFAULT_DECISION_MODE, "adapter");
	// A value the toggle does not know is not a mode, and `isDecisionMode` is what the
	// reader and the GUI both validate against.
	assert.equal(isDecisionMode("pi"), true);
	assert.equal(isDecisionMode("adapter"), true);
	assert.equal(isDecisionMode("needle"), false);
	assert.equal(isDecisionMode(""), false);
	assert.equal(isDecisionMode(undefined), false);
});

test("the toggle lives beside policy.json, under the one state dir", () => {
	assert.equal(decisionModePath("/state"), "/state/decision-mode.json");
});

test("a file that was never written is the default with nothing to report", async () => {
	await withDir((dir) => {
		const reading = readDecisionMode(decisionModePath(dir));
		assert.equal(reading.mode, "adapter");
		assert.equal(reading.source, "default");
		// A fresh install is not a fault: there is no reason to put on a row.
		assert.equal(reading.note, undefined);
	});
});

test("a written mode is read back as the file's answer", async () => {
	await withDir((dir) => {
		const path = decisionModePath(dir);
		writeDecisionMode(path, "pi");
		const reading = readDecisionMode(path);
		assert.equal(reading.mode, "pi");
		assert.equal(reading.source, "file");
		assert.equal(reading.note, undefined);
		// The on-disk shape is the shape the GUI writes, so both sides can read it.
		const written = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
		assert.equal(written.mode, "pi");
		assert.equal(typeof written.updatedAt, "string");
	});
});

test("a bare JSON string is accepted, so a shell can set it too", async () => {
	await withDir((dir) => {
		const path = decisionModePath(dir);
		writeFileSync(path, '"pi"\n');
		assert.equal(readDecisionMode(path).mode, "pi");
	});
});

test("a mode this build does not have falls back to the default and says why", async () => {
	await withDir((dir) => {
		const path = decisionModePath(dir);
		writeFileSync(path, '{"mode":"needle"}\n');
		const reading = readDecisionMode(path);
		assert.equal(reading.mode, "adapter");
		assert.equal(reading.source, "default");
		assert.match(reading.note ?? "", /names no known mode/);
		// The fallback must name the value it refused, or an operator cannot tell a typo
		// from a stale build.
		assert.match(reading.note ?? "", /needle/);
	});
});

test("malformed JSON falls back rather than refusing to supervise", async () => {
	await withDir((dir) => {
		const path = decisionModePath(dir);
		writeFileSync(path, '{"mode": "pi"');
		const reading = readDecisionMode(path);
		assert.equal(reading.mode, "adapter");
		assert.match(reading.note ?? "", /is not JSON/);
	});
});

test("a non-object falls back, and an array is not an object", async () => {
	await withDir((dir) => {
		const path = decisionModePath(dir);
		writeFileSync(path, "[]\n");
		assert.match(readDecisionMode(path).note ?? "", /is not a JSON object/);
		writeFileSync(path, "42\n");
		assert.match(readDecisionMode(path).note ?? "", /is not a JSON object/);
	});
});

test("an unreadable file falls back with the read error recorded", async () => {
	await withDir((dir) => {
		// A directory where the file should be: present, and impossible to read as a file.
		const path = join(dir, "decision-mode.json");
		mkdirSync(path);
		const reading = readDecisionMode(path);
		assert.equal(reading.mode, "adapter");
		assert.equal(reading.source, "default");
		assert.match(reading.note ?? "", /could not read/);
	});
});

test("the write is atomic: no temp file survives it, and a reader never sees a partial one", async () => {
	await withDir((dir) => {
		const path = decisionModePath(dir);
		writeDecisionMode(path, "pi");
		writeDecisionMode(path, "adapter");
		assert.deepEqual(
			readdirSync(dir).filter((entry) => entry.includes(".tmp")),
			[],
			"the rename leaves no temp file behind",
		);
		assert.equal(readDecisionMode(path).mode, "adapter");
	});
});

test("a failed rename removes its temp file instead of leaving litter", async () => {
	await withDir((dir) => {
		// A path whose parent does not exist: the write fails, and the temp file must not
		// be left in the directory the caller actually has.
		const missing = join(dir, "nope", "decision-mode.json");
		assert.throws(() => writeDecisionMode(missing, "pi"));
		assert.deepEqual(
			readdirSync(dir).filter((entry) => entry.includes(".tmp")),
			[],
			"a failed write cleans up after itself",
		);
	});
});
