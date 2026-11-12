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

import { classify, findingFields, formatAge, RULES, type CommandSample, type FindingFields, type Rule, type Verdict } from "./rules.ts";

/** What a pane is, from the supervisor's own snapshot. Only the fields this stage
 *  reads: it is not a `HerdrAgent`, and a caller should not have to build one. */
export interface WatchTarget {
	paneId: string;
	/** The directory the pane is working in — the agent's foreground cwd where herdr
	 *  reports one, else its cwd. This is the attribution key. */
	cwd: string;
	/** Ticks since the pane last changed, when the caller has the clock. Absent means
	 *  "do not judge idleness" rather than "idle for no ticks": the process rules do
	 *  not need a clock and a caller without one must not silently get the idle rule
	 *  at its firing threshold. */
	idleTicks?: number;
	/** The pane's own status. The idle rule reads it and nothing else does. */
	status?: string;
}

/** How many ticks of no input make a pane worth speaking to.
 *
 *  Derived from the corpus, not chosen: on the fit half of the mined turns, the
 *  operator's reply latency has a **median of 1.38 minutes** — half of all replies
 *  arrive inside that — so the first whole tick at which a reply has stopped being
 *  the likely next event is the second. Two ticks of silence is the point where
 *  waiting is no longer a bet on the human. The distribution behind it, and the
 *  held-out check that it was not tuned on the rows it is scored on, are in
 *  `docs/stage0-residue-2026-11-10.md` § "The idle rule".
 *
 *  This is the rule the first pass was missing, and the reason the seven process
 *  rules could only ever be an alarm: they detect a runaway *process*, and the
 *  corpus is overwhelmingly a pane that has *stopped*. */
export const IDLE_TICKS = 2;

export const IDLE_RULE = "idle-turn";

/** The rule's own sentence, exported so the measurement prints the same words the
 *  supervisor would. */
export const IDLE_WHY = "the agent finished a turn and has taken no input since: nobody is coming back to this pane on their own";

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
	/** What to do about it, present exactly when `speak` is true. */
	action?: WordAction;
	/** True when the deciding process was past its allowance but the second sample
	 *  showed CPU progress. Only ever set on a silent verdict, and it is the one
	 *  silence a reader should be able to tell from "nothing was running". */
	working?: boolean;
}

/** There is exactly one action for a flagged command, and it contains no terminate.
 *
 *  The operator's rule, and it is absolute: **the watchdog never stops, kills or
 *  signals anything.** Not "prefers not to", not "only when it looks hung" — the
 *  subject of a finding keeps running, whatever the rule says and whatever a model
 *  proposes. So a flagged command gets exactly three things:
 *
 *    1. the owning agent is prompted, and told in as many words that the final
 *       decision about the process is its own;
 *    2. the operator is notified of the same facts;
 *    3. the command carries on in the background, untouched.
 *
 *  `signal` is the literal `"none"` rather than a boolean or an option, because this
 *  is the contract that must not acquire a switch. There is no code path behind it
 *  to switch on: `src/watchdog/` imports no `child_process` and calls no signal, the
 *  `HerdrPort` has no `stop`/`close`/`kill` member (`src/herdr/types.ts`), and the op
 *  vocabulary has no stop op for a model to propose. `test/no-terminate.test.ts`
 *  pins all three absences, because an absence nobody tests is a default waiting to
 *  be filled in. */
export interface WordAction {
	readonly kind: "prompt-agent-and-notify";
	/** Exactly what is sent to the owning agent. */
	readonly prompt: string;
	/** Exactly what is sent to the operator. */
	readonly notify: string;
	/** There is nothing to send to the process, because there is no way to send it. */
	readonly signal: "none";
	/** The command keeps running. A literal for the same reason. */
	readonly leavesRunning: true;
}

/** The idle-turn rule's action. Same contract as a process finding — prompt the
 *  agent, tell it the decision is its own, notify the operator, signal nothing —
 *  with no process to leave running because this rule is about a pane that has
 *  stopped rather than one that is running. There is nothing to stop here, and the
 *  action still says so, because the contract is "never terminate", not "nothing to
 *  terminate". */
export function idleActionFor(target: WatchTarget, idleTicks: number): WordAction {
	const prompt = [
		`Watchdog: this pane has taken no input for ${idleTicks} ticks.`,
		"",
		`Why that is worth a look: ${IDLE_WHY}`,
		"",
		"Nothing has been signalled and nothing will be: this is yours to decide. If you are blocked, say what you need or unblock yourself. If the work is finished, say what you delivered. The final decision is yours.",
	].join("\n");
	const notify = `${target.paneId}: no input for ${idleTicks} ticks (${IDLE_RULE}). Its agent has been asked to decide and told the decision is its own. Nothing was stopped.`;
	return { kind: "prompt-agent-and-notify", prompt, notify, signal: "none", leavesRunning: true };
}

/** The idle rule, as a verdict or nothing. Absent a clock, absent a verdict: a caller
 *  that cannot say how long the pane has been idle is not told that it has not been. */
function idleVerdict(target: WatchTarget): WordVerdict | undefined {
	if (target.idleTicks === undefined || target.status === undefined) return undefined;
	// Only a resting agent. `working` is doing something, `blocked` is waiting on a
	// human by its own account and has its own trigger, and `done` finished on purpose
	// — nudging any of the three would be speaking to a pane about the wrong thing.
	if (target.status !== "idle") return undefined;
	if (target.idleTicks < IDLE_TICKS) return undefined;
	return {
		speak: true,
		rule: IDLE_RULE,
		why: `${IDLE_WHY} (${target.idleTicks} ticks and counting)`,
		action: idleActionFor(target, target.idleTicks),
	};
}
export function wordActionFor(target: WatchTarget, rule: string, why: string, finding: FindingFields): WordAction {
	const command = finding.command.trim() || "a command";
	const age = formatAge(finding.ageMs);
	const prompt = [
		`Watchdog: \`${command}\` (pid ${finding.pid}) has been running ${age}, past the allowance for its class of command.`,
		"",
		`Why that is worth a look: ${why}`,
		"",
		"Nothing has been signalled and nothing will be: this process is yours to decide about. Leave it if it is working, and if it is not, change what you are doing about it. The final decision is yours.",
	].join("\n");
	const notify = `${target.paneId}: \`${command}\` (pid ${finding.pid}) has run ${age} past its allowance (${rule}). Its agent has been asked to decide and has been told the decision is its own. The command is still running — nothing was stopped.`;
	return { kind: "prompt-agent-and-notify", prompt, notify, signal: "none", leavesRunning: true };
}

/** Which pane a process belongs to, by the same attribution `needsAWord` uses: the
 *  pane working where the process works. `undefined` when no pane claims it, which
 *  is the honest answer for a daemon and means the finding goes to the operator
 *  rather than to an agent. */
export function ownerOf(sample: CommandSample, targets: readonly WatchTarget[]): WatchTarget | undefined {
	if (!sample.cwd) return undefined;
	return targets.find((target) => target.cwd === sample.cwd);
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
		return {
			speak: true,
			rule: verdict.rule,
			why: verdict.why,
			finding: findingFields(sample, verdict),
			action: wordActionFor(target, verdict.rule, verdict.why, findingFields(sample, verdict)),
		};
	}
	if (decided) {
		return {
			speak: false,
			rule: decided.verdict.rule,
			why: `past its allowance, but the second sample showed CPU progress — working, not hung`,
			working: true,
		};
	}

	// The pane-level rule, after the process rules and never instead of them: a
	// running command past its allowance is stronger evidence about this pane than a
	// clock is, and the two barely overlap — a pane running something is not idle.
	const idle = idleVerdict(target);
	if (idle) return idle;

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
