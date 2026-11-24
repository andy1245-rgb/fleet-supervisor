# fleet-supervisor

Watches a fleet of live coding-agent panes and reports on them: for each pane that has stopped working, it decides whether a word is owed, and says so. It has no way to stop, close or signal one.

![license: MIT](https://img.shields.io/badge/license-MIT-blue)
![node: >=24](https://img.shields.io/badge/node-%3E%3D24-informational)

## What it does

Five things, in the order one tick does them:

|   | step | where |
|---|---|---|
| 1 | **Reads the fleet.** One `herdr agent list`; a pane whose completion counter did not move since the last tick is not looked at again, so a still fleet costs one list call and no model call. | `src/fleet/detect.ts` |
| 2 | **Asks whether this is a moment that needs a word.** Stage 0: seven process rules plus one idle rule, each able to *permit* silence and required to say which rule permitted it. | `src/watchdog/needs-a-word.ts` |
| 3 | **Asks a model, only on the rows stage 0 speaks on,** for one of four ops — `leave`, `nudge`, `declare_done`, `flag` — with one escalation available and never more than one. | `src/decision/ladder.ts` |
| 4 | **Gates the action.** `nudge` and `declare_done` are the only ops that touch a pane; each one either runs or is parked for a human to release. `leave` is not an action, and `flag` notifies without touching anything. | `src/manager/tick.ts`, `src/manager/answer.ts` |
| 5 | **Writes every step to an append-only log** that can be queried a window at a time. | `src/metrics/report.ts` |

One observe tick over 17 live panes — the whole pipeline, and nothing sent:

```console
$ AGENTFLEET_OBSERVE=1 AGENTFLEET_ONCE=1 AGENTFLEET_STATE_DIR=<dir> node src/manager/tick.ts
fleet tick: 17 agents, 17 moved, 17 decisions, 9/17 spoke, 0 triggers, 0 inspected, 0 escalated,
            0 escalations failed, 0 prompts, 0 held, $0.002852 (observe)
```

`9/17 spoke` is stage 0 speaking — its silences are in the log beside the rule that allowed them. `17 decisions` is one model call per moved pane. `0 prompts · 0 held` is observe mode's whole promise. Per pane, a verdict is `{ speak: false, rule: "idle-shell" }` or `{ speak: true, rule: "idle-turn", why: … }` carrying the sentence a human would be shown.

## The measured result

Stage 0 is the settled part, and it is worth quoting with the caveat inside the sentence: on a corpus of one operator's own sessions, a process-only rule table was a good alarm and a poor gate, and adding one rule that watches the clock instead of a process fixed most of the difference.

| | the seven process rules | with the idle rule |
|---|---|---|
| share of turns it speaks on | 2.5% (34 of 1,363) | **54.1% (738 of 1,363)** |
| of the turns where a word was owed, how many it sees | 2.7% (13 of 483) | **41.6% (220 of 529, held out)** |
| of the turns it speaks on, how many owed a word | 54.2% (13 of 24 scorable) | **61.5% (held out)** |

The process rules detect a runaway *process*; the corpus is overwhelmingly a pane that has *stopped*, which is why they saw 2.7% of the words that were owed. The eighth rule is the pane-level one — `idle-turn`: an agent that finished a turn and has taken no input for `IDLE_TICKS` — with `N = 2` taken from the reply-latency distribution rather than from taste (p50 1.38 minutes on the fit half, so the second tick, checked on a held-out half). Together they select 54% of turns, cover 42% of the words that were owed, and leave a residue that is 63% word-owed rather than mostly `leave`.

What no rule in the table can do is tell a pane that has **finished** from one that is **stuck**. That is the whole of its 36% error rate, and a transcript cannot even label it — so stage 0 is a gate for attention and not yet a gate for judgement. Record: [docs/stage0-residue-2026-11-10.md](docs/stage0-residue-2026-11-10.md) (1,363 decision points, 1,073 scorable, 292 sessions, a 60-second window).

## A local decision model was tried, and retired

The plan was a two-tier ladder: a 121M-parameter engine at home (20 layers, the same four ops) as a free pre-filter, so the hosted model was paid only for the panes the engine refused. It was built, measured, taken off the hot path, and closed with a written verdict rather than a commit message.

**The verdict in one sentence:** used correctly, the engine proposes `flag` at a confidence of about five thousandths and then withholds it — a task-framing failure, not a decoding one ([bench/results/NEEDLE3-CLOSED.md](bench/results/NEEDLE3-CLOSED.md)).

| the corrected run, 24 rows | |
|---|---|
| ops committed | **0 of 24** |
| proposals the engine made and then withheld | **20 of 24** — fourteen of them `flag` |
| confidence on its own answers | p50 **0.0053**, and never once zero |
| if every withheld proposal were taken as its answer | 3 of 24 = **12.5%**, against a constant that always says `nudge` at **54.2%** |

Four adapter faults were found and fixed before that verdict was written: a decode budget shorter than the prompt's own reasoning, the system prompt passed in the query instead of the static prefix, the withheld proposal discarded, and a deadline below the engine's measured latency. The twelve records written under those faults stay in the tree and are named one by one as invalid in [bench/results/INVALIDATED-needle3.md](bench/results/INVALIDATED-needle3.md); none of them may be cited as a statement about the model. Fixing the adapter made the failure legible. It did not make the engine pass.

The engine, the ladder and the fine-tune scaffold stay in the tree, and `AGENTFLEET_PRIMARY=needle3` still selects it. What would reopen the question is written down too — serve the decision as an instruction rather than as a state block, shrink the tail, use a checkpoint with a trained confidence head, or fine-tune on this corpus. None of the four is scheduled.

## Quickstart

Node 24 or newer. That is the whole requirement for everything below the next heading.

```console
$ npm install          # typescript + @types/node; the test suite itself needs no dependency
$ node --version       # v24+ : the tests run .ts files directly by type stripping
$ npm test
$ npm run typecheck
$ npm run check:corpus # the guard that keeps mined text out of a public repo
```

Three more that need no fleet, no pane and no model:

```console
$ node src/watchdog/rules.ts                 # reads /proc, prints every process past its allowance
$ node ext/pi-fleet/selfcheck.ts             # drives the pi extension's handlers against a temp registry
$ node src/metrics/report.ts --window=all    # tables from <state>/events.jsonl; zeros when there is none
```

To point it at a live fleet it needs two things it cannot invent: `herdr` on `PATH` (or `HERDR_BIN_PATH`), and a model credential — `COMMAND_CODE_API_KEY` for the default primary, `OPENROUTER_API_KEY` if the escalator is to work. Then, one tick that runs the whole pipeline and sends nothing:

```console
$ AGENTFLEET_OBSERVE=1 AGENTFLEET_ONCE=1 AGENTFLEET_STATE_DIR=<dir> node src/manager/tick.ts
```

Drop `AGENTFLEET_OBSERVE=1` and it acts through `herdr` instead of recording. Set `AGENTFLEET_DRY=1` and it decides without touching anything. The knobs that matter:

| variable | default | effect |
|---|---|---|
| `AGENTFLEET_INTERVAL_MS` | `60000` | tick interval. The idle rule's `N` was derived against 60 s; at any other interval two ticks is a different amount of silence and the rule stops meaning what it was measured to mean. |
| `AGENTFLEET_ASK` | `fork` | when the gate parks an action for a human instead of performing it: `never` acts and reports after, `fork` asks on a hard fork only, `often` also asks on a soft one, `always` asks on every non-`leave` decision. |
| `AGENTFLEET_MAX_PROMPTS` | `3` | prompts a single tick is allowed to send. |
| `AGENTFLEET_DAILY_COST_CAP_USD` | unset | the day's spend at or above which a tick makes no model call. Unset means no cap; spend is recorded either way. |
| `AGENTFLEET_INSPECTOR` | `cheap` | Tier 2: `off` announces a cross-agent trigger and stops, `cheap` asks the escalator over a bounded brief, `deep` gives one child 120 s. |
| `AGENTFLEET_STATE_DIR` | `$HOME/.pi/agent/fleet-state` | where state lives: `events.jsonl`, `marks.json`, `pending.json`, `asks.jsonl`, `policy.json`. |

A held action is one line in `<state>/asks.jsonl`, and the last line for an id is that id's state, so a pending action survives a restart and cannot be applied twice:

```console
$ node src/manager/answer.ts <id> yes            # send the held nudge
$ node src/manager/answer.ts <id> yes "shorter"  # ...with replacement text
$ node src/manager/answer.ts <id> no             # discard it
```

Telegram replies are not polled; the notification carries the id and the command, and this CLI is the answer channel.

## How it was measured

Two harnesses, both committed, both scored by code in the repository rather than by hand.

- **Offline.** `mine/time-sampled-points.ts` turns transcripts into decision points — a point is a completed agent turn, labelled by what a human did inside one tick's window, with *no human message* being a label (`leave`) rather than a missing value. `bench/` runs a frozen task set against a model with one fixed prompt and stratified sampling, and writes a record into `bench/results/` that carries its task-set sha, per-op recall, exact match, regret and nearest-rank latency. `bench/runners/stage0.ts` scores the rules alone, on a fit half and a held-out half.
- **Live.** `AGENTFLEET_OBSERVE=1` runs the whole pipeline and writes what it *would* have done, then joins each decision to what the pane did next — so a pane the supervisor stayed quiet about, and which then never moved, becomes a counterexample row. That join is the only evidence here a transcript could not have produced: [docs/observe-protocol-2026-11-14.md](docs/observe-protocol-2026-11-14.md).
- **The supervisor's own log** is a typed, append-only JSONL with one report over it. Rates are `null` rather than `0` when the denominator is empty; percentiles are nearest-rank over values that actually occurred; a field no stage can supply honestly is left out and named rather than written as zero: [docs/METRICS.md](docs/METRICS.md).

**Records are public; data is not.** Mined rows, bench task sets and adapter archives are gitignored, and `npm run check:corpus` reads the *tracked* content and fails on a pane id, a session id, a terminal tail or a credential ([docs/CORPUS-POLICY.md](docs/CORPUS-POLICY.md)). A record cites its task-set sha and the rows travel out of band — which is also why the bench cannot be re-run from a clone without a corpus.

The design record, including what was rejected and why, is [docs/specs/agent-fleet-design.md](docs/specs/agent-fleet-design.md); the independent sceptical review of the plan is [docs/reviews/2026-10-26-plan-review.md](docs/reviews/2026-10-26-plan-review.md). Everything else in `docs/` is indexed in [docs/README.md](docs/README.md).

## What it does not do

- **It does not stop, kill, signal or close anything.** Not as a policy — as an absence of capability. `HerdrPort` has `list`, `get`, `read` and `prompt`, and no other member; nothing under `src/watchdog/` can spawn, signal or exit; the op vocabulary has no stop op, so no model can propose one. [test/no-terminate.test.ts](test/no-terminate.test.ts) pins all four absences against the source text, and was verified the way a guard should be: adding a `process.kill` to the watchdog fails it.
- **It does not act in observe mode.** Nothing leaves the process — no prompt, no notification, no parked ask, no claim file. Every would-be message is a log row, and a four-tick run records `prompts 0 · held 0 · asks 0` and creates no `asks.jsonl`.
- **Stage 0 is not wired as a gate on a live tick.** There is no `AGENTFLEET_STAGE0`; stage 0's verdicts are computed and logged in observe mode only, so a live tick still asks the model about every pane that moved. Wiring it is a cost question, not a correctness one.
- **It has not been scored against what a fleet actually did.** Every label it has ever been scored against is a transcript proxy. `declare_done` has zero mined targets, so its column reads `n/a` rather than as a result. Tier 2 — the inspector that investigates cross-agent trouble — reports and never acts, and has never been scored at all. And the live `stalled`:`progressed` base rate is short of the row count that would let one model be called better than another rather than luckier.
- **It does not know whether a nudge helps.** Observe can only label the silent side: a pane that moves after the supervisor stayed quiet is a nudge that was not needed, and a pane that stays still is ambiguous between finished and stuck. Scoring a nudge requires sending one, which is a live trial and a different decision.

## Layout

| path | what is in it |
|---|---|
| `src/manager/` | one pass over the fleet (`tick.ts`), the cross-agent triggers, the ask gate and its answer channel, the Tier-2 inspector, and every limit that stops one unattended tick doing damage (`config.ts`). |
| `src/decision/` | Model adapters, the single prompt and input renderer, the defensive parse every op passes through, and `ladder.ts`. |
| `src/watchdog/` | Stage 0: the rule table, the idle rule, and the action contract that reports and never signals. |
| `src/fleet/` | Claim registry (one JSON file per pane, written tmp-then-rename), grouping, and change detection by monotonic sequence number rather than text diffing. |
| `src/herdr/` | The only module that shells out to `herdr`. It returns wire envelopes and never folds an error code into an exception, because a rejected prompt is a decision input. |
| `src/metrics/` | The typed event vocabulary, the store, the report, and the exporter that turns judged outcomes into candidate bench rows. |
| `src/notify/`, `src/swarm/`, `src/channels/`, `src/labeling/`, `src/corpus/` | The outbox; the grant/lease machinery; a Reddit channel; the one definition of what a mined label means for a supervisor; the credential-shape list the corpus guard and the miner share. |
| `test/` | `node:test` over the same tree, including the gate, the ladder, the watchdog and the no-terminate contract. |
| `bench/` | The measurement harness, its schema, and every committed record. |
| `mine/` | The session miner; its output is gitignored by policy. |
| `finetune/` | The retired local engine's fine-tune scaffold, in Python. Not on any path a tick takes. |
| `ext/pi-fleet/` | The worker-side pi extension: it makes each live session write its own claim file, because the supervisor sees a terminal and not a session. |
| `docs/` | Measurement records, protocol, policy, design and specs — [docs/README.md](docs/README.md). |
| `tools/` | The corpus guard and its allowlist. |

`package.json` carries no `bin`: every entry point above is a script or a file path, and the npm aliases are `test`, `typecheck`, `tick`, `watchdog`, `mine`, `bench`, `rescore`, `check:corpus`.

## Licence

MIT — see [LICENSE](LICENSE).

Third-party code is used as dependencies and is not vendored: `cactus-needle`, the local engine the fine-tune scaffold targets, and `@earendil-works/pi-coding-agent`, which the pi extension is typed against.
