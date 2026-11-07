// The path guard, and the refusal codes that make a start testable without a process.
//
// This is the rule PLAN-v1 D2 picks out by name: `resolveStartDir`'s home containment moves into
// the core, so the route and the verb cannot disagree. The page refuses `/tmp`; the terminal now
// refuses it too unless the verb's own `--allow-outside-home` was given — and that flag is
// declared on the verb and never settable through a route, which is what keeps the stricter rule
// the one both surfaces share.

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { DIR_MAX, planStart, resolveStartDir, startDirectoryOptions, startVerb } from "../../src/fleet/start.ts";
import type { Ctx, Row, Source } from "../../src/fleet/types.ts";

function row(paneId: string, overrides: Partial<Row> = {}): Row {
	return {
		pane_id: paneId,
		workspace_id: "w1",
		tab_id: "w1:t1",
		agent: "pi",
		agent_status: "idle",
		cwd: "/home/andrew/work",
		foreground_cwd: "/home/andrew/work",
		focused: false,
		label: null,
		revision: 1,
		terminal_id: "term",
		terminal_title: "",
		terminal_title_stripped: "",
		agent_session: null,
		completion_seq: 1,
		state_change_seq: 1,
		...overrides,
	};
}

function ctxWith(panes: Row[], options: { mode?: "live" | "fixture"; enableChat?: boolean; home?: string } = {}): Ctx {
	const source = { mode: options.mode ?? "live", panes: { origin: "herdr", panes, reason: null }, claims: { claims: new Map() } } as unknown as Source;
	return {
		opts: { enableChat: options.enableChat ?? true, home: options.home ?? "/home/andrew", herdr: true, agentFleetRoot: "/home/andrew/agentFleet" },
		source,
	} as unknown as Ctx;
}


test("the path guard is home containment, and --allow-outside-home is the only way past it", () => {
	const dir = mkdtempSync(join(tmpdir(), "fleet-start-"));
	try {
		const home = join(dir, "home");
		const inside = join(home, "work");
		const outside = join(dir, "scratch");
		mkdirSync(inside, { recursive: true });
		mkdirSync(outside, { recursive: true });
		writeFileSync(join(home, "file.txt"), "");

		assert.equal(resolveStartDir(inside, { home }).ok, true);
		assert.equal(resolveStartDir("~/work", { home }).ok, true);
		assert.equal(resolveStartDir("~", { home }).ok, true);

		const refusedOutside = resolveStartDir(outside, { home });
		assert.equal(refusedOutside.ok, false);
		assert.equal(refusedOutside.code, "dir_outside_home");
		assert.equal(resolveStartDir(outside, { home, allowOutsideHome: true }).ok, true);

		assert.equal(resolveStartDir("~/missing", { home }).code, "dir_missing");
		assert.equal(resolveStartDir(join(home, "file.txt"), { home }).code, "dir_not_directory");
		assert.equal(resolveStartDir("relative/path", { home }).code, "dir_not_absolute");
		assert.equal(resolveStartDir("~someone/else", { home }).code, "dir_home_only");
		assert.equal(resolveStartDir("a\nb", { home }).code, "dir_bad_chars");
		assert.equal(resolveStartDir("x".repeat(DIR_MAX + 1), { home }).code, "dir_too_long");
		assert.equal(resolveStartDir("", { home }).code, "dir_required");

		const ctx = ctxWith([row("w1:p1")], { home });
		const plan = planStart({ dir: inside, text: "start here", ctx });
		assert.equal(plan.ok, true);
		if (!plan.ok) return;
		assert.equal(plan.plan.command, startVerb(inside, "start here"));
		assert.equal(plan.plan.argv[1], inside);

		const refused = planStart({ dir: outside, text: "start here", ctx });
		assert.equal(refused.ok, false);
		if (!refused.ok) assert.equal(refused.code, "dir_outside_home");

		// A route never sets this flag; the verb may.
		const allowed = planStart({ dir: outside, text: "start here", ctx, allowOutsideHome: true });
		assert.equal(allowed.ok, true);

		const noText = planStart({ dir: inside, text: "   ", ctx });
		assert.equal(noText.ok, false);
		if (!noText.ok) assert.equal(noText.code, "bad_text");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("the directories offered never include $HOME itself", () => {
	const home = "/home/andrew";
	const panes = [row("w1:p1", { cwd: home }), row("w2:p1", { cwd: `${home}/agentFleet` }), row("w3:p1", { cwd: `${home}/agentFleet` }), row("w4:p1", { cwd: "/etc" })];
	const options = startDirectoryOptions({ panes: { origin: "herdr", panes, reason: null } } as never, { home, notesDir: null });
	assert.deepEqual(options.options.map((option) => option.dir), [`${home}/agentFleet`]);
	assert.equal(options.options[0]?.panes, 2);
});
