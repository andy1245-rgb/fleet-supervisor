// One prompt, two adapters. The benchmark compares models on identical input, so
// neither adapter is allowed to editorialise the request.

import type { DecisionInput } from "./types.ts";

export const SYSTEM = `You supervise one coding agent working unattended. Choose exactly one action.

Reply with a single JSON object and nothing else:
{"op": "leave" | "nudge" | "declare_done" | "flag", "argument": "<one sentence>", "confidence": <0..1>}

- leave: the agent is on track; argument is a short reason.
- nudge: the agent stopped before finishing; argument is the instruction to send it.
- declare_done: the acceptance criteria are met; argument summarises what was delivered.
- flag: the situation needs a human or a stronger model; argument names the problem.

Judge only from the fields given. If the evidence is insufficient to choose an
action, use flag. Never invent file names or facts not present in the input.`;

/** Field-per-line so a small model can ground on individual values. */
export function renderInput(input: DecisionInput): string {
	const lines = [
		`pane: ${input.paneId}`,
		`cwd: ${input.cwd}`,
		`status: ${input.status}`,
		`title: ${input.title}`,
		`intent: ${input.intent}`,
		`phase: ${input.phase}`,
	];
	if (input.acceptance) lines.push(`acceptance: ${input.acceptance}`);
	lines.push(`claimed state: ${input.claimState}`, `last completed: ${input.last}`, `idle ticks: ${input.idleTicks}`);
	lines.push("terminal tail:", input.tail ? clipTail(input.tail) : "(empty)");
	return lines.join("\n");
}

/** Characters of terminal output a decision may see. The tail is the only field
 *  with no natural bound; every other field is one line. Beyond this the value is
 *  cut from the front and marked, so the reader knows the evidence is partial.
 *
 *  Derivation: the engine has a 1024-token window and a 401-token static prefix,
 *  so max_new_tokens=96 leaves 527 tokens (~2000 chars at 3.8 chars/token) for the
 *  whole prompt — not for the tail alone. Measured fixed cost: SYSTEM 709 chars,
 *  the one-line field block 370 chars (max 420 over the corpus), ~2 for the
 *  separator. 2000 - 709 - 370 - 2 leaves ~900; 700 keeps the ~30-char truncation
 *  marker inside the budget with margin. Prefill also cost ~1.6ms/char here, so the
 *  shorter budget is the faster one. */
export const MAX_TAIL_CHARS = 700;

/** Keep the end of the output: what the agent did last is the evidence, not how
 *  its first lines were echoed back. */
export function clipTail(tail: string): string {
	if (tail.length <= MAX_TAIL_CHARS) return tail;
	const kept = tail.slice(tail.length - MAX_TAIL_CHARS);
	return `[...truncated ${tail.length - kept.length} chars...]\n${kept}`;
}
