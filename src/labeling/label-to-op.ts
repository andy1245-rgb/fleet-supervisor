// The one definition of what a mined label means for a supervisor.
//
// The miner (mine/decision-points.ts) labels a decision point with the human's
// next instruction. That is ground truth about what a human had to do, not about
// the op — so something has to translate it, and there used to be two somethings
// that disagreed: the benchmark scored models against one table while the
// fine-tune trained against another, which makes every bench result untransferable
// to the tuned model. Both consumers now import this file
// (bench/tasks/from-captures.ts, finetune/dataset.ts), so there is exactly one
// answer to "what was correct here".
//
// Every row reads as *what a supervisor should have done instead of waiting for
// the human to do it*. The cost of getting a row wrong is priced by REGRET in
// bench/runners/run.ts, and that matrix is deliberately asymmetric — it punishes
// action when the right answer was silence (leave → nudge is 5, the most
// expensive cell) and does not price under-reacting at all (the nudge and flag
// rows have no leave column). So a row is only mapped to something active when
// the human's own message proves action was owed.
//
//   continue  → nudge        the agent stopped to ask; a supervisor's nudge saves
//                            the human the turn. The human has just supplied the
//                            go-ahead, so that text is the nudge argument.
//   nudge     → nudge        the human typed an instruction; the supervisor
//                            should have typed it. The miner's reason for this
//                            bucket is "no explicit signal" — i.e. no correction
//                            marker, not no content — so the message is a real
//                            instruction and relaying it is the action owed.
//   redirect  → nudge        the human corrected course; the supervisor should
//                            have sent the correction. A correction is still an
//                            instruction to the same agent, so flag (1) and
//                            declare_done (4) both overclaim: one sentence fixes
//                            what the supervisor could have said itself.
//   stop      → leave        doing nothing was correct: the human wanted it
//                            halted. This row is why the table is anchored on
//                            leave — mistaking a stop for action is the matrix's
//                            worst case (nudge 5, declare_done 4, flag 2).
//   new_task  → flag         the human abandoned the thread; that is a judgement
//                            call, not a supervisor action. With no carry-over
//                            between the agent's last turn and the new work,
//                            declaring done would claim a delivery that was never
//                            accepted and nudging would chase a dropped thread.
//                            flag is the honest op and the cheapest to be wrong
//                            about (1 in either direction).
//
// `nudge → nudge` is the row that flipped: finetune/dataset.ts used to read this
// bucket as leave, on the argument that the human's message carried no correction
// and so nothing needed doing. That reads silence as approval, and the bucket is
// 64% of the corpus (323 of 502), so it trained a supervisor whose majority action
// was inaction — on the one hand-verified label where a human demonstrably had to
// type something. The miner only records points where a human spoke, so the data
// cannot contain a "nobody had to intervene" example in the first place.
//
// A consequence worth naming: no label maps to declare_done, so neither the bench
// task set nor the fine-tune corpus holds a declare_done target. A human's next
// message cannot evidence a delivery — abandoning the thread is a judgement call,
// not an acceptance — so an op for "the work was accepted" would need its own
// label, not a remap of these five.

import type { Op } from "../decision/types.ts";

export type Label = "continue" | "nudge" | "redirect" | "stop" | "new_task";

export const LABEL_TO_OP: Readonly<Record<Label, Op>> = {
	continue: "nudge",
	nudge: "nudge",
	redirect: "nudge",
	stop: "leave",
	new_task: "flag",
};

export function isLabel(value: unknown): value is Label {
	return typeof value === "string" && Object.hasOwn(LABEL_TO_OP, value);
}
