// Where things are, and the three copies of the state-dir string this replaced.

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { agentFleetRoot, answerVerb, fixturePaths, notesDir, profilesFile, registryDir, stateDir, statePaths } from "../../src/fleet/where.ts";

test("the four paths, with their overrides and their defaults", () => {
	assert.equal(stateDir({}), join(homedir(), ".pi", "agent", "fleet-state"));
	assert.equal(stateDir({ AGENTFLEET_STATE_DIR: "/tmp/state" }), "/tmp/state");
	assert.equal(registryDir({}), join(homedir(), ".pi", "agent", "fleet"));
	assert.equal(registryDir({ AGENTFLEET_REGISTRY: "/tmp/claims" }), "/tmp/claims");
	assert.equal(profilesFile({}), join(homedir(), ".pi", "profiles", "config.json"));
	assert.equal(profilesFile({ FLEET_RULES_CONFIG: "/tmp/config.json" }), "/tmp/config.json");
	assert.equal(notesDir({}), join(homedir(), ".pi", "agent", "fleet-notes"));
	assert.equal(notesDir({ FLEET_NOTES_DIR: "/tmp/notes" }), "/tmp/notes");
});

test("an empty override is not an override", () => {
	// `AGENTFLEET_STATE_DIR=""` must not resolve to "" — an empty state dir would make every
	// join land in the cwd, which is how a supervisor writes into whatever directory it was
	// started from.
	assert.equal(stateDir({ AGENTFLEET_STATE_DIR: "" }), join(homedir(), ".pi", "agent", "fleet-state"));
});

test("the state files are named once, and the two toggles sit beside policy.json", () => {
	const paths = statePaths("/s");
	assert.deepEqual(paths, {
		dir: "/s",
		events: "/s/events.jsonl",
		asks: "/s/asks.jsonl",
		marks: "/s/marks.json",
		triggers: "/s/triggers.json",
		cooldowns: "/s/cooldowns.json",
		pending: "/s/pending.json",
		policy: "/s/policy.json",
		settings: "/s/settings.json",
		decisionMode: "/s/decision-mode.json",
	});
	const fixture = fixturePaths("/f");
	assert.equal(fixture.panes, "/f/panes.json");
	assert.equal(fixture.claims, "/f/claims");
});

test("every path is absolute, so a relative --data-dir cannot resolve against cwd twice", () => {
	const dir = mkdtempSync(join(tmpdir(), "fleet-where-"));
	try {
		for (const path of Object.values(statePaths(dir))) assert.equal(path.startsWith("/"), true);
		assert.equal(agentFleetRoot({}).startsWith("/"), true);
		assert.equal(answerVerb("/root", "ask-1", "yes").includes("/root/src/manager/answer.ts"), true);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
