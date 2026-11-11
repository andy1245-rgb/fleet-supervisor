// Corpus and secret guard. Fails if real session text or a credential is TRACKED.
// This repo is public, so "tracked" is the only line that matters: an ignored file
// on disk is private; a committed one is published and stays in history after a
// later delete.
//
// Named `check:corpus` in package.json. Never prints the matched text -- a guard
// that echoes what it found becomes the leak it was meant to stop.
//
// Two rule classes, deliberately:
//   * DATA files (*.jsonl, bench/results/**, bench/fixtures/**) may not carry session
//     text at all. A record cites its task-set sha; the rows themselves stay out of git.
//   * SOURCE files (*.ts, *.md, *.mjs, package.json) are allowed to name the schema
//     keys -- `"paneId"` in a type definition or a test example is not a leak -- but
//     never a credential.

import { execFileSync } from "node:child_process";

const CORPUS_PATHS = [/^mine\/out\//, /^bench\/tasks\/.*\.jsonl$/, /^finetune\/out\//, /^\.cache\//];

const SESSION_TEXT = [
	{ name: "decision-input", re: /"(paneId|claimState|idleTicks)"\s*:/ },
	{ name: "pane-id", re: /\bw[0-9]+:p[0-9]+\b/ },
	{ name: "session-id", re: /\bsession:[0-9a-f]{8,}\b/ },
	{ name: "terminal-tail", re: /"tail"\s*:\s*"[\s\S]{40,}/ },
];

const CREDENTIALS = [
	{ name: "openai-key", re: /\bsk-[A-Za-z0-9_-]{20,}/ },
	{ name: "github-token", re: /\b(ghp|gho|ghu|ghs)_[A-Za-z0-9]{20,}/ },
	{ name: "aws-key", re: /\bAKIA[0-9A-Z]{16}\b/ },
	{ name: "private-key", re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
	{ name: "slack-token", re: /\bxox[baprs]-[A-Za-z0-9-]{10,}/ },
	{ name: "basic-auth-url", re: /\/\/[^\s/:@]+:[^\s/@]+@[^\s/]+/ },
	// A literal assignment. Prose that merely contains the word is fine.
	{ name: "assigned-secret", re: /\b(api[_-]?key|secret|password|passwd)\b\s*[:=]\s*["'][^"']{16,}["']/i },
];

const PLACEHOLDER = /test|fake|dummy|example|placeholder|redacted|your[_-]?key|xxxx|\.\.\./i;

const DATA_FILE = /\.(jsonl|ndjson)$|^bench\/results\/|^bench\/fixtures\/|\.csv$/;

function tracked() {
	return execFileSync("git", ["ls-files", "-z"], { encoding: "utf8" }).split("\0").filter(Boolean);
}

function rulesFor(file) {
	const rules = [...CREDENTIALS];
	if (DATA_FILE.test(file)) rules.push(...SESSION_TEXT);
	return rules;
}

function body(file) {
	try {
		const buf = execFileSync("git", ["show", `HEAD:${file}`], { maxBuffer: 64 * 1024 * 1024 });
		return buf.subarray(0, 4096).includes(0) ? null : buf.toString("utf8");
	} catch {
		return null;
	}
}

const { readFileSync } = await import("node:fs");
const allowPath = new URL("./corpus-allowlist.txt", import.meta.url);
const allowed = new Set(
	readFileSync(allowPath, "utf8")
		.split("\n")
		.map((line) => line.replace(/#.*$/, "").trim())
		.filter(Boolean),
);

const files = tracked();
const findings = [];

for (const file of files) {
	if (allowed.has(file)) continue;
	for (const re of CORPUS_PATHS) {
		if (re.test(file)) findings.push({ file, line: 0, what: "corpus-path" });
	}
	const text = body(file);
	if (text === null) continue;
	const lines = text.split("\n");
	for (const { name, re } of rulesFor(file)) {
		const global = new RegExp(re.source, `${re.flags.replace("g", "")}g`);
		for (let i = 0; i < lines.length; i += 1) {
			const match = lines[i].match(global);
			if (!match) continue;
			const allowed = name !== "corpus-path" && PLACEHOLDER.test(match[0]);
			if (allowed) continue;
			findings.push({ file, line: i + 1, what: name });
			break;
		}
	}
}

if (findings.length === 0) {
	console.log(`check:corpus ok -- ${files.length} tracked files, no session text and no credentials`);
	process.exit(0);
}

console.error("check:corpus FAILED. These tracked files would publish content that must stay local:");
for (const f of findings) console.error(`  ${f.file}${f.line ? `:${f.line}` : ""}  (${f.what})`);
console.error("");
console.error("The matched text is not printed on purpose. Open the file yourself.");
console.error("Fix: git rm --cached <file>, add it to .gitignore. If it is already in history that is");
console.error("a separate decision -- rewriting public history -- and it is the operator's call.");
process.exit(1);
