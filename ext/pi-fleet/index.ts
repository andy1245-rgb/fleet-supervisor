// pi-fleet — every live agent session reports its own state as a claim file.
//
// The supervisor (~/fleet-supervisor/src/manager/tick.ts) reads one JSON claim per
// live pane from ~/.pi/agent/fleet/<pane>.json and decides what to say to that
// agent from `phase`, `last` and `state`. Nothing else can know those: the
// supervisor sees a terminal, not a session's intent. So each session writes
// its own file and the supervisor only reads it.
//
// One file per pane is what makes that safe — two sessions never share an inode.
// Outside herdr there is no pane to claim, so the extension registers nothing.
// A `--mode rpc` child (a forge subagent) inherits HERDR_PANE_ID but does not own
// the pane; letting it write would clobber its parent's claim, so it stays silent.

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { readClaim, registryDir, type Claim } from "../../src/fleet/registry.ts";
import { messageTokens } from "./src/derive.ts";
import { BLANK, ClaimState, type Carried } from "./src/state.ts";
import { ClaimWriter } from "./src/writer.ts";

/** Session starts that continue the work the pane already reported. */
const CONTINUES: ReadonlySet<string> = new Set(["resume", "reload"]);

/** This process's pane, or undefined when no herdr pane owns it. */
function paneId(env: NodeJS.ProcessEnv = process.env): string | undefined {
	if (env.HERDR_ENV !== "1") return undefined;
	const id = env.HERDR_PANE_ID;
	return id ? id : undefined;
}

/** A nested runner streams its own messages into the parent's pane; it does not own it. */
function ownsPane(ctx: ExtensionContext): boolean {
	return ctx.mode !== "rpc";
}

/** What the claim on disk already says, so a continuing session does not contradict it. */
function carriedFrom(claim: Claim | undefined): Carried {
	if (!claim) return BLANK;
	return {
		intent: claim.intent,
		phase: claim.phase,
		last: claim.last,
		state: claim.state,
		tokens: typeof claim.budget?.tokens === "number" ? claim.budget.tokens : 0,
	};
}

/**
 * Runs a handler body, discarding any failure. An extension that throws into the
 * agent loop turns a bookkeeping bug into a broken turn, which is never a fair
 * trade for a claim file.
 */
function safely(body: () => void): void {
	try {
		body();
	} catch {
		// The claim is a report, not a control path: a lost write is recovered by
		// the next event, and pi never sees the error.
	}
}

export default function piFleet(pi: ExtensionAPI): void {
	const pane = paneId();
	if (!pane) return;

	const writer = new ClaimWriter();
	let state: ClaimState | undefined;

	const publish = (): void => {
		if (state) writer.schedule(state.snapshot());
	};

	pi.on("session_start", (event, ctx) => {
		safely(() => {
			if (!ownsPane(ctx)) return;
			const cwd = ctx.cwd || process.cwd();
			const existing = readClaim(pane, registryDir());
			state = new ClaimState(pane);
			// `resume` and `reload` continue the same work, so the file keeps saying
			// what it already said; `startup`, `new` and `fork` are new work in the
			// same pane and must not inherit the last session's intent.
			state.reset(cwd, CONTINUES.has(event.reason) ? carriedFrom(existing) : BLANK);
			publish();
		});
	});

	pi.on("before_agent_start", (event, ctx) => {
		safely(() => {
			if (!ownsPane(ctx) || !state || event.messageType !== "user") return;
			state.prompt(event.prompt);
			publish();
		});
	});

	pi.on("turn_start", (_event, ctx) => {
		safely(() => {
			if (!ownsPane(ctx) || !state) return;
			state.beginTurn();
			publish();
		});
	});

	pi.on("tool_execution_start", (event, ctx) => {
		safely(() => {
			if (!ownsPane(ctx) || !state) return;
			// A nested call belongs to the tool that made it, not to the session.
			if (event.parentToolCallId) return;
			state.tool(event.toolName, event.args);
			publish();
		});
	});

	pi.on("message_end", (event, ctx) => {
		safely(() => {
			if (!ownsPane(ctx) || !state) return;
			const tokens = messageTokens(event.message);
			if (tokens <= 0) return;
			state.addTokens(tokens);
			publish();
		});
	});

	pi.on("turn_end", (event, ctx) => {
		safely(() => {
			if (!ownsPane(ctx) || !state) return;
			state.endTurn({
				message: event.message,
				toolResults: event.toolResults.length,
				outcome: event.outcome,
			});
			publish();
		});
	});

	pi.on("agent_settled", (event, ctx) => {
		safely(() => {
			if (!ownsPane(ctx) || !state) return;
			state.settled(event.aborted);
			publish();
		});
	});

	pi.on("session_shutdown", (_event, ctx) => {
		safely(() => {
			if (!ownsPane(ctx) || !state) return;
			// The last claim of a session must not depend on a timer that never
			// fires because the process is going away.
			writer.flush();
		});
	});
}
