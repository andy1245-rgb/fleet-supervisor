# Retrospective observe-only — the pi corpus mined as a supervisor record, 2026-11-10

The supervisor had been waiting on a live week of fleet observation. It did not have to: the local
session corpus holds 1,982 pi sessions and 278,659 messages of local agent work, and the miner had
only ever read 117 files out of one of the two session roots. This is the corpus read properly, with
a decision point defined so that `leave` can exist at all.

**Nothing here publishes a row.** Every number below is a count, a rate, a window or a sha.
`docs/CORPUS-POLICY.md` is the rule and `npm run check:corpus` is the enforcement: mined text lives
in `mine/out/` (gitignored), the records in `bench/results/` carry scores and cite their task-set sha,
and this document describes shapes rather than quoting anything an agent or a human said.

## The corpus

`~/.pi/agent/sessions/` (interactive sessions) plus `~/.pi/agent/subforge/sessions/` (subagent runs),
read through the session-insights CLI:

```
{"corpus": {"sessions": 1981, "calls": 148212, "results": 148099, "errors": 5577},
 "rows":   {"msgs": 278659, "calls": 148212, "results": 148099, "sessions": 1981, "runs": 1762}}
```

`mine/decision-points.ts` reads `.jsonl` files under one root and had seen **117 sessions — 6 % of
the corpus**, and none of the subagent half. It is left untouched: its corpus has to stay
reproducible, and its definition is the thing being replaced.

**Only the `main` root is mined.** 292 of the 1,982 sessions are interactive; the other 1,690 are
subagent runs whose "user" turns are dispatcher prompts. A supervisor that learned from those would
learn that a machine ordering an agent around is a human speaking — the exact opposite of the
judgement `leave` encodes. The split is 292 `main` / 1,690 `sub`, and the sub root is excluded by
`--root` rather than by a filter applied afterwards, so the exclusion is visible in the command.

**14 of the 292 sessions are excluded, not sanitised** (policy §3). Each carried a credential shape
in its own text — 5 openai-key, 5 basic-auth-url, 3 private-key, 1 assigned-secret — and the miner
drops the whole session rather than editing it, counting 220 points that would otherwise have been
rows. The exclusion uses the same shape list as `tools/check-corpus.mjs` (both import
`src/corpus/credentials.ts`), so a guard and a miner cannot disagree about what a secret looks like.
All 14 matches are live-looking by the guard's own placeholder test, so the miner's stricter policy
cost no session the guard would have allowed. That is the whole exclusion report: no ids, no text.

## The definition, and the window it needs

`mine/decision-points.ts` defines a decision point as *a completed agent turn that a human then
answered*, so P(a human intervened) = 1 in every row and `leave` cannot appear: "nothing was owed"
has no human message to bound it. That is a property of the definition, not of the data.

**Time-sampled decision point.** Every point where the agent finished a turn, whether or not a human
replied next. Labelled from what followed inside one decision window:

| what followed within the window | label | op |
|---|---|---|
| a human message, inside the window | `continue` / `instruction` / `redirect` / `question` | `nudge` |
| a human message that is only a halt | `stop` | `leave` |
| **no human message** | `quiet` | **`leave`** |
| nothing — the window runs past the session end | *(none)* | **censored** |

`quiet` is new and is the point of the exercise: it is a label whose evidence is an absence. It is
the sixth entry in `src/labeling/label-to-op.ts`, beside `stop`, so label → op still has exactly one
definition and the message-bounded miner cannot produce it (`labelFor` returns it never — pinned by a
test).

**The window is the fleet's own tick interval: 60,000 ms** (`AGENTFLEET_INTERVAL_MS`'s default). The
supervisor looks at a pane, acts or does not, and looks again one tick later, so the question a
`leave` answers is "will a human have spoken before I look again?" — a 60-second question by
construction. It is not fitted to the data, and the data would fit several answers: the measured
reply latency is

```
n = 1,105 turn ends with a later human message
p10 0.0 s   p25 7.0 s   p50 78.0 s   p75 410.0 s   p90 3,714 s   p99 156,253 s
<=15 s 29.4%   <=30 s 34.9%   <=60 s 45.0%   <=2 m 57.8%   <=5 m 71.6%   <=10 m 79.2%   <=1 h 89.9%
```

so the window is the whole ballgame and the sensitivity is reported rather than hidden:

| window | scorable rows | `quiet` | `nudge` | `stop` | censored |
|---|---|---|---|---|---|
| 15 s | 1,073 | **70.6 %** | 29.1 % | 0.3 % | 290 |
| 30 s | 1,073 | **65.3 %** | 34.4 % | 0.3 % | 290 |
| **60 s** | **1,073** | **55.0 %** | **44.7 %** | **0.3 %** | **290** |
| 120 s | 1,073 | 41.9 % | 57.8 % | 0.3 % | 290 |
| 5 m | 1,073 | 27.9 % | 71.9 % | 0.3 % | 290 |
| 10 m | 1,073 | 20.3 % | 79.4 % | 0.3 % | 290 |
| 30 m | 1,073 | 12.6 % | 87.1 % | 0.3 % | 290 |

Anything past ten minutes stops being a supervisory question and starts being "this session is over",
which is why the choice is made at the tick and the curve is published beside it.

The `quiet` column counts `quiet` only; the three `stop` rows — a human whose message was nothing but
a halt, the old corpus's one route to `leave` — are the 0.3 % beside it. The op-level tables below add
them, which is why they read 55.3 % where this one reads 55.0 %.

## What was mined

```
node mine/time-sampled-points.ts --sweep            # window 60000 ms, root main
sessions scanned: 292  (root main)
turns ending cleanly: 1509
points written:   1363  (1073 scorable, 290 censored)
  continue          16    1.2%
  instruction      385   28.2%
  redirect          28    2.1%
  question          51    3.7%
  stop               3    0.2%
  quiet            590   43.3%
  censored         290   21.3%
excluded: 14 sessions (220 points) carried a credential shape
skipped: 1231 synthetic user messages, 82 unlabelled human messages,
         142 empty turns, 4 turns that ended mid-tool-call
wrote mine/out/points-time-sampled.jsonl   sha 55aff8ba9437d89b
wrote mine/out/tasks-time-sampled.jsonl    sha a4465493eeed4251  (1073 tasks)
```

Laid out as ops over the 1,073 scorable rows:

| op | rows | share |
|---|---|---|
| **`leave`** | **593** | **55.3 %** |
| `nudge` | 480 | 44.7 % |
| `flag` | 0 | 0.0 % |
| `declare_done` | 0 | 0.0 % |

Against the message-bounded corpus this is a different population, not a correction of it:

| | message-bounded (502 rows) | time-sampled (1,073 rows) |
|---|---|---|
| `nudge` | 406 (80.9 %) | 480 (44.7 %) |
| `leave` | 7 (1.4 %) | **593 (55.3 %)** |
| `flag` | 89 (17.7 %) | 0 |
| `declare_done` | 0 | 0 |

### Censoring, and what is not a `leave`

**290 points are censored** — the session ended before the window did. That is 21.3 % of points and
roughly one per session, because the last turn of every session has nothing after it by definition.
Censored rows carry `label: null`, are written to the points file so the count is auditable, and are
excluded from the task set.

Three readings of the same 1,363 rows, all defensible, all quoted so nobody picks one by accident:

- **55.3 % `leave`** over the 1,073 scorable rows — the estimate used from here on;
- **43.5 % `leave`** over all 1,363 points, counting censored rows as "not leave";
- **64.8 %** if every censored point were a `leave` — the upper bound, and the wrong answer, because a
  session that stopped being written is not a supervisor's observation.

**Four turns ended mid-tool-call** (last record a tool result, `terminal_stop_reason: "toolUse"` on
the session) and are dropped rather than censored: the agent was waiting on a result when the
transcript stopped. That is a dead pane, not a quiet one, and a `leave` there would teach the model to
ignore a hang. The count is small only because pi writes a final assistant message on nearly every
path — of the 290 censored sessions, 269 end with `stop`, 9 `error`, 8 `aborted`, 4 `toolUse`.

`quiet` rows are not silent about their evidence. Their gap is recorded: **p10 1.3 min, p50 5.3 min,
p90 255.6 min** — so the median `leave` is a turn after which the human spoke five minutes later, and
the label says nothing was owed *inside one tick*. The eventual reply is classified and stored as
`nextLabel` (`instruction` 443, `question` 101, `continue` 26, `redirect` 20) and deliberately **not**
used as the label.

## The constant baselines

```
node bench/runners/baselines.ts mine/out/tasks-time-sampled.jsonl
sha a4465493eeed4251   rows 1073
```

| constant | exact match | regret per task |
|---|---|---|
| **always `leave`** | **55.3 %** | 2.6841 |
| always `nudge` | 44.7 % | 2.7633 |
| **always `flag`** | 0.0 % | **1.5527** |
| always `declare_done` | 0.0 % | 4.0000 |

Two floors, and they disagree about which constant is best, which is the most useful thing in this
document:

**By accuracy,** always-`leave` is the floor at 55.3 %. That is the number a decision model must beat
to have measured anything about this corpus, and it is about 40× the `leave` share of the
message-bounded corpus (1.4 %). `leave` is no longer a rounding error someone has to decide whether to
keep: it is the most common correct action.

**By regret,** always-`flag` wins at 1.5527 despite never being right. `REGRET` prices a false alarm
at 2 (`leave` expected, `flag` predicted) and at 1 (`nudge` expected, `flag` predicted), while
predicting `leave` on a row that owed action costs 6. So always-flag pays 0.553 × 2 + 0.447 × 1 =
1.5527, and always-leave pays 0.447 × 6 + 0.553 × 0 = 2.6841. A constant that always calls for a
human is the cheap constant under weights that punish silence six times harder than a false alarm.
**So the corpus's own optimism is not the model's target: any model has to beat 55.3 % exact match
*and* 1.5527 regret per task, and the second is harder.** A model that learns "flag when unsure" will
beat the first and fail the second, and this table is what makes that visible before the money is
spent.

The regret weights are still asserted, unitless and unswept (`weightsSwept: false`) — the same caveat
every record in this repo carries. What is new is that the corpus now prices the cell the weights were
guessed about: `leave` is 55.3 % of rows, so the `leave` row of the matrix is the bill.

## The decision model, offline

The supervisor's current primary, `commandcode/deepseek/deepseek-v4.1-flash`, scored against a
stratified 100-row sample of the same corpus (`bench/runners/run.ts` gained the `commandcode/` branch
of `manager/tick.ts:buildModel`; before that a `commandcode/…` name fell through to the
chat-completions adapter, which is a different wire and a different question).

`bench/results/2026-11-11T07-41-45-180Z__commandcode_deepseek_deepseek-v4.1-flash.json`, n = 100
stratified (`leave` 55 / `nudge` 45; corpus 593 / 480), 7 m 3 s wall, **$0.048266 recorded on the card
for 100 decisions** — the account's commandcode plan is flat, so the marginal spend is nothing while
the record still prices what the calls would cost. Its trace stayed on disk, not in git.

| | exact match | regret / task | `leave` recall | `nudge` recall |
|---|---|---|---|---|
| **`deepseek-v4.1-flash`** | **38.0 %** | **2.7600** | **18.2 %** (10/55) | 62.2 % (28/45) |
| always `leave` | 55.0 % | 2.7000 | 100 % | 0 % |
| always `nudge` | 45.0 % | 2.7500 | 0 % | 100 % |
| always `flag` | 0.0 % | **1.5500** | 0 % | 0 % |

It is under both floors: **17 points below the majority constant on accuracy, and dearer than a
constant that is never right.** It answers every row (refusals 0, p50 2,301 ms against 4,942 ms on the
pre-exclusion run) and the confusion says why it is still wrong:

| expected → predicted | n |
|---|---|
| `leave` → `nudge` | **32** |
| `leave` → `leave` | 10 |
| `leave` → `flag` | 9 |
| `leave` → `declare_done` | 4 |
| `nudge` → `nudge` | 28 |
| `nudge` → `leave` | 13 |
| `nudge` → `flag` | 4 |

The model has not inverted the classes at random; it has a **prior that action is owed**. On 55 quiet
turns it called for work 45 times, and on the 45 that did owe work it chose `leave` 13 times. Every one
of those is a defensible-looking sentence about the pane; the corpus disagrees with 62 of them.

Its confidence carries no information: **0.658 mean on the 38 it got right, 0.632 on the 62 it got
wrong.** That is the same property measured a second way — `needle3`'s confidence scored AUROC 0.523, a
coin flip, over another project's 382-row intent set — and it means the ladder's
escalate-on-low-confidence rule cannot rescue this model: it has no low-confidence rows to escalate.

### The corpus is not the problem: one feature beats the model by 35 points

Before concluding anything about decision models from a 0.38, the corpus has to be shown learnable at
all. It is, from a feature the supervisor already reads — **how many characters of terminal output the
turn ended with** (`tail`, capped at 1,200 characters by the prompt):

```python
leave if len(tail) > 1180 else nudge
```

| rows | rule | exact match | regret / task | `nudge` precision |
|---|---|---|---|---|
| the same 100 the model saw | `tail > 1180` | **73.0 %** | **1.5900** | **87.5 %** (21/24) |
| all 1,073 | `tail > 1180` | 72.0 % | 1.6542 | — |
| held out by session (threshold fitted on 576 rows, scored on 497) | `tail > 1180` | **72.8 %** vs 54.1 % majority | — | — |

The threshold was chosen on half the sessions and measured on the other half, so this is not an
in-sample fit. What it says is interpretable: a turn that ends after a long delivery goes quiet, and a
turn that ends on a short line — usually a question or a one-line status — gets a reply inside the
minute. The model had this field and did worse with it than a comparison does.

That reframes the model result: **0.38 is a model failure, not a corpus limit.** The corpus supports
~72 % from one number, so there is something to learn; what is broken is the decider, and the record
above is the evidence that the current one should not be trusted on this corpus as wired.

The 100-row sample above was drawn after the exclusion, so its rows are the same rows the baselines and
the rule were scored on. An earlier record on the pre-exclusion corpus
(`2026-11-10T19-35-28-775Z`, sha `8b37d54869c5a99a`, n = 100) scored 0.300 and is kept rather than
deleted: it is a real measurement of the same model on a corpus 14 sessions larger, and the direction
did not change.

## What the balance implies for the ladder

**1. Tier 0 is confirmed, and it is now quantified.** The claim the whole design rests on — that most
of the time the right answer is to do nothing — is 55.3 % of decisions in this corpus, and `leave` is
the single most common correct op. Tier 0 costs one `herdr agent list` and no model, so the majority
class of the supervisor's work is already free and already right.

**2. The `leave` question is mostly not a model's to answer.** The input carries no clock at the
moment of decision (`idleTicks` 0, `status` idle by construction) while the label is dominated by how
long a human took to type, so what is left for content is the share the tail explains — a lot, as
the section above measures, but nearly all of it one comparison wide. A model that costs a call per
moved pane to re-derive a comparison the gate already has is the thing this measurement argues
against. What is genuinely worth a model is the minority question — *did this turn stop in a way that
owed work?* — where the base rate is 44.7 % and precision, not accuracy, is the metric.

**3. So the ladder's shape is: a rule for `leave`, a model for the rest.** Concretely, the ordering
this corpus supports is

| stage | decides | evidence |
|---|---|---|
| Tier 0 | nothing moved → `leave` | already built, free, 0.094 s |
| a content gate | did the turn end on a short line, an unanswered question, or an error → candidate | one comparison on `tail`, measured below |
| the model | `nudge` / `flag` / `declare_done` on candidates only | precision on 44.7 % of rows |

That gate is not a proposal for a new component so much as the observation that the supervised
decision lives where the agent's own output says something is owed, and the corpus can find those rows
with a comparison.

**4. The regret weights are now measurably distorting the ranking and should be swept before any
model is judged.** `always flag` never scores a hit and wins the regret column (1.5527) against
`always leave` (2.6841), because silence on a row that owed action is priced 6 and a false alarm is
priced 2. On a corpus where 55.3 % of rows are `leave`, that ratio makes "call for a human every time"
the cheapest constant there is. The weights are still `weightsSwept: false` — asserted, unitless,
never fitted — and this is the first corpus with enough `leave` rows to price the decision they were
guessed about. Until they are swept, "lower regret" is not the same claim as "better supervisor".

**5. Two ops remain unmineable, and this work does not change that.** `flag` 0 rows, `declare_done` 0
rows. `leave` was unmineable for a *definitional* reason and is now the majority class; the other two
are unmineable for evidential reasons that survive the new definition — no human message anywhere in
this corpus evidences "a human must take over" or "the delivery was accepted". Any table that shows
them scoring is showing a constant.

**6. What this does not measure.** Same caveat as the old corpus, one level down: these are turn ends
in transcripts, not fleet snapshots, and no decision here has been scored against what a supervised
fleet actually did next. `status` and `idleTicks` are reconstructions; the window is the sampling
rule. The row is "this turn, and then this much of a human's attention", which is the closest a
transcript can get to "this pane, and then this supervisor's next tick".

**7. One thing to keep out of reach.** The needle3 ladder is not re-run here and the probe already
settled it (at a ten-minute cap: `op: null` on 4 of 4). Whether it is retired is a maintainer
decision, not this document's.

## How to reproduce

```sh
node mine/session-cache.ts --root=main     # once: ~7 min for the 292 interactive sessions
node mine/time-sampled-points.ts --sweep    # 292 → 1,363 points → 1,073 tasks, all under mine/out
node bench/runners/baselines.ts mine/out/tasks-time-sampled.jsonl
node bench/runners/run.ts commandcode/deepseek/deepseek-v4.1-flash --limit=100 \
  --taskset=mine/out/tasks-time-sampled.jsonl
npm run check:corpus && npm test
```

The census in `## The corpus` was taken with `--root=all` (1,982 timelines, ~10 min); the miner never
reads the 1,690 subagent ones. `mine/out/` is gitignored and nothing the miner writes goes anywhere
else — the bench runner copies the task set it is given into `bench/tasks/`, which is gitignored by
policy, to freeze the sha a record cites. The miner's cache never deletes a cached timeline: a session
that leaves the index keeps its file, because a cached timeline is evidence rather than scratch.

**Traces are not committed for these runs, and that is the policy rather than an oversight.** A
`.traces.jsonl` row carries the model's own sentence, and for any model that answers rather than
refusing, that sentence is the tail's words rearranged. The record keeps the scores and the sha; the
trace stays on disk beside the corpus it came from.
