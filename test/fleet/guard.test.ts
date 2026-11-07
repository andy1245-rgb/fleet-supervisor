// The one loopback predicate, and the count that keeps it one.
//
// Two things are tested here and they are different: the predicate's own truth table (a
// security test that says yes to `example.com` is a hole, not a bug), and the mechanism that
// stops a seventh copy. The second is why this file imports `tools/drift.ts`: a copy fails
// the definition count, and the count is asserted in the suite rather than in a report.

import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { HOST_SPELLINGS, SYMBOL_PATTERNS, clientIsLoopback, isLoopbackBind, isLoopbackHost, requireLoopback } from "../../src/fleet/guard.ts";
import { drift, guardDefinitionCount } from "../../tools/drift.ts";

const ROOT = new URL("../..", import.meta.url).pathname.replace(/\/$/, "");

test("the Host header test is narrow on purpose", () => {
	// A bracketed IPv6 literal keeps its brackets through the port strip, so `[::1]` and
	// `[::1]:8080` are the two legal spellings. A bare `::1` is not a legal Host header, and
	// the six deleted copies did not accept one either: preserving their behaviour is the point
	// of a port, so this predicate does not quietly get wider than they were.
	for (const host of ["127.0.0.1", "127.0.0.1:8080", "localhost", "localhost:3000", "[::1]", "[::1]:8080", "LOCALHOST"]) {
		assert.equal(isLoopbackHost(host), true, `${host} is loopback`);
	}
	for (const host of [null, undefined, "", "example.com", "example.com:80", "10.0.0.1", "127.0.0.2", "0.0.0.0", "::", "::1", "[::1", "localhost.example.com", "127.0.0.1.nip.io"]) {
		assert.equal(isLoopbackHost(host), false, `${String(host)} is not loopback`);
	}
});

test("the bind test takes all of 127/8, because a bind address cannot be forged", () => {
	for (const host of ["127.0.0.1", "127.0.0.2", "127.1.2.3", "::1", "[::1]", "localhost"]) {
		assert.equal(isLoopbackBind(host), true, `${host} is a loopback bind`);
	}
	for (const host of [null, "", "0.0.0.0", "::", "100.115.189.66", "192.168.1.4"]) {
		assert.equal(isLoopbackBind(host), false, `${String(host)} is not a loopback bind`);
	}
});

test("the peer address is a fact for a sentence, never a gate", () => {
	assert.equal(clientIsLoopback("127.0.0.1"), true);
	assert.equal(clientIsLoopback("::ffff:127.0.0.1"), true);
	assert.equal(clientIsLoopback("::1"), true);
	assert.equal(clientIsLoopback("100.115.189.66"), false);
	assert.equal(clientIsLoopback(null), false);
});

test("requireLoopback is one call with one refusal code", () => {
	const loopback = requireLoopback({ headers: { host: "127.0.0.1:7777" } });
	assert.equal(loopback, null);

	const remote = requireLoopback({ headers: { host: "example.com" }, socket: { remoteAddress: "10.0.0.9" } });
	assert.notEqual(remote, null);
	assert.equal(remote?.ok, false);
	assert.equal(remote?.code, "not_loopback");
	assert.equal(remote?.status, 403);
	assert.equal(remote?.host, "example.com");
	assert.equal(remote?.remoteAddress, "10.0.0.9");

	const missing = requireLoopback({ headers: {} });
	assert.equal(missing?.code, "not_loopback");

	// `--allow-remote-writes` is an input to the predicate, not a second predicate.
	assert.equal(requireLoopback({ headers: { host: "example.com" } }, { allowRemoteWrites: true }), null);

	// A repeated Host header is not trusted into a string.
	assert.equal(requireLoopback({ headers: { host: ["127.0.0.1", "example.com"] } }), null);
	assert.equal(requireLoopback({ headers: { host: ["example.com", "127.0.0.1"] } })?.code, "not_loopback");
});

test("the guard and the deny-list agree about which spellings are theirs", () => {
	for (const spelling of SYMBOL_PATTERNS) assert.equal(typeof spelling, "string");
	// The list is the four names the six copies compared against; two of them are the legal
	// spellings of an IPv6 loopback and two are the v4/name spellings.
	assert.deepEqual([...HOST_SPELLINGS], ["127.0.0.1", "localhost", "[::1]", "::1"]);
	assert.equal(isLoopbackHost("127.0.0.1"), true);
	assert.equal(isLoopbackHost("localhost"), true);
	assert.equal(isLoopbackHost("[::1]"), true);
});

test("exactly one file defines a loopback predicate", () => {
	const report = drift({ roots: [{ root: ROOT, label: "agentFleet" }] });
	const guard = report.guard;
	assert.equal(guard.definitionFiles, 1, `expected one definition file, got ${guard.files.join(", ")}`);
	assert.equal(guard.canonical, join(ROOT, "src", "fleet", "guard.ts"));
	for (const definition of guard.definitions) {
		assert.equal(definition.file, guard.canonical, `${definition.symbol} is defined outside the guard at ${definition.file}:${definition.line}`);
	}
	// The count the plan's `grep -cE 'function .*[Ll]oopback'` was standing in for.
	const count = guardDefinitionCount({ roots: [{ root: ROOT, label: "agentFleet" }] });
	assert.equal(count.files, 1);
	assert.equal(count.definitions, guard.definitions.length);
});

test("a deliberate second copy turns the check red, and removing it turns it green", () => {
	const dir = mkdtempSync(join(tmpdir(), "fleet-copy-"));
	try {
		// A copy that renames the definition but keeps the shape and the host list: the case a
		// symbol-only deny-list would miss. The declaration is assembled from parts so *this* file
		// does not carry a line the check matches — the scan reads every file in the roots, tests
		// included, which is what stops a copy hiding in one.
		const declaration = ["export", "function", "isLoopbackAny(hostHeader) {"].join(" ");
		const copy = [
			"// a seventh copy, written the way the first six were",
			declaration,
			"\tif (!hostHeader) return false;",
			"\tconst name = hostHeader.replace(/:\\d+$/, \"\").toLowerCase();",
			"\treturn name === \"127.0.0.1\" || name === \"localhost\" || name === \"[::1]\" || name === \"::1\";",
			"}",
			"",
		].join("\n");
		mkdirSync(join(dir, "lib"), { recursive: true });
		writeFileSync(join(dir, "lib", "http.mjs"), copy);

		const red = drift({ roots: [{ root: ROOT, label: "agentFleet" }, { root: dir, label: "copy" }] });
		assert.equal(red.ok, false, "a second copy must make the check fail");
		assert.equal(red.guard.definitionFiles, 2, "two files now define a loopback predicate");
		const finding = red.findings.find((entry) => entry.file.endsWith("lib/http.mjs"));
		assert.notEqual(finding, undefined, "the copy is reported with its file and line");
		assert.equal(finding?.line, 2);

		// A copy that names nothing loopback-shaped: the host literals are what catch it. (A grep
		// cannot see a concatenated literal, and `drift.ts` says so; the shape this catches is the
		// one all six copies actually had.)
		writeFileSync(join(dir, "lib", "gate.mjs"), "export const LOCAL = [\"127.0.0.1\", \"localhost\"];\nexport const isLocal = (h) => LOCAL.includes(h);\n");
		const redAgain = drift({ roots: [{ root: ROOT, label: "agentFleet" }, { root: dir, label: "copy" }] });
		assert.equal(redAgain.ok, false, "the host spellings are deny-listed as literals, not only as symbols");
		assert.notEqual(redAgain.findings.find((entry) => entry.file.endsWith("lib/gate.mjs")), undefined);

		rmSync(join(dir, "lib", "http.mjs"));
		rmSync(join(dir, "lib", "gate.mjs"));
		const green = drift({ roots: [{ root: ROOT, label: "agentFleet" }, { root: dir, label: "copy" }] });
		assert.equal(green.ok, true, `expected no findings after removing the copies, got ${JSON.stringify(green.findings)}`);
		assert.equal(green.guard.definitionFiles, 1);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
