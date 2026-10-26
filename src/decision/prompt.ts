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
	lines.push("terminal tail:", input.tail || "(empty)");
	return lines.join("\n");
}
