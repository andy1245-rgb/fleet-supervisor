# fleet-supervisor

Watches a fleet of live coding-agent panes and reports on them. For each pane that has stopped
working it decides whether a word is owed, and says so. It has no way to stop, close or signal one.

![license: MIT](https://img.shields.io/badge/license-MIT-blue)
![node: >=24](https://img.shields.io/badge/node-%3E%3D24-informational)

## What it does

|   | step | code |
|---|---|---|
| 1 | **Reads the fleet.** One `herdr agent list`; a pane whose completion counter did not move since the last tick is not looked at again, so a still fleet costs one list call and no model call. | `src/fleet/detect.ts` |
| 2 | **Asks whether this is a moment that needs a word.** Stage 0: seven process rules plus one idle rule, each able to *permit* silence and required to name the rule that permitted it. | `src/watchdog/needs-a-word.ts` |
| 3 | **Asks a model, only on the rows stage 0 speaks on,** for one of four ops — `leave`, `nudge`, `declare_done`, `flag` — with one escalation available and never more than one. | `src/decision/ladder.ts` |
| 4 | **Gates the action.** `nudge` and `declare_done` are the only ops that touch a pane, and each either runs or is parked for a human to release. `leave` is not an action; `flag` notifies without touching anything. | `src/manager/tick.ts`, `src/manager/answer.ts` |
| 5 | **Writes every step to an append-only log** that can be queried a window at a time. | `src/metrics/report.ts` |

One observe tick against a live fleet — the whole pipeline, and nothing sent:

```console
$ AGENTFLEET_OBSERVE=1 AGENTFLEET_ONCE=1 AGENTFLEET_STATE_DIR=.fleet-state node src/manager/tick.ts
fleet tick: 50 agents, 50 moved, 50 decisions, 39/50 spoke, 0 triggers, 0 inspected, 0 escalated,
            0 escalations failed, 0 prompts, 0 held, $0.013369 · no daily cap · spent $0.013369 (observe)
```

`39/50 spoke` is stage 0 speaking, and its silences are logged beside the rule that allowed them.
Per pane a verdict is `{ speak: false, rule: "idle-shell" }` or `{ speak: true, rule: "idle-turn", why: … }`,
carrying the sentence a human would be shown. `50 decisions` is one model call per moved pane;
`0 prompts · 0 held` is observe mode's promise.

## The measured result

Stage 0 is the settled part. On a corpus of one operator's own sessions, one rule that watches the
clock instead of a process took stage 0 from speaking on 2.5% of turns to **54.1%** — a gate for
attention, not yet for judgement, because no rule in the table can tell a pane that has **finished**
from one that is **stuck**:

| | seven process rules | with the idle rule |
|---|---|---|
| share of turns it speaks on | 2.5% (34 of 1,363) | **54.1% (738 of 1,363)** |
| of the turns that owed a word, how many it sees | 2.7% (13 of 483) | **41.6% (220 of 529, held out)** |
| of the turns it speaks on, how many owed a word | 54.2% (13 of 24) | **62.9%** |

The process rules detect a runaway *process*; the corpus is overwhelmingly a pane that has *stopped*.
The eighth rule is the pane-level one — `idle-turn`: an agent that finished a turn and has taken no
input for `IDLE_TICKS` — with `N = 2` taken from the reply-latency distribution, not from taste (half
of all replies arrive inside 1.38 minutes, so the second tick; held out, it scores 61.5% precision).

That 54.1% is a corpus number and does not transfer: on the live fleet the same rules spoke on
**88.9% of 68,898 verdicts**, dominated by `command` (71%) rather than `idle-turn` (18%), so a gate
calibrated on the corpus is calibrated for the wrong fleet. The corpus figures are
[docs/stage0-residue-2026-11-10.md](docs/stage0-residue-2026-11-10.md) (1,363 decision points, 1,073
scorable, 292 sessions); the live ones are the observe stream in
[docs/headtohead-2026-11-24.md](docs/headtohead-2026-11-24.md).

## A local decision model was tried, and retired

The plan was a two-tier ladder: a 121M-parameter engine at home (20 layers, the same four ops) as a
free pre-filter, so the hosted model was paid only for the panes the engine refused.

**The verdict in one sentence:** built, measured, taken off the hot path and closed — because used
correctly, the engine proposes `flag` at a confidence of about five thousandths and then withholds it;
a task-framing failure, not a decoding one
([bench/results/NEEDLE3-CLOSED.md](bench/results/NEEDLE3-CLOSED.md)).

| the corrected run, 24 rows | |
|---|---|
| ops committed | **0 of 24** |
| proposals the engine made and then withheld | **20 of 24** — fourteen of them `flag` |
| confidence on its own answers | p50 **0.0053**, and never once zero |
| if every withheld proposal were taken as its answer | 3 of 24 = **12.5%**, against a constant that always says `nudge` at **54.2%** |

Four adapter faults were found and fixed before the verdict: a decode budget shorter than the
reasoning, the system prompt passed in the query instead of as the static prefix, the withheld
proposal discarded, a deadline under the engine's latency. The twelve `needle3` records and five
`slate` records written under them stay in the tree, named as invalid one by one in
[bench/results/INVALIDATED-needle3.md](bench/results/INVALIDATED-needle3.md); the fix made the failure
legible, not passing.

What would reopen the question is written down too — serve the decision as an instruction rather than
a state block, shrink the tail, use a checkpoint with a trained confidence head, or fine-tune on this
corpus. None of the four is scheduled; `AGENTFLEET_PRIMARY=needle3` still selects the engine.

## Two supervisors, head to head

On one evidence base, one label definition and one session-hash split, `node bench/runners/headtohead.ts`
scores two arms: **the decision model at its strongest framing** — stage 0 picks the moment, the model
picks the word on the residue, so it is never asked about a pane that needed nothing — against **five
cheap anomaly detectors** that need no model and no labels: a duration past its task type's p99, three
identical calls in one turn, an edit with no test run, an unanswered ask, a vanished process.

Only the first three of those five are computable from a transcript, and they are the three detector
rows below; the last two are pane state and are not in this table at all. The detectors are scored on
674 held-out turns and the model on the 24-row residue stage 0 had already selected, so the two blocks
have different denominators:

| arm | fires on | precision | recall | false-positive rate |
|---|---|---|---|---|
| detector — duration past max(p99, 60 s) | 1.0% (7 of 674) | 100% | 1.3% | **0.0%** |
| detector — repeat: 3 identical calls in one turn | 1.0% (7 of 674) | 100% | 1.3% | **0.0%** |
| detector — edit with no test run after it | 2.8% (19 of 674) | 100% | 3.6% | **0.0%** |
| **detectors — all five unioned, counting distinct turns** | **3.6% (24 of 674)** | **100%** | **4.5%** | **0.0% (0 of 145 quiet turns)** |
| model — proposed a word | 75% (18 of 24) | 50% (9 of 18) | 69.2% (9 of 13) | **81.8% (9 of 11)** |

The union row is not the sum of the rows above it. It unions **all five** detectors, the three
above and the two pane-state ones, and it counts **distinct turns**: those three rows fire
7 + 7 + 19 = 33 times across the 674 turns, and a firing that lands on a turn already counted does
not add a second turn, so the union is **24 turns**.

Two things the detector block hides. The precision is a real lift over a 78% base rate (0.78²⁴ ≈ 0.3%
by luck) but a lift of **24 firings**, and these are *per-turn* rates: a detector that re-fires while a
turn is still open sees it ten or twenty times, so the tick-level false-alarm rate is many times this
unless every detector is edge-triggered. The model bought its 69% recall the other way: it spoke on
three residue rows in four, was right about the word 15% of the time, and committed an op on 0 of 24.

4.5% recall is a precise alarm that is nearly blind, and no rival to the stage-0 numbers above: those
are a *gate*, firing on half the turns to cover 41.6% of the words owed; these are an *alarm*, firing
on 3.6% to be right almost every time they do. It replaces silence with a rare event a human can trust
and will never decide what to say to a pane. Both tables, the split and the cost per tick are in
[docs/headtohead-2026-11-24.md](docs/headtohead-2026-11-24.md) under *Arm 2, measured offline* and
*Arm 1, on the same residue*.

**The cheap detector is trustworthy and narrow, the model is neither — and a supervisor that cries
wolf gets switched off in a day.**

## Quickstart

Node 24 or newer is the whole toolchain: the tests run `.ts` files directly by type stripping.

```console
$ npm install          # typescript + @types/node; the test suite itself needs no dependency
$ npm test             # 684 tests, 681 pass, 3 skipped, 0 fail
$ npm run check:corpus # the guard that keeps mined text out of a public repo
```

Four entry points that need no fleet, no pane and no model:

```console
$ node ext/pi-fleet/selfcheck.ts           # drives the pi extension's handlers against a temp registry
$ node src/metrics/report.ts --window=all  # tables from the event log; zeros when there is none
$ node bench/runners/headtohead.ts         # both supervisors side by side; writes nothing
$ node src/watchdog/rules.ts               # reads /proc, prints every process past its allowance
```

To point it at a live fleet it needs two things it cannot invent: `herdr` on `PATH` (or
`HERDR_BIN_PATH`), and a model credential — `COMMAND_CODE_API_KEY` for the default primary, or the
`auth.json` in the pi agent config directory, which the adapter also reads, plus `OPENROUTER_API_KEY`
if the escalator is to work; without it each tick reports the escalation it could not place. Then the
observe tick at the top of this page is the whole pipeline in one command, and drop
`AGENTFLEET_OBSERVE=1` to make it act through `herdr`; `AGENTFLEET_DRY=1` decides without touching
anything. The knobs that matter:

| variable | default | effect |
|---|---|---|
| `AGENTFLEET_INTERVAL_MS` | `60000` | tick interval. The idle rule's `N` was derived against 60 s; at any other interval two ticks is a different amount of silence and the rule stops meaning what it was measured to mean. |
| `AGENTFLEET_ASK` | `fork` | when the gate parks an action for a human instead of performing it: `never` acts and reports after, `fork` asks on a hard fork only, `often` also asks on a soft one, `always` asks on every non-`leave` decision. |
| `AGENTFLEET_MAX_PROMPTS` | `3` | prompts a single tick may send. |
| `AGENTFLEET_DAILY_COST_CAP_USD` | unset | the day's spend at or above which a tick makes no model call. Unset means no cap; spend is recorded either way. |
| `AGENTFLEET_INSPECTOR` | `cheap` | the cross-agent tier: `off` announces a trigger and stops, `cheap` asks the escalator over a bounded brief, `deep` gives one child 120 s. |
| `AGENTFLEET_STATE_DIR` | `.pi/agent/fleet-state` under your home | where state lives: `events.jsonl`, `marks.json`, `pending.json`, `asks.jsonl`, `policy.json`. |

A held action is one line in `<state>/asks.jsonl`, and the last line for an id is that id's state, so
a pending action survives a restart and cannot be applied twice. Telegram replies are not polled: the
notification carries the id and the command, and this CLI is the answer channel.

```console
$ node src/manager/answer.ts <id> yes            # send the held nudge
$ node src/manager/answer.ts <id> yes "shorter"  # ...with replacement text
$ node src/manager/answer.ts <id> no             # discard it
```

## How it was measured

Three harnesses, all committed, all scored by code in the repository rather than by hand:

- **Offline.** `mine/time-sampled-points.ts` turns transcripts into decision points — a point is a
  completed agent turn, labelled by what a human did inside one tick's window, with *no human message*
  being a label (`leave`) rather than a missing value. `bench/runners/stage0.ts` scores the rules on a
  fit half and a held-out half; `headtohead.ts` scores both supervisors on one evidence base; `run.ts`
  runs a frozen task set against a model and writes a `bench/results/` record carrying its task-set
  sha, per-op recall, exact match, regret and nearest-rank latency.
- **Live.** `AGENTFLEET_OBSERVE=1` runs the whole pipeline, writes what it *would* have done, then
  joins each decision to what the pane did next — so a pane the supervisor stayed quiet about, and
  which then never moved, becomes a counterexample row. Observation is log-only: the log is the whole
  output and nothing executes. That join is evidence no transcript could have produced
  ([docs/observe-protocol-2026-11-14.md](docs/observe-protocol-2026-11-14.md)), and it has now run
  against a live fleet — 2,059 ticks over three days, stopped on the 17th, every one of the 232
  decisions a provider refusal, so the span records the provider failing, not the model judging. How
  to read it: [docs/observation-running-2026-11-14.md](docs/observation-running-2026-11-14.md).
- **The supervisor's own log** is a typed, append-only JSONL with one report over it. Rates are
  `null` rather than `0` when the denominator is empty, percentiles are nearest-rank over values that
  occurred, and a field no stage can supply honestly is named rather than written as zero:
  [docs/METRICS.md](docs/METRICS.md).

**Records are public; data is not.** Mined rows, bench task sets and adapter archives are gitignored,
and `npm run check:corpus` reads the *tracked* content and fails on a pane id, a session id, a
terminal tail or a credential ([docs/CORPUS-POLICY.md](docs/CORPUS-POLICY.md)). A record cites its
task-set sha and the rows travel out of band, which is why the bench cannot be re-run from a clone.

The design record is [docs/specs/agent-fleet-design.md](docs/specs/agent-fleet-design.md), what was
rejected included; the register of everything wrong or unverified is
[docs/specs/LIMITATIONS.md](docs/specs/LIMITATIONS.md); the plan's independent sceptical review is
[docs/reviews/2026-10-26-plan-review.md](docs/reviews/2026-10-26-plan-review.md). Everything else in
`docs/` is indexed in [docs/README.md](docs/README.md).

## What it does not do

- **It does not stop, kill, signal or close anything.** Not as a policy — as an absence of capability.
  `HerdrPort` has `list`, `get`, `read` and `prompt`, and no other member; nothing under
  `src/watchdog/` can spawn, signal or exit; the op vocabulary has no stop op, so no model can propose
  one. [test/no-terminate.test.ts](test/no-terminate.test.ts) pins all four absences against the
  source text, and was verified the way a guard should be: adding a `process.kill` to the watchdog
  fails it.
- **It does not act in observe mode.** Nothing leaves the process — no prompt, no notification, no
  parked ask, no claim file: every would-be message is a log row, and a four-tick run records
  `prompts 0 · held 0 · asks 0`.
- **Stage 0 is not wired as a gate on a live tick.** There is no `AGENTFLEET_STAGE0`; stage 0's
  verdicts are computed and logged in observe mode only, so a live tick still asks the model about
  every pane that moved. Wiring it is a cost question, not a correctness one.
- **It has not been scored against what a fleet actually did.** Every label it has been scored against
  is a transcript proxy. `declare_done` has zero mined targets, so its column reads `n/a` rather than
  as a result; the cross-agent inspector reports, never acts, and has never been scored at all; and
  the live `stalled`:`progressed` base rate is too short to tell one model from a luckier one.
- **It does not know whether a nudge helps.** Observe can only label the silent side: a pane that
  moves after the supervisor stayed quiet is a nudge that was not needed, and a pane that stays still
  is ambiguous between finished and stuck. Scoring a nudge requires sending one — a live trial, a
  different decision.

## Layout

| path | what is in it |
|---|---|
| `src/manager/` | one pass over the fleet (`tick.ts`), the cross-agent triggers, the ask gate and its answer channel, the inspector, and every limit that stops one unattended tick doing damage (`config.ts`). |
| `src/decision/` | model adapters, the single prompt and input renderer, the defensive parse every op passes through, and `ladder.ts`. |
| `src/watchdog/` | stage 0: the rule table, the idle rule, and the action contract that reports and never signals. |
| `src/fleet/` | claim registry (one JSON file per pane, written tmp-then-rename), grouping, change detection by monotonic sequence number rather than text diffing, the loopback write guard, and the route and screen tables an external `fleet-manager` server reads. |
| `src/herdr/` | the only module that shells out to `herdr`. It returns wire envelopes and never folds an error code into an exception, because a rejected prompt is a decision input. |
| `src/metrics/` | the typed event vocabulary, the store, the report, and the exporter that turns judged outcomes into candidate bench rows. |
| `src/notify/`, `src/swarm/`, `src/channels/`, `src/labeling/`, `src/corpus/` | the outbox; the grant/lease machinery; a Reddit channel; the one definition of what a mined label means for a supervisor; the credential-shape list the corpus guard and the miner share. |
| `test/` | `node:test` over the same tree, including the gate, the ladder, the watchdog and the no-terminate contract. |
| `bench/` | the measurement harness, its schema, and every committed record. |
| `mine/` | the session miner; its output is gitignored by policy. |
| `finetune/` | the retired local engine's fine-tune scaffold, in Python. Not on any path a tick takes. |
| `ext/pi-fleet/` | the worker-side pi extension: it makes each live session write its own claim file, because the supervisor sees a terminal and not a session. |
| `docs/` | measurement records, protocol, policy, design and specs — [docs/README.md](docs/README.md). |
| `tools/` | the corpus guard and its allowlist, and a drift check that fails when a security predicate grows a second copy. |

`package.json` carries no `bin`: every entry point above is a script or a file path, and the npm
aliases are `test`, `typecheck`, `tick`, `watchdog`, `mine`, `bench`, `rescore`, `check:corpus`.

## Licence and attribution

MIT — see [LICENSE](LICENSE). Third-party code is used as dependencies and is not vendored:
`cactus-needle`, the local engine the fine-tune scaffold targets, and
`@earendil-works/pi-coding-agent`, which the pi extension is typed against.
