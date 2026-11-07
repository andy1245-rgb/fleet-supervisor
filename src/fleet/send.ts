// The one way text gets into an agent, and the checks in front of it.
//
// Sending is `herdr agent prompt <pane> <text> --wait`: herdr's own verb, not a keystroke
// replay, so herdr's validation (`agent_blocked`, `agent_not_promptable`) applies exactly
// as it does from a terminal. This module adds no prompt policy of its own. It decides
// only whether it is allowed to try, and the answer is **no** unless every one of these
// holds:
//
//   1. the write path is armed        (`--enable-chat`; a surface's own guard)
//   2. the text is usable             non-empty, bounded, no NUL byte
//   3. a live pane list               a fixture pane id has no process behind it
//   4. the pane is in that list       and it is a `pi` agent, never a shell or another TUI
//   5. the pane is not blocked        herdr would reject `agent_blocked` anyway
//
// **There is no claim check, and its absence is the point.** This module used to require
// `verdict === "live"` — "the supervisor has released this pane to a worker" — before a
// message could be sent. That is a gate on the supervisor's own proposals: it answers
// "may the automaton act on this pane". A person typing into a box is not a proposal. On
// a box where the claim writer has never run, the old rule made every single pane refuse
// (43 panes, 0 claim files), so the page rendered and could not be typed into. The claim
// is still *shown*; it is information about the supervisor, not a lock on the operator's
// own agents.
//
// Four argv builders used to exist for this one verb (two flag shapes, four timeouts).
// There is one builder (`promptVerb`) and one executor (`runSend`), and the timeouts are
// `SEND_TIMEOUT_MS`, named once.

import { spawn } from "node:child_process";

import { herdrPort } from "../herdr/cli.ts";
import type { Ctx, Row, Source } from "./types.ts";

export const SEND_MAX = 4000;
export const SEND_TIMEOUT_MS = 60_000;
const PANE_PATTERN = /^[A-Za-z0-9_-]{1,40}:[A-Za-z0-9_-]{1,40}$/;

export interface SendPlan {
	kind: "prompt";
	paneId: string;
	text: string;
	argv: string[];
	command: string;
	timeoutMs: number;
	operator: string;
	claimState: string | null;
	sendable: { ok: true; code: "sendable"; reason: string };
}

export type SendRequest =
	| { ok: true; plan: SendPlan }
	| { ok: false; code: string; message: string; command?: string; next?: string; extra?: Record<string, unknown> };

function quoteForDisplay(text: string): string {
	return `'${String(text).replace(/'/g, `'\\''`)}'`;
}

/** The exact command a person would type instead. Display only: `runSend` never goes
 *  through a shell. */
export function promptVerb(paneId: string, text: string, options: { timeoutMs?: number } = {}): string {
	return `herdr agent prompt ${paneId} ${quoteForDisplay(text)} --wait --timeout ${options.timeoutMs ?? SEND_TIMEOUT_MS}`;
}

/** The same command as an argv array, which is what actually runs. */
export function promptArgv(paneId: string, text: string, options: { timeoutMs?: number } = {}): string[] {
	return ["agent", "prompt", paneId, text, "--wait", "--timeout", String(options.timeoutMs ?? SEND_TIMEOUT_MS)];
}

/**
 * Can this load be sent to at all? A fixture load cannot: `fixtures/panes.json` is a
 * sample of a fleet, and a pane id in it names nothing on this machine. Exported so the
 * rail's rows, the composer and the route answer this question once.
 */
export function sourceSendable(source: Pick<Source, "mode" | "panes"> | null | undefined): { ok: boolean; code: string; reason: string | null; next?: string } {
	if (source === null || source === undefined) return { ok: false, code: "no_source", reason: "no source was loaded, so there is no pane list to check a pane against" };
	if (source.mode === "fixture") {
		return {
			ok: false,
			code: "fixture_data",
			reason: "this fleet is the shipped fixture, not your fleet: a fixture pane id has no live process behind it, so there is nothing to prompt",
			next: "run against the supervisor's real state dir (drop --force-fixture / --fixture-dir) with the write path armed",
		};
	}
	if (source.panes?.origin !== "herdr") {
		return {
			ok: false,
			code: "no_pane_list",
			reason: `the pane list is not herdr's (${source.panes?.origin ?? "none"}): ${source.panes?.reason ?? "no reason given"}`,
			next: "start without --no-herdr so the pane list is real",
		};
	}
	return { ok: true, code: "live", reason: null };
}

/** May a person send to this pane? Pure, so the rail's rows, the composer and the route
 *  cannot disagree about which panes can take a message. */
export function paneSendable(pane: Row | null | undefined): { ok: boolean; code: string; reason: string } {
	if (pane === null || pane === undefined) {
		return { ok: false, code: "unknown_pane", reason: "that pane is not in this load's `herdr api snapshot`, so there is nothing to send to" };
	}
	if (pane.agent !== "pi") {
		return { ok: false, code: "not_pi_agent", reason: `this pane's agent is ${JSON.stringify(pane.agent || "unknown")}; this system only ever prompts a pi agent` };
	}
	if (pane.agent_status === "blocked") {
		return {
			ok: false,
			code: "pane_blocked",
			reason: "herdr reports this pane at an approval or question dialog; `agent prompt` rejects that with agent_blocked before sending any input, so nothing was sent",
		};
	}
	return { ok: true, code: "sendable", reason: `herdr lists this pane as a ${pane.agent} agent in state ${pane.agent_status}` };
}

export function findPane(source: Pick<Source, "panes">, paneId: string): Row | null {
	return source.panes.panes.find((pane) => pane.pane_id === paneId) ?? null;
}

export function textProblem(text: unknown): string | null {
	if (typeof text !== "string") return "body.text must be a string";
	if (text.trim() === "") return "body.text is empty: there is nothing to send";
	if (text.length > SEND_MAX) return `body.text is ${text.length} characters; the limit is ${SEND_MAX}`;
	if (text.includes("\u0000")) return "body.text contains a NUL byte";
	return null;
}

/**
 * The gate. Returns `{ok: true, plan}` with everything `runSend` needs, or
 * `{ok: false, code, message}` with a stable code. It never sends anything itself, which
 * is what makes every refusal testable without a byte reaching a pane.
 *
 * `ctx.opts.enableChat` is the arming flag. A CLI verb that has no such flag sets it
 * true and is the operator's own shell; a route passes its own flag, so a disarmed route
 * and an armed verb differ in exactly one declared place.
 */
export function sendRequest(args: { paneId: string; text: unknown; ctx: Ctx }): SendRequest {
	const { paneId, ctx } = args;
	const text = args.text;
	const command = typeof text === "string" ? promptVerb(paneId, text) : `herdr agent prompt ${paneId} '<text>' --wait`;
	const refuse = (code: string, message: string, extra: Record<string, unknown> = {}): SendRequest => ({ ok: false, code, message, command, extra });

	if (ctx.opts.enableChat !== true) {
		return {
			ok: false,
			code: "chat_disabled",
			message:
				"Sending is off on this server: the chat write path is behind a flag that is off by default, which is a guard and not a fault. Nothing was sent, and the next step is the command below, in a terminal.",
			command,
			next: "run the command in a terminal, or restart with --enable-chat",
			extra: { guard: true, enableWith: "--enable-chat" },
		};
	}
	if (!PANE_PATTERN.test(paneId)) return refuse("bad_pane_id", "A pane id looks like `w46:p1`.");

	const problem = textProblem(text);
	if (problem !== null) return refuse("bad_text", problem, { length: typeof text === "string" ? text.length : null, limit: SEND_MAX });

	const sourceGate = sourceSendable(ctx.source);
	if (!sourceGate.ok) {
		return {
			ok: false,
			code: sourceGate.code,
			message: `${sourceGate.reason}. Nothing was sent, and nothing could have been: ${sourceGate.next ?? ""}`.trim(),
			command,
			next: sourceGate.next,
			extra: { guard: true, sourceMode: ctx.source.mode, panesOrigin: ctx.source.panes.origin },
		};
	}

	const pane = findPane(ctx.source, paneId);
	if (pane === null) {
		return {
			ok: false,
			code: "unknown_pane",
			message: `No pane ${paneId} in this load's \`herdr api snapshot\`. The rail lists what herdr reports; a pane id that is not in it cannot be prompted.`,
			command,
			extra: { listed: ctx.source.panes.panes.map((entry) => entry.pane_id), panesOrigin: ctx.source.panes.origin },
		};
	}

	const sendable = paneSendable(pane);
	if (!sendable.ok) return refuse(sendable.code, sendable.reason, { sendable, agent: pane.agent });

	// The claim is reported, never consulted.
	const claim = ctx.source.claims.claims.get(paneId)?.claim ?? null;
	return {
		ok: true,
		plan: {
			kind: "prompt",
			paneId,
			text: text as string,
			argv: promptArgv(paneId, text as string),
			command,
			timeoutMs: SEND_TIMEOUT_MS,
			operator: "local",
			claimState: claim?.state ?? null,
			sendable: { ok: true, code: "sendable", reason: sendable.reason },
		},
	};
}

export interface SendResult {
	ok: boolean;
	code: string;
	message: string | null;
	state: string | null;
	durationMs: number;
	paneId: string;
	stdout?: string | null;
}

/** Runs the plan. The only executor: `herdrPort().prompt` is the port, so no surface
 *  builds an argv of its own. */
export async function runSend(plan: SendPlan): Promise<SendResult> {
	const started = Date.now();
	try {
		const result = await herdrPort().prompt(plan.paneId, plan.text, plan.timeoutMs);
		if (result.disposition === "accepted") {
			return { ok: true, code: "sent", message: null, state: result.observed ?? null, durationMs: Date.now() - started, paneId: plan.paneId };
		}
		return { ok: false, code: result.reason ?? "rejected", message: `herdr refused the prompt for ${plan.paneId}`, state: null, durationMs: Date.now() - started, paneId: plan.paneId };
	} catch (error) {
		const message = error instanceof Error ? error.message : "herdr agent prompt failed";
		const code = message.includes("timeout") ? "timeout" : "spawn_failed";
		return { ok: false, code, message, state: null, durationMs: Date.now() - started, paneId: plan.paneId };
	}
}

/** A spawn-free view of the plan, for `--dry-run` and for the document. */
export function describeSend(plan: SendPlan): Record<string, unknown> {
	return { paneId: plan.paneId, command: plan.command, argv: plan.argv, timeoutMs: plan.timeoutMs, claimState: plan.claimState, operator: plan.operator };
}
