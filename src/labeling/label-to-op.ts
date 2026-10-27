// The one definition of what a mined label means for a supervisor.
//
// The miner (mine/decision-points.ts) labels a decision point with evidence found
// in the human's next message. That is ground truth about what a human had to do,
// not about the op — so something has to translate it, and there used to be two
// somethings that disagreed: the benchmark scored models against one table while
// the fine-tune trained against another, which makes every bench result
// untransferable to the tuned model. Both consumers import this file
// (bench/tasks/from-captures.ts, finetune/dataset.ts), so there is exactly one
// answer to "what was correct here".
//
// Every row reads as *what a supervisor should have done instead of waiting for
// the human to do it*. The cost of getting a row wrong is priced by REGRET in
// bench/runners/run.ts, and that matrix punishes abandoning a pane hardest:
// `nudge` expected and `leave` predicted costs 6, because that loses the whole
// cycle the pane was running. So a row is only mapped to something active when the
// human's own message proves action was owed — and in this corpus it always is,
// because the miner only emits a row when a human spoke.
//
// The vocabulary and the evidence behind each label are defined in the miner's
// header; this file only prices them.
//
//   continue     → nudge   the human typed nothing but a go-ahead. The agent had
//                          stopped to ask, so the supervisor could have said the
//                          same one word itself; that word is the nudge argument.
//   instruction  → nudge   the human supplied a directive or a statement. The
//                          message *is* the nudge, so a
//                          supervisor that relayed it saved the human the turn.
//   redirect     → nudge   the human corrected the course the agent was on. A
//                          correction is still an instruction to the same agent, so
//                          flag (which claims the human must take over) overclaims
//                          and badging it `leave` would abandon a work thread the
//                          human just repaired.
//   question     → nudge   the human asked the agent something instead of telling
//                          it. The pane must answer, so silence is not owed: the
//                          supervisor's job is to carry the question to it.
//   stop         → leave   the human's message was *only* a halt. This is the one
//                          row where doing nothing was correct, and it is why the
//                          table is anchored on leave at all.
//
// THREE GAPS, STATED PLAINLY, because a reader who assumes coverage will read the
// corpus wrong.
//
// `flag` has no mined support. It was fed entirely by `new_task`, which was
// `text.length > 200` and turned out to be populated by instructions to the same
// agent on the same task — the exact opposite of "a human must take over". The
// evidence-based replacements for it were measured and are dark: explicit
// abandonment phrasing, and a path/repo/file not mentioned anywhere earlier in the
// session. Both are recorded in the miner's header with their counts. So `flag` is
// currently unmineable from transcripts, and the honest statement is that this
// corpus cannot teach it. It stays in `Op` because the supervisor still needs it at
// runtime — `parseDecision` maps every refusal and unparseable answer to `flag` — but
// no row here expects it.
//
// `declare_done` has zero targets, for the same structural reason: a human's next
// message can evidence what they had to do and never that they accepted a delivery.
// An op for "the work was accepted" would need its own label mined from a signal
// that is not a human turn (the claim's own `state` is the same signal the worker
// already computes).
//
// `leave` is reachable only through `stop`, and a human halting work is not the same
// event as a supervisor correctly staying quiet: the row exists because a human
// intervened. Because the miner emits a row only when a human spoke, P(human
// intervened) = 1 across the whole corpus, so the op the supervisor should most
// often choose is the one the population cannot contain.
//
// The consequence to keep in view: with those three gaps, four of the five labels
// map to `nudge`, so the corpus's op distribution is almost entirely `nudge` plus a
// handful of `leave`. That is the corpus's honest ceiling, not a tuning target — a
// model that cannot beat `always nudge` here has demonstrated nothing, which is what
// bench/runners/run.ts reports beside every model.

import type { Op } from "../decision/types.ts";

export type Label = "continue" | "instruction" | "redirect" | "question" | "stop";

export const LABEL_TO_OP: Readonly<Record<Label, Op>> = {
	continue: "nudge",
	instruction: "nudge",
	redirect: "nudge",
	question: "nudge",
	stop: "leave",
};

export function isLabel(value: unknown): value is Label {
	return typeof value === "string" && Object.hasOwn(LABEL_TO_OP, value);
}
