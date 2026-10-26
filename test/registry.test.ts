import assert from "node:assert/strict";
import { test } from "node:test";
import type { TestContext } from "node:test";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readClaim, readClaims, writeClaim } from "../src/fleet/registry.ts";
import { claim, REPO } from "./fixtures.ts";

function tempRegistry(t: TestContext): string {
	const dir = mkdtempSync(join(tmpdir(), "agentfleet-registry-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	return dir;
}

function names(dir: string): string[] {
	return readdirSync(dir).sort();
}

test("writeClaim then readClaim round-trips every field", (t) => {
	const dir = tempRegistry(t);
	const written = claim("w2C:p1", {
		phase: "verify",
		state: "waiting",
		intent: "pin the pure modules",
		group: "alpha",
		acceptance: "npm test is green",
		last: "wrote test/registry.test.ts",
		budget: { runs: 3, tokens: 12000 },
		updated: "2020-01-01T00:00:00.000Z",
	});

	writeClaim(written, dir);
	const read = readClaim("w2C:p1", dir);
	assert.ok(read, "expected the claim back");

	assert.equal(read.paneId, "w2C:p1");
	assert.equal(read.cwd, REPO);
	assert.equal(read.intent, "pin the pure modules");
	assert.equal(read.phase, "verify");
	assert.equal(read.state, "waiting");
	assert.equal(read.last, "wrote test/registry.test.ts");
	assert.equal(read.group, "alpha");
	assert.equal(read.acceptance, "npm test is green");
	assert.deepEqual(read.budget, { runs: 3, tokens: 12000 });
	// writeClaim stamps `updated` itself rather than echoing the caller's value.
	assert.notEqual(read.updated, "2020-01-01T00:00:00.000Z");
	assert.match(read.updated, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
});

test("a claim with no optional fields round-trips without inventing them", (t) => {
	const dir = tempRegistry(t);
	writeClaim(claim("w2C:p1"), dir);

	const read = readClaim("w2C:p1", dir);
	assert.ok(read, "expected the claim back");
	assert.deepEqual(Object.keys(read).sort(), ["cwd", "intent", "last", "paneId", "phase", "state", "updated"]);
	assert.equal(read.group, undefined);
	assert.equal(read.acceptance, undefined);
	assert.equal(read.budget, undefined);
});

test("a partial budget survives as written", (t) => {
	const dir = tempRegistry(t);
	writeClaim(claim("w2C:p1", { budget: { tokens: 500 } }), dir);

	assert.deepEqual(readClaim("w2C:p1", dir)?.budget, { tokens: 500 });
});

test("readClaim on a pane with no file is undefined", (t) => {
	const dir = tempRegistry(t);

	assert.equal(readClaim("w2C:absent", dir), undefined);
	assert.equal(readClaim("w2C:absent", join(dir, "missing-directory")), undefined);
});

test("readClaims skips unparseable files and files with no paneId, and keys by paneId", (t) => {
	const dir = tempRegistry(t);
	writeClaim(claim("w2C:p1"), dir);
	writeClaim(claim("w2C:p2", { phase: "verify" }), dir);
	writeFileSync(join(dir, "broken.json"), '{ "paneId": "w2C:p9", this is not json');
	writeFileSync(join(dir, "nopane.json"), JSON.stringify({ cwd: REPO, intent: "no pane id here" }));
	writeFileSync(join(dir, "blank.json"), "");
	writeFileSync(join(dir, "notes.txt"), "not a claim file at all");

	const claims = readClaims(dir);

	assert.deepEqual([...claims.keys()].sort(), ["w2C:p1", "w2C:p2"]);
	assert.equal(claims.get("w2C:p1")?.paneId, "w2C:p1");
	assert.equal(claims.get("w2C:p2")?.phase, "verify");
	assert.equal(claims.has("w2C:p9"), false);
});

test("readClaims on a missing directory is empty rather than throwing", () => {
	assert.equal(readClaims(join(tmpdir(), "agentfleet-registry-does-not-exist")).size, 0);
});

test("readClaims keys by the paneId inside the file, not the filename", (t) => {
	const dir = tempRegistry(t);
	writeFileSync(join(dir, "whatever.json"), JSON.stringify(claim("w2C:p7")));

	const claims = readClaims(dir);
	assert.deepEqual([...claims.keys()], ["w2C:p7"]);
});

test("the filename sanitises colons so the pane id round-trips", (t) => {
	const dir = tempRegistry(t);
	writeClaim(claim("w2C:p1"), dir);

	assert.deepEqual(names(dir), ["w2C_p1.json"]);
	assert.equal(readClaim("w2C:p1", dir)?.paneId, "w2C:p1");
	assert.equal(readClaims(dir).get("w2C:p1")?.paneId, "w2C:p1");
});

test("writing twice leaves exactly one file per pane", (t) => {
	const dir = tempRegistry(t);
	writeClaim(claim("w2C:p1", { last: "first pass" }), dir);
	writeClaim(claim("w2C:p1", { last: "second pass" }), dir);

	assert.deepEqual(names(dir), ["w2C_p1.json"]);
	assert.equal(readClaim("w2C:p1", dir)?.last, "second pass");
});

test("writeClaim creates the registry directory when it is missing", (t) => {
	const dir = join(tempRegistry(t), "nested", "fleet");
	writeClaim(claim("w2C:p1"), dir);

	assert.deepEqual(names(dir), ["w2C_p1.json"]);
	assert.equal(readClaim("w2C:p1", dir)?.paneId, "w2C:p1");
});

test("two panes coexist without clobbering each other", (t) => {
	const dir = tempRegistry(t);
	writeClaim(claim("w2C:p1", { last: "one" }), dir);
	writeClaim(claim("w2C:p2", { last: "two" }), dir);

	assert.deepEqual(names(dir), ["w2C_p1.json", "w2C_p2.json"]);
	assert.equal(readClaims(dir).size, 2);
	assert.equal(readClaim("w2C:p1", dir)?.last, "one");
	assert.equal(readClaim("w2C:p2", dir)?.last, "two");
});
