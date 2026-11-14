# Observation is running — four days, and how to read it on day four

Started 2026-11-14 15:36 local, on the operator's approval of four days. This is the note the
operator asked for: what is running, what was verified before leaving it, how to read the log when
the four days are up, and what would count as enough labelled rows.

## What is running, exactly

```sh
AGENTFLEET_OBSERVE=1 \
AGENTFLEET_STATE=/home/andrew/.pi/agent/fleet-observe/marks.json \
AGENTFLEET_STATE_DIR=/home/andrew/.pi/agent/fleet-observe \
AGENTFLEET_INTERVAL_MS=60000 \
node src/manager/tick.ts
```

- **A dedicated state dir**, `~/.pi/agent/fleet-observe/`, so the four days are one bounded span
  rather than rows mixed into the supervisor's own log. `events.jsonl` is the record; `pending.json`
  is the open-question set; `marks.json` is what makes the next tick see only what moved.
- **60 s, not something lazier.** The idle rule's `IDLE_TICKS = 2` was derived against a 60-second
  tick; at any other interval "two ticks" is a different amount of silence and the rule stops
  meaning what it was measured to mean. If this is ever re-started at another interval, say so in
  the analysis.
- **Detached process, not a systemd unit.** It survives this session and a logout, not a reboot. If
  the box reboots, re-run exactly the command above: `marks.json` means it resumes without deciding
  the whole fleet again.

## Verified before leaving it

Six ticks, 29 live panes, throwaway-to-real state dir:

| | |
|---|---|
| rows landing | 608 rows in six ticks — `stage0` 174, `watchdog_action` 69, `notify_observed` 99, `decision` 30, `action` 30 |
| the model was consulted | 30 `decision` rows, one per moved pane, each with `model`, `refused`, `costUsd` |
| the join is closing | **26 `outcome` rows, all `stalled` at `ticksObserved: 3`**, and 4 questions still open in `pending.json` |
| the loop is live | tick 1 decided 29 cold panes; tick 4 caught one real move in the fleet |
| nothing was sent | 0 prompts, 0 held, 0 asks, no `nudge`/`done`/`flag`/`ask` row, no `asks.jsonl`, no claim registry |

The one thing that is **not** working is the model: every one of the 30 calls was refused with
`HTTP 400 — insufficient credits`, in ~400 ms, and every refusal escalated to an escalator that has
no key. The pipeline is recording the provider failing. **Check this first on day four** — see below.

## How to read the log on day four

```sh
cd /home/andrew/agentFleet
L=~/.pi/agent/fleet-observe/events.jsonl

# 1. is the span a dataset at all? refusal rate on model rows, then cost
python3 - <<'PY'
import json, collections
rows = [json.loads(l) for l in open("/home/andrew/.pi/agent/fleet-observe/events.jsonl")]
dec = [r for r in rows if r.get("kind") == "decision" and r.get("schema")]
print("decisions", len(dec), "refused", sum(1 for d in dec if d.get("refused")),
      "ratio", round(sum(1 for d in dec if d.get("refused")) / max(1, len(dec)), 3))
print("ops", collections.Counter(d["op"] for d in dec))
print("cost", round(sum(r.get("costUsd", 0) for r in rows if r.get("kind") == "tick" and r.get("schema")), 6))
PY
```

Read those four numbers in this order, and stop at the first that is wrong:

1. **refusal ratio.** Near 1.0: the account is still out of credits, the span is a record of the
   provider failing, and no amount of analysis fixes it — top up, restart the span, discard these
   days. Near 0: carry on.
2. **`ops` mix.** All `flag` and none `leave` means the model believes every pane needs a human,
   which is the prior it showed on the mined corpus. A healthy mix is the point of watching.
3. **cost.** Against the estimate: $0.0246 for a median day, $0.0565 at p90, $0.0985 on the busiest
   recorded day, $0 on a day the fleet does not move. A number far above that is a fleet-size or
   interval surprise; $0 on a busy day is the refusal problem again.
4. **judged rows and their kinds:**

```sh
python3 - <<'PY'
import json, collections
rows = [json.loads(l) for l in open("/home/andrew/.pi/agent/fleet-observe/events.jsonl")]
out = [r for r in rows if r.get("kind") == "outcome"]
print("judged", len(out), collections.Counter(r["outcomeKind"] for r in out))
print("by op", collections.Counter(r["op"] for r in out))
print("stage0 speaking", sum(1 for r in rows if r.get("kind") == "stage0" and r.get("speak")),
      "of", sum(1 for r in rows if r.get("kind") == "stage0"))
PY
```

`stalled` on a `leave` or `flag` is the counterexample row — the supervisor stayed quiet and the
pane did not move. `progressed` is the opposite: it moved anyway, so the nudge would have been
wasted. Those two counts are what the log is for. Also watch the stage-0 speaking share: it should
sit near the mined corpus's 54 %, and a fleet where `command` outnumbers `idle-turn` among the
speaking rows is a fleet of hung processes rather than a fleet that is thinking.

## What counts as enough labelled rows

**350 judged `outcome` rows — 350 in total, of which about 130 will be the minority class — is the
bar.** That is ±5 points at 95 % confidence around a 63/37 split (`n = z²p(1−p)/e²` with p = 0.63,
e = 0.05), and it is the smallest n at which one model can be called better than another rather than
lucky. Below it, a single row moves the accuracy by three points and the engine's own run-to-run
wobble is larger than the gap being measured — which is exactly how a 24-row residue produced a
result nobody could act on.

**Four days probably will not reach it.** The corpus says this operator's panes complete 6.99 turns
an hour over 8.1 active hours, so 51 moves on a median day and 117 on a p90 day, and only the
proposals that stay silent (`leave`, `flag`) get judged at all. Four days is therefore roughly
**200 rows at the median pace and 470 at the p90 pace** — so the honest expectation is *just short on
a quiet week and comfortable on a busy one*. What four days certainly buys is the two things the
mined corpus could not give: a live refusal rate, and a live `stalled`:`progressed` ratio. What it
probably will not buy is a stage-1 score. Extending to seven days costs another six cents and closes
that gap; that is a decision to take on day four with the counts in hand, not on faith.

**And the limit that no number of days removes:** observe never sends, so it can only label the
silent side. A pane that moves after the supervisor stayed quiet is a nudge that was not needed; a
pane that stays still is ambiguous between finished and stuck. Scoring a *nudge* itself needs a live
trial, which is a different decision than this one.
