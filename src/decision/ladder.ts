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
	/** True whenever the primary was found insufficient and the escalator was asked
	 *  — including when the ask failed. The count exists to reveal "the primary
	 *  could not handle this", so an escalator outage must not silence it. */
	escalated: boolean;
	/** True when an escalation was attempted and the escalator threw. The decision
	 *  is then the primary's, with the failure noted in its argument. */
	escalationFailed?: boolean;
	/** Every model that was consulted, in order, for the benchmark record. An
	 *  escalator that threw was never consulted, so it is not in the trail. */
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
		// An escalator outage must not lose the primary's opinion outright, and it
		// must not read as "no escalation": the primary was insufficient and the
		// escalation was attempted. escalationFailed is what makes the attempt
		// distinguishable from a success in the report.
		const argument = `${first.argument} (escalation failed: ${(e as Error).message})`;
		return { decision: { ...first, argument }, escalated: true, escalationFailed: true, trail };
	}
	trail.push(second);
	return { decision: second.refused ? { ...first, confidence: second.confidence, raw: `${first.raw}\n${second.raw}` } : second, escalated: true, escalationFailed: false, trail };
}
