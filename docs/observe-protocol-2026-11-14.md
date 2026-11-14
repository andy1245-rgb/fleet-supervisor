# Observe mode, verified — and the collection protocol it exists for

2026-11-14. Everything else in this repository is measured against transcripts. This is the one
mode that records a live fleet instead: the whole pipeline runs, every verdict and every proposal is
written, each decision is joined to what the pane did next, and **nothing leaves the process**.

The mode was built in the previous pass and had eight unit tests. What follows is the verification
that it does that against a real fleet — and the ninth test, added since, that the idle rule is
reachable from a tick at all — plus the cost of running it, and what to do with what it writes.

## What it must do, and what the log shows it doing

| promised | evidence in the log |
|---|---|
| run the full pipeline **including the model** | `decision` rows, one per moved pane, carrying `model`, `confidence`, `latencyMs`, `costUsd`, `refused` |
| log **every stage-0 verdict** | `stage0` rows, one per pane per tick — spoken *and* silent, each with the `rule` that decided it |
| log **every proposal** | `decision` + `action` rows; a proposal that would have reached the pane is a `*_observed` row (`nudge_observed`, `flag_observed`, `done_observed`) |
| join each row to the pane's **next observed state** | `pending.json` after the decision, then `outcome` rows once the window elapses, carrying `outcomeKind`, `movedSinceDecision`, `ticksObserved` and the pane's state at judgement |
| **send nothing at all** | no `nudge` / `done` / `flag` / `ask` row exists; every would-be message is `notify_observed` or `*_observed`; `asks.jsonl` and the claim registry are not created |

## The command

```sh
AGENTFLEET_OBSERVE=1 node src/manager/tick.ts
```

That is the whole of it. It loops at `AGENTFLEET_INTERVAL_MS` (default 60 s), writes to
`~/.pi/agent/fleet-state/events.jsonl` beside `pending.json` and `marks.json`, and is safe to leave
running: the only state it advances is its own marks, and the only thing it costs is the model call
per moved pane. `AGENTFLEET_ONCE=1` runs a single tick, which is what the demonstrations below used.

Two things to know before starting it:

- **It advances the marks.** A tick that observed panes marks them seen, exactly as a live tick
  would, so a live supervisor started afterwards finds a steady fleet rather than a backlog. That is
  the correct behaviour for a mode that is meant to *be* the supervisor minus the sending; it does
  mean observe and operate should not run against the same state directory at the same time.
- **It is not `dry`.** A dry tick decides and discards: it judges nothing and records no pending
  decision. Observe judges, records pending and saves marks. The `tick` row carries `observe: true`
  and `dry: false`, so the two are distinguishable in one field.

## One tick, as field names only

Four ticks against this box's live fleet, throwaway state dir. Row kinds and the fields they carry —
**no value of any field is shown**, because the log holds pane ids, titles, working directories and
terminal text:

```
row kind                  n     field names
  tick                      4    agents, asks, costUsd, dailyCostUsd, decisions, dry, durationMs,
                                escalated, escalationFailed, held, inspected, kind, models, moved,
                                observe, prompts, schema, triggers, ts
  stage0                  112    ageMs, cwd, kind, paneId, pid, rule, schema, speak, ts, why
  decision                 28    completionTokens, confidence, costUsd, decision, escalated,
                                escalationFailed, group, held, kind, latencyMs, mode, model, op,
                                paneId, policy, promptTokens, reasoning, refused, schema, ts
  action                   28    disposition, gated, group, kind, latencyMs, op, paneId, policy,
                                reason, schema, ts
  notify_observed          60    kind, level, text, ts
  watchdog                 32    ageMs, command, kind, pid, rule, schema, ts
  watchdog_action          32    kind, paneId, pid, rule, signal, ts, wouldPrompt
  watchdog_prompt_observed 24    kind, paneId, rule, text, ts
  claim                    28    diverged, group, kind, paneId, phase, state, ts
  outcome                  25    argument, cwd, group, idleTicks, kind, movedSinceDecision, op,
                                outcomeKind, paneId, status, ticksObserved, title, ts

pending.json                3    entry fields: argument, decidedAtSeq, group, op, paneId, ticksObserved
```

Read down the columns rather than across: `stage0` carries `speak` **and** `rule` on silent rows, so
a tick that said nothing is auditable; `action` carries `disposition` and `reason`, so
`observed / would-nudge` is a value not a guess; `outcome` carries `movedSinceDecision` beside
`ticksObserved`, which is the join. The single most load-bearing field on the whole log is
`tick.observe`: it is what stops an observer's rows being read as a supervisor's.

Bearer of bad news, in the same run: **`decision.refused` was true on all 28 rows, at ~400 ms each,
with `costUsd` 0.** The provider returned `HTTP 400 … insufficient credits`, every decision became a
refusal, and every row escalated to an escalator with no key. The pipeline was exercised end to end
— call, refusal, escalation attempt, recording, join — but no model opinion was produced. See
"Before you start it" below.

## Nothing was sent — the negative evidence

From the same four ticks:

```
prompts 0   held 0   asks 0        (the tick row's own counts)
nudge / done / flag / ask rows      none
asks.jsonl                          not created
claim registry                      not created
notify_observed 60                  every would-be notification, recorded instead
watchdog_prompt_observed 24         every would-be watchdog prompt, recorded instead
```

`outcome` 25 rows, all `outcomeKind: stalled` at `ticksObserved: 3` — the decisions were `flag`, a
silent op, the window elapsed and the panes had not moved. That is the counterexample row the
outcome module exists to produce, and it was produced live.

An earlier run the same day, before the account's credits ran out, is the other half of the picture:
17 panes, 17 decisions, **$0.002852**, no refusals, and three idle ticks afterwards at exactly
`$0.000000` each. A quiet fleet costs nothing, which is the property the whole design rests on.

## Cost per day, at the recorded per-call price

The price is from a record, not an estimate: `bench/results/2026-11-11T07-41-45-180Z__commandcode_deepseek_deepseek-v4.1-flash.json`,
`costUsd.per1k` 0.4827 over n = 100, so **$0.0004827 per decision**.

The daily volume is measured from the mined corpus, which is the only record of how often this
operator's panes actually complete a turn: **6.99 turn ends per active hour**, over 24 active days
averaging 8.1 active hours each.

| day type | turn ends (moves) | cost at $0.0004827 | at the live-measured $0.0001678 |
|---|---|---|---|
| median day | 51 | **$0.0246** | $0.0086 |
| p90 day | 117 | **$0.0565** | $0.0196 |
| busiest recorded day | 204 | **$0.0985** | $0.0342 |
| a day the fleet does not move | 0 | **$0.00** | $0.00 |

So: **two to ten cents a day, about 2.5 cents on a median day**, for a supervisor that observes every
minute of every day. The second column is here because the live ticks came in cheaper than the bench
records do (their prompts carry shorter pane tails); both are recorded, and the estimate above uses
the higher one. Escalations add nothing on this box — there is no `OPENROUTER_API_KEY`, so every
escalation fails before it is billed. If stage 0 were ever wired as the model's gate, the volume
would fall to its 54 % firing rate; it is not wired, so observe pays for every moved pane.

## Before you start it: the account is out of credits

The verification ran into this, so it belongs in the protocol rather than in a footnote. As of
2026-11-14 the `commandcode` account returns `HTTP 400 — insufficient credits` on every call.
Observe handles that correctly (refusal, escalation attempt, recorded, joined) but a log written
under it is a record of the provider failing, not of the model judging. **The first thing to check
in any observation log is the refusal rate on `decision` rows**: near 1.0 means top up the account
and discard that span; near 0 means the rows are worth joining.

## The collection protocol

Run observe for **at least a week of the fleet's normal working days, and stop on whichever comes
first: seven days, or 350 judged `outcome` rows.** At the measured 51 moves a day — and only the
proposals that stay silent (`leave`, `flag`) get judged at all — that is roughly 7–14 days at the
median rate and about 3 at the p90 rate, so check the count rather than the calendar. What to look at,
in this order: the **refusal rate** first, because a high one means the span is not a dataset; then
the **`stage0` rule mix**, because a fleet where `command` outnumbers `idle-turn` is a fleet of hung
processes rather than a fleet that is thinking, and the two want different rules; then the
**`stalled` : `progressed` ratio among silent decisions**, which is the base rate of "the supervisor
stayed quiet and the pane did not move anyway" — the number that decides whether a nudge is ever
worth sending; then `tick.costUsd` per day against the two-to-ten-cents estimate above, which is the
check that the interval and the fleet size are what you think they are. The point at which there are
enough rows to score stage 1 honestly is **350 judged rows in total, about 130 of them the minority
class**, which is
±5 points at 95 % confidence around a 63/37 split — and the honest caveat is that observe can only
label the silent side: a pane that moves after the supervisor stayed quiet is a nudge that was not
needed, and a pane that stays still is genuinely ambiguous between finished and stuck, because
observe never sends. Cleared that bar, the log supports scoring the model's `leave` decisions and
nothing else; scoring a *nudge* requires sending one, which is a live trial and a different decision
than this one.
