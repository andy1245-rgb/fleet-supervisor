# agentFleet

A supervisor for a fleet of live agent panes. It observes them through `herdr`, detects which ones actually moved since the last tick, decides one action per moved agent with a cheap decision model that escalates once to a stronger one, acts only through `herdr`, and notifies a phone. It is not a new agent loop and it does not re-implement one: the agents already exist and already run; this decides what, if anything, to say to them next. The whole economics of the thing rest on not looking at an agent that did not move.

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
                                                 ├──► src/decision/ladder
                                                 │      primary → 1 escalation
                                                 ├──► src/watchdog/rules
                                                 └──► src/notify ──► Telegram

   offline, no fleet: ~/.pi/agent/sessions → mine/ → bench/ (+ src/labeling, finetune/)
```

| module | responsibility |
|---|---|
| `src/herdr` | The only module that shells out to `herdr`. Returns wire envelopes and never folds an error code into an exception, because a rejected prompt (`agent_blocked`) is a decision input, not a failure. |
| `src/fleet` | Claim registry (one JSON file per pane, `<target>.<pid>.tmp` + rename so a reader never sees half a claim), grouping (declared group, else cwd basename, with `$HOME` deliberately not a group), and change detection (monotonic sequence numbers, not text diffing). |
| `src/decision` | Model adapters (`openrouter.ts`, `needle.ts` + `needle_sidecar.py`), the one shared prompt and input renderer, the defensive parse every op passes through, and `ladder.ts`. |
| `src/labeling` | `LABEL_TO_OP` — the single definition of what a mined human label means for a supervisor. Both `bench/tasks/from-captures.ts` and `finetune/dataset.ts` import it, so the benchmark and the training corpus cannot disagree about what "correct" means. |
| `src/manager` | `tick.ts` (observe → decide movers → act → record), `triggers.ts` (the cross-agent rules), `config.ts` (every limit that keeps one unattended tick from doing damage, in one place, from the environment). |
| `src/watchdog` | Process rules. A "command" is defined structurally (a shell/agent descendant, or a terminal's foreground job) and a first-match table decides how long each class may legitimately live; every rule carries the sentence shown to the human. |
| `src/notify` | The outbox. Telegram when configured, console otherwise; three levels (`info`/`action`/`alert`) that only change a prefix. |
| `ext/pi-fleet` | The worker-side half: a pi extension that makes each live session write its own claim file. It is the only thing that knows a session's intent, phase and last action — the supervisor sees a terminal, not a session. |
| `mine/` | Session miner: a decision point is a completed agent turn that a human then answered, so the state the agent left is the input and the human's next instruction is the label. |
| `bench/` | The measurement harness: fixed prompt, fixed task set, asymmetric regret, records committed to `bench/results/`. |
| `finetune/` | Needle scaffold: LoRA fine-tune of the local engine on the mined corpus, evaluated on refusal rate, per-class accuracy and calibration. |

## The escalation ladder, and why it is the cost centre

| tier | when | what it costs |
|---|---|---|
| **0** | nothing moved — every pane's `completion_seq` / `state_change_seq` is unchanged | one `herdr agent list`, zero model calls. Measured below: 21 panes, 0 decisions, 0.211 s |
| **1** | one pane moved since the last tick | exactly one decision call for that pane, through `decideWithEscalation`; the escalator is consulted only if the primary refused or scored below `AGENTFLEET_THRESHOLD` (default 0.7) |
| **2** | a cross-agent condition the per-agent view structurally cannot see: `divergence` (claims `working`, herdr says resting for N ticks), `churn` (same phase and same last action for N turns — step repetition), `collision` (two working agents in one tree), `blocked` | nothing extra. **No model is called.** These are fixed rules in `src/manager/triggers.ts` that produce a notification |

Two properties of the ladder are load-bearing rather than incidental. Escalation happens **at most once** per decision, so a bad primary can never multiply cost per decision. And if the escalator throws — no API key, an outage — the ladder keeps the primary's opinion and appends `(escalation failed: …)` instead of losing the turn; the catch path reports `escalated: false`, so a failed escalation is *not* counted as an escalation in the tick report.

The measured per-decision cost is **$0.000227** (`costUsd.total` 0.009095 over `n` = 40, model `z-ai/glm-5.3-flash`, `taskSetSha` `b9765d1a55e18b4e`, `bench/results/2026-10-26T21-59-25-120Z__openrouter_z-ai_glm-5.3-flash.json`), i.e. $0.2274 per 1,000 decisions, at p50 1568 ms / p95 2939 ms. Arithmetic on that measurement, not a second measurement: a tick where all 21 panes of this machine moved costs about $0.0048. The local engine (`needle3`) is $0 per call by construction, and on this machine it does not currently answer at all — see the findings below.

## How to run

Everything here was executed in this repository; the outputs are in the findings section.

```sh
cd /home/andrew/agentFleet

npm test                 # 91 tests, node --test
npx tsc --noEmit         # exit 0
```

A tick needs `herdr` running and a decision model. `AGENTFLEET_ONCE=1` runs exactly one tick; `AGENTFLEET_DRY=1` decides and logs but sends no prompts and writes no claim files.

```sh
# steady state (Tier 0): nothing moved. Marks primed by hand from a live agent
# list, which is what a second tick sees after the first one has recorded marks.
AGENTFLEET_DRY=1 AGENTFLEET_ONCE=1 AGENTFLEET_WATCHDOG=0 \
AGENTFLEET_STATE=/tmp/fleet-t0/marks.json AGENTFLEET_STATE_DIR=/tmp/fleet-t0 \
  node src/manager/tick.ts

# one pane unseen (cold Tier 1). Do NOT run this with an empty marks file on a
# 21-pane machine: every pane is "new", decisions are serialised behind one
# engine, and the tick does not finish in minutes.
AGENTFLEET_DRY=1 AGENTFLEET_ONCE=1 AGENTFLEET_WATCHDOG=0 \
AGENTFLEET_STATE=/tmp/fleet-t1/marks.json AGENTFLEET_STATE_DIR=/tmp/fleet-t1 \
  node src/manager/tick.ts
```

State lives in `~/.pi/agent/fleet-state/` (`events.jsonl`, `marks.json`, `triggers.json`, `cooldowns.json`); `AGENTFLEET_STATE` and `AGENTFLEET_STATE_DIR` relocate it, which is how the two runs above stay out of the real state. Claims live in `~/.pi/agent/fleet/` (`AGENTFLEET_REGISTRY`).

```sh
node src/watchdog/rules.ts             # standalone; add --stalled to re-sample and separate slow from hung
node mine/decision-points.ts           # scans ~/.pi/agent/sessions, writes mine/out/decision-points.jsonl
node bench/runners/run.ts needle3 --limit=3
node bench/runners/run.ts z-ai/glm-5.3-flash   # needs OPENROUTER_API_KEY
node ext/pi-fleet/selfcheck.ts         # drives the extension's real handlers, ~4 s
```

`npm run bench`, `npm run mine`, `npm run tick` and `npm run watchdog` are thin aliases for the same four scripts. `bench/runners/run.ts` takes a `--limit=N` that **strides** the task file rather than slicing it — the file is ordered by session, so a head slice would benchmark one project.

Loading `ext/pi-fleet` (full detail in `ext/pi-fleet/README.md`): symlink it into `~/.pi/agent/extensions/pi-fleet`, or pass `pi -e /home/andrew/agentFleet/ext/pi-fleet` for one session, or list the absolute path in the `extensions` array of `~/.pi/agent/settings.json`. It must stay inside this repository — it imports `src/fleet/registry.ts` for the `Claim` shape and the atomic write.

## Measured findings

Every number below is either a field in `bench/results/` or an output I ran in this repository. Records are committed because a design decision that is not backed by a record here is not a decision.

**Both existing records carry `taskSetSha` `b9765d1a55e18b4e`, which is still the sha256 prefix of `bench/tasks/tasks.jsonl` today.** But `tasks.jsonl` was last regenerated (18:07) *after* `src/labeling/label-to-op.ts` was changed to unify the label mapping (18:06), and after both records were written. So the flash record predates the unified labels as a matter of file ordering; the sha happens to match, which means the regeneration produced the same bytes for these rows, not that the run was contemporary. **Re-run it before quoting it as a current number.**

1. **The cheap local engine produces no decisions on this machine.** `needle3`, n = 20, `taskSetSha` `b9765d1a55e18b4e`: `refusals` 20/20, `exactMatch` 0.25, `perOpRecall` `{flag: 1, nudge: 0}`, p50 30004 ms, p95 224764 ms, cost $0 (`bench/results/2026-10-26T21-47-52-144Z__needle3.json`). That p50 is not inference: the adapter's sidecar timeout is 30 000 ms (`src/decision/needle.ts`) and a single call I ran today returned in **30031 ms** with `raw: ""` and `refused: true`. The exact match 0.25 is therefore an artifact — the strided n=20 subset is 5 `flag` + 15 `nudge`, and a refusal falls back to `flag` (`parseDecision`), so it scores 5/5 on flag and 0/15 on nudge without producing a single real op. Treat this record as "the sidecar timed out 20 times", not as a model result.
2. **`z-ai/glm-5.3-flash` answers, cheaply and not well.** n = 40, `taskSetSha` `b9765d1a55e18b4e`: `exactMatch` 0.35, `perOpRecall` `{flag: 0, nudge: 0.4}` (0/5 and 14/35), `refusals` 0, regret total 16 (0.4 per task), p50 1568 ms, p95 2939 ms, $0.009095 → $0.000227 per decision (`bench/results/2026-10-26T21-59-25-120Z__openrouter_z-ai_glm-5.3-flash.json`). Its confidence is anti-correlated with correctness in this record: at threshold 0.5 it covers 100 % of tasks at 0.35 accuracy, and at 0.7 it covers 57.5 % at 0.1739 — i.e. the calls it is most sure about are the ones it gets most wrong. n = 40 is a small sample and the subset contains **no `leave` rows at all**, so this measures nudge/flag discrimination only.
3. **Tier 0 is free.** `21 agents, 0 moved, 0 decisions, 0 escalated, 0 prompts, $0.000000 (dry)`, 0.211 s wall, against 21 live panes with primed marks (`/tmp/fleet-t0`, hand-seeded from `herdr agent list`).
4. **One cold decision costs 30.4 s here, and escalates into nothing.** Same command with exactly one unseen pane: `21 agents, 1 moved, 1 decisions, 0 escalated, 0 prompts, $0.000000 (dry)`, 30.351 s wall; the logged decision is `refused(model returned no JSON object (escalation failed: OPENROUTER_API_KEY is not set)) via needle3 conf 0.00`, and because the op was `flag` it went out through the notifier. `OPENROUTER_API_KEY` is unset in this environment, so the escalator is unavailable and there is no keyless fast path: the only keyless model is the local engine, which times out.
5. **A cold tick over all 21 panes does not complete.** The same command with an empty marks file was killed at 180 s with no tick report. The sidecar serialises — one engine, one inference at a time — so first-tick cost is one decision per pane, sequentially.
6. **The benchmark is slow for the same reason.** The `--limit=3` run I added today (`bench/results/2026-10-26T22-18-46-002Z__needle3.json`) is `n` = 3, `taskSetSha` `b9765d1a55e18b4e`, `refusals` 3, `exactMatch` 0.3333, p50 30006 ms — and took **6 min 40 s wall** for three decisions, because each timeout kills the sidecar and the next call pays engine load again.
7. **The watchdog earns its keep.** `node src/watchdog/rules.ts` reported 6 processes today, headed by a 20h11m `node …/launch-patched.mjs` and a 15h41m `lune run` — all under the generic `command` rule, none from the inference-server, build or infrastructure classes.
8. **The miner runs over real sessions.** `116 sessions scanned`, `518 decision points`, `continue 73 / nudge 335 / redirect 12 / stop 7 / new_task 91`, `348 non-human user messages skipped`, 1.3 s. The committed corpus is the 502-row snapshot the bench task set and the fine-tune corpus were built from; I restored it after this run rather than silently moving the ground truth under the existing records.
9. **The extension's own contract holds.** `node ext/pi-fleet/selfcheck.ts` → `all checks passed`, including one write per coalescing window, the flush on shutdown, no surviving `*.tmp`, and the supervisor's reader returning the claim unchanged.

## Open questions

- **`declare_done` has zero benchmark targets.** No mined label maps to it — a human's next message can evidence an instruction, a correction or an abandonment, never an acceptance. `bench/tasks/tasks.jsonl` is `nudge` 406, `flag` 89, `leave` 7, `declare_done` 0. Neither the bench nor the fine-tune can currently reward or learn it.
- **`leave` is a 7-row class, and the bench has never scored one.** 7 of 502 rows, and both strided subsets (n = 20, n = 40) contain zero `leave` targets. The regret matrix prices `leave` mistakes highest (`leave → nudge` = 5), so the most expensive cell is the one with no evidence behind it.
- **The labels are proxies.** A mined label is reconstructed from a session transcript: `status` is assumed `idle` because the human spoke, `phase` is inferred from tool names, `idleTicks` is 0. That is a proxy for a fleet state, not an observation of one. The bench measures models against transcripts, and nothing here has yet measured a decision against what a supervised fleet actually did next.
- **The local engine's timeout is smaller than its own cold start.** Engine load plus prefill measured 13.4 s of generation on a warm engine today, and the adapter's 30 s timeout kills the sidecar on expiry, so the next call pays load again. Whether the ladder should hold a longer first call, keep the process alive, or not use the local engine in the interactive path is undecided.
- **A failed escalation is invisible in the tick report.** `escalated` stays `false` when the escalator throws (`ladder.ts`), so the one number that should show "the primary was not enough" reads 0 during an escalator outage.
- **Tier 2 is a rule, not an inspector.** The design language says "inspector"; the code calls no model for cross-agent triggers. Groups, collisions and churn have never been scored.
- **No `OPENROUTER_API_KEY` in this environment**, so the intended steady-state pair (local primary, hosted escalator) has never run here as configured.
