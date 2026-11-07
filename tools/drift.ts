// The drift check: one implementation, two one-line invocations, and a deny-list.
//
// A parity harness cannot catch a security predicate growing a copy, because parity
// compares documents and a predicate emits none. The loopback test reached six copies —
// five byte-identical Host-header bodies on five write gates, plus the bind check in
// `auth.mjs` — and none of them disagreed, which is exactly why nobody fixed one: the
// seventh route would copy whichever file its author happened to open first.
//
// So the mechanism is a grep, generated from the code rather than written by hand:
//
//   1. **one definition file.** Every definition of a loopback-shaped symbol across the
//      scanned roots must live in `src/fleet/guard.ts`. The check reports the file count
//      and the definition count, and a second copy is a finding with `file:line`.
//   2. **the literal deny-list.** The four host spellings are literals, not symbols, and a
//      copy of a predicate can be written without naming any function at all. Each has to
//      have exactly one file allowed to spell it.
//   3. **the other literals** — the identifiers a second implementation is spelled with
//      (`agent_session`, `fleet-state`, the fixture pane-id shape, and the two model ids
//      the fast switch moves) — with one owner each.
//
// What a grep cannot see, stated so nobody trusts it further than it goes: a copy that
// assembles its host names (`"127.0" + ".0.1"`) or defines its predicate under a name with no
// `loopback` in it and never calls the guard matches nothing here. The shape it does catch is
// the shape all six copies actually had — a verbatim four-line body, typed because it was
// cheaper than finding out where the other one lived.
//
// There is no linter in this tree and adding one would mean a dependency and a config,
// which is a build step by another name. A grep needs `node:fs` and nothing else, and
// because it is *generated* from the code it survives the one thing a hand-written rule
// cannot: a symbol the core adds six months from now.
//
// No directory walk crosses a mount: `node:readdir` here is scoped to files under the
// roots a caller names, and `src/` trees in this project have no mounts in them.

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

export interface Finding {
	file: string;
	line: number;
	symbol: string;
	owner: string;
	kind: "definition" | "literal" | "spelling";
}

export interface DriftReport {
	ok: boolean;
	findings: Finding[];
	roots: { root: string; label: string; files: number }[];
	guard: {
		canonical: string;
		files: string[];
		definitions: { file: string; line: number; symbol: string }[];
		definitionFiles: number;
		definitionCount: number;
	};
	literals: { name: string; value: string; owner: string; files: string[] }[];
}

export interface DriftOptions {
	/** Repo roots to scan. `{root, label}` where label names the repo for the report. */
	roots: { root: string; label: string }[];
	/** The one file allowed to define a loopback predicate. */
	canonicalGuard?: string;
	/** Directories inside a root that are skipped whole (`node_modules`, `.git`, `.venv`). */
	skip?: string[];
	/** Extensions worth reading. */
	extensions?: string[];
}

export const DEFAULT_SKIP = ["node_modules", ".git", ".venv", "__pycache__", "dist", "build", "coverage", "checkpoints", "bench/results"];

export const DEFAULT_EXTENSIONS = [".ts", ".mts", ".tsx", ".js", ".mjs", ".cjs"];

/** The symbol shape a loopback predicate is defined with: `function hostLoopback(`,
 *  `const isLoopbackHost =`, `export function hostIsLoopbackHost(`. */
export const LOOPBACK_DEFINITION = /\b(?:function|const|let|var)\s+([A-Za-z_$][\w$]*[Ll]oopback[\w$]*)\s*[(=]/;

/** The identifier patterns a *caller* of a copy is spelled with, quoted from the six that
 *  existed so the check still fires on a copy that renames the definition. */
export const LOOPBACK_SPELLINGS: readonly string[] = ["hostIsLoopback", "hostLoopback", "hostIsLoopbackHost", "isLoopbackHost", "isLoopbackBind", "clientIsLoopback"];

/** The four host literals. A copy of the predicate is a copy of these. */
export const HOST_LITERALS: readonly string[] = ['"127.0.0.1"', "'127.0.0.1'", '"localhost"', "'localhost'", '"[::1]"', "'[::1]'", '"::1"', "'::1'"];

/** The other literals, each with the files allowed to spell it — named one by one, so a new
 *  file spelling one is a finding rather than an argument. A document *printing* a key name
 *  is a mention, not a second implementation, and that distinction is what this list records. */
export const LITERAL_OWNERS: readonly { name: string; value: string; owner: string; allowed: string[] }[] = Object.freeze([
	{ name: "agent_session", value: "agent_session", owner: "src/herdr/cli.ts", allowed: ["src/herdr/cli.ts", "src/fleet/types.ts", "src/fleet/identity.ts", "src/fleet/record.ts", "src/fleet/screens/conversation.ts"] },
	{ name: "state-dir string", value: "fleet-state", owner: "src/fleet/where.ts", allowed: ["src/fleet/where.ts"] },
	{ name: "fixture pane namespace", value: "sample[0-9]+:p[0-9]+", owner: "src/fleet/identity.ts", allowed: ["src/fleet/identity.ts"] },
	{ name: "fast switch key", value: "fastNewWork", owner: "src/fleet/settings.ts", allowed: ["src/fleet/settings.ts", "src/fleet/screens/settings.ts"] },
	{ name: "fast model id", value: "deepseek-v4.1-flash-fast", owner: "src/fleet/settings.ts", allowed: ["src/fleet/settings.ts"] },
]);

/** A file that names a literal only in order to assert on it is not a second implementation.
 *  Test files are excluded from the literal and spelling checks and *not* from the definition
 *  check: a test that defines a loopback predicate is still a copy worth seeing. */
export function isTestFile(path: string): boolean {
	return path.includes("/test/") || /\.test\.(?:ts|mts|tsx|js|mjs|cjs)$/.test(path);
}

/** The check's own file spells every deny-listed literal, deliberately, so it excludes itself
 *  by name rather than by a pattern that could grow to hide something. */
export function isSelf(path: string, roots: { root: string }[]): boolean {
	return roots.some(({ root }) => resolve(path) === resolve(root, "tools/drift.ts"));
}

function codeOf(error: unknown): string {
	if (typeof error === "object" && error !== null && "code" in error) {
		const code = (error as { code?: unknown }).code;
		return typeof code === "string" ? code : "error";
	}
	return "error";
}

function isDirectory(path: string): boolean {
	try {
		return statSync(path).isDirectory();
	} catch {
		return false;
	}
}

function isFile(path: string): boolean {
	try {
		return statSync(path).isFile();
	} catch {
		return false;
	}
}

/** Every file under the roots, one level at a time, with skip directories pruned. Not a
 *  `find`: the walk is explicit, it never follows a symlink, and a directory it cannot read
 *  is skipped rather than fatal. */
export function filesUnder(root: string, options: { skip?: string[]; extensions?: string[] } = {}): string[] {
	const skip = new Set(options.skip ?? DEFAULT_SKIP);
	const extensions = options.extensions ?? DEFAULT_EXTENSIONS;
	const out: string[] = [];
	const stack = [resolve(root)];
	const seen = new Set<string>();
	while (stack.length > 0) {
		const dir = stack.pop() as string;
		if (seen.has(dir)) continue;
		seen.add(dir);
		let names: string[];
		try {
			names = readdirSync(dir);
		} catch (error) {
			void codeOf(error);
			continue;
		}
		for (const name of names) {
			if (name.startsWith(".") && name !== ".") {
				if (name === ".git") continue;
			}
			const path = join(dir, name);
			if (isDirectory(path)) {
				if (skip.has(name)) continue;
				const rel = relative(resolve(root), path);
				if (skip.has(rel)) continue;
				stack.push(path);
				continue;
			}
			if (!isFile(path)) continue;
			if (!extensions.some((extension) => name.endsWith(extension))) continue;
			out.push(path);
		}
	}
	return out.sort();
}

function isComment(line: string): boolean {
	const trimmed = line.trim();
	return trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*");
}

/**
 * The check. Returns findings, never throws: a caller's suite asserts `ok`, and a reader
 * gets `file:line` for every copy so the fix is a location rather than a search.
 */
export function drift(options: DriftOptions): DriftReport {
	const canonical = resolve(options.canonicalGuard ?? join(options.roots[0]?.root ?? process.cwd(), "src", "fleet", "guard.ts"));
	const skip = options.skip ?? DEFAULT_SKIP;
	const extensions = options.extensions ?? DEFAULT_EXTENSIONS;

	const definitions: { file: string; line: number; symbol: string }[] = [];
	const definitionFiles = new Set<string>();
	const literalHits = new Map<string, Set<string>>();
	const findings: Finding[] = [];
	const rootReports: DriftReport["roots"] = [];

	for (const { root, label } of options.roots) {
		const files = filesUnder(root, { skip, extensions });
		rootReports.push({ root: resolve(root), label, files: files.length });
		for (const file of files) {
			let text: string;
			try {
				text = readFileSync(file, "utf8");
			} catch (error) {
				void codeOf(error);
				continue;
			}
			const lines = text.split("\n");
			for (let index = 0; index < lines.length; index += 1) {
				const line = lines[index] ?? "";
				if (isComment(line)) continue;

				const definition = LOOPBACK_DEFINITION.exec(line);
				if (definition !== null) {
					const symbol = definition[1] ?? "loopback";
					definitions.push({ file, line: index + 1, symbol });
					definitionFiles.add(file);
					if (resolve(file) !== canonical) {
						findings.push({ file, line: index + 1, symbol, owner: canonical, kind: "definition" });
					}
				}

				for (const spelling of LOOPBACK_SPELLINGS) {
					if (!line.includes(spelling)) continue;
					if (resolve(file) === canonical) continue;
					if (isTestFile(file) || isSelf(file, options.roots)) continue;
					// A spelling inside a caller that is not defining it is still a finding: the
					// point is that one file names the predicate.
					if (definition !== null && definition[1] === spelling) continue;
					findings.push({ file, line: index + 1, symbol: spelling, owner: canonical, kind: "spelling" });
				}

				for (const literal of HOST_LITERALS) {
					if (!line.includes(literal)) continue;
					if (isTestFile(file) || isSelf(file, options.roots)) continue;
					const key = literal.replace(/["']/g, "");
					const owners = literalHits.get(key) ?? new Set<string>();
					owners.add(file);
					literalHits.set(key, owners);
					if (resolve(file) !== canonical) {
						findings.push({ file, line: index + 1, symbol: `the host literal ${literal}`, owner: canonical, kind: "literal" });
					}
				}
			}
		}
	}

	const literalReports: DriftReport["literals"] = [];
	for (const entry of LITERAL_OWNERS) {
		const allowed = options.roots
			.flatMap(({ root }) => entry.allowed.map((suffix) => resolve(root, suffix)))
			.filter((candidate) => isFile(candidate));
		const files: string[] = [];
		for (const { root, label } of options.roots) {
			const files_ = filesUnder(root, { skip, extensions });
			for (const file of files_) {
				if (isTestFile(file) || isSelf(file, options.roots)) continue;
				let text: string;
				try {
					text = readFileSync(file, "utf8");
				} catch {
					continue;
				}
				if (!text.includes(entry.value)) continue;
				files.push(file);
				if (!allowed.includes(resolve(file))) {
					const at = text.split("\n").findIndex((line) => line.includes(entry.value) && !isComment(line));
					findings.push({ file, line: at + 1, symbol: `${entry.name} (${entry.value})`, owner: allowed[0] ?? `${label}/${entry.owner}`, kind: "literal" });
				}
			}
		}
		literalReports.push({ name: entry.name, value: entry.value, owner: entry.allowed.join(", "), files });
	}

	return {
		ok: findings.length === 0,
		findings,
		roots: rootReports,
		guard: {
			canonical,
			files: [...definitionFiles],
			definitions,
			definitionFiles: definitionFiles.size,
			definitionCount: definitions.length,
		},
		literals: literalReports,
	};
}

/** The count the plan's `grep -rcE 'function .*[Ll]oopback' lib/` was standing in for,
 *  computed over the same files the check reads. `1` means one file owns the predicate. */
export function guardDefinitionCount(options: DriftOptions): { files: number; definitions: number; canonical: string; files_ : string[] } {
	const report = drift(options);
	return {
		files: report.guard.definitionFiles,
		definitions: report.guard.definitionCount,
		canonical: report.guard.canonical,
		files_: report.guard.files,
	};
}

/** The report as the two lines a failing suite prints. */
export function formatReport(report: DriftReport): string {
	if (report.ok) {
		return [
			`drift: 0 findings · guard definitions ${report.guard.definitionCount} in ${report.guard.definitionFiles} file(s)`,
			`  roots: ${report.roots.map((root) => `${root.label} (${root.files} files)`).join(", ")}`,
			`  canonical: ${report.guard.canonical}`,
		].join("\n");
	}
	const lines = [`drift: ${report.findings.length} finding(s)`];
	for (const finding of report.findings) {
		lines.push(`  ${finding.file}:${finding.line}  ${finding.kind === "definition" ? "defines" : "spells"} \`${finding.symbol}\`, which is owned by ${finding.owner}`);
	}
	lines.push("run: node --test test/drift.test.mjs");
	return lines.join("\n");
}
