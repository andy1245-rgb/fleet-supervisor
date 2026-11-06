// Escalation by rule. The primary answers every decision; a second call is earned
// by a *fact about that answer*, never by a number the answering model chose.
//
// The confidence ladder this replaces gated on the model's own confidence, and both
// halves of that gate were unsound: the local engine's confidence head is deleted by
// `needle build --lora`, so confidence arrives as 0 and everything escalated, and on
// the hosted model self-reported confidence is anti-correlated with correctness
// (0.7 gate: 57.5% coverage at 0.1739 accuracy against a 0.35 base rate). So there is
// no threshold in this file, and no branch reads one.
//
// Exactly one escalation per decision: the rules decide *whether* it happens, once.

import type { Decision, DecisionInput, DecisionModel } from "./types.ts";

/** The four facts that earn a second call. One value per decision — a decision that
 *  satisfies all four still gets one escalation, not four. */
export type EscalationRule = "R1_unparseable" | "R2_ungrounded" | "R3_irreversible" | "R4_cross_agent";

/** What R4 needs from the caller: which panes a cross-agent condition named. Structural
 *  rather than the manager's `Trigger`, so this module never imports the manager. */
export interface NamedTrigger {
	readonly kind: string;
	readonly paneIds: readonly string[];
}

export interface EscalationFacts {
	/** The pane the decision is about, which is what a trigger has to name to earn R4. */
	readonly paneId: string;
	/** This tick's triggers. Absent means the caller has not scanned for them, and R4
	 *  cannot fire — the rule is a fact the caller supplies, not one this module invents. */
	readonly triggers?: readonly NamedTrigger[];
}

export interface EscalationOptions {
	primary: DecisionModel;
	/** The falsifier. Absent only when the supervisor degraded to a single model
	 *  (the primary's adapter could not be built), which is the one case where there
	 *  is nobody to ask; a *configured* same-family pair is refused by
	 *  assertDifferentFamily rather than passed as absent. */
	escalator?: DecisionModel;
	/** Forwarded to R4 unchanged. */
	triggers?: readonly NamedTrigger[];
}

export interface EscalationResult {
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
	/** The rule that earned the second call. Undefined when no rule fired. */
	rule?: EscalationRule;
}

/** A refusal that already asks for a human is a usable answer — the model picked
 *  `flag` and its argument names the reader — so a second sample buys nothing. A
 *  refusal with no such reading (a parse failure, a suppressed decode, a sidecar
 *  fault) is unusable, and a second sample is its only recovery. */
const NAMES_A_HUMAN = /needs? a human/i;

/** The cross-agent conditions a per-pane call structurally cannot see: two agents in
 *  one tree, or one agent repeating itself. The other two trigger kinds (divergence,
 *  blocked) are visible in the pane's own fields, so they do not earn a second call. */
const CROSS_AGENT_KINDS: readonly string[] = ["collision", "churn"];

/** Which rule, if any, earns the second call. First match wins, in the spec's order:
 *  an unusable answer is the most basic defect, an ungrounded one is next, an
 *  irreversible op is worth a second opinion on its own, and cross-agent blindness
 *  is the weakest of the four. */
export function escalationRule(first: Decision, facts: EscalationFacts): EscalationRule | undefined {
	if (first.refused && !NAMES_A_HUMAN.test(first.argument)) return "R1_unparseable";
	if ((first.suppressed ?? 0) > 0) return "R2_ungrounded";
	if (first.op === "declare_done") return "R3_irreversible";
	const named = (facts.triggers ?? []).some((trigger) => CROSS_AGENT_KINDS.includes(trigger.kind) && trigger.paneIds.includes(facts.paneId));
	if (named) return "R4_cross_agent";
	return undefined;
}

/** The model family a name belongs to: the transport prefix (`openrouter:`,
 *  `commandcode:`) is a wire and the segment after the vendor
 *  (`deepseek/deepseek-v4.1-flash`) is a variant, so neither distinguishes families. */
export function familyOf(name: string): string {
	const colon = name.indexOf(":");
	const bare = (colon === -1 ? name : name.slice(colon + 1)).trim();
	return (bare.split("/")[0] ?? bare).toLowerCase();
}

/** A falsifier that shares the generator's weights shares its blind spots
 *  (`01a17643 #88`), so a pair inside one family is a configuration error, not a
 *  weaker escalation. Thrown rather than commented: the tick's caller alerts on it. */
export function assertDifferentFamily(primary: DecisionModel, escalator: DecisionModel): void {
	const primaryFamily = familyOf(primary.name);
	const escalatorFamily = familyOf(escalator.name);
	if (primaryFamily !== escalatorFamily) return;
	throw new Error(
		`escalator ${escalator.name} is in the same model family as primary ${primary.name} ("${primaryFamily}"): a second call to the same weights cannot falsify the first`,
	);
}

export async function decideWithEscalation(input: DecisionInput, options: EscalationOptions): Promise<EscalationResult> {
	if (options.escalator !== undefined) assertDifferentFamily(options.primary, options.escalator);

	const first = await options.primary.decide(input);
	const trail = [first];

	const rule = escalationRule(first, { paneId: input.paneId, ...(options.triggers ? { triggers: options.triggers } : {}) });
	if (rule === undefined) return { decision: first, escalated: false, trail };

	if (options.escalator === undefined) {
		// A degraded pair has no falsifier: the tick has already alerted that the
		// primary is unavailable, and asking the primary's own weights again returns
		// the same answer. The rule is still recorded, so the row shows what would
		// have earned a second call; `escalated` stays false because nobody was asked.
		return { decision: first, escalated: false, trail, rule };
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
		return { decision: { ...first, argument }, escalated: true, escalationFailed: true, trail, rule };
	}
	trail.push(second);
	// An escalator that refuses has no op of its own, so the primary's op stands. Its
	// confidence and raw text are kept because they are what the record shows was
	// consulted — the confidence is recorded here, never branched on.
	const decision = second.refused ? { ...first, confidence: second.confidence, raw: `${first.raw}\n${second.raw}` } : second;
	return { decision, escalated: true, escalationFailed: false, trail, rule };
}
