// Self-check: fabricates the event stream a real session produces, drives the
// extension's handlers through a fake ExtensionAPI, and prints every claim file
// that lands. Proves the coalescing window, the flush on shutdown, and both
// no-op guards without needing a herdr pane or a model.
//
//   node ext/pi-fleet/selfcheck.ts

import { copyFileSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext, ExtensionMode } from "@earendil-works/pi-coding-agent";
import { readClaim } from "../../src/fleet/registry.ts";
import piFleet from "./index.ts";
import { oneLine } from "./src/derive.ts";

const PANE = "w2C:p1";
const PROMPT =
	"Make every live agent session report its own state as a claim file.\n\nThis second paragraph must never reach the claim.";
const COALESCE_WAIT_MS = 2100;

const registry = mkdtempSync(join(tmpdir(), "pi-fleet-selfcheck-"));
process.env.AGENTFLEET_REGISTRY = registry;
process.env.HERDR_ENV = "1";
process.env.HERDR_PANE_ID = PANE;

const claimPath = join(registry, `${PANE.replace(/[^A-Za-z0-9._-]/g, "_")}.json`);

type Handler = (event: unknown, ctx: ExtensionContext) => unknown;
type Hooks = Map<string, Handler[]>;

const failures: string[] = [];

function check(name: string, ok: boolean, detail = ""): void {
	console.log(`${ok ? "ok  " : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
	if (!ok) failures.push(name);
}

function makeCtx(mode: ExtensionMode): ExtensionContext {
	return { mode, cwd: "/home/andrew/agentFleet", hasUI: false } as unknown as ExtensionContext;
}

/** A stand-in for pi's ExtensionAPI: records handlers so the check can dispatch. */
function makePi(hooks: Hooks): ExtensionAPI {
	return {
		on(event: string, handler: Handler) {
			const list = hooks.get(event) ?? [];
			list.push(handler);
			hooks.set(event, list);
			return () => {};
		},
	} as unknown as ExtensionAPI;
}

function dispatch(hooks: Hooks, ctx: ExtensionContext, event: string, payload: unknown): void {
	for (const handler of hooks.get(event) ?? []) handler(payload, ctx);
}

function claimText(): string {
	try {
		return readFileSync(claimPath, "utf8").trimEnd();
	} catch {
		return "(no claim file yet)";
	}
}

function claim(): Record<string, unknown> {
	try {
		return JSON.parse(readFileSync(claimPath, "utf8")) as Record<string, unknown>;
	} catch {
		return {};
	}
}

function budgetTokens(value: Record<string, unknown>): unknown {
	const budget = value["budget"];
	return typeof budget === "object" && budget !== null ? (budget as Record<string, unknown>)["tokens"] : undefined;
}

function show(title: string): void {
	console.log(`\n--- ${title} ---`);
	console.log(claimText());
}

const sleep = (ms: number): Promise<void> =>
	new Promise((resolve) => {
		setTimeout(resolve, ms);
	});

console.log("== pi-fleet self-check ==");
console.log(`registry: ${registry}`);
console.log(`pane: ${PANE} (HERDR_ENV=1)`);

const hooks: Hooks = new Map();
const ctx = makeCtx("tui");
piFleet(makePi(hooks));

dispatch(hooks, ctx, "session_start", { type: "session_start", reason: "startup" });
show("1. session_start — first claim, written at once");
const first = claimText();
check("a claim file exists immediately after session_start", first !== "(no claim file yet)");
check("initial phase is idle", claim()["phase"] === "idle");
check("initial state is waiting (no prompt has arrived yet)", claim()["state"] === "waiting");
check("no budget before any measured response", claim()["budget"] === undefined);

// A burst: one prompt, one turn start, one read. Three events, one write due.
dispatch(hooks, ctx, "before_agent_start", { type: "before_agent_start", messageType: "user", prompt: PROMPT });
dispatch(hooks, ctx, "turn_start", { type: "turn_start", turnIndex: 0, timestamp: Date.now() });
dispatch(hooks, ctx, "tool_execution_start", {
	type: "tool_execution_start",
	toolCallId: "call-1",
	toolName: "read",
	args: { path: "src/fleet/registry.ts" },
});
check("3 events in the burst, still the 1st claim on disk (coalesced)", claimText() === first);
console.log("\n   event: before_agent_start(user)  -> intent");
console.log("   event: turn_start                -> state working");
console.log("   event: tool_execution_start(read)-> phase research, last 'read src/fleet/registry.ts'");
console.log(`   waiting ${COALESCE_WAIT_MS}ms for the coalescing window…`);

await sleep(COALESCE_WAIT_MS);
show("2. after the window — one write carrying the whole burst");
const second = claim();
check("intent is the first line of the first user prompt", second["intent"] === "Make every live agent session report its own state as a claim file.");
check("phase followed the tool: research", second["phase"] === "research");
check("last is tool + path", second["last"] === "read src/fleet/registry.ts");
check("state is working mid-turn", second["state"] === "working");

dispatch(hooks, ctx, "tool_execution_start", {
	type: "tool_execution_start",
	toolCallId: "call-2",
	toolName: "bash",
	args: { command: "npx tsc --noEmit 2>&1 | tail -20" },
});
dispatch(hooks, ctx, "message_end", {
	type: "message_end",
	message: {
		role: "assistant",
		content: [{ type: "text", text: "Running the typecheck." }],
		usage: { input: 39000, output: 2230, totalTokens: 41230 },
	},
});
const beforeSecondWindow = claimText();
await sleep(COALESCE_WAIT_MS);
show("3. after the second window — bash test/build flips phase to verify, usage becomes budget");
const third = claim();
check("a test/build command lands in verify", third["phase"] === "verify");
check("last names the command", String(third["last"]).startsWith("bash npx tsc --noEmit"));
check("budget.tokens is the measured usage", budgetTokens(third) === 41230);
check("the second window also coalesced two events into one write", beforeSecondWindow !== claimText());

dispatch(hooks, ctx, "turn_end", {
	type: "turn_end",
	turnIndex: 0,
	message: {
		role: "assistant",
		content: [{ type: "text", text: "Done — the writer lands and the supervisor can read it." }],
	},
	toolResults: [],
	outcome: "completed",
});
dispatch(hooks, ctx, "agent_settled", { type: "agent_settled", aborted: false });
dispatch(hooks, ctx, "session_shutdown", { type: "session_shutdown", reason: "quit" });
show("4. turn_end with a completion phrase, then session_shutdown — flushed, not left to a timer");
const last = claim();
check("a quiet turn ending in a completion phrase is done", last["state"] === "done");
check("phase survives the turn boundary", last["phase"] === "verify");
check("no *.tmp file was left behind (rename, not copy)", readdirSync(registry).every((name) => !name.endsWith(".tmp")));
check("one file per pane, nothing else written", readdirSync(registry).length === 1);

// The supervisor reads this file with registry.ts's own parser; if that parser
// drops a field, the claim is wrong no matter how tidy the JSON looks.
const reread = readClaim(PANE, registry);
check(
	"the registry's own reader returns the claim unchanged",
	reread !== undefined &&
		reread.paneId === PANE &&
		reread.phase === "verify" &&
		reread.state === "done" &&
		reread.intent === "Make every live agent session report its own state as a claim file." &&
		reread.last === "bash npx tsc --noEmit 2>&1 | tail -20" &&
		reread.budget?.tokens === 41230 &&
		reread.acceptance === undefined,
);

// Guard 1: no herdr pane, no claim.
delete process.env.HERDR_ENV;const outsideHooks: Hooks = new Map();
piFleet(makePi(outsideHooks));
check("outside herdr the extension registers no hooks at all", outsideHooks.size === 0, `${outsideHooks.size} hooks`);

// Guard 2: a nested --mode rpc runner inherits the pane but does not own it.
process.env.HERDR_ENV = "1";
const nestedHooks: Hooks = new Map();
piFleet(makePi(nestedHooks));
const beforeNested = claimText();
dispatch(nestedHooks, makeCtx("rpc"), "session_start", { type: "session_start", reason: "startup" });
dispatch(nestedHooks, makeCtx("rpc"), "tool_execution_start", {
	type: "tool_execution_start",
	toolCallId: "call-3",
	toolName: "write",
	args: { path: "nested-should-not-appear.ts" },
});
check("an rpc child leaves the owning pane's claim untouched", claimText() === beforeNested);

// Continuity: /resume and /reload are the same work, so the claim must not blink
// back to blank; a fresh start in the pane must.
const continuity = mkdtempSync(join(tmpdir(), "pi-fleet-continuity-"));
copyFileSync(claimPath, join(continuity, `${PANE.replace(/[^A-Za-z0-9._-]/g, "_")}.json`));
process.env.AGENTFLEET_REGISTRY = continuity;
const resumeHooks: Hooks = new Map();
piFleet(makePi(resumeHooks));
dispatch(resumeHooks, makeCtx("tui"), "session_start", { type: "session_start", reason: "resume" });
const resumed = readClaim(PANE, continuity);
check(
	"a resumed session keeps intent, phase, last, done and spend",
	resumed?.intent === "Make every live agent session report its own state as a claim file." &&
		resumed.phase === "verify" &&
		resumed.last === "bash npx tsc --noEmit 2>&1 | tail -20" &&
		resumed.state === "done" &&
		resumed.budget?.tokens === 41230,
);
const freshHooks: Hooks = new Map();
piFleet(makePi(freshHooks));
dispatch(freshHooks, makeCtx("tui"), "session_start", { type: "session_start", reason: "startup" });
const fresh = readClaim(PANE, continuity);
check(
	"a fresh start in the same pane starts blank",
	fresh?.intent === "" && fresh.phase === "idle" && fresh.last === "" && fresh.state === "waiting" && fresh.budget === undefined,
);
process.env.AGENTFLEET_REGISTRY = registry;

// Truncation rule, checked directly so the 160-char cap is not taken on faith.
check("oneLine cuts to exactly 160 chars", [...oneLine("x".repeat(300), 160)].length === 160);

console.log(`\n== claim file: ${claimPath} ==`);
console.log(claimText());
console.log(`\n${failures.length === 0 ? "all checks passed" : `${failures.length} check(s) failed: ${failures.join(", ")}`}`);
process.exitCode = failures.length === 0 ? 0 : 1;
