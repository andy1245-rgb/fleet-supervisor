// Inspector triggers. These are the only reasons the manager spends on a
// cross-agent look; everything else is settled by a single per-agent decision.
//
// Each trigger is grounded in a disagreement between what a worker *claims* and
// what herdr *observes*, or in two workers touching the same tree — the two
// failure modes that a per-agent decision call structurally cannot see.

import type { HerdrAgent } from "../herdr/types.ts";
import { collisions, groupOf } from "../fleet/groups.ts";
import type { Claim } from "../fleet/registry.ts";

export type TriggerKind = "divergence" | "collision" | "churn" | "blocked";

export interface Trigger {
	kind: TriggerKind;
	group: string;
	paneIds: string[];
	detail: string;
}

/** What the manager remembered about a claim last tick, to spot repetition. */
export interface ClaimHistory {
	phase: string;
	last: string;
	/** Consecutive turns that reported the same phase *and* the same last action. */
	repeats: number;
}

export interface TriggerOptions {
	/** Consecutive resting ticks before a "working" claim is called divergent. */
	divergenceTicks: number;
	/** Consecutive identical completions before a group is called churning. */
	churnRepeats: number;
}

export const DEFAULT_TRIGGER_OPTIONS: TriggerOptions = { divergenceTicks: 3, churnRepeats: 2 };

export interface TriggerScan {
	triggers: Trigger[];
	history: Map<string, ClaimHistory>;
}

export function scanTriggers(
	agents: HerdrAgent[],
	claims: Map<string, Claim>,
	idleTicks: Map<string, number>,
	previous: Map<string, ClaimHistory>,
	options: TriggerOptions = DEFAULT_TRIGGER_OPTIONS,
): TriggerScan {
	const triggers: Trigger[] = [];
	const history = new Map<string, ClaimHistory>();

	for (const agent of agents) {
		const claim = claims.get(agent.paneId);
		const group = groupOf(agent, claim);

		// 1. Divergence: the session says it is working, herdr says it is resting.
		const rest = idleTicks.get(agent.paneId) ?? 0;
		if (claim?.state === "working" && rest >= options.divergenceTicks) {
			triggers.push({
				kind: "divergence",
				group,
				paneIds: [agent.paneId],
				detail: `claims working on "${claim.last}", but herdr reports ${agent.status} for ${rest} ticks`,
			});
		}

		// 4. Blocked is always worth a human look — the agent cannot free itself.
		if (agent.status === "blocked") {
			triggers.push({
				kind: "blocked",
				group,
				paneIds: [agent.paneId],
				detail: claim ? `blocked while "${claim.last}"` : "blocked with no claim file",
			});
		}

		// 3. Churn: turns keep completing but the claimed phase and last action
		//    never change — the signature of step repetition.
		const prev = previous.get(agent.paneId);
		if (claim) {
			const repeated = prev !== undefined && prev.phase === claim.phase && prev.last === claim.last;
			const repeats = repeated ? prev.repeats + 1 : 0;
			history.set(agent.paneId, { phase: claim.phase, last: claim.last, repeats });
			if (repeats >= options.churnRepeats) {
				triggers.push({
					kind: "churn",
					group,
					paneIds: [agent.paneId],
					detail: `${repeats + 1} turns in a row reporting phase "${claim.phase}" and "${claim.last}"`,
				});
			}
		}
	}

	// 2. Collision: two or more working agents in the same tree.
	for (const [tree, members] of collisions(agents)) {
		triggers.push({
			kind: "collision",
			group: groupOf(members[0] as HerdrAgent, claims.get((members[0] as HerdrAgent).paneId)),
			paneIds: members.map((m) => m.paneId),
			detail: `${members.length} agents working in ${tree}`,
		});
	}

	return { triggers, history };
}
