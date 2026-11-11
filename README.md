# fleet-supervisor

A supervisor for a fleet of live agent panes. It observes them through `herdr`, detects which ones actually moved since the last tick, decides one action per moved agent with a cheap decision model that escalates once to a stronger one, holds that action when it is contested, investigates cross-agent trouble with an inspector that only ever reports, acts only through `herdr`, and notifies a phone.

It is not a new agent loop and it does not re-implement one: the agents already exist and already run; this decides what, if anything, to say to them next. The economics rest on not looking at an agent that did not move — a tick where nothing moved costs one `herdr agent list` and no model call — and on the fact that a decision the supervisor got wrong is a prompt to a working agent, which is why every action passes one gate and can be parked for a human instead.

## Status

### What runs in the hot path

The decision step runs on `commandcode/deepseek/deepseek-v4.1-flash`, the model this deployment uses; `AGENTFLEET_PRIMARY` still selects anything else. The escalator is `z-ai/glm-5.3-flash`, and without an OpenRouter key in the environment every rule-fired escalation fails and returns the primary's own answer with `escalationFailed: true` — code-complete and unexercised, not a working second opinion. A decision call gets 90 s and `reasoning.effort: "low"`: the same call completed in 62.1 s and 64.6 s (a 45 s deadline censored 5 of 6 rows), and `none` is cheaper but changes the request and was never measured for answer quality.

The local engine and its fine-tune are off the hot path. `needle.ts`, the ladder and every artefact under `finetune/out/` remain in the tree until phase 8 removes them.

### The pre-filter, as measured

A Tier-0 pre-filter was built: a 20-layer, 121M-parameter local engine (`needle3`) asked to pick one of four ops per moved pane — `leave`, `nudge`, `declare_done`, `flag` — so the expensive model would only be paid for the panes the cheap one refuses. Alongside it, a four-variant LoRA fine-tune slate (`d4` / `d8` / `d20` / `triage`) plus `control-d8`, a base checkpoint sliced to 8 layers with no adapter.

On the committed n = 22 stratified sample, `needle3` returned **no parseable decision on any row**: 22/22 refusals, `usableOutputRate` 0, `accuracyGivenUsable` undefined at n = 0. Its `exactMatch` 0.1364 and regret 26 (1.1818 per task) are **exactly** the always-flag constant's — every record now carries the four constant baselines, so this is checkable rather than asserted. A trivial always-nudge scores 0.5455 exact match, so the pre-filter is four times worse than a constant that never reads the input. For reference the hosted `z-ai/glm-5.3-flash` scored 0.35 on a different n = 40 subset.

### The fine-tune

Nothing usable: **five archives exist in the tree** — `d4`, `d8`, `d20`, `control-d4`, `control-d8` — but `triage` was never built, and the three tuned archives are one tune exported at three depths, the `d4` and `d8` adapters differing by a max tensor delta of 6.9e-3 (`bench/results/SLATE.md` records them; `finetune/out/` is gitignored, so a clone has the record rather than the archives). The `make slate` probe of `d4` measured 262.4 s per training step — 126.8 minutes per epoch against a 600 s budget — and was stopped after two steps. That probe ran on the **CPU** (`backend cpu float32` in `finetune/out/slate/_probe/d4/probe.log`), not on a GPU, so it bounds the software path rather than the model's trainability. `control-d8` does exist and prices depth: 994 ms p50 at 8 layers against 3776 ms at 20, at 37/40 refusals — cheaper, not better.

### Why a refusal happened: suppressed or declined

A refusal can be the grounding gate withholding a proposal the model made (`suppressed > 0`), or a decode that produced nothing (`suppressed == 0`), and the two need different fixes. `suppressed` was computed by the sidecar and discarded until a change persisted it, so the historical records cannot answer it. A first run that captures it — `bench/results/2026-11-04T11-04-36-485Z__needle3.json`, n = 6, taken on a heavily loaded machine so its latency columns are not comparable to anything — splits cleanly in two:

- **4 of 6 are suppressions.** The model emitted a call and grounding rejected it, at confidence 0.002–0.006. The argument did not survive the grounding check.
- **2 of 6 are genuine no-calls, at high confidence** (0.331, 0.338), and the model gives its reason: *"No tool available for creating or managing a project. The request is for a project management task which is not supported by any available tool."* That is a task-framing prior — the model does not believe supervising a pane maps onto `leave` / `nudge` / `declare_done` / `flag` at all.

So this is not a parse failure and not one bug. The high-confidence no-calls are exactly what a fine-tune on this corpus teaches, since the corpus is 502 examples of that mapping. The low-confidence suppressions are a span problem: a target argument that is not a substring of the query gets suppressed, and the training data invites exactly that — `finetune/dataset.ts` keeps the **front** of the tail (`cutPrefix`, used by `renderTail`) while the sidecar serves the **end** of it (`clipTail`, `src/decision/prompt.ts:60`), so a mined target can sit outside the query the model is actually asked. The fix for that is staged outside this repository. n = 6 is a signal, not a result — the 22-row confirmation ran (`bench/results/2026-11-04T11-05-56-783Z__needle3.json`: n = 22, `usableOutputRate` 0, 22/22 refusals, and **10 of 22 rows carry `suppressed > 0`**), but that record is untracked: it is not committed here.

### Silence first, and the model on the residue

The architecture is two stages, and only the first one is settled. **Stage 0** is `src/watchdog/needs-a-word.ts`: `needsAWord(pane, samples) → {speak, rule, why}`, built on the seven watchdog rules, where silence is a returned value carrying the rule that permitted it. **Stage 1** is the decision model, consulted only on the rows stage 0 speaks on.

Measured on the mined corpus (`bench/runners/stage0.ts`, 1,073 scorable rows, 292 sessions): the rules fire on **34 turns**, and on the 24 of those that are scorable a word was owed **54.2 %** of the time against a 45.0 % base rate — **precision 54.2 %, recall 2.7 %** of the 483 turns that owed one. So the rules as written are a good alarm and a poor gate: they are precise about runaway processes and blind to a pane that has simply stopped. That is why `AGENTFLEET_STAGE0` is not wired as the live gate and why the model has not been taken out of the hot path. **The comparison is open** — `src/decision/`, `finetune/` and the ladder stay, and the residue is where they are scored from now on (`bench/results/SLATE-residue.md`). See `docs/stage0-residue-2026-11-10.md`.

### What is out of scope

`declare_done` has zero targets in the mined corpus, so no variant can learn it and its column is `n/a` everywhere. `leave` has 7 rows corpus-wide, so any 10-point move on it is one row. The regret ranking is not publishable: the cost weights are asserted, unitless and unswept (`weightsSwept: false`). And no decision here has been scored against what a supervised fleet actually did next — the labels are reconstructed from transcripts, so this measures models against proxies.

### Repository visibility

**This repository is public, and `"private": true` stays in `package.json`.** That field is a guard against an accidental `npm publish`, not a visibility flag — nothing here is intended as an npm package — and the code ships under the MIT licence in `LICENSE`.

## Architecture

```
   pi panes ──────── herdr (agent list · agent read · agent prompt) ────────┐
       │ ext/pi-fleet writes its own claim                                   │
       ▼                                                                     │
 ~/.pi/agent/fleet/<pane>.json ──► src/fleet/registry ──┐                    │
                                   (claims, one file/pane)                   │
                                                         ▼                   ▼
   src/fleet/detect ──► moves + idleTicks ──► src/manager/tick ◄────── src/herdr
   (seq diff, free)                              │   ▲                  (only shell-out)
                                                 │   └─ src/manager/config
                        src/manager/triggers ────┘
                        (cross-agent rules)
                                                 │
                                                 ├──► src/decision/ladder
                                                 │      primary → 1 escalation
                                                 │            │
                                                 │            ▼
                                                 │      src/manager/ask
                                                 │      (never|fork|often|always, per group)
                                                 │         hold ──► <state>/asks.jsonl
                                                 │         │              │
                                                 │         │              ▼
                                                 │         │        src/manager/answer
                                                 │         │        node ... answer.ts <id> yes|no
                                                 │         │ act
                                                 │         ▼
                                                 │      the only path that prompts a pane
                                                 │
                                                 ├──► src/manager/inspector
                                                 │      trigger → ≤6000-char brief → finding
                                                 │      (never acts; a proposal goes through ask)
                                                 ├──► src/watchdog/rules
                                                 └──► src/notify ──► Telegram

   offline, no fleet: ~/.pi/agent/sessions → mine/ → bench/ (+ src/labeling, finetune/)
```

| module | responsibility |
|---|---|
| `src/herdr` | The only module that shells out to `herdr`. Returns wire envelopes and never folds an error code into an exception, because a rejected prompt (`agent_blocked`) is a decision input, not a failure. |
| `src/fleet` | Claim registry (one JSON file per pane, `<target>.<pid>.tmp` + rename so a reader never sees half a claim), grouping (declared group, else cwd basename, with `$HOME` deliberately not a group), and change detection (monotonic sequence numbers, not text diffing). |
| `src/decision` | Model adapters (`openrouter.ts`, `needle.ts` + `needle_sidecar.py`), the one shared prompt and input renderer, the defensive parse every op passes through, and `ladder.ts`. The input renderer owns the tail budget (`MAX_TAIL_CHARS`, 700) because it is derived from the local engine's window, not from taste. |
| `src/labeling` | `LABEL_TO_OP` — the single definition of what a mined human label means for a supervisor. Both `bench/tasks/from-captures.ts` and `finetune/dataset.ts` import it, so the benchmark and the training corpus cannot disagree about what "correct" means. |
| `src/manager` | `tick.ts` (observe → decide movers → gate → act → inspect → record), `triggers.ts` (the cross-agent rules), `config.ts` (every limit that keeps one unattended tick from doing damage, in one place, from the environment), `inspector.ts` (Tier 2: investigate a trigger, report, never act), `ask.ts` (the fork predicates and the policy table), `answer.ts` (the channel that releases a held action, and the owner of `asks.jsonl`). |
| `src/watchdog` | Process rules. A "command" is defined structurally (a shell/agent descendant, or a terminal's foreground job) and a first-match table decides how long each class may legitimately live; every rule carries the sentence shown to the human. |
| `src/notify` | The outbox. Telegram when configured, console otherwise; three levels (`info`/`action`/`alert`) that only change a prefix. |
| `ext/pi-fleet` | The worker-side half: a pi extension that makes each live session write its own claim file. It is the only thing that knows a session's intent, phase and last action — the supervisor sees a terminal, not a session. |
| `mine/` | Session miner: a decision point is a completed agent turn that a human then answered, so the state the agent left is the input and the human's next instruction is the label. |
| `bench/` | The measurement harness: fixed prompt, fixed task set, stratified sampling, per-task traces, asymmetric regret, records committed to `bench/results/`. |
| `finetune/` | Needle fine-tune: LoRA on the local engine over the mined corpus, a slate of depth and scope variants, evaluated on refusal rate, per-class accuracy and calibration. |

**There is exactly one component that mutates a pane.** Every would-be action — a decision's, and an inspector's proposal — is a `Decision` handed to the gate in `src/manager/tick.ts`, which either performs it through `src/herdr` or parks it in `<state>/asks.jsonl`. Nothing else calls `agent prompt`, so "this action was authorised" has one implementation and one audit trail. `leave` is not an action and is never gated. `flag` is deliberately not gated: holding it would mean holding a notification, which is the thing `flag` already is.

## The escalation ladder, and why it is the cost centre

| tier | when | what it costs |
|---|---|---|
| **0** | nothing moved — every pane's `completion_seq` / `state_change_seq` is unchanged | one `herdr agent list`, zero model calls. Measured below: 21 panes, 0 decisions, 0.094 s |
| **1** | one pane moved since the last tick | exactly one decision call for that pane, through `decideWithEscalation`; the escalator is consulted only if the primary refused or scored below `AGENTFLEET_THRESHOLD` (default 0.7). The result is then gated: the policy decides whether this tick acts or parks it. |
| **2** | a cross-agent condition the per-agent view structurally cannot see: `collision` (two working agents in one tree), `blocked`, `divergence` (claims `working`, herdr says resting for N ticks), `churn` (same phase and same last action for N turns — step repetition) | one inspection per trigger, worst-first, capped. `AGENTFLEET_INSPECTOR` selects the mode: `off` announces the trigger and stops (churn stays log-only), `cheap` (default) asks the escalator for a finding over a bounded brief, `deep` gives one bounded `pi -p` child 120 s with bash and read-only `herdr` commands, told never to prompt, focus or close a pane. `AGENTFLEET_MAX_INSPECTIONS` (default 2) caps inspections per tick in severity order collision → blocked → divergence → churn, so a fleet-wide flap cannot become a fleet-wide spend. |

The inspector is what Tier 2 became, and what it is *not* is the point. It takes a trigger, assembles a brief that is capped at 6000 characters (pure function of the fleet snapshot, the claims and the tails already read — the trigger's own panes keep three times the tail share of same-group peers, and peers are what get dropped when the headers alone would overrun the budget), asks one model, and returns `{diagnosis, recommendation, proposed?, evidence, confidence}`. It has no `HerdrPort`. An unparsed answer is still reported as a finding, but it carries no proposal; a proposal is kept only when the op is real, `leave`-less, names a pane the trigger itself named, and has text worth sending. A `deep` child that cannot be spawned, times out, or answers in prose falls back to `cheap` rather than failing the tick.

Two properties of the ladder are load-bearing rather than incidental. Escalation happens **at most once** per decision, so a bad primary can never multiply cost per decision. And if the escalator throws — no API key, an outage — the ladder keeps the primary's opinion and appends `(escalation failed: …)` instead of losing the turn; the catch path reports `escalated: true` with `escalationFailed: true` (since `0c66c5c`, `src/decision/ladder.ts:39-46`, pinned by `test/tick.test.ts`), so a failed escalation is counted as an attempt and is distinguishable from a success in the tick report.

The measured per-decision cost is **$0.000227** (`costUsd.total` 0.009095 over `n` = 40, model `z-ai/glm-5.3-flash`, `taskSetSha` `b9765d1a55e18b4e`, `bench/results/2026-10-26T21-59-25-120Z__openrouter_z-ai_glm-5.3-flash.json`), i.e. $0.2274 per 1,000 decisions, at p50 1568 ms / p95 2939 ms. Arithmetic on that measurement, not a second measurement: a tick where all 21 panes of the measured fleet moved costs about $0.0048. The local engine (`needle3`) is $0 per call by construction — and, measured, *slower* in wall clock than the cloud model, at 3776 ms p50. Tier 1 spends time or money, not both, and currently the cheaper currency is the hosted one.

## How to run

Every command below was run in this working tree; the outputs are in Measured findings.

```sh
cd ~/agentFleet

npm test                 # 417 tests in this working tree (414 pass, 3 skipped), 275 at HEAD, node --test
npx tsc --noEmit         # exit 0
```

`npm test` runs the `.ts` files directly, so it depends on Node's type stripping: `"engines": { "node": ">=24" }`, and the only host any of this was measured on is Node v24.21.0.

A tick needs `herdr` running and a decision model. `AGENTFLEET_ONCE=1` runs exactly one tick; `AGENTFLEET_DRY=1` decides and logs but sends no prompts and writes no claim files; `AGENTFLEET_OBSERVE=1` runs the whole pipeline — stage 0's verdict for every pane, the model's proposal for every pane that moved — writes all of it, joins each decision to the pane's next observed state, and sends nothing at all. Observe is not dry: a dry tick judges nothing and records no pending decision, so there is nothing to join later.

```sh
# steady state (Tier 0): nothing moved. Marks primed by hand from a live agent
# list, which is what a second tick sees after the first one has recorded marks.
AGENTFLEET_DRY=1 AGENTFLEET_ONCE=1 AGENTFLEET_WATCHDOG=0 \
AGENTFLEET_STATE=/tmp/fleet-t0/marks.json AGENTFLEET_STATE_DIR=/tmp/fleet-t0 \
  node src/manager/tick.ts

# one pane unseen (cold Tier 1). Do NOT run this with an empty marks file on a
# 21-pane machine unless you want all 21 decided: decisions are serialised behind
# one engine and the tick then takes about a minute.
AGENTFLEET_DRY=1 AGENTFLEET_ONCE=1 AGENTFLEET_WATCHDOG=0 \
AGENTFLEET_STATE=/tmp/fleet-t1/marks.json AGENTFLEET_STATE_DIR=/tmp/fleet-t1 \
  node src/manager/tick.ts
```

State lives in `~/.pi/agent/fleet-state/` (`events.jsonl`, `marks.json`, `triggers.json`, `cooldowns.json`, `asks.jsonl`, `policy.json`); `AGENTFLEET_STATE` and `AGENTFLEET_STATE_DIR` relocate it, which is how the two runs above stay out of the real state. Claims live in `~/.pi/agent/fleet/` (`AGENTFLEET_REGISTRY`).

Two knobs decide how much the supervisor asks a human instead of acting:

| setting | values | default | effect |
|---|---|---|---|
| `AGENTFLEET_ASK` | `never` / `fork` / `often` / `always` | `fork` | `never` acts and reports after the fact; `fork` asks on a hard fork only — the two models disagreed, the action is `declare_done` (it stops a live agent), or it is named by a `collision` / `churn`; `often` also asks on a soft fork — a nudge over 300 chars, a nudge naming a path outside the agent's own tree, or a tick already at its prompt cap; `always` asks on every non-`leave` decision. |
| `AGENTFLEET_INSPECTOR` | `off` / `cheap` / `deep` | `cheap` | see the Tier-2 row above. `AGENTFLEET_MAX_INSPECTIONS` (default 2) caps findings per tick. |
| `AGENTFLEET_DAILY_COST_CAP_USD` | dollars, unset (or `0`) disables | unset (no cap) | the only limit here that is not per tick. Before its first model call a tick sums today's `costUsd` from the day's tick rows; at or over the cap it makes no call, writes one `tick` row with `models: []`, `capped: true` and the reason, writes no `decision` row, and notifies once for the day. The total uses the tick rows, which already price whole ticks — the per-model decision rows are not added to them. Off by default, like the account-wide cap: the fleet runs on a flat floor plan, so the ceiling is a refusal with no saving behind it. **Spend is still recorded** when this is off — `costUsd`, `dailyCostUsd` and the Cost screen are unchanged; only the refusal goes away. The summary line says `· no daily cap` rather than omitting the clause, because a missing clause reads as a cap that was satisfied. |
| `AGENTFLEET_GLOBAL_SPEND_CAP_USD` | dollars, `0` or unset disables | unset (off) | the wider of the two: the **UTC** day's spend across every agent on the host plus this supervisor, read from `~/.pi/agent/usage.jsonl` (`AGENTFLEET_USAGE_LOG` moves it) plus the day's tick rows. When both caps are enabled the lower one fires and the row's `capScope` says which. Off until you set it. An unreadable source fails open — the tick spends, stderr and one Telegram message say so every day, and the row carries `globalSpendSource: "unavailable"` with **no** `globalSpendUsd`, so a page can never show `$0.00` that nobody measured. |

Per-group overrides live in `<state>/policy.json` and are read every tick, so changing one needs no restart and no code change:

```json
{ "askByGroup": { "fleet-supervisor": "always", "home": "often" } }
```

A bare map — `{ "fleet-supervisor": "always" }` — is accepted too; entries whose value is not a policy are ignored rather than trusted.

A held action is one line in `<state>/asks.jsonl`, and the last line for an id is that id's state, so a pending action survives the supervisor restarting and cannot be applied twice:

```sh
node src/manager/answer.ts <id> yes            # send the held nudge / write the held done claim
node src/manager/answer.ts <id> yes "shorter"  # ...with replacement text
node src/manager/answer.ts <id> no             # discard it
```

Telegram replies are not polled yet; the notification carries the id and the command, and the CLI is the answer channel.

```sh
node src/watchdog/rules.ts             # standalone; add --stalled to re-sample and separate slow from hung
node mine/decision-points.ts           # scans ~/.pi/agent/sessions, writes mine/out/decision-points.jsonl
node bench/runners/run.ts needle3 --limit=22
node bench/runners/run.ts z-ai/glm-5.3-flash   # needs OPENROUTER_API_KEY
node bench/runners/slate.ts                    # every trained variant on one task set (needs the python extra)
node ext/pi-fleet/selfcheck.ts         # drives the extension's real handlers, ~4 s
```

`npm run bench`, `npm run mine`, `npm run tick` and `npm run watchdog` are thin aliases for the same four scripts. `bench/runners/run.ts` takes a `--limit=N` that **stratifies by expected op** rather than striding or slicing the file. The contract: every op in the corpus gets at least one seat; an op with fewer rows than an even split (that is `leave`, 7 of 502) contributes all of its rows as soon as the limit can hold them; the subset is exactly `N` rows unless the arithmetic cannot be, and then the record says so. Sampling is deterministic from a seed and the row id, so two records against one `taskSetSha` select the same rows, and every record carries `sampledPerOp` / `corpusPerOp` so the subset's composition is part of the measurement rather than an assumption about it.

Loading `ext/pi-fleet` (full detail in `ext/pi-fleet/README.md`): symlink it into `~/.pi/agent/extensions/pi-fleet`, or pass `pi -e "$(pwd)/ext/pi-fleet"` for one session, or list the absolute path in the `extensions` array of `~/.pi/agent/settings.json`. It must stay inside this repository — it imports `src/fleet/registry.ts` for the `Claim` shape and the atomic write.

## Measured findings

Every number below is either a field in `bench/results/` (or its `.traces.jsonl` sidecar) or an output produced by running the scripts in this repository. Records are committed because a design decision that is not backed by a record here is not a decision.

Every record that carries a `taskSetSha` carries `b9765d1a55e18b4e`: **502 rows — `nudge` 406, `flag` 89, `leave` 7, `declare_done` 0.**

**The rows are not tracked at HEAD.** The mined corpus and the bench task sets carry session text, addresses and terminal output from real work, so `bench/tasks/*.jsonl` is gitignored and the records cite a sha instead. The harness, the schema, the records and the scoring code all ship; the data does not ship *in the tree*.

**History no longer carries them either.** The corpus was originally committed and later untracked, and those are not the same thing: `.gitignore` and `git ls-files` describe the working tree, while a clone takes the object store. The history has since been rewritten to drop that path from every commit (`git filter-repo --invert-paths --path bench/tasks/tasks.jsonl`), so no commit here contains the rows, and a test fails if the path ever reappears in history.

`b9765d1a` is also **not** the current working task set. The local `bench/tasks/tasks.jsonl` — not shipped, and cited by no record because nothing was measured against it — is `89e3ec2de7d41e84`: **527 rows — `nudge` 524, `leave` 3, `flag` 0, `declare_done` 0**, because commit `3df75ef` (2026-10-26 22:13 local) rebuilt the label vocabulary and removed `flag` outright. The task set every record here cites is present at `e2b7fbf` and unchanged through `27d4921`; every measurement predates `3df75ef`, though the rescored record below inherits its trace's `recordedAt`, so its file is newer than its decisions.

So a record **can be re-scored** against the 502-row set but **cannot be regenerated** from the 527-row one: `flag` has no rows left to score. The `perOpRecall.flag` of 1.0 below is doubly uninformative — it is a recall over a class the current labels no longer contain, *and* every one of the 22 rows refused, so those hits are refusals coerced to `flag`. Read `usableOutputRate` first: it is 0, which makes `ops.exactMatch` an artefact rather than an accuracy, and a test pins that a fully refusing run scores exactly the always-flag constant. Record ids are UTC; wall-clock times below are local. **Re-run any record before quoting it as a current number.**

1. **The needle engine was not slow, it was broken twice over, and both defects are fixed.** `run()` defaults to `max_steps=8` and even `max_steps=1` decodes twice and returns the second decode — our tools record nothing, so the loop priced every decision at 2× and answered with a re-decode of the sentinel (measured on one prompt: `complete(96)` 2432 ms vs `run(max_steps=1, 96)` 4043 ms). And the engine's 1024-token window minus its 401-token static prefix left 111 input tokens (~421 chars) at the stock `max_new_tokens=512`, smaller than any real fleet tail, so the engine self-repeated until the adapter's 30 s cap fired. The adapter now issues one `complete(text, max_new_tokens=96)` per decision, and `MAX_TAIL_CHARS` is 700 because the budget is the *whole prompt* (SYSTEM is 709 chars, the one-line field block ~370, 527 tokens ≈ 2000 chars at 96 generated tokens) — 1500 was tried and measured 4447–4913 ms against 2530–3281 ms. Both runs are n = 22, `taskSetSha` `b9765d1a55e18b4e`, 12 `nudge` / 7 `leave` / 3 `flag`:

   | | `2026-10-26T22-42-18-769Z__needle3.json` (before) | `2026-10-26T22-59-13-964Z__needle3.json` (after) |
   |---|---|---|
   | p50 | 6800 ms | **3776 ms** |
   | p95 | 19469 ms | **5416 ms** |
   | max trace | 21391 ms | **7894 ms** |
   | calls at the 30 s cap | 3 | **0** |
   | refusals | 22/22 | 22/22 |

2. **The short-input refusal is a real model result; the long-input timeouts were not.** In a live dry tick, one cold decision over a 40-line pane tail returned in **2.774 s** with `op: null` and confidence 0.01 — `refused(needle declined to call a tool (escalation failed: OPENROUTER_API_KEY is not set)) via needle3 conf 0.01` (`/tmp/fleet-t1/events.jsonl`). That is the engine declining to emit a call, at a latency nothing like the 30 s cap, and it is the same phenomenon as finding 3. Do not read the pre-fix `p50 30004 ms` records as a model verdict: that was the adapter starving the window and then timing out.

3. **The fix does not make the local engine a usable pre-filter.** Same n = 22 record, after the fix: `refusals` 22/22, `exactMatch` 0.1364, `perOpRecall` `{nudge: 0, leave: 0, flag: 1}`, coverage **0.0 at every threshold from 0.3 to 0.9**, regret 26 (1.1818 per task). `leave` recall is 0 on all 7 rows, and `leave` is the op worth 5. The ladder therefore escalates 100 % of rows and pays 3776 ms for the privilege, so the "cheap" stage saves nothing but dollars. The refusals are not wrong, they are uninformative: what is missing is weights that emit calls at usable confidence, not more prompt plumbing.

4. **The remaining latency is prefill, and the local model is slower than the cloud one.** An empty query costs 40 ms, SYSTEM alone (709 chars) 421–1455 ms, the full prompt ~**1.6 ms/char**. Against the cloud record (n = 40, p50 **1568 ms**), the local 20-layer engine (n = 22, p50 **3776 ms**) is 2.4× slower for the same task, on the development machine, with llama-server and two VBox VMs also running. No token budget fixes that: the SYSTEM prompt alone already exceeds a 1500 ms prefill.

5. **The 30 s cap is still reachable, so "zero timeouts" is a property of a run, not of the adapter.** `bench/results/2026-10-26T23-21-59-933Z__needle3.json` is n = 3 (one `flag`, one `nudge`, one `leave`), `refusals` 3/3, p50 **30002 ms**, p95 30009 ms. Its three rows are the three slowest rows of the n = 22 run (4613, 4924 and 4895 ms) and in the n = 3 run they hit 30009, 30002 and 20256 ms — 6× the same row's earlier cost. The fix removed the defect; it did not remove the variance on a loaded box.

6. **`z-ai/glm-5.3-flash` answers, cheaply and not well.** n = 40, `taskSetSha` `b9765d1a55e18b4e`: `exactMatch` 0.35, `perOpRecall` `{flag: 0, nudge: 0.4}` (0/5 and 14/35), `refusals` 0, regret total 16 (0.4 per task), p50 1568 ms, p95 2939 ms, $0.009095 → $0.000227 per decision (`bench/results/2026-10-26T21-59-25-120Z__openrouter_z-ai_glm-5.3-flash.json`). Its confidence is anti-correlated with correctness in this record: at threshold 0.5 it covers 100 % of tasks at 0.35 accuracy, and at 0.7 it covers 57.5 % at 0.1739 — the calls it is most sure about are the ones it gets most wrong. This record was taken under the old strided sampler: its `perOpRecall` has no `leave` key at all, so it measures nudge/flag discrimination only.

7. **The smaller strided subsets contained zero `leave` rows, which is why the sampler changed.** The n = 20 record (`2026-10-26T21-47-52-144Z__needle3.json`) reports `perOpRecall` `{flag: 1, nudge: 0}` and the n = 40 cloud record `{flag: 0, nudge: 0.4}` — no `leave` key in either, because a stride over a file ordered by session happened to select none of the 7 rows. `leave` mistakes are priced highest in the regret matrix (`leave → nudge` = 5), so the most expensive cell was the one with no evidence behind it. The sampler is now stratified (`bench/runners/run.ts`, `sampleStratified`), which is what makes the 7-row `leave` class appear in the n = 22 and n = 40 records at all.

8. **Depth is the latency lever, measured.** A control slice — the published base checkpoint exported at 8 layers with no adapter, `bench/results/2026-10-26T23-24-18-841Z__slate-control-d8.json`, n = 40, `taskSetSha` `b9765d1a55e18b4e` — runs at p50 **994 ms** / p95 1210 ms against the full 20-layer engine's p50 **3776 ms** / p95 5416 ms (n = 22). Different subsets, so this prices depth, not accuracy: the d8 slice is ~3.8× cheaper per call and, at `refusals` 37/40, no better at deciding. It is the row a fine-tune has to beat rather than a result to deploy.

9. **The slate driver never finished; the five archives were built by hand.** `finetune/slate.json` defines `d4` / `d8` / `d20` (full 4-op label set at three depths) and `triage` (3 ops, `declare_done` out of scope), plus `control-d8` — a control, not a fine-tune. Five `.cact` archives are on disk (`d4` 15,378,708 B, `d8` 27,393,236, `d20` 63,437,076, `control-d4` 15,390,548, `control-d8` 27,411,604) with two 7.9 MB adapters and 78-step `train.log`s; `triage` is the one that was never built. The `make slate` probe measured **262.4 s per training step** over 2 of 29 steps, so **7609.6 s = 126.8 min per epoch** against a 600 s budget, and was killed after two steps (586.9 s wall, exit -15). Training here is FLOP-bound, not I/O-bound: the LoRA trains on the full 20-layer base whatever `--layers` says, so the three depth variants share one fine-tune and differ only in what was exported.

10. **Tier 0 is free.** `21 agents, 0 moved, 0 decisions, 0 triggers, 0 inspected, 0 escalated, 0 prompts, 0 held, $0.000000 (dry)`, **0.094 s** wall, against 21 live panes with primed marks (`/tmp/fleet-t0`, seeded from `herdr agent list`).

11. **A cold tick over all 21 panes now completes.** The same command with an empty marks file: `21 agents, 21 moved, 21 decisions, 0 triggers, 0 inspected, 0 escalated, 0 prompts, 0 held, $0.000000 (dry)`, **61.052 s** wall — one decision per pane, serialised behind one engine at ~2.9 s each. Before the needle fix the same run was killed at 180 s with no tick report.

12. **The gate's CLI refuses what it should.** Against a hand-written `asks.jsonl`: an unknown id exits 1 with `no ask "zzzz9999" in <path>`; `answer.ts aaaa1111 no` prints `discarded nudge for w26:p1: …` and appends one `answered` line; a second `answer.ts aaaa1111 yes` exits 1 with `ask "aaaa1111" was already answered no at … — refusing to apply it twice`.

13. **The inspector never acts, and without a key it cannot even think.** With no `OPENROUTER_API_KEY`, a cheap inspection of a hand-built two-pane `collision` returns `diagnosis: "the inspector could not run: OPENROUTER_API_KEY is not set"`, `evidence: []`, `confidence: 0`, and **no** `proposed` field — the failure is a finding, not an exception, and nothing was prompted. The brief is bounded in practice as well as in the constant: 2 panes with 2400-char tails → 5160 chars, 6 panes → 5996, 12 panes with 5000-char tails → 6000, and a deliberately silly 40 panes with 9000-char tails → 5446. Everything else about the inspector and the gate is covered by tests, not by a live fleet: every tick above is dry and fired no trigger, so `inspected` 0 and `held` 0 in every run (`test/inspector.test.ts`, `test/ask.test.ts`, and the suite around them: 417 tests in this working tree, 275 at HEAD, 0 fail in both). A finding has never been scored against what the group actually needed.

14. **The watchdog earns its keep.** `node src/watchdog/rules.ts` reported 6 processes, headed by a 20h11m `node …/launch-patched.mjs` and a 15h41m `lune run` — all under the generic `command` rule, none from the inference-server, build or infrastructure classes.

15. **The miner runs over real sessions.** `116 sessions scanned`, `518 decision points`, `continue 73 / nudge 335 / redirect 12 / stop 7 / new_task 91`, `348 non-human user messages skipped`, 1.3 s. The committed corpus is the 502-row snapshot the bench task set and the fine-tune corpus were built from.

16. **The extension's own contract holds.** `node ext/pi-fleet/selfcheck.ts` → `all checks passed`, including one write per coalescing window, the flush on shutdown, no surviving `*.tmp`, and the supervisor's reader returning the claim unchanged.

## Open questions

- **`declare_done` has zero benchmark targets.** No mined label maps to it — a human's next message can evidence an instruction, a correction or an abandonment, never an acceptance. `bench/tasks/tasks.jsonl` is `nudge` 406, `flag` 89, `leave` 7, `declare_done` 0. Neither the bench nor the fine-tune can reward or learn it, and it is `triage`'s reason for existing.
- **`leave` is now measurable and measures zero.** 7 of 502 rows, now present in any subset that can hold them, and 0 recall on all 7. A 10-point move on this class is one row, so the next question is whether 7 mined examples can evidence the op at all, not whether the sampler reaches them.
- **The labels are proxies.** A mined label is reconstructed from a session transcript: `status` is assumed `idle` because the human spoke, `phase` is inferred from tool names, `idleTicks` is 0. That is a proxy for a fleet state, not an observation of one. The bench measures models against transcripts, and nothing here has yet measured a decision against what a supervised fleet actually did next.
- **The local engine is cheaper in dollars and more expensive in seconds.** 3776 ms p50 against the cloud model's 1568 ms, 22/22 refusals, coverage 0 at every threshold. Whether the ladder should keep a `needle3` primary at all before the fine-tune lands — rather than making the hosted model primary and treating the local engine as the offline fallback — is undecided, and the slate that was supposed to answer it produced no variant that beats its own control (best tuned archive 28.0 % exact against 26.0 % for the untrained slice at the same depth, `bench/results/SLATE.md`).
- **Tier 2 has never been scored.** The inspector reports and does not act, which is testable, but whether its diagnosis is right — on a real collision, a real churn, a group that genuinely needs one nudge — has no ground truth and no record. Groups, collisions and churn have never been scored either.
- **The gate's act path has never run against a live fleet.** All of the above is dry: 0 asks recorded end to end. `answer.ts` has only been driven by hand and by tests, never by an operator releasing a real held action mid-incident.
- **No `OPENROUTER_API_KEY` in this environment**, so the intended steady-state pair (local primary, hosted escalator) has never run here as configured — and because the inspector's `cheap` mode spends the escalator, a cheap inspection without a key returns `the inspector could not run` and proposes nothing. Tier 2 is therefore exercised only through tests and through the degraded finding above; a real inspection has never run on the development machine.

**Fixed, so no longer an open question.** A failed escalation used to be invisible in the tick report: the catch path in `src/decision/ladder.ts` returned `escalated: false`, so the one number that should show "the primary was not enough" read 0 during an escalator outage. `0c66c5c` changed that path to `escalated: true, escalationFailed: true` (`src/decision/ladder.ts:39-46`), and `test/tick.test.ts` pins it.
