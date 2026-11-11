// Stage 0: does this pane need a word at all?
//
// The supervisor's expensive question is "what should we say". The cheap one, which
// almost every tick can answer, is "is there anything here to say anything about".
// This module is that second question, as a contract rather than as the absence of
// a code path: silence is a returned value with its own rule and reason, so a tick
// that says nothing can be read afterwards and asked which rule permitted it.
//
// It is built on `./rules.ts` rather than beside it. The seven rules, their order,
// their allowances and their `why` sentences are the watchdog's, and this file adds
// exactly two things to them:
//
//   * **attribution** — which processes belong to which pane, structurally, by the
//     process's own working directory, so a pane is judged on its own tree rather
//     than on the machine's;
//   * **the second half of the verdict** — a process past its allowance that is
//     still making progress is *working*, not hung, and the answer to "does this
//     pane need a word" for a working process is no.
//
// What this deliberately does not do: decide what the word is. That is stage 1, and
// the whole point of splitting the question is that stage 1 only runs on rows this
// stage speaks on. Measured on the mined corpus, that residue is small and precise
// rather than large and cheap — see `bench/runners/stage0.ts` and
// `docs/stage0-residue-2026-11-10.md`.

import { classify, findingFields, RULES, type CommandSample, type FindingFields, type Rule, type Verdict } from "./rules.ts";

/** What a pane is, from the supervisor's own snapshot. Only the fields this stage
 *  reads: it is not a `HerdrAgent`, and a caller should not have to build one. */
export interface WatchTarget {
	paneId: string;
	/** The directory the pane is working in — the agent's foreground cwd where herdr
	 *  reports one, else its cwd. This is the attribution key. */
	cwd: string;
}

/** The answer. `speak: false` is a finding, not a default: `rule` names the rule
 *  that permitted silence and `why` is the sentence a human would be shown if the
 *  rule had fired instead. */
export interface WordVerdict {
	speak: boolean;
	/** The rule id that decided it — `silence` when no rule matched any process. */
	rule: string;
	why: string;
	/** The finding that would be reported, present exactly when `speak` is true. */
	finding?: FindingFields;
	/** True when the deciding process was past its allowance but the second sample
	 *  showed CPU progress. Only ever set on a silent verdict, and it is the one
	 *  silence a reader should be able to tell from "nothing was running". */
	working?: boolean;
}

/** No rule matched any process of this pane. Distinct from a rule that permits
 *  silence on purpose: that one has a sentence behind it. */
export const SILENCE_RULE = "silence";

const SILENCE_NO_PROCESS = "no process of this pane is running, so there is nothing to say anything about";

/** The processes that belong to one pane: same working directory, and nothing else
 *  in common is assumed. A pid whose cwd cannot be read is not attributed — an
 *  unknown directory is not a match.
 *
 *  Deliberately not ancestry-based. An agent's descendants share its cwd, but so do
 *  two panes in the same directory, and the failure that matters here is attributing
 *  another pane's runaway to this one. Two panes in one tree both see the process,
 *  which is the correct answer for both: the fact is true of the directory they are
 *  both working in. */
export function processesOf(samples: readonly CommandSample[], cwd: string): CommandSample[] {
	if (!cwd) return [];
	return samples.filter((sample) => sample.cwd === cwd);
}

/** The pane's oldest process, which is the one whose rule decides the pane: a pane
 *  with a server and a runaway bash needs the word about the bash, and age is the
 *  only ordering that does not require trusting a rule's `why` twice. */
function oldest(samples: readonly CommandSample[]): CommandSample | undefined {
	let best: CommandSample | undefined;
	for (const sample of samples) {
		if (best === undefined || sample.elapsedMs > best.elapsedMs) best = sample;
	}
	return best;
}

/** Does this pane need a word? Silence is explicit: every path that returns
 *  `speak: false` also returns the rule that decided so and the sentence that
 *  explains it. */
export function needsAWord(
	target: WatchTarget,
	samples: readonly CommandSample[],
	options: { rules?: readonly Rule[]; previousCpu?: ReadonlyMap<number, number> } = {},
): WordVerdict {
	const mine = processesOf(samples, target.cwd);
	if (mine.length === 0) return { speak: false, rule: SILENCE_RULE, why: SILENCE_NO_PROCESS };

	const rules = options.rules ?? RULES;
	// Every process of the pane is classified, not just the oldest: a pane whose
	// oldest process is covered can still be running something past its own rule, and
	// choosing only the oldest would let a permitted neighbour mask it.
	let decided: { sample: CommandSample; verdict: Verdict } | undefined;
	for (const sample of mine) {
		const previous = options.previousCpu?.get(sample.pid);
		const verdict = classify(sample, rules, previous);
		if (!verdict.flagged) continue;
		// Past its allowance and still burning CPU is a working process: the watchdog's
		// own rule, and the reason a long build is not a hang.
		if (verdict.stalled === false) {
			decided ??= { sample, verdict };
			continue;
		}
		return { speak: true, rule: verdict.rule, why: verdict.why, finding: findingFields(sample, verdict) };
	}
	if (decided) {
		return {
			speak: false,
			rule: decided.verdict.rule,
			why: `past its allowance, but the second sample showed CPU progress — working, not hung`,
			working: true,
		};
	}

	// Nothing fired. The sentence that explains why is the rule that covered the
	// pane's oldest process, which is the rule that would have had to be different
	// for this pane to be worth a word.
	const sample = oldest(mine);
	const verdict = sample === undefined ? undefined : classify(sample, rules);
	return {
		speak: false,
		rule: verdict?.rule ?? SILENCE_RULE,
		why: verdict?.why ?? SILENCE_NO_PROCESS,
	};
}

/** The verdict as one log row. Kept here rather than in the schema because the
 *  stage owns its own facts, and a writer that re-derived the rule id would be the
 *  second definition of it. */
export interface Stage0Fields {
	paneId: string;
	cwd: string;
	speak: boolean;
	rule: string;
	why: string;
	/** The finding, when the verdict speaks. Flattened so the row needs no join. */
	pid?: number;
	ageMs?: number;
	stalled?: boolean;
	working?: boolean;
}

export function stage0Fields(target: WatchTarget, verdict: WordVerdict): Stage0Fields {
	const fields: Stage0Fields = {
		paneId: target.paneId,
		cwd: target.cwd,
		speak: verdict.speak,
		rule: verdict.rule,
		why: verdict.why.slice(0, 200),
	};
	if (verdict.working === true) fields.working = true;
	if (verdict.finding) {
		fields.pid = verdict.finding.pid;
		fields.ageMs = verdict.finding.ageMs;
		if (verdict.finding.stalled !== undefined) fields.stalled = verdict.finding.stalled;
	}
	return fields;
}
