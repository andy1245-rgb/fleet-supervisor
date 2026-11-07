// The drift check, run as a suite.
//
// Six lines and no logic: the check itself is `tools/drift.ts`, which is erasable TypeScript
// imported like everything else in this tree. A second copy of the check would be the disease it
// exists to catch, so this file asserts and prints and does nothing else.
//
// It fails on the mechanism, not on a list: a new file defining a loopback predicate, or spelling
// one of the four host names outside `src/fleet/guard.ts`, turns this red with `file:line`.

import assert from "node:assert/strict";
import { test } from "node:test";

import { formatReport, guardDefinitionCount, drift } from "../tools/drift.ts";

const ROOT = new URL("..", import.meta.url).pathname.replace(/\/$/, "");

test("drift: 0 findings across this repo", () => {
	const roots = [{ root: ROOT, label: "agentFleet" }];
	const report = drift({ roots });
	assert.equal(report.ok, true, formatReport(report));
	assert.deepEqual(report.findings, []);
	assert.equal(report.roots[0]?.files > 0, true, "the check read something");
});

test("drift: the guard has one definition file", () => {
	const count = guardDefinitionCount({ roots: [{ root: ROOT, label: "agentFleet" }] });
	assert.equal(count.files, 1, `loopback predicates are defined in ${count.files} files: ${count.files_.join(", ")}`);
	assert.equal(count.definitions >= 3, true, "the three predicates are all in guard.ts");
	assert.equal(count.canonical.endsWith("src/fleet/guard.ts"), true);
});
