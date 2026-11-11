# needle3 timeout probe — 2026-11-10

The question the committed n = 22 record cannot answer: **does needle3 ever emit an `op` given
time?** Every record before this one capped the adapter at 30 s or 120 s, so a refusal and a
slow decode are indistinguishable in them.

## What was run

```
node bench/runners/run.ts needle3 --limit=4 --timeout-ms=600000 \
  --taskset=bench/tasks/2026-10-26.b9765d1a55e18b4e.jsonl
```

Wall clock **3 m 22.8 s** (202.8 s), exit 0. Record written:
`bench/results/2026-11-10T10-12-52-421Z__needle3.json`. Its `.traces.jsonl` sidecar stayed on disk
and is **not** committed — a trace carries the engine's own words, which for this engine are a
paraphrase of the pane it was shown (`docs/CORPUS-POLICY.md`). The record keeps every score and
cites the task-set sha, which is what a reader needs to re-score with the corpus supplied out of
band.

One deviation from the handoff's command, deliberate: `--taskset` names the **frozen 502-row
snapshot** rather than the working `bench/tasks/tasks.jsonl`. The working file is now `89e3ec2d…`
(527 rows, `nudge` 524 / `leave` 3 / `flag` 0 / `declare_done` 0), so sampling it would have
measured a different corpus from every record this repository cites and could not have produced a
`flag` row at all. The snapshot is what the n = 22 record used and what the task-set sha
`b9765d1a55e18b4e` names, so the four rows below are directly comparable to that record.

**n = 4 is not representative.** Sampling is stratified by expected op, so four seats means the
subsets are chosen, not drawn: `flag` 1, `nudge` 2, `leave` 1, `declare_done` 0 (the op has no
corpus rows). Every number here is a statement about four rows.

## What happened

**0 of 4 returned an `op`. 0 of 4 timed out.** The record reads `refusals` 4,
`usableOutputRate` 0, `accuracyGivenUsable` `{value: null, n: 0}`, coverage **0** at every
threshold from 0.3 to 0.9, and `exactMatch` 0.25 — which is exactly the always-flag constant's
score on this subset, so the single "correct" row is a refusal coerced to `flag`, not a decision.
The always-nudge constant scores 0.5 here.

| row | expected | latency | `suppressed` | confidence | what the engine did |
|---|---|---|---|---|---|
| `dp-0164-01a15f32` | `flag` | 37,935 ms | 0 | 0.4700 | emitted no call; its reasoning was a task-framing sentence |
| `dp-0368-01a14237` | `nudge` | 58,568 ms | 2 | 0.0026 | proposed two calls, both withheld with a reasoned split |
| `dp-0375-01a1426a` | `nudge` | 43,041 ms | 1 | 0.0049 | proposed one call, withheld |
| `dp-0483-01a14da7` | `leave` | 52,264 ms | 1 | 0.0027 | proposed one call, withheld; reasoning cut mid-sentence by the token cap |

The `what the engine did` column describes the shape of each answer on purpose. The reasoning text
itself is a paraphrase of the pane it was shown, so it lives in the trace on disk and not in this
repository — see `docs/CORPUS-POLICY.md`, and note that the traces from this run are not committed.

p50 43,041 ms, p95 58,568 ms against a **600,000 ms** cap. The cap was never approached: the
slowest row used 9.8 % of it.

Given time, the engine does not produce an op — but **it is not silent**, and that distinction is
the finding. On three of four rows the model *did* emit calls; `suppressed` 1, 1 and 2 are the
grounding gate withholding them, and the refusal is the gate's report of that withholding, not a
decode that produced nothing. On the fourth (`suppressed` 0, confidence 0.4700 — an order of
magnitude above the others) the model never called a tool at all, and its reasoning was the
task-framing argument: it does not believe the task this pane was on maps onto `leave` / `nudge` /
`declare_done` / `flag`. That is the task-framing prior, and no amount of time changes it.

So the answer is **no, and not for the reason time would fix.** The four ops are unreachable for
this engine, but the binding constraints are the grounding gate over a proposed span and a
task-framing prior — neither is latency.

## The same four rows, under the 120 s cap

All four appear in the n = 22 record, so this is a paired comparison rather than a fresh sample:

| row | 2026-11-04 (120 s cap) | 2026-11-10 (600 s cap) | outcome |
|---|---|---|---|
| `dp-0164` | 54,510 ms, `suppressed` 0, conf 0.4788 | 37,935 ms, `suppressed` 0, conf 0.4700 | identical |
| `dp-0368` | 3,936 ms, `suppressed` 2, conf 0.0014 | 58,568 ms, `suppressed` 2, conf 0.0026 | identical |
| `dp-0375` | 3,631 ms, `suppressed` 1, conf 0.0147 | 43,041 ms, `suppressed` 1, conf 0.0049 | identical |
| `dp-0483` | 19,543 ms, `suppressed` 1, conf 0.0025 | 52,264 ms, `suppressed` 1, conf 0.0027 | identical |

The cap changed nothing: same suppressed counts, same refusal, same argument class. What moved is
the clock, by up to **16×** on the same row, the same input and the same output — this box is at
load average 14.33 on 12 cores with `llama-server` holding 743 % CPU, so every latency column
here is inflated and comparable to nothing. The probe's conclusion is robust to that because the
margin to the cap is over 10×; its latency column is not a measurement of anything.

## A correction to the handoff

The handoff states that 12 of the 22 rows in that record are timeouts "and more than half the
sample never got an answer at all". Counted from the traces, it is **8 of 22** (36 %):
`dp-0038`, `dp-0062`, `dp-0064`, `dp-0071`, `dp-0082`, `dp-0141`, `dp-0143`, `dp-0146`. The rest
split as **10** rows with `suppressed > 0` and **4** genuine no-calls at `suppressed == 0`
(`dp-0164`, `dp-0287`, `dp-0404`, `dp-0455`) — 8 + 10 + 4 = 22, no row in both. The two-failure
account is right; the proportions are inverted. Grounding suppression, not the timeout, is the
larger half of that record, which is the half the `finetune/dataset.ts` fix addresses.

## What it means for the ladder

The local engine is not slow infrastructure that a longer cap salvages. At ten minutes per
decision it returns nothing usable, on four rows spread across three ops, and it returns the same
nothing it returned at two minutes. Retire it as a **cost-saving** pre-filter: it saves no
dollars the hosted model does not also spend in seconds (3776 ms p50 at 20 layers against
1568 ms), and it produces no decision to save them on.

Two parts of the ladder survive that verdict, and they are different parts:

- **Tier 0 is untouched and still the thing that makes the economics work** — 21 panes, 0
  decisions, 0.094 s, $0. Not looking at an agent that did not move was never a model question.
- **The gate and the ladder's structure are fine.** A refusal at zero confidence escalates once
  and never more, which is exactly what a tier-0 filter that refuses everything should do. The
  problem is that it refuses everything.

The `dataset.ts` fix is the right next experiment on the suppression half — the arguments being
suppressed are spans that training drew from a tail the sidecar does not serve — but it cannot
touch the task-framing half, and it changes no archive until a retrain, which at 262.4 s/step on
CPU is not an overnight job. **Do not read this probe as a case for retraining tonight.**

The decision step already runs on a hosted model with `needle3` retired from the hot path, so
nothing in the running supervisor depends on this. The finding is for the *next* time someone
proposes tuning the local ladder rather than replacing it: the engine is not out of time, it is
out of grounding and out of belief in the task.
