import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const TASKS = join(ROOT, "bench", "tasks");
const RESULTS = join(ROOT, "bench", "results");

function sha16(bytes: Buffer | string): string {
	return createHash("sha256").update(bytes).digest("hex").slice(0, 16);
}

/** Frozen snapshots are named `<date>.<sha16>.jsonl`; the sha in the name is the
 *  file's own sha256 prefix, so the name is a checkable claim rather than a label. */
function frozen(): Map<string, string> {
	const found = new Map<string, string>();
	if (!existsSync(TASKS)) return found;
	for (const name of readdirSync(TASKS)) {
		const match = /\.([0-9a-f]{16})\.jsonl$/.exec(name);
		if (match?.[1]) found.set(match[1], join(TASKS, name));
	}
	return found;
}

interface CitedRecord {
	name: string;
	taskSetSha?: string;
	taskSetPath?: string;
}

function records(): CitedRecord[] {
	const out: CitedRecord[] = [];
	for (const name of readdirSync(RESULTS)) {
		if (!name.endsWith(".json")) continue;
		const record = JSON.parse(readFileSync(join(RESULTS, name), "utf8")) as CitedRecord;
		out.push({ name, taskSetSha: record.taskSetSha, taskSetPath: record.taskSetPath });
	}
	return out;
}

/** The corpus is private. This guards the index only: it stops the rows coming back
 *  the next time someone runs `git add -A`, which is how they got in. It says nothing
 *  about history — a clone takes the object store, not the index — so the real
 *  guarantee is the `todo` test at the foot of this file, which fails until the
 *  history is rewritten. */
test("no task-set rows are tracked at HEAD", (t) => {
	let tracked: string[];
	try {
		tracked = execFileSync("git", ["ls-files", "--", "bench/tasks"], { cwd: ROOT, encoding: "utf8" })
			.split("\n")
			.filter((line) => line.trim() !== "");
	} catch {
		t.skip("git is unavailable, so tracked paths cannot be checked");
		return;
	}
	const leaked = tracked.filter((path) => path.endsWith(".jsonl"));
	assert.deepEqual(
		leaked,
		[],
		`task-set rows are tracked (${leaked.join(", ")}); the corpus is private and must stay out of the tree`,
	);
});

test("any task set present locally hashes to the sha its filename and the records claim", (t) => {
	const snapshot = frozen();
	if (snapshot.size === 0) {
		t.skip("no local task set is present, which is the published state");
		return;
	}
	const cited = new Set(records().map((record) => record.taskSetSha).filter(Boolean));
	for (const [sha, file] of snapshot) {
		assert.equal(sha16(readFileSync(file)), sha, `${file} does not hash to the sha its filename claims`);
		assert.ok(
			cited.has(sha),
			`${file} is a task set no record cites, so it is stale or was never measured against`,
		);
	}
});

test("a record naming a local taskset path names bytes that hash to the sha it cites", () => {
	for (const record of records()) {
		if (!record.taskSetPath) continue;
		const absolute = join(ROOT, record.taskSetPath);
		// Absent is the intended published state: the corpus is supplied out of band,
		// so a missing file is not a failure — a present one that does not match is.
		if (!existsSync(absolute)) continue;
		assert.equal(
			sha16(readFileSync(absolute)),
			record.taskSetSha,
			`${record.name} names ${record.taskSetPath}, whose bytes do not hash to the sha the record cites`,
		);
	}
});

/** The property that actually decides whether the corpus ships, and the one the guard
 *  above cannot see: untracking a file hides it from the index, while every earlier
 *  blob stays reachable from HEAD, so a clone still carries the rows.
 *
 *  This was a `todo` until the history was rewritten on 2026-11-04
 *  (`git filter-repo --invert-paths --path bench/tasks/tasks.jsonl`). It is now a
 *  plain assertion, so putting the path back into any commit turns the suite red. */
test("no corpus blob is reachable from HEAD", () => {
	let reachable: string[];
	try {
		reachable = execFileSync("git", ["rev-list", "HEAD", "--", "bench/tasks/tasks.jsonl"], {
			cwd: ROOT,
			encoding: "utf8",
		})
			.split("\n")
			.filter((line) => line.trim() !== "");
	} catch {
		return;
	}
	assert.deepEqual(
		reachable,
		[],
		`bench/tasks/tasks.jsonl is reachable from HEAD in ${reachable.length} commit(s). .gitignore keeps it out of the index, but a clone takes the object store and still gets the rows — this needs the history rewrite, not another ignore rule`,
	);
});
