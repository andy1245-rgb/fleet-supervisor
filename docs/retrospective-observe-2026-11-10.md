# Retrospective observe-only — the pi corpus mined as a supervisor record, 2026-11-10

The supervisor had been waiting on a live week of fleet observation. It did not have to: this box
holds 1,982 pi sessions and 278,659 messages of the operator's own work, and the miner had only
ever read 117 files out of one of the two session roots. This is the corpus read properly, with a
decision point defined so that `leave` can exist at all.

## The corpus

`~/.pi/agent/sessions/` (operator sessions) plus `~/.pi/agent/subforge/sessions/` (subagent runs),
read through the session-insights CLI:

```
{"corpus": {"sessions": 1981, "calls": 148212, "results": 148099, "errors": 5577},
 "rows":   {"msgs": 278659, "calls": 148212, "results": 148099, "sessions": 1981, "runs": 1762}}
```

`mine/decision-points.ts` reads `.jsonl` files under one root and had seen **117 sessions — 6 % of
the corpus**, and none of the subagent half. It is left untouched: its corpus has to stay
reproducible, and its definition is the thing being replaced.

**Only the `main` root is mined.** 292 of the 1,982 sessions are the operator's; the other 1,690 are
subagent runs whose "user" turns are dispatcher prompts. A supervisor that learned from those would
learn that a machine ordering an agent around is a human speaking — the exact opposite of the
judgement `leave` encodes. The split is 292 `main` / 1,690 `sub`, and the sub root is excluded by
`--root` rather than by a filter applied afterwards, so the exclusion is visible in the command.

## The definition, and the window it needs

`mine/decision-points.ts` defines a decision point as *a completed agent turn that a human then
answered*, so P(a human intervened) = 1 in every row and `leave` cannot appear: "nothing was owed"
has no human message to bound it. That is a property of the definition, not of the data.

**Time-sampled decision point.** Every point where the agent finished a turn, whether or not a
human replied next. Labelled from what followed inside one decision window:

| what followed within the window | label | op |
|---|---|---|
| a human message, 0 s later, in the same second | `continue` / `instruction` / `redirect` / `question` | `nudge` |
| a human message that is only a halt | `stop` | `leave` |
| **no human message** | `quiet` | **`leave`** |
| nothing — the window runs past the session end | *(none)* | **censored** |

`quiet` is new and is the point of the exercise: it is a label whose evidence is an absence. It is
the sixth entry in `src/labeling/label-to-op.ts`, beside `stop`, so label → op still has exactly one
definition and the message-bounded miner cannot produce it (`labelFor` returns it never — pinned by
a test).

**The window is the fleet's own tick interval: 60,000 ms** (`AGENTFLEET_INTERVAL_MS`'s default). The
supervisor looks at a pane, acts or does not, and looks again one tick later, so the question a
`leave` answers is "will a human have spoken before I look again?" — a 60-second question by
construction. It is not fitted to the data, and the data would fit several answers: the measured
reply latency is

```
n = 1,311 turn ends with a later human message
p10 0.0 s   p25 8.0 s   p50 85.0 s   p75 434.0 s   p90 3,759 s   p99 141,114 s
<=15 s 28.6%   <=30 s 34.0%   <=60 s 43.7%   <=2 m 56.8%   <=5 m 70.4%   <=10 m 78.5%   <=1 h 89.8%
```

so the window is the whole ballgame and the sensitivity is reported rather than hidden:

| window | scorable rows | `leave` | `nudge` | `stop` | censored |
|---|---|---|---|---|---|
| 15 s | 1,276 | **71.5 %** | 28.3 % | 0.2 % | 307 |
| 30 s | 1,276 | **66.2 %** | 33.5 % | 0.2 % | 307 |
| **60 s** | **1,276** | **56.3 %** | **43.5 %** | **0.2 %** | **307** |
| 120 s | 1,276 | 43.0 % | 56.7 % | 0.2 % | 307 |
| 5 m | 1,276 | 29.1 % | 70.7 % | 0.2 % | 307 |
| 10 m | 1,276 | 21.0 % | 78.8 % | 0.2 % | 307 |
| 30 m | 1,276 | 12.5 % | 87.2 % | 0.2 % | 307 |

Anything past ten minutes stops being a supervisory question and starts being "this session is over",
which is why the choice is made at the tick and the curve is published beside it.

The `leave` column counts `quiet` only; the three `stop` rows — a human whose message was nothing but
a halt, the old corpus's one route to `leave` — are the 0.2 % beside it. The op-level tables below add
them, which is why they read 56.5 % where this one reads 56.3 %.

## What was mined

```
node mine/time-sampled-points.ts --sweep            # window 60000 ms, root main
sessions scanned: 292  (root main)
turns ending cleanly: 1751
points written:   1583  (1276 scorable, 307 censored)
  continue          18    1.1%
  instruction      449   28.4%
  redirect          30    1.9%
  question          58    3.7%
  stop               3    0.2%
  quiet            718   45.4%
  censored         307   19.4%
skipped: 1593 synthetic user messages, 88 unlabelled human messages,
         164 empty turns, 4 turns that ended mid-tool-call
```

Laid out as ops over the 1,276 scorable rows:

| op | rows | share |
|---|---|---|
| **`leave`** | **721** | **56.5 %** |
| `nudge` | 555 | 43.5 % |
| `flag` | 0 | 0.0 % |
| `declare_done` | 0 | 0.0 % |

Against the message-bounded corpus this is a different population, not a correction of it:

| | message-bounded (502 rows) | time-sampled (1,276 rows) |
|---|---|---|
| `nudge` | 406 (80.9 %) | 555 (43.5 %) |
| `leave` | 7 (1.4 %) | **721 (56.5 %)** |
| `flag` | 89 (17.7 %) | 0 |
| `declare_done` | 0 | 0 |

### Censoring, and what is not a `leave`

**307 points are censored** — the session ended before the window did. That is 19.4 % of points and
roughly one per session, because the last turn of every session has nothing after it by definition.
Censored rows carry `label: null`, are written to the points file so the count is auditable, and are
excluded from the task set.

Three readings of the same 1,583 rows, all defensible, all quoted so nobody picks one by accident:

- **56.5 % `leave`** over the 1,276 scorable rows — the estimate used from here on;
- **45.5 % `leave`** over all 1,583 points, counting censored rows as "not leave";
- **64.9 %** if every censored point were a `leave` — the upper bound, and the wrong answer, because
  a session that stopped being written is not a supervisor's observation.

**Four turns ended mid-tool-call** (last record a tool result, `terminal_stop_reason: "toolUse"` on
the session) and are dropped rather than censored: the agent was waiting on a result when the
transcript stopped. That is a dead pane, not a quiet one, and a `leave` there would teach the model
to ignore a hang. The count is small only because pi writes a final assistant message on nearly
every path — 286 of the 307 censored sessions end with `stop`, 9 `error`, 8 `aborted`, 4 `toolUse`.

`quiet` rows are not silent about their evidence. Their gap is recorded: **p10 1.4 min, p50 5.5 min,
p90 223.7 min** — so the median `leave` is a turn after which the human spoke five and a half
minutes later, and the label says nothing was owed *inside one tick*. The eventual reply is stored
as `nextLabel` (`instruction` 449, `question` 58, `redirect` 30, `continue` 18) and deliberately
**not** used as the label.

## The constant baselines

```
node bench/runners/baselines.ts bench/tasks/tasks-time-sampled.jsonl
sha 8b37d54869c5a99a   rows 1276
```

| constant | exact match | regret per task |
|---|---|---|
| **always `leave`** | **56.5 %** | 2.6097 |
| always `nudge` | 43.5 % | 2.8252 |
| **always `flag`** | 0.0 % | **1.5650** |
| always `declare_done` | 0.0 % | 4.0000 |

Two floors, and they disagree about which constant is best, which is the most useful thing in this
document:

**By accuracy,** always-`leave` is the floor at 56.5 %. That is the number a decision model must
beat to have measured anything about this corpus, and it is 40× the majority class of the
message-bounded corpus's `leave` column (1.4 %). `leave` is no longer a rounding error someone has to
decide whether to keep: it is the most common correct action.

**By regret,** always-`flag` wins at 1.5650 despite never being right. `REGRET` prices a false alarm
at 2 (`leave` expected, `flag` predicted) and at 1 (`nudge` expected, `flag` predicted), while
predicting `leave` on a row that owed action costs 6. So always-flag pays 0.565 × 2 + 0.435 × 1 =
1.5650, and always-leave pays 0.435 × 6 + 0.565 × 0 = 2.6097. A constant that always calls for a
human is the cheap constant under weights that punish silence six times harder than a false alarm.
**So the corpus's own optimism is not the model's target: any model has to beat 56.5 % exact match
*and* 1.5650 regret per task, and the second is harder.** A model that learns "flag when unsure"
will beat the first and fail the second, and this table is what makes that visible before the money
is spent.

The regret weights are still asserted, unitless and unswept (`weightsSwept: false`) — the same
caveat every record in this repo carries. What is new is that the corpus now prices the cell the
weights were guessed about: `leave` is 56.5 % of rows, so the `leave` row of the matrix is the
bill.

## The decision model, offline

The supervisor's current primary, `commandcode/deepseek/deepseek-v4.1-flash`, scored against a
stratified 100-row sample of the same corpus (`bench/runners/run.ts` gained the `commandcode/`
branch of `manager/tick.ts:buildModel`; before that a `commandcode/…` name fell through to the
chat-completions adapter, which is a different wire and a different question).

`bench/results/2026-11-10T19-35-28-775Z__commandcode_deepseek_deepseek-v4.1-flash.json`, n = 100
stratified (`leave` 56 / `nudge` 44; corpus 721 / 555), 13 m 19 s wall, **$0.026772 recorded on the
card for 100 decisions** — and the operator's commandcode plan is flat, so the marginal spend is
nothing while the record still prices what the calls would cost.

| | exact match | regret / task | `leave` recall | `nudge` recall |
|---|---|---|---|---|
| **`deepseek-v4.1-flash`** | **30.0 %** | **3.1000** | **8.9 %** (5/56) | 56.8 % (25/44) |
| always `leave` | 56.0 % | 2.6400 | 100 % | 0 % |
| always `nudge` | 44.0 % | 2.8000 | 0 % | 100 % |
| always `flag` | 0.0 % | **1.5600** | 0 % | 0 % |

It is below both floors: **26 points under the majority constant on accuracy, and twice as
expensive as a constant that is never right.** The confusion says why, and it is not noise:

| expected → predicted | n |
|---|---|
| `leave` → `nudge` | **41** |
| `leave` → `declare_done` | 5 |
| `leave` → `flag` | 5 |
| `leave` → `leave` | 5 |
| `nudge` → `nudge` | 25 |
| `nudge` → `leave` | 10 |
| `nudge` → `flag` | 7 |
| `nudge` → `declare_done` | 2 |

The model has not inverted the classes at random; it has a **prior that action is owed**. On 56
quiet turns it called for work 41 times, with arguments that read plausibly — *"Carry out your own
stated plan: reproduce the launch outside VSCode"*, *"Don't block on the unanswerable question: keep
scope to MDMA only"* — each of which is a reasonable thing to say to an agent, and each of which was
wrong, because the operator was going to say something himself within the minute.

Its confidence carries no information: **0.627 mean on the 30 it got right, 0.622 on the 70 it got
wrong.** That is the same property measured a second way: `needle3`'s confidence scored AUROC 0.523
— a coin flip — over `localAlexa`'s 382-row intent set, and here the mean confidence of right answers
and wrong answers differ by 0.005. It means the ladder's escalate-on-low-confidence rule cannot
rescue this model: it has no low-confidence rows to escalate.

### The corpus is not the problem: one feature beats the model by 43 points

Before concluding anything about decision models from a 0.30, the corpus has to be shown learnable
at all. It is, from a feature the supervisor already reads — **how long the agent's final message
was** (`tail`, the terminal output the prompt already carries, capped at 1,200 characters):

```python
leave if len(tail) > 1180 else nudge
```

| rows | rule | exact match | regret / task | `nudge` precision |
|---|---|---|---|---|
| the same 100 the model saw | `tail > 1180` | **73.0 %** | **1.5900** | **87.0 %** (20/23) |
| all 1,276 | `tail > 1180` | 72.3 % | 1.6379 | — |
| held out by session (threshold fitted on 729 rows, scored on 547) | `tail > 1180` | **69.7 %** vs 55.0 % majority | — | — |

The threshold was chosen on half the sessions and measured on the other half, so this is not an
in-sample fit. What it says is interpretable: a turn that ends after a long delivery goes quiet, and
a turn that ends on a short line — usually a question or a one-line status — gets a reply inside the
minute. The model had this field and did worse with it than a comparison does.

That reframes the model result: **0.30 is a model failure, not a corpus limit.** The corpus supports
~70 % from one number, so there is something to learn; what is broken is the decider, and the
record above is the evidence that the current one should not be trusted on this corpus as wired.


## What the balance implies for the ladder

**1. Tier 0 is confirmed, and it is now quantified.** The claim the whole design rests on — that
most of the time the right answer is to do nothing — is 56.5 % of decisions in this corpus, and
`leave` is the single most common correct op. That is 40× the `leave` share of the message-bounded
corpus, where the class could not appear at all. Tier 0 costs one `herdr agent list` and no model,
so the majority class of the supervisor's work is already free and already right.

**2. The `leave` question is mostly not a model's to answer.** The input carries no clock at the
moment of decision (`idleTicks` 0, `status` idle by construction) while the label is dominated by how
long the operator took to type, so what is left for content is the share the tail explains — a lot,
69.7 %, but nearly all of it one comparison wide. A model that costs a call per moved pane to
re-derive a comparison the gate already has is the thing this measurement argues against. What is
genuinely worth a model is the minority question — *did this turn stop in a way that owed work?* —
where the base rate is 43.5 %, precision is the metric, and the current model's precision is 37.9 %
against a one-number rule's 87.0 %.

**3. So the ladder's shape is: a rule for `leave`, a model for the rest.** Concretely, the ordering
this corpus supports is

| stage | decides | evidence |
|---|---|---|
| Tier 0 | nothing moved → `leave` | already built, free, 0.094 s |
| a content gate | did the turn end on a short line, an unanswered question, or an error → candidate | one comparison, 69.7 % held-out as a full decider |
| the model | `nudge` / `flag` / `declare_done` on candidates only | precision, not accuracy, on 43.5 % of rows |

That gate is not a proposal for a new component so much as the observation that the supervised
decision lives where the agent's own output says something is owed, and the corpus can find those
rows with a comparison. Paying a model per moved pane to re-derive "the human was about to speak"
is the thing this measurement argues against.

**4. The regret weights are now measurably distorting the ranking and should be swept before any
model is judged.** `always flag` never scores a hit and wins the regret column (1.5650) against
`always leave` (2.6097) and against the `tail > 1180` rule (1.6379), because silence on a row that
owed action is priced 6 and a false alarm is priced 2. On a corpus where 56.5 % of rows are `leave`,
that ratio makes "call for a human every time" the cheapest constant there is. The weights are
still `weightsSwept: false` — asserted, unitless, never fitted — and this is the first corpus with
enough `leave` rows to price the decision they were guessed about. Until they are swept, "lower
regret" is not the same claim as "better supervisor".

**5. Two ops remain unmineable, and this work does not change that.** `flag` 0 rows, `declare_done`
0 rows. `leave` was unmineable for a *definitional* reason and is now the majority class; the other
two are unmineable for evidential reasons that survive the new definition — no human message
anywhere in this corpus evidences "a human must take over" or "the delivery was accepted". Any
table that shows them scoring is showing a constant.

**6. What this does not measure.** Same caveat as the old corpus, one level down: these are turn
ends in transcripts, not fleet snapshots, and no decision here has been scored against what a
supervised fleet actually did next. `status` and `idleTicks` are reconstructions; the window is the
sampling rule. The row is "this turn, and then this much of the operator's attention", which is the
closest a transcript can get to "this pane, and then this supervisor's next tick".

**7. One thing to keep out of reach.** The needle3 ladder is not re-run here and the probe already
settled it (at a ten-minute cap: `op: null` on 4 of 4). Whether it is retired is the operator's
decision, not this document's.

## How to reproduce

```sh
node mine/session-cache.ts --root=main     # once: ~7 min for the 292 operator sessions
node mine/time-sampled-points.ts --sweep    # 292 sessions → 1,583 points → 1,276 tasks
node bench/runners/baselines.ts bench/tasks/tasks-time-sampled.jsonl
node bench/runners/run.ts commandcode/deepseek/deepseek-v4.1-flash --limit=100 \
  --taskset=bench/tasks/tasks-time-sampled.jsonl
npm test
```

The census in `## The corpus` was taken with `--root=all` (1,982 timelines, ~10 min); the miner
never reads the 1,690 subagent ones. `mine/out/` and `bench/tasks/*.jsonl` are gitignored: the rows
carry session text. The miner's cache
is append-only in the strict sense that it never deletes a cached timeline — a session that leaves
the index keeps its file, because a cached timeline is evidence rather than scratch.
