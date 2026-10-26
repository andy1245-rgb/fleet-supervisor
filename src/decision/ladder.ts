// Escalation ladder. The primary model answers everything; anything it refuses
// or is unsure about is re-asked of the escalator. Exactly one escalation, so a
// bad primary can never multiply cost per decision.

import type { Decision, DecisionInput, DecisionModel } from "./types.ts";

export interface LadderOptions {
	primary: DecisionModel;
	escalator: DecisionModel;
	/** Below this confidence, the escalator decides instead. */
	threshold: number;
}

export interface LadderResult {
	decision: Decision;
	escalated: boolean;
	/** Every model that was consulted, in order, for the benchmark record. */
	trail: Decision[];
}

export async function decideWithEscalation(input: DecisionInput, options: LadderOptions): Promise<LadderResult> {
	const first = await options.primary.decide(input);
	const trail = [first];

	if (!first.refused && first.confidence >= options.threshold) {
		return { decision: first, escalated: false, trail };
	}

	let second: Decision;
	try {
		second = await options.escalator.decide(input);
	} catch (e) {
		// An escalator outage must not lose the primary's opinion outright.
		return { decision: { ...first, argument: `${first.argument} (escalation failed: ${(e as Error).message})` }, escalated: false, trail };
	}
	trail.push(second);
	return { decision: second.refused ? { ...first, confidence: second.confidence, raw: `${first.raw}\n${second.raw}` } : second, escalated: true, trail };
}
