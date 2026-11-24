# Two supervisors, head to head — 2026-11-24

The operator wants both, not one instead of the other: **the decision model given its strongest framing**
(stage 0 picks the moment, the model picks the word on the residue), and **a bag of cheap anomaly
detectors** (per-task-type duration baselines, repeated identical calls, edit with no test run, a pane
waiting on an unanswered ask, a process that vanished). Same evidence, same event stream, same labels,
same split. `node bench/runners/headtohead.ts` reproduces every number below and writes nothing.

## What each arm is, precisely

**Arm 1 — the model.** Stage 0's rules decide *when* to speak; on the rows it selects (the residue),
the local engine chooses *what* to say. This is its strongest framing: it is not asked about panes
that need nothing, and it is scored only where the rules already fired. Evidence: the corrected
adapter's record `2026-11-15T09-52-19-800Z`, twenty-four residue rows.

**Arm 2 — the detectors.** No model, no labels, no training:
the p99 of each task type's duration in the fit half (a `bash/test` call that normally finishes in
30 s and is at 12 minutes), three identical calls in one turn, an edit with no test run after it, a
pane whose ask has gone unanswered, a command that was running and is gone without a result.

**Same labels.** The one definition everything in this repository uses: did a human eventually have
to say something after this turn (a word was owed), or did nobody ever come back. **Same split**: the
session-hash half, so a row sits on the same side of every table.

## Arm 2, measured offline

674 holdout turns, 529 of which owed a word (78 %), 145 that did not.

| detector | fired | share | precision | recall | **false-positive rate** |
|---|---|---|---|---|---|
| duration > max(p99, 60 s) | 7 | 1.0 % | 100 % | 1.3 % | **0.0 %** |
| duration > max(p99, 5 min) | 5 | 0.7 % | 100 % | 0.9 % | **0.0 %** |
| duration > 3 × p99 | 3 | 0.4 % | 100 % | 0.6 % | **0.0 %** |
| repeat: 3 identical calls | 7 | 1.0 % | 100 % | 1.3 % | **0.0 %** |
| edit with no test run | 19 | 2.8 % | 100 % | 3.6 % | **0.0 %** |
| turn ended on a question | 0 | 0.0 % | — | 0.0 % | 0 % |
| **union of the five** | **24** | **3.6 %** | **100 %** | **4.5 %** | **0.0 %** |

Two things to be careful about, because the table flatters.

**The precision is real but thin.** 24 firings, none of them on a quiet turn. Against a 78 % base
rate the chance of that happening by luck is 0.78²⁴ ≈ 0.3 %, so it is a genuine lift — but it is a
lift of 24 observations, and a detector that fires twice a week is a detector whose precision is
re-measured every month.

**The number that will kill it is not in this table.** These are *per-turn* rates. A detector that
re-fires on every tick while the turn is still open sees the same turn ten or twenty times, so the
tick-level false-alarm rate is many times the per-turn one unless every detector is **edge-triggered**
— fires once per (pane, turn, detector) and then latches until the pane moves. That is not a
refinement; it is the difference between an alarm and a nuisance, and it is why the supervisor already
has a per-pane cooldown.

## Arm 1, on the same residue

Twenty-four rows, all of which stage 0 had already selected — so this is the model at its best case,
not in competition with a rule that would have filtered it out.

| | |
|---|---|
| committed an op | **0 of 24** (0 %) |
| proposed a word (non-`leave`) | **18 of 24** (75 %) |
| of those, a word was owed | 9 → **precision 50 %** |
| of those, nothing was owed | 9 → **false-positive rate 81.8 %** |
| recall of "a word was owed" | 9 of 13 → **69.2 %** |
| right word when it proposed one | **3 of 20 proposals (15 %)** |

Read the last line twice: when the model does choose to speak, it names the correct op 15 % of the
time. Its 69 % recall is bought by firing on three rows out of four, and it pays 82 % false positives
on the rows where nothing was owed.

## The live event stream

The observation run, read-only:

```
span            2026-11-14T20:35 → 2026-11-17T20:55   (2,059 ticks, three days)
decisions       232   (77/day) — every one refused: the account has no credits
outcomes        132   all `stalled`
stage 0 spoke   88.9 % of 68,898 verdicts
                `command` 71 % · `idle-turn` 18 % · `idle-shell` 11 %
watchdog        27,715 findings over 140 distinct pids ≈ 13.5 flags/tick, mostly the same processes
model spend     $0.000000
```

**The run stopped on the 17th and has not restarted.** The host rebooted on the 22nd, and the last
tick predates the reboot, so the process died first and the reboot is not the cause. I have not
restarted it: the operator approved four days, this collected three, and the credits are still out so
a resumed span would record refusals. Resuming is one command —
`AGENTFLEET_OBSERVE=1 AGENTFLEET_STATE_DIR=~/.pi/agent/fleet-observe … node src/manager/tick.ts` — and
`marks.json` means it picks up where it left off rather than re-deciding the fleet.

Three things the live stream says that the corpus cannot:

- **The rules speak far more on a live fleet than on the corpus** (88.9 % vs 54.1 %), and the mix is
  dominated by `command` (71 %) rather than `idle-turn`. A gate built on the corpus's numbers would
  be calibrated for the wrong fleet.
- **The watchdog's live behaviour is a nuisance in the making**: 13.5 flags per tick over only 140
  distinct pids is the same long-lived processes re-flagged every minute. Edge-triggering, not a
  better rule, is what fixes that.
- **Every outcome is `stalled`** (132 of 132) because observe never sends: a pane the supervisor left
  alone and that did not move. That is the counterexample class and it is being collected.

## Which arm can be validated offline, and which needs live data

| | offline (transcripts) | live only |
|---|---|---|
| arm 1 | scored on the residue, on a proxy label | **its decisive question** — finished versus stuck — has no transcript label at all |
| arm 2: duration, repeat, edit-without-test | **fully** — durations and sequences are transcript facts | — |
| arm 2: unanswered ask, vanished process | not at all | **only** — pane state, and this observe log cannot answer the first because observe never parks an ask |
| false-positive rate *per tick* (either arm) | underestimable at best | **only** — it is a property of repetition over ticks |

And one blocker worth naming: **the duration detector cannot be validated from the observe log as it
stands**, because the log records pane state and not tool timings. Running it live means giving the
tick a per-call duration — from the claim the worker already writes, or from the session file — which
is a change to the evidence, not to the detector.

## Cost per tick

| | per decision | per tick (measured) | per day at 77 decisions |
|---|---|---|---|
| arm 1 | $0.0004827 (the record's `per1k`) | 0.113 decisions/tick → **$0.000055** | **$0.037** |
| arm 2 | $0 | **$0.00** | **$0.00** |

Arm 1's per-tick cost is small because stage 0 filters most ticks out; it is not small because the
model is cheap. And the filter is weak where it matters: live, stage 0 speaks on 88.9 % of verdicts,
so a gate built on it would save 11 % of the calls, not 46 %.

## Which I would ship

**Arm 2 — the union, as an alarm, edge-triggered, and not as a gate.** It fires on 3.6 % of turns,
never on a quiet one, costs nothing, and needs no labels to exist. The three offline detectors go in
first because they are computable from evidence the supervisor can already reach; `unanswered ask` and
`vanished process` go in next because they are the most specific of the five and are pure pane state —
"this pane asked me something twelve minutes ago and I have not answered" is not a judgement call.

**I would not ship arm 1.** Not because a small local model cannot do this task in principle, but
because on its best framing it proposes a word on three rows out of four and is wrong about the word
85 % of the time, and its false-positive rate on quiet panes is 82 %. A supervisor that cries wolf on
four quiet panes in five is turned off within a day, which is the operator's own criterion.

The honest limit of what I am recommending: **arm 2's recall is 4.5 %.** It does not decide what to
say to a pane, and it never will. It replaces *silence* with a rare alarm that a human can trust —
which is exactly what a tier-0 stage should be, and is the opposite of what the ladder was built to do.
