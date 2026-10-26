// The claim a session makes about itself. This is the state machine only: it
// holds what the session knows (intent, phase, state, last action, tokens) and
// emits a `Claim` shaped exactly like the supervisor's. No clock, no files, no
// pi API, so the self-check can drive it without a runtime.

import type { Claim, Phase } from "../../../src/fleet/registry.ts";
import {
	describeTool,
	firstLine,
	hasToolCall,
	isCompletionText,
	messageText,
	phaseForTool,
} from "./derive.ts";

/** The baseline a session starts from, taken from the claim already on disk. */
export interface Carried {
	intent: string;
	phase: Phase;
	last: string;
	/** A `done` (or `working`) already on disk survives a resumed session until it moves. */
	state: Claim["state"];
	tokens: number;
}

export const BLANK: Carried = { intent: "", phase: "idle", last: "", state: "waiting", tokens: 0 };

export class ClaimState {
	#paneId: string;
	#cwd = "";
	#intent = "";
	#phase: Phase = "idle";
	#state: Claim["state"] = "waiting";
	#last = "";
	#tokens = 0;

	constructor(paneId: string) {
		this.#paneId = paneId;
	}

	reset(cwd: string, carried: Carried): void {
		this.#cwd = cwd;
		this.#intent = carried.intent;
		this.#phase = carried.phase;
		this.#last = carried.last;
		this.#tokens = carried.tokens;
		this.#state = carried.state;
	}

	/** The first user prompt names the session; any prompt restarts work. */
	prompt(text: string): void {
		if (!this.#intent) this.#intent = firstLine(text);
		this.#state = "working";
	}

	/** A turn began: streaming again, which clears a sticky `done`. */
	beginTurn(): void {
		this.#state = "working";
	}

	/** The phase and the last action both come from tool calls, never from prose. */
	tool(toolName: string, args: unknown): void {
		this.#phase = phaseForTool(toolName, args, this.#phase);
		this.#last = describeTool(toolName, args);
		this.#state = "working";
	}

	addTokens(tokens: number): void {
		if (tokens > 0) this.#tokens += tokens;
	}

	/**
	 * A turn ended. `done` needs a quiet end — no tool results, no pending tool
	 * calls — plus a completion phrase, or an abort.
	 */
	endTurn(input: { message: unknown; toolResults: number; outcome: string }): void {
		const text = messageText(input.message);
		const busy = input.toolResults > 0 || hasToolCall(input.message);
		const finished = input.outcome === "aborted" || (!busy && isCompletionText(text));
		this.#state = finished ? "done" : "waiting";
	}

	/** Final settlement: pi will not continue on its own. */
	settled(aborted: boolean): void {
		if (aborted) this.#state = "done";
		else if (this.#state === "working") this.#state = "waiting";
	}

	/**
	 * The claim to write. `acceptance` and `group` are deliberately absent: the
	 * human declares them, and the writer carries any existing value forward.
	 */
	snapshot(now = new Date()): Claim {
		const claim: Claim = {
			paneId: this.#paneId,
			cwd: this.#cwd,
			intent: this.#intent,
			phase: this.#phase,
			state: this.#state,
			last: this.#last,
			updated: now.toISOString(),
		};
		// Only a real measurement becomes a budget; a guessed number would read
		// as spend the supervisor may act on.
		if (this.#tokens > 0) claim.budget = { tokens: this.#tokens };
		return claim;
	}
}
