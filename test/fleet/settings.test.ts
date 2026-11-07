// The settings store: one atomic writer, two toggles, and a fast switch that records what it
// moved so switching off puts back only that.
//
// The bug worth testing for is the blind reverse: a profile can legitimately contain tiers
// that are fast on purpose, and "turn fast off" implemented as "replace every -fast id with
// its base" rewrites the very thing the switch exists to select.

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
	applyFastToProfile,
	decisionModeState,
	fastModelFor,
	fastState,
	fastVariantOf,
	mergeJsonAtomic,
	readApplied,
	readFastSetting,
	restoreFromApplied,
	setFast,
	unfastVariantOf,
	writeDecisionMode,
	writeJsonAtomic,
} from "../../src/fleet/settings.ts";
import { DEFAULT_DECISION_MODE, readDecisionMode } from "../../src/decision/mode.ts";

function tempDir(): string {
	return mkdtempSync(join(tmpdir(), "fleet-settings-"));
}

test("writeJsonAtomic writes a sibling and renames over the target", () => {
	const dir = tempDir();
	try {
		const path = join(dir, "a.json");
		writeJsonAtomic(path, { a: 1 });
		assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), { a: 1 });
		writeJsonAtomic(path, { a: 2 });
		assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), { a: 2 });
		// Nothing left behind: a temp file on disk is a second reader's torn read.
		assert.deepEqual(readFileSync(path, "utf8").endsWith("\n"), true);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("mergeJsonAtomic preserves the keys it does not own", () => {
	const dir = tempDir();
	try {
		const path = join(dir, "s.json");
		writeJsonAtomic(path, { keep: true, replace: 1 });
		mergeJsonAtomic(path, { replace: 2 });
		assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), { keep: true, replace: 2 });
		// An absent file is replaced rather than treated as an error.
		mergeJsonAtomic(join(dir, "missing.json"), { a: 1 });
		assert.deepEqual(JSON.parse(readFileSync(join(dir, "missing.json"), "utf8")), { a: 1 });
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("the decision mode: default when absent, file when set, reason when unusable", () => {
	const dir = tempDir();
	try {
		const absent = decisionModeState(dir);
		assert.equal(absent.mode, DEFAULT_DECISION_MODE);
		assert.equal(absent.source, "default");
		assert.equal(absent.updatedAt, null);

		const written = writeDecisionMode({ mode: "pi", stateDir: dir });
		assert.equal(written.ok, true);
		assert.equal(written.before, "adapter");
		assert.equal(written.after, "pi");
		const fromFile = decisionModeState(dir);
		assert.equal(fromFile.mode, "pi");
		assert.equal(fromFile.source, "file");
		assert.equal(typeof fromFile.updatedAt, "string");
		// The supervisor's own reader agrees with the document's.
		assert.equal(readDecisionMode(absent.path).mode, "pi");

		const bad = writeDecisionMode({ mode: "turbo" as never, stateDir: dir });
		assert.equal(bad.ok, false);
		assert.equal(bad.code, "bad_mode");
		assert.deepEqual(bad.allowed, ["adapter", "pi"]);

		writeFileSync(absent.path, "not json");
		const broken = decisionModeState(dir);
		assert.equal(broken.mode, DEFAULT_DECISION_MODE);
		assert.match(broken.note ?? "", /not JSON/);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("the fast switch: off unless the file says true, and a non-boolean is reported", () => {
	const dir = tempDir();
	try {
		const state = fastState(dir);
		assert.equal(state.fast, false);
		assert.equal(state.source, "default");
		assert.equal(state.chatModel.includes("-fast"), false);

		writeJsonAtomic(state.path, { fastNewWork: true });
		assert.equal(fastState(dir).fast, true);
		assert.equal(fastState(dir).chatModel.includes("-fast"), true);

		writeJsonAtomic(state.path, { fastNewWork: "yes" });
		const coerced = readFastSetting(state.path);
		assert.equal(coerced.fast, false);
		assert.match(coerced.note ?? "", /non-boolean/);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("the variant table moves two ids and nothing else", () => {
	assert.equal(fastVariantOf("deepseek/deepseek-v4.1-flash"), "deepseek/deepseek-v4.1-flash-fast");
	assert.equal(fastVariantOf("deepseek/deepseek-v4.1-flash-fast"), "deepseek/deepseek-v4.1-flash-fast");
	assert.equal(fastVariantOf("deepseek/deepseek-v4-pro"), null, "v4-pro has no fast variant and stays where it is");
	assert.equal(fastVariantOf("deepseek/deepseek-v4.1-flash-ultrafast"), null, "ultrafast is a different model, not a faster one");
	assert.equal(unfastVariantOf("deepseek/deepseek-v4.1-flash-fast"), "deepseek/deepseek-v4.1-flash");
	assert.equal(unfastVariantOf("deepseek/deepseek-v4.1-flash"), null);
	assert.equal(fastModelFor("commandcode", "deepseek/deepseek-v4.1-flash"), "commandcode/deepseek/deepseek-v4.1-flash-fast");
	assert.equal(fastModelFor("commandcode", "deepseek/deepseek-v4-pro"), null);
});

test("switching off restores only what it moved", () => {
	const config = {
		profiles: {
			solo: {
				tiers: [
					{ name: "cheap", model: "commandcode/deepseek/deepseek-v4.1-flash" },
					{ name: "fast", model: "commandcode/deepseek/deepseek-v4.1-flash-fast" },
					{ name: "hard", model: "anthropic/claude-opus" },
				],
			},
		},
	};
	const on = applyFastToProfile(config, "solo", true);
	// `cheap` moved, `fast` was already fast, `hard` has no variant.
	assert.deepEqual(on.changed, ["cheap: commandcode/deepseek/deepseek-v4.1-flash -> commandcode/deepseek/deepseek-v4.1-flash-fast"]);
	assert.equal(on.skipped.length, 1);
	assert.match(on.skipped[0] ?? "", /no model|no fast variant/);

	// Switching off is the restore path, not the reverse transform: a blind reverse would also
	// rewrite the tier named `fast`, which is fast on purpose. Only the ledger is put back.
	const restored = restoreFromApplied(on.config, [
		{ profile: "solo", tier: "cheap", from: "commandcode/deepseek/deepseek-v4.1-flash", to: "commandcode/deepseek/deepseek-v4.1-flash-fast" },
	]);
	const tiers = (restored.config.profiles?.solo as { tiers: { name: string; model: string }[] }).tiers;
	assert.equal(tiers.find((tier) => tier.name === "cheap")?.model, "commandcode/deepseek/deepseek-v4.1-flash");
	assert.equal(tiers.find((tier) => tier.name === "fast")?.model, "commandcode/deepseek/deepseek-v4.1-flash-fast", "the deliberately-fast tier is left alone");
	assert.equal(restored.restored.length, 1);
	assert.deepEqual(restored.missing, []);

	// A ledger row for a tier that has since been re-rendered is named, never resurrected.
	const gone = restoreFromApplied(on.config, [{ profile: "solo", tier: "deleted-tier", from: "x" }]);
	assert.deepEqual(gone.restored, []);
	assert.match(gone.missing[0] ?? "", /tier is gone/);
});

test("setFast writes the setting, the ledger, and the profile — in that order", () => {
	const dir = tempDir();
	try {
		const stateDir = join(dir, "state");
		const profilePath = join(dir, "config.json");
		writeFileSync(
			profilePath,
			JSON.stringify({ profiles: { solo: { tiers: [{ name: "cheap", model: "commandcode/deepseek/deepseek-v4.1-flash" }] } } }, null, "\t"),
		);

		const on = setFast({ fast: true, stateDir, profilePath });
		assert.equal(on.ok, true);
		assert.equal(on.changed.length, 1);
		const profile = JSON.parse(readFileSync(profilePath, "utf8")) as { profiles: { solo: { tiers: { model: string }[] } } };
		assert.equal(profile.profiles.solo.tiers[0]?.model, "commandcode/deepseek/deepseek-v4.1-flash-fast");
		const ledger = readApplied(join(stateDir, "fast.json"));
		assert.equal(ledger.length, 1);

		const off = setFast({ fast: false, stateDir, profilePath });
		assert.equal(off.ok, true);
		const restored = JSON.parse(readFileSync(profilePath, "utf8")) as { profiles: { solo: { tiers: { model: string }[] } } };
		assert.equal(restored.profiles.solo.tiers[0]?.model, "commandcode/deepseek/deepseek-v4.1-flash");
		assert.deepEqual(readApplied(join(stateDir, "fast.json")), []);

		const bad = setFast({ fast: "yes" as never, stateDir, profilePath });
		assert.equal(bad.ok, false);
		assert.equal(bad.code, "bad_value");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a profile that does not exist leaves the switch set and says so", () => {
	const dir = tempDir();
	try {
		const result = setFast({ fast: true, stateDir: join(dir, "state"), profilePath: join(dir, "nope.json") });
		assert.equal(result.ok, true);
		assert.equal(result.fast, true);
		assert.match(result.note ?? "", /does not exist/);
		assert.equal(readFastSetting(join(dir, "state", "fast.json")).fast, true);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
