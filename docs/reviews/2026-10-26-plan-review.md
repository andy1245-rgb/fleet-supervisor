# Sceptical review of the agentFleet plan

2026-10-26. Read-only review. Nothing outside `docs/reviews/` was modified; no training
process was touched. Every number here comes from `bench/results/`, from a read-only command
recorded in the appendix, or from a file line named beside it.

The question is not whether this code is tidy. It is whether the plan can work. So the method
was: find the smallest set of numbers that would prove the plan wrong, then try to make them.

---

## Verdict

**The design is partly sound, and the part that is unsound is the part the repository is proudest
of.**

The supervisor shape — herdr as the only observation/action boundary, workers writing their own
claims, sequence-delta change detection, one decision per moved pane, one gate on every mutation
— survives every attempt to break it below. That half of the plan is sound, and I could not
falsify it.

The learning half does not survive. Mined labels → benchmark → fine-tune → escalation ladder is a
chain in which **the ground truth is a function of the human message's character count and first
word, over a population conditioned on the human having spoken at all**, and the benchmark built
on it has less signal than a one-line constant predictor. Measured:

| predictor | exact match | regret/task | source |
|---|---|---|---|
| `always nudge`, full 502-row corpus | **0.8088** | **0.2470** | appendix A2 |
| `z-ai/glm-5.3-flash`, its own 40-row subset | 0.3500 | 0.4000 | `bench/results/2026-10-26T21-59-25-120Z__openrouter_z-ai_glm-5.3-flash.json` |
| `always nudge`, that same 40-row subset | **0.8750** | **0.1250** | appendix A3 |
| `needle3`, 22-row subset | 0.1364 | 1.1818 | `bench/results/2026-10-27T00-43-19-911Z__needle3.json` |
| `always flag`, that same 22-row subset | **0.1364** | **1.1818** | appendix A2 |
| `slate-control-d8`, 40-row subset | 0.1500 | 1.1500 | `bench/results/2026-10-26T23-24-18-841Z__slate-control-d8.json` |
| `always flag`, that same 40-row subset | **0.1750** | **1.0000** | appendix A2 |

`needle3`'s committed record *is* `always flag`, to four decimals, because 22/22 refusals are
mapped to `flag` by `parseDecision`. `control-d8` is one row worse than `always flag`. The only
hosted measurement in the repository loses 52.5 points of exact match to the corpus's own
majority class on its own 40 rows.

### The single weakest link

> `expectedOp` is produced by `labelFor()` in `mine/decision-points.ts:210-232`, which reads one
> string — the human's next message — and classifies it by first-word regex and character count.
> The corpus is conditioned on that message existing, so *P(a human had to intervene) = 1 for all
> 502 rows*, and the supervisor's most common correct answer (`leave`) cannot appear except as
> `stop`-labelled rows where a human intervened to halt. The majority label, `nudge` at 406/502,
> is the **fallback branch** — `labelReason: "no explicit signal"` — i.e. ground truth is the
> absence of a pattern match.

Everything downstream is calibrated against that: the SLATE variants, the depth rungs, the
fine-tune corpus, `AGENTFLEET_THRESHOLD`, and the regret matrix that ranks them. If the chain is
broken at the label, it is broken everywhere, and no amount of fine-tuning repairs it.

### What is actually salvageable

Most of it. The supervisor itself needs **three small corrections and one deletion**, not a
rewrite: `docs/reviews/` recommends below that the local model tier, the fine-tune programme and
Tier 2's per-tick model call are dropped, and that the default configuration (which currently
turns every actionable decision into a Telegram message answerable only from a shell) is
re-pointed at the hosted model. The target architecture in §9 is the existing tree with
`src/decision/ladder.ts`, `src/decision/needle.ts`, `finetune/` and `bench/runners/slate.ts`
deleted, and six edits in the modules that stay.

---

## 1. Is the supervisor-over-herdr shape right?

**The claim.** `docs/specs/2026-10-26-agent-fleet-design.md` §1 and §3: herdr is the only
observation and action boundary; polling `herdr agent list` every 60 s and diffing two integer
counters per pane is the cost gate the whole system rests on; a decision happens only for panes
whose `completion_seq` or `state_change_seq` advanced.

**Evidence for.** It is the cheapest correct thing measured. `README.md:64` records the tier-0
tick (21 panes, nothing moved, one `agent list`) at **0.094 s and 0 model calls**. I ran
`herdr agent list` against the live machine: **21 panes, 7,820 bytes, one call, O(1) in fleet
size**. Polling one endpoint does not get more expensive as the fleet grows; the alternatives
below do. The `HerdrPort` interface, the envelope-not-exception treatment of `agent_blocked`, and
the refusal to own PTYs are all correct and I found no way to break them.

**Evidence against — one counter, not two.** The design says two counters exist because they
distinguish meanings: "`completion_seq` bumps when a turn completes; `state_change_seq` bumps on
any lifecycle transition" (`src/fleet/detect.ts:6-8`). Live payload, all 21 panes:

```
completion_seq === state_change_seq: 21/21
delta sample: done c614 s614 | idle c449 s449 | idle c75 s75 | done c626 s626 | done c615 s615
```

The two counters advance in lockstep on every pane on this machine. So `detect`'s preference
order (`detect.ts:90-93`: `completionSeq > stateChangeSeq > status`) means the `state_change`
branch is unreachable in practice, and the design's central claim — that the pair lets you tell
"a turn completed" from "the pane merely went idle" — is unsupported by the payload it reads.
That distinction is load-bearing: `divergence` depends on being able to say a pane *stopped*
without a turn completing. Today it cannot.

**Evidence against — the two-counter fiction is not the only one.** `idleTicks` is computed as
`reason ? (resting(status) ? 1 : 0) : ...` (`detect.ts:96`). A moved pane that is resting
therefore always carries `idleTicks = 1`; `idleTicks = 0` is produced only by the `new` path and
by non-resting panes. Every one of the 502 benchmark rows pairs `status: idle` with
`idleTicks: 0` (appendix A1) — a combination the production detector emits only on a cold start.
The benchmark is therefore measuring the supervisor's first tick after a restart, 502 times
(see §2).

**The three alternatives, costed.**

*(a) A shared task queue the agents pull from.* This is not an alternative to the supervisor; it
is an alternative to the fleet. The panes are interactive `pi` sessions that the operator also
types into. A queue requires the worker to poll it, which means the worker's control loop changes
from "wait for a prompt" to "claim work" — i.e. the panes stop being the thing that exists today.
It also solves a different problem: the supervisor does not have work to distribute, it has
permission to grant. **Rejected for the work channel, adopted for the action channel**: the
existing `asks.jsonl` is already a durable, idempotent outbox with an id and an answer CLI, and
that is the correct shape for actions (§6).

*(b) herdr events instead of polling.* herdr protocol 22, read from `herdr api schema --json`:
`EventsSubscribeParams { subscriptions: [Subscription] }`, `EventsWaitParams { match_event,
timeout_ms }`, `EventKind` containing **`pane_agent_status_changed`**, `pane_agent_detected`,
`pane_output_changed`, `pane_exited`, and `SubscriptionEventEnvelope`. The event the supervisor
needs is published by the server it already talks to. The design says the wire contract is "small
and versioned (protocol 22)" — and then polls it.

Cost of taking it: `herdr api` exposes only `snapshot` and `schema`, so events require speaking
the socket directly (~150 lines plus a reconnect story), because the CLI-expressible form is
`herdr agent wait <pane> --until idle|blocked|done --timeout <ms>`, which is **N blocking
processes instead of 1 list** — strictly worse scaling than polling. Gain: no marks file, no
diffing state machine, no restart storm (§ below), and fresh observation.

**Recommendation: keep polling, do not take events yet, and delete the second counter.** The
measured reasons: tier 0 is 0.094 s and O(1) in fleet size; a 60 s-stale view of a pane that has
*stopped* costs the operator nothing, because the thing being waited on is an idle agent, not a
human; and the event path's real prize is architectural (removing stateful diffing), not
latency. That prize does not justify a socket client and a liveness story at 21 panes. Take
events at the point the marks file causes a real incident — the cold-start storm described next
is the candidate.

**The one polling defect worth fixing now.** `detect` on a missing or unreadable marks file
returns `{}` (`detect.ts:26-35`), which makes all 21 panes `new`, which makes 21 decisions in one
tick. At the shipped defaults that is 5.3 s of cold sidecar load plus 21 serialised inferences
(§4): **41.7-73.3 s of wall clock**, on every restart, re-deciding a fleet that is 17/21 idle
(live sample). `AGENTFLEET_DRY` avoids consuming marks but cannot avoid the storm after a crash.
Cost to fix: on a missing marks file, seed marks from the current list and decide nothing.

**What this section costs to change:** deleting `stateChangeSeq` from `Mark`/`HerdrAgent` and
from `detect`: one hour, touches `types.ts`, `cli.ts`, `detect.ts`, two tests. Seeding marks on a
cold start: 30 minutes.

---

## 2. Is the mined-label chain sound?

**The claim.** `mine/decision-points.ts:1-4` and `README.md:54`: a decision point is a completed
agent turn that a human then answered, so the state the agent left is the input and the human's
next instruction is the label. `src/labeling/label-to-op.ts` maps five labels to four ops and is
imported by both the benchmark and the fine-tune, so they cannot disagree.

**Where the chain breaks — four independent places, in order of severity.**

### 2.1 The label is a typography classifier, not a state classifier

`labelFor()` receives one argument: the human's message. It is applied in this order
(`mine/decision-points.ts:210-232`):

1. `STOP_PATTERN = /^(?:stop|halt|cancel|wait|hold on|nevermind|never mind)\b/i` → `stop` → `leave`
2. `CONTINUE_PATTERN` and `length < 80` → `continue` → `nudge`
3. `length > 200` → `new_task` → `flag`
4. `REDIRECT_PATTERN` (`instead|actually|no,|rather|change|switch|forget that|...`) → `nudge`
5. otherwise → `nudge`, `labelReason: "no explicit signal"`

Nothing in that function can see the fleet. So `expectedOp` is a function of how the human typed,
not of what the agent had done.

**The `new_task → flag` bucket is the clearest failure.** It is defined purely by
`text.length > NEW_TASK_MIN_CHARS = 200`; there is no topic-shift test anywhere in the miner.
It is 89 rows, 17.7% of the corpus. Sampled 10, verbatim openings:

```
[273] is the 70h powder from them worth it over chlorphine from syntharise?...
[254] seperate into grouped commits dont aim for a number js group my relevance, 2. idk if...
[312] okay so yes i want to do all that but maybe we can make a new folder as home/polycrawlerMarketing...
[279] we shuold also probably make this change rn to increase result characters from 8k to maybe 16k...
[592] okay great but lets run benchmarks on various tasks along the way please...
[338] okay great js make sure we are not messing with any data with the real pi stuff...
[1576] can we make sure please cause look: Sat 17 Oct 2026...
[647] do all with subagents and then come back and tell me where to move next...
[268] dont understand the program types thing, for where scanning originates how can we solve this...
[1327] okay sure, before we do that i wan tyou to fully go over current harness...
```

Ten of ten are **instructions to the same agent** — the strongest possible evidence that a
`nudge` was owed, since the text *is* the nudge. The label says the opposite: `flag`, meaning a
human must take over. The bucket inverts the semantics of the op it maps to, and it is the entire
`flag` class.

### 2.2 The `leave` class is 7 rows and at least 4 are wrong

The highest-priced cell in the regret matrix (`leave` predicted as anything else) rests on seven
rows. All seven, verbatim:

```
[28]  wait so what does this mean?                                    → "wait" → stop → leave
[53]  wait so what did you do here? full description please           → "wait" → stop → leave
[6]   cancel                                                          → stop
[6]   cancel                                                          → stop
[6]   cancel                                                          → stop
[153] cancel the run, lets js run a regular subagent through them pointed at the tools in the
      visionHelper harness and let it benested so it can call others   → stop
[62]  wait what so lets test it out on some stuff in this chat js rq   → "wait" → stop → leave
```

Rows 1, 2 and 7 are questions or instructions addressed to the agent (`what does this mean?`,
`full description please`, `lets test it out`) — the pane must answer, which is a `nudge`. Row 6
opens with `cancel` and then issues a new task. Three rows (`cancel` ×3) support `leave`.

So: at most 3/7 are clean, and the measurement "`leave` recall 0 on all 7 rows"
(`bench/results/NOTES-needle.md`) — the number the design calls "the one op worth 5 regret" — is
a statistic over a set that is ~57% mislabeled, produced by a `^wait\b` regex.

### 2.3 The population is conditioned on the human having spoken

This is the structural break, and it is not fixable by relabelling. `scanSession` only emits a
decision point when a `user` record passes `isHumanMessage` (`mine/decision-points.ts:255-272`).
Therefore every row has `P(human intervened) = 1`. The corpus cannot contain "the supervisor
should have left it alone", because such a moment has no human message and produces no pair.
`label-to-op.ts` acknowledges this in prose ("the data cannot contain a 'nobody had to intervene'
example") and then maps the fallback bucket to `nudge` anyway, which trains a supervisor that
always acts.

The consequence is measurable. `leave` is 7/502 = 1.4% of the corpus and 71% of a real fleet is
idle at any instant (live sample: 17 idle + 4 done of 21). **The corpus's class distribution is
the inverse of the deployment's.**

### 2.4 The state block is a reconstruction that contradicts its own label

`bench/tasks/from-captures.ts:69-84` builds the input. Cardinalities across all 502 rows
(appendix A1):

| field | distinct values | value |
|---|---|---|
| `status` | 1 | `idle` |
| `claimState` | 1 | `working` |
| `idleTicks` | 1 | `0` |
| `acceptance` | 1 | absent |
| `phase` | 4 | `unknown` 316, `implement` 70, `verify` 68, `research` 48 |
| `cwd` | 15 | `/home/andrew` 282 (56%), `/home` 80, `toolInterfacer` 45 |
| `title`, `last`, `tail` | ~unique | the only varying evidence |

Four of twelve fields are constants, and `phase` is itself derived from the same tail
(`from-captures.ts:44-51` applies `TEST_TOOL`/`MUTATE_TOOL`/`SEARCH_TOOL` to the tool names that
`buildTail` then prints). So the model's evidence is one field.

Now the contradiction. `claimState: "working"` is hard-coded. The extension that writes real
claims cannot produce it at this moment: `ClaimState.endTurn()` sets state to `"done"` or
`"waiting"` (`ext/pi-fleet/src/state.ts:88-96`) and `BLANK.state` is `"waiting"`. A session that
finished a turn and is waiting for a human is `waiting` or `done`, never `working`. And
`status: idle` + `claimState: working` is precisely the `divergence` trigger signature
(`triggers.ts:65-73`).

This is the mechanistic explanation of the GLM record: the model reads "claims working, herdr says
idle, 0 idle ticks", concludes *it finished a turn, leave it*, and is scored wrong because the
human typed something. Its per-op recall confirms the direction — `{nudge: 0.4, flag: 0}` on 35
nudge and 5 flag rows: it never once predicted `flag`, and got only 14/35 nudges, with the rest
spread over `leave`/`declare_done`. **The model is being punished for correctly reading a state
block that was fabricated.**

### 2.5 So what is the benchmark measuring?

It measures: *given a state block of which one field carries information, predict which regex
bucket the human's next message would have fallen into.* Since 81% of buckets are the
no-pattern-matched fallback and 17.7% are a length threshold, the answer is essentially "guess
nudge, unless the human types a lot". That is why `always nudge` scores 0.8088.

**Can a model that scores well on it do anything useful in production?** No, and the reason is
independent of the scores:

> For 406 of 502 rows the correct `nudge` requires emitting the human's specific instruction,
> and that instruction is not in the input — it *is* the label. The benchmark scores only `op`,
> so a model can score 100% while producing a nudge that says nothing useful. The scored unit is
> not the delivered unit.

This is the deepest break and it is invisible to the harness. `TaskTrace`
(`bench/runners/run.ts:328-338`) records the argument string, but nothing scores it.

**Recommendation: change.** The op is salvageable; the label definition is not. Concretely:
`new_task` must stop being a length test (either add a topic-shift test or fold it into `nudge`),
`leave` needs a population that is not conditioned on human speech (§12 experiment 3), and the
benchmark must score the argument or admit it does not. Cost: the relabel is a half day plus a
re-mine; the population fix needs instrumentation that does not exist yet.

---

## 3. Is a four-op vocabulary enough, and is it right?

**The claim.** `src/decision/types.ts:1`: `leave | nudge | declare_done | flag`, exactly one per
moved agent, and the vocabulary is deliberately small so a supervisor "can never decide to go do
the work itself" (design §4).

**Evidence against — two of four ops are unrepresentable, and one is not an action.**

| op | corpus support | note |
|---|---|---|
| `nudge` | 406 (80.9%) | 89 of those are the length bucket (§2.1) |
| `flag` | 89 (17.7%) | **the entire class**, and 10/10 sampled are instructions |
| `leave` | 7 (1.4%) | ~3 clean (§2.2) |
| `declare_done` | **0** | no label maps to it; `label-to-op.ts` says so explicitly |

`declare_done` deserves separate treatment because it is not merely rare — **it is not an action.**
It writes the claim's state to `done` (`tick.ts:520-537`) and notifies. The claim is a report, not
a control path (design §2), so writing `done` changes what the supervisor believes and nothing
about the agent. Its only consumer is the next decision's `claimState` and the operator's view.
So the model is being asked to emit an op whose entire effect is a notification with a side effect
on a file the supervisor owns.

Worse, the signal that *would* justify it already exists without a model:
`isCompletionText()` in `ext/pi-fleet/src/derive.ts:55-75` matches anchored completion phrases
(`done`, `shipped`, `all set`, `that's it`, `ready to ship`, …) against the last line of the
assistant message and sets `state: "done"`. The worker already knows. The supervisor asking a
model to guess what the worker already computed is a duplicate opinion — the exact failure design
§2 rejects for `phase`.

**What vocabulary is actually learnable from this corpus?** Three classes, and one of them is not
the one the design has:

- `nudge` with an *unknowable* argument (406 rows) — learnable as a class, useless as a message (§2.5).
- `answer` — the pane asked a question and is waiting on a yes. 71 `continue` rows are the human
  answering, and the argument is generatable without knowing the human's text ("yes, proceed").
  This is the design's own motivating example ("the agent asked a question and wants a yes",
  design §"The problem") and the vocabulary has no op for it — it is smeared into `nudge`.
- `leave` — only 7 rows, so not learnable here, but it is the op that matters operationally.

**What the supervisor loses by shrinking to three.** Dropping `declare_done` loses the ability to
mark acceptance in the claim; that capability should move to the supervisor *reading* the
extension's `done` state and reporting it, not asking a model. Dropping `flag` as a model output
loses nothing, because at runtime `flag` is already the parse-failure/refusal class
(`types.ts:70-77` maps every unparseable or refused answer to `flag` with `refused: true`) — the
supervisor cannot currently distinguish "the model chose flag" from "the model failed".

**Recommendation: change, minimally.** Vocabulary becomes
`leave | answer | nudge | flag`, where `answer` is the generic-affirmative op, `declare_done`
leaves the model's vocabulary and becomes a supervisor-side report derived from the claim's own
`state`, and `flag` is documented as the refusal class rather than a decision. The 3-op tool
catalogue is also what `finetune/slate.json`'s `triage` variant already tried to express — its
description says the scope difference "is only in the grammar" — so the grammar change is a
one-line edit in `finetune/tools.py`.

**Cost of changing:** the vocabulary is 4 tool schemas (`finetune/out/tools.json`) + `OPS` +
`LABEL_TO_OP` + two fixtures. Two hours of code, plus a corpus relabel for `new_task` (§2.1). The
risk is that this invalidates every existing record, which is why §10 puts it after the baselines
are added.

---

## 4. Is the escalation ladder justified?

**The claim.** Design §4 and `README.md:60-68`: the marginal decision is trivial, a local $0
primary answers most of them, and the hosted model is consulted only below
`AGENTFLEET_THRESHOLD` (default 0.7), once.

**The measured reality.** The local primary refuses **22/22 at confidence ≈ 0.03**, coverage is
**0.0 at every threshold 0.3–0.9** (`bench/results/2026-10-27T00-43-19-911Z__needle3.json`:
`coverageAtThreshold {0.3:0, 0.5:0, 0.7:0, 0.9:0}`), so the ladder escalates **100% of rows**. Its
refusals are honest model output, not an adapter artefact. Therefore:

> **The local tier saves exactly $0.00 per day, because it never answers anything.** Its only
> effect on the system is latency.

Two further measured facts make it worse than a no-op:

1. **It serialises.** `src/decision/needle.ts:1-4`: "Calls are serialised — one engine, one
   inference at a time — which is correct even though it caps throughput at ~1 decision per
   1.5s." They meant "safe", not "correct": the hosted adapter gets 4-way concurrency free
   (`AGENTFLEET_CONCURRENCY` default 4, `config.ts:132`), the sidecar gets a mutex. So the local
   tier is *architecturally worse at concurrency than the cloud tier it is supposed to spare*.
2. **It is cold on every tick.** `needleModel()` defaults `idleMs: 2_000` (`needle.ts:270`) and
   the sidecar is killed after 2 s without work (`needle.ts:165-180`). With a 60 s tick, every
   tick starts a fresh process: **~5.3 s of load before the first inference** ("The sidecar
   exists to avoid a 5.3s load per decision", `needle.ts:40-42`; `needle_sidecar.py:4` says ~5 s).
   The committed p50 of 2023 ms is a *warm* number.

### Cost per day, 18 agents on a 60 s tick

Decisions/day = 18 × 1440 / cycle. Measured cycle from the miner's own timestamps (404
consecutive decision-point gaps over 80 sessions, appendix A4): **p50 4.14 min, p75 12.88 min** →
**2,012 to 6,261 decisions/day**. Both columns below.

| option | $/day @2,012 | $/day @6,261 | p50 latency / decision | tick wall clock, 18 movers | cost of the failure mode |
|---|---|---|---|---|---|
| **needle-primary** (shipped default: `primary: needle3`, `escalator: z-ai/glm-5.3-flash`, `threshold: 0.7`) | **0.4575** | **1.4238** | **8.89 s** (5.3 cold + 2.023 + 1.568) | **41.7 s** @2023 ms; **73.3 s** @3776 ms | venv missing ⇒ degraded; sidecar timeout 30 s ⇒ refusal; serialised tick |
| **GLM-primary** | 0.4575 | 1.4238 | 1.568 s | 7.1 s (4-way) | OpenRouter outage ⇒ no supervision |
| **GLM-primary + needle as offline fallback** | 0.4575 | 1.4238 | 1.568 s | 7.1 s | as above; fallback returns `flag` = "needs you", which is the *correct* degraded behaviour |
| **no local model at all** | 0.4575 | 1.4238 | 1.568 s | 7.1 s | as above |

**The dollars are identical in all four rows.** The local tier cannot save money because it never
answers. On a modal tick (one pane moved — the common case on a 17/21-idle fleet) the shipped
default pays **7.32 s of extra wall clock per decision**, of which 5.3 s is loading a model in
order to be refused by it.

And the tick loop compounds it: `main()` awaits `setTimeout(intervalMs)` **after** the tick
completes (`tick.ts:697-700`), so the real period is *tick + 60 s*. A 41.7 s tick makes the
supervisor a 101.7 s supervisor. `README.md` already knows this and says so: "Do NOT run this with
an empty marks file on a 21-pane machine unless you want all 21 decided: decisions are serialised
behind one engine and the tick then takes about a minute."

**Is the fine-tune an optimisation of a path that should not exist?** Yes. Its whole prize is
≤ **$1.4238/day** and **574 ms/decision** (`control-d8` p50 994 ms at 8 layers vs GLM 1568 ms —
`bench/results/2026-10-26T23-24-18-841Z__slate-control-d8.json`). The cheapest hosted model in
`src/decision/openrouter.ts` that has never been measured, `z-ai/glm-flash-latest`, is **3.63×
cheaper on input and 6.60× cheaper on output** than the measured one (0.0413/0.0758 vs
0.15/0.50 per M) — one benchmark run would tell you whether a ~$0.13/day supervisor is adequate,
against a 5.5-hour-per-variant fine-tune.

**Recommendation: drop the ladder.** One model, one call, no `LadderOptions`, no `trail`. Keep
`needle.ts` only if an offline path is wanted, and then wire it as the *escalator's fallback*
(GLM-primary, needle when the network is down), where its refusal-into-`flag` behaviour is
exactly right: it turns an outage into "I need you" instead of silence.

**Cost of changing:** delete `src/decision/ladder.ts` (49 lines), change
`buildLadderModels`/`decideWithEscalation` call sites in `tick.ts`, move the `first.op !== last.op`
fork predicate (§6). ~2 hours, and `test/ladder.test.ts` goes with it. The fine-tune tree
(`finetune/`, `bench/runners/slate.ts`, 0 of 4 variants on disk per `bench/results/SLATE.md`) is
deleted or archived: it costs 21.9 h of box time for 4 variants (§7) to chase $1.42/day.

---

## 5. Is Tier 2 worth it?

**The claim.** `README.md:65-67`, `src/manager/inspector.ts:1-14`: a cross-agent trigger is a
question, not an announcement; one bounded brief (≤6000 chars) and one escalator call per
trigger, capped at 2/tick in severity order, produce a finding that is notified; a finding's
proposal is re-gated.

**Evidence against — the deliverables are thin and the costs are not.**

1. **It has no ground truth and has never been scored.** Design's own "Not yet measured" list:
   "whether an inspector finding is right about a group (no ground truth, no record)". There is
   no `bench/results` record containing the string `inspector`. So Tier 2 is the only component
   in the system making model calls with no measurement at all — against a repository whose
   stated rule is "measured over asserted".
2. **It has no prompt of its own.** `inspectCheap()` calls `ctx.model.decide(...)`
   (`inspector.ts`, `inspectCheap`, line 521 at the time of writing — this file is being edited
   concurrently, so cite the function, not the line) — the same `DecisionModel`, therefore the same
   `SYSTEM` from `src/decision/prompt.ts`, which opens "You supervise one unattended coding agent.
   **Pick exactly one action.**" The brief is stuffed into the `brief:` field and `CHEAP_TASK`
   appended. So Tier 2 is Tier 1 with a longer input, a contradictory system prompt, and the
   model's `argument` relabelled as a "diagnosis". Its quality ceiling is the decision model's,
   which is measured at 0.35 exact / 0.1739 accuracy above threshold.
3. **It sends a self-contradictory state block.** `cheapInput()` (same file, line 307) sets
   `status` from the *first named pane*, `idleTicks: 0`, `tail: ""`, and then a 6-pane brief. The
   model is told one pane's status and handed six panes' evidence.
4. **It costs more than a decision.** 6,000-char brief ≈ 2,167 prompt tokens at the 3.2
   chars/token the repo measured → **$0.000385/inspection = 1.69× the measured
   $0.0002274/decision**.
5. **Its most common trigger is not an anomaly — it is the steady state.** `collisions()`
   (`src/fleet/groups.ts:44-56`) buckets by exact resolved cwd among panes with
   `status === "working"`, requiring ≥2. Live sample: **15 of 21 panes share `/home/andrew`**
   exactly. So the collision predicate is "two agents in the home directory are working at the
   same instant", and its frequency is:

   | fraction of time a pane is working | P(≥2 of 15 working) |
   |---|---|
   | 0.05 | 0.171 |
   | 0.10 | 0.451 |
   | 0.15 | 0.681 |
   | 0.20 | **0.833** |

   At a plausible 10-20% duty cycle the `$HOME` collision fires on **45-83% of ticks** — 648 to
   1,195 inspections/day = **$0.25-$0.46/day**, and the 2/tick cap permits **$1.11/day**. Tier 2
   then costs 55-100% of Tier 1 while producing prose.

   This is also an internal contradiction in the design: `groupOf()` deliberately maps `$HOME` to
   a single `"home"` bucket *because* "over half a real fleet lives there and would otherwise
   collapse into one meaningless bucket" (`groups.ts:1-4`), and then `collisions()` buckets on
   the raw resolved path, so the exact bucket that was excluded from grouping is the one that
   generates the most triggers.

**Could the four predicates be acted on directly?** Yes — every one already has a predetermined
response, and the inspector does not change it:

| trigger | what the code does with `inspector: off` | what a diagnosis adds |
|---|---|---|
| `blocked` | notify "it needs you" (`tick.ts:586`) | nothing: the agent cannot free itself, a human must act |
| `collision` | notify group + pane list; already a **hard fork** in `ask.ts:113-120`, so nudges in that group are held | which files? The model cannot see them — it sees a 6-pane terminal brief |
| `divergence` | notify "claims X, herdr says resting N ticks" | the detail string already says exactly that (`triggers.ts:70`) |
| `churn` | log-only, unchanged | a sentence, on a condition that is 2 repeated turns |

**Recommendation: change, and it is nearly free.** `AGENTFLEET_INSPECTOR` default becomes `off`
(the tick already handles it: triggers are notified, `churn` stays log-only), and `deep` — a
bounded `pi -p` child with bash and read-only herdr, 120 s — becomes an **operator-invoked verb**,
not a per-tick spend. That also settles a live inconsistency: `cheap` is the default and returns
a degraded finding whenever `OPENROUTER_API_KEY` is unset, which the design's own changes section
admits "means Tier 2 does nothing at all on this box today."

**Cost of changing:** one default in `config.ts:129`, one test. The `inspector.ts` module stays
(the `deep` path is the only place the system does anything the per-pane decision structurally
cannot). Deleting the `cheap` path is ~120 lines.

**Separately, the collision fix is worth more than Tier 2.** Two agents in `$HOME` are not about
to stomp each other — they are in different repos under a parent directory. Changing
`collisions()` to key on `groupOf()` and skip `"home"` removes the false-positive trigger
entirely: 30 minutes, and it removes 45-83% of all triggers along with the `fork` that they cause.

---

## 6. Is the ask gate at the right granularity?

**The claim.** `src/manager/ask.ts` + `config.ts:1-26`: `never | fork | often | always`, per-group
overrides in `<state>/policy.json`, default `fork`. Five fork predicates: (a) the two models
disagreed, (b) `declare_done`, (c) collision/churn names this pane, (d) nudge too long or leaves
its tree, (e) at the prompt cap. `flag` is deliberately not gated.

**The axis is fine; the default is fatal, and the channel is inert.**

**a) The default configuration never acts.** Fork predicate (a) is
`first.op !== last.op` (`ask.ts:108-111`), where `first` is the primary's answer and `last` the
escalator's. With `primary: needle3` the primary always refuses → `op: "flag"`. The escalator
then answers `nudge`. The two ops differ, so **every actionable decision is a hard fork**, and
`shouldAsk("fork", …)` holds it. The shipped defaults (`config.ts:127-133`) therefore compose
into: the supervisor decides nothing and sends a Telegram message about every pane that moved.

That is not a tuning problem, it is a composition failure between two changes that were each
individually correct. Fix: predicate (a) must mean "two *confident, competent* models disagreed".
A refusal is a routing fact about the ladder, not a risk property of the decision. Once the
ladder is dropped (§4) the predicate has nothing to compare and should be deleted.

**b) The answer channel is slower than the thing it gates.** Measured decision-point cycle
**p50 4.14 min**; `answer.ts` is a shell command and `README.md:117` states "Telegram replies are
not polled yet". So a held action waits for the operator to reach a terminal — minutes to hours,
against a pane that moves every ~4 minutes. In practice `fork` means "drop it, tell me later", and
that is indistinguishable from `never` except for the notification. This is the binding constraint
on the whole gate, and it is worth more than any new axis: **nothing about the four-level policy
matters until the notification can be answered from the notification.**

**c) Do the predicates measure risk?** (b) `declare_done` and (c) collision/churn are genuine
risk predicates. (d) `argument.length > 300` and path-escape (`ask.ts:145-152`) are genuine — and
the path-escape check is careful work (`escapesTree` resolves against the *pane's* cwd, not the
supervisor's). (e) is a budget predicate wearing a fork's clothes. (a), as above, is not a risk
predicate at all.

**d) What the operator actually wants that is missing.** Ranked by how often it would bind:
1. **A channel that works** (§b) — without it there is nothing to tune.
2. **An action budget** — `maxPromptsPerTick: 3` is a per-tick cap; there is no per-day cap on
   prompts, dollars, or notifications. A churning fleet can prompt 3/tick = 4,320/day.
3. Per-group autonomy already exists: `askByGroup {agentFleet: "never", home: "always"}` gives
   exactly "these groups may be acted on, those need approval". That axis is adequate and should
   be kept as-is.
4. Time windows — no measurement supports them, and there is no evidence the operator wants a
   quiet fleet at 3am. Defer.

**e) One small contradiction.** `flag` skips the gate entirely (`tick.ts:509-515`), which is
right, and `shouldAsk` still has a `case "always"` branch returning `ask: true` for `flag` — dead
code reachable only if the caller changes. Also `report.promptsSent += 1` precedes the
`disposition === "rejected"` check (`tick.ts:552-556`), so a prompt that herdr refused consumes a
slot of `maxPromptsPerTick = 3`; on a fleet with several blocked panes the tick budget is spent on
rejections.

**Recommendation: keep the axis, change the default behaviour.** Delete predicate (a) with the
ladder, add a per-day action cap, and treat Telegram reply-polling as a precondition for running
`fork` at all. **Cost:** predicate (a) is 4 lines; the daily cap is ~20 lines in `tick.ts` plus a
counter in `events.jsonl`; the channel is the only real work, half a day.

---

## 7. Does the corpus justify fine-tuning at all?

**Case for.**

- The corpus is genuine work, not invented examples: 502 pairs mined from 80 real sessions, and
  the task shape (read a bounded state block, emit one of a small vocabulary) is a good fit for a
  1024-token window with a 333-token prefix.
- 452 usable rows, 26 steps/epoch, **63.2 s/step at `--max-len 640`** → **27.4 min/epoch**
  (`bench/results/NOTES-needle.md` step-rate table; 30.6 min against the 29-step plan). Twelve
  epochs is **5.5 h** — an overnight run on one box, not a project.
- The reward is real if it lands: `control-d8` at 8 layers runs **p50 994 ms** against GLM's
  1568 ms, so a working local engine would be the *fastest* tier, not the cheapest one.
- It removes a third-party dependency for the operator's own terminal contents, which is the only
  argument here that survives the cost analysis in §4.

**Case against — five things, in ascending order of force.**

1. **Zero training targets for one of four output classes.** `finetune/out/slate/d4/data.json`:
   `perOp {nudge: 366, flag: 79, leave: 7}` — and the tool catalogue hands the model
   `declare_done` anyway (`finetune/out/tools.json` has 4 tools). That is not a missing class, it
   is an **unconstrained output class**: the decode grammar can emit an op with no training
   signal at all (§3).
2. **The val split leaks.** `finetune/dataset.ts:355-363` splits by `stableHash(example.query)`
   per row, with no session grouping, over **80 sessions / 502 rows** (mean 6.3 rows/session)
   whose `cwd` takes 15 values and whose `intent` takes 15. Sibling rows from one session land on
   both sides, so val loss is optimistic by an unknown amount. `valFraction` 0.1 → 45 rows.
3. **The window forced the evidence out.** Fitting 640 halved the terminal tail: **251 → 114
   chars per row** (`NOTES-needle.md`, stated plainly there as "the cost of the shorter window").
   A decision whose job is to read a terminal now reads 114 characters of it. The prefix
   compaction (403 → 333 tokens) was good work that bought back 9%, but the constraint itself is
   the model.
4. **The base model will not emit tool calls, and 452 rows at rank 16 will not teach it.** Measured
   refusal 22/22 at confidence ≈ 0.03 on every prompt variant tried, including after the prefix
   was compacted (identical score, `NOTES-needle.md` adapter table). First-epoch loss 0.6853 is a
   model learning the target *format*, and `NOTES-needle.md` says the quiet part: "a refusal-heavy
   local run cannot distinguish a compact prompt from a broken one."
5. **The prize is ≤$1.42/day and the baseline it must beat does not exist.** No variant has been
   shown to beat `always nudge` (0.8088 exact on the full corpus) or even `always flag` (which
   `needle3` and `control-d8` both fail to beat, §Verdict). Optimising a model against a
   benchmark whose degenerate baseline wins is not a fine-tuning problem.

**Verdict: drop it.** Not "defer it". The gate should be a property of the corpus, not a date:
**do not re-open the fine-tune until the corpus has ≥3 populated classes, the majority class is
below 60%, and *some* model — any model — beats `always <majority>` by a margin larger than the
run-to-run wobble `SLATE.md` itself measured (three runs of the same archive spanning 37/40 to
40/40 refusals).** All three are cheap to check and none of them is true today. Keep
`finetune/dataset.ts` and `finetune/measure_window.py` — they are the corpus instrument, and
`measure_window.py` is the only thing in the repo that counts tokens with the engine's own
tokenizer.

---

## 8. What I could not falsify

I tried the following and each attempt failed, which is the honest basis for keeping those parts.

1. **Workers write their own claims; the supervisor only reads them.** I could not falsify the
   inversion itself: the supervisor has no way to know a session's intent or acceptance criteria,
   and the alternative (infer it from the terminal tail) would produce two disagreeing opinions
   with no way to attribute either. **But the design statement is false in one path**, and the
   review should record it: `tick.ts:520-537` writes a claim with `state: "done"` on
   `declare_done`, and `applyFinding` does the same for an inspector proposal. So "the agent says
   it is done" and "the supervisor decided it was done" are the same bytes, which is the rejected
   design's failure mode returning through the action channel. Fix: an `author` field on `Claim`,
   or stop writing and report instead (§3). One hour.
2. **One decision per moved pane is the right cost unit.** I could not falsify it. The
   alternative (a rules engine, no model) has to read the same tail, and the model call costs
   $0.0002274. The cost argument for a second tier collapses (§4), but the argument for *a* model
   call per move holds.
3. **The regret matrix is the right way to weight ops.** I could not falsify the *weights*; I did
   falsify the *matrix*, which is not square (below). No argument I could construct makes
   `leave → nudge` cheaper than 5 or `flag → nudge` dearer than 1.
4. **The watchdog's structural process definition.** I read `src/watchdog/rules.ts` and did not
   test it against a live process table; no claim in this review rests on it.
5. **`parseDecision`'s refuse-to-act behaviour.** Unfalsifiable in the good sense: it maps every
   unparseable answer to `flag` with `refused: true`, and there is no path where a supervisor acts
   on an op it did not parse. That is the single most defensible design decision in the repo.

**And one thing I found while trying, which is not an attempt that failed but a structural defect
in the metric itself.**

`REGRET` in `bench/runners/run.ts:26-31` is typed `Record<Op, Record<Exclude<Op, "leave">, number>>`
— the outer rows have **no `leave` column**. `regretOf` therefore returns 0 for any prediction of
`leave` (`run.ts:33-38`). Consequences, computed in appendix A2:

| policy | exact | regret/total | regret/task |
|---|---|---|---|
| `always leave`, full corpus | 0.0139 | **0** | **0.0000** |
| `always leave`, 40-row subset | 0.1750 | 0 | 0.0000 |
| `always leave`, 22-row subset | 0.3182 | 0 | 0.0000 |

**The do-nothing policy is the exact optimum of the stated objective, on every subset.** The design
says this is deliberate ("Under-reacting is not priced in the `nudge` and `flag` rows"), but the
effect is that the repository's headline metric — `regret.perTask`, the number every record
carries and every review would quote — ranks a supervisor that never acts above every model ever
measured. `exactMatch` is the only metric here that is not gamed, and it is gamed by `always
nudge` at 0.8088.

This is the second-weakest link and it is the cheapest to fix: add the `leave` column to the two
rows that lack it, then re-derive. Cost: ~6 lines in `run.ts`, and every historical record's
`regret` becomes incomparable — which is the correct outcome, because the numbers were wrong.

**Limits of this review.** (i) I reconstructed the GLM record's 40-row subset from
`git show 490bfc2^:bench/runners/run.ts` (stride `i % floor(502/40) === 0`, sliced to 40), because
that record predates the stratified sampler and carries no `coverage` block; my sampler
re-implementation is validated by reproducing the 22-row and 40-row `sampledPerOp` exactly, but
the pre-stratification subset is a reconstruction. (ii) The GLM record and the `control-d8` record
have **no trace files** — traces were added in `4c19420`/`490bfc2` and only the `needle3` records
have them — so the two numbers this review leans on hardest cannot be explained row-by-row. (iii)
`w` (per-pane working duty cycle) is unmeasured; the collision-frequency table is a model, not a
measurement, and §12 gives the experiment. (iv) I did not verify that `herdr agent list`'s 21
panes are the same 21 the operator means by "20 live panes".

---

## 9. Recommended target architecture

**Survives unchanged:** `src/herdr/*` (the boundary is right — keep the envelope handling, drop
`stateChangeSeq`), `src/fleet/registry.ts`, `src/fleet/detect.ts` (one counter + status),
`src/notify/`, `src/manager/answer.ts`, `src/manager/tick.ts` (shape), `src/manager/config.ts`,
`src/watchdog/`, `src/decision/prompt.ts`, `src/decision/types.ts`, `src/decision/openrouter.ts`.
`bench/runners/run.ts` survives and gains the baseline rows.

**Survives with one edit each:**

| module | edit | why |
|---|---|---|
| `src/fleet/groups.ts` | `collisions()` keys on `groupOf()` and skips `"home"` | removes 45-83% of all triggers (§5) |
| `src/manager/ask.ts` | delete fork (a); keep (b)-(e) | (a) is constant-true under a refusing primary (§6) |
| `src/labeling/label-to-op.ts` | `new_task` stops being a length test | 10/10 sampled are instructions (§2.1) |
| `bench/runners/run.ts` | add `leave` column; score `always nudge`/`always flag`/`always leave` as models | the metric's degenerate optimum and the corpus's baseline (§8) |
| `src/manager/tick.ts` | seed marks on cold start; stop writing claims on `declare_done`; count a rejected prompt as not-sent | storm (§1), false audit trail (§8), cap waste (§6) |
| `ext/pi-fleet/src/writer.ts` | append one line per state transition to `~/.pi/agent/fleet/history/<pane>.jsonl` | the only possible `declare_done` ground truth (§12 exp. 3) |

**Replaced or deleted:**

| removed | replaced by |
|---|---|
| `src/decision/ladder.ts` | nothing. One call, one model, no trail (§4) |
| `src/decision/needle.ts`, `needle_sidecar.py` | retained *only* as an offline fallback wired behind the hosted adapter; its refusal→`flag` behaviour is the correct outage behaviour |
| `finetune/` except `dataset.ts` + `measure_window.py` | nothing. Gate re-entry on §7's three conditions |
| `bench/runners/slate.ts` | nothing (it scored variants that do not exist: 0 of 4 on disk) |
| `src/manager/inspector.ts` `cheap` path | `off` becomes the default; `deep` becomes an operator-invoked verb |
| `declare_done` as a model op | a supervisor report derived from the claim's own `state` (§3) |
| `stateChangeSeq` | one counter (§1) |

**Order — cheapest decisive first.** Each step is independently useful and none requires the
next.

1. **Add the baselines to the bench** (1 h). Score `always nudge` / `always flag` / `always leave`
   as models over the same subsets and commit the records. Every existing number is recontextualised
   immediately; you cannot un-see 0.8088.
2. **Add the `leave` column to `REGRET` and re-derive** (1 h). Accept that historical `regret`
   values are void.
3. **Re-point the defaults and delete the ladder** (§4: primary → `z-ai/glm-5.3-flash`,
   `inspector` → `off`, delete `ladder.ts` + `needle.ts` from the hot path). ~2 h. This alone
   removes 7.32 s/decision, the 41.7-73.3 s tick, the venv dependency, and the total-paralysis
   composition in §6a.
4. **Delete fork (a)** (15 min). The gate starts acting again.
5. **Fix `collisions()`** (30 min). Triggers drop by up to 83%; `fork` stops holding nudges that a
   `$HOME` neighbour caused.
6. **Stop writing claims from the supervisor; add `author`** (1 h). Restores the audit property
   the design claims.
7. **Instrument claims** (§12 exp. 3) and run the fleet for a day (1 day of wall clock, ~10 lines
   of code). This is the cheapest way to find out what the supervisor's real decision distribution
   is, and it is the *only* way to ever get a `declare_done` label.
8. **Make asks answerable from Telegram** (half a day). Until this exists, `fork` is decorative.
9. **Then, and only then, reconsider any local model** — against step 1's baselines and step 7's
   corpus.

Steps 1-6 are under a working day and remove the ladder, the fine-tune's justification, Tier 2's
per-tick spend, and the gate's paralysis. That is the smallest set that fixes the weakest links.

---

## 10. Cheapest decisive experiments

| # | open question | one measurement that settles it | cost |
|---|---|---|---|
| 1 | Does *any* model beat the corpus's own majority class? | Add the three constant policies as scored rows in `bench/runners/run.ts`; recompute each existing record's subset. | 1 h, $0 |
| 2 | Is the only cloud number comparable to the others? | Re-run `bench` on `openrouter:z-ai/glm-5.3-flash` at the **current** stratified 40-row set (it was measured on the pre-`490bfc2` stride, `n=40`, subset `{nudge 35, flag 5}`, no `leave`). Then the same for `z-ai/glm-flash-latest`, which is 3.63× cheaper and has never been run. | ~80 calls, ≈$0.02, ~3 min |
| 3 | Can `declare_done` ever be learned? | Append one line per claim state transition to a per-pane jsonl in `ext/pi-fleet/src/writer.ts`; run the fleet a day; count transitions into `done` and how often the human's next message contradicts one. | 10 lines, 1 day wall clock, $0 |
| 4 | What is the real tick arithmetic? | Poll `herdr agent list` + `agent read` every 60 s for an hour (no model calls) and record the histogram of movers/tick and the per-pane working duty cycle. This replaces the cycle model in §4 and the `w` assumption in §5 with observations. | 1 h of shell + ~60 s of CPU |
| 5 | Is the variant 22/22 refusal a grammar problem or a weights problem? | The traces already exist but drop `decision.raw`. Add `raw` to `TaskTrace` (`run.ts:328`) and re-run one `needle3` record; the sidecar's `reasoning` field is the only evidence that distinguishes "the grammar will not emit" from "the model declines". | 20 min, $0, 22 calls |
| 6 | Is the op the deliverable, or the argument? | Replay ~30 historical nudge rows against a live agent twice: generic nudge ("you stopped mid-`implement`; continue or say what blocks you") vs the human's own text; score whether the agent resumes correctly. This is the only experiment that tests §2.5, and nothing in the repo can answer it. | ~2 h of agent time, needs a replay harness |
| 7 | Does Tier 2 produce anything an operator acts on? | Run a day at `inspector: off` and a day at `cheap`; count notifications that led to an operator action. | 2 days wall clock, ≤$0.46 |
| 8 | Does a cold start actually storm? | Delete the marks file and run one tick with `AGENTFLEET_DRY=1`; compare `report.moved` and wall clock against a warm tick. | 2 min, $0 |

Experiments 1, 2, 4, 5 and 8 cost under two hours combined and would settle, between them, whether
the benchmark has signal, whether the cloud tier is even the model you think it is, what the fleet's
real load looks like, and whether the local engine is broken or merely untrained.

---

## Appendix — the values this review is built on

### A1. Corpus shape (`mine/out/decision-points.jsonl`, `bench/tasks/tasks.jsonl`)

```
rows 502, sessions 80
labels: new_task 89, continue 71, nudge 323, redirect 12, stop 7
human-message length p10/p50/p90/p99/max = 8 / 67 / 326 / 1576 / 2000
  >200 chars: 89   80-200: 143   <80: 270
field cardinality over 502 task inputs:
  status 1 (idle)   claimState 1 (working)   idleTicks 1 (0)   acceptance 1 (absent)
  phase 4 (unknown 316, implement 70, verify 68, research 48)   cwd 15 (/home/andrew 282)
tail chars p10/p50/p90/max = 773 / 1607 / 2320 / 2491 ; 417 tails contain a tool-call line
phase→expectedOp: unknown→nudge 261, verify→nudge 53, implement→nudge 52, research→nudge 40,
                  implement→flag 18, unknown→flag 51, verify→flag 12, research→flag 8,
                  unknown→leave 4, verify→leave 3
```

### A2. Constant-policy baselines (computed, `bench/runners/run.ts` + `sampleStratified`)

```
full corpus (502)          always nudge  exact 0.8088  regret 124  perTask 0.2470
                           always flag   exact 0.1773  regret 420  perTask 0.8367
                           always leave  exact 0.0139  regret   0  perTask 0.0000
                           always done   exact 0.0000  regret 1741 perTask 3.4681
stratified 40 {nudge 26, flag 7, leave 7}   nudge .6500/1.0500  flag .1750/1.0000  leave .1750/0
stratified 22 {nudge 12, leave 7, flag 3}   nudge .5455/1.7273  flag .1364/1.1818  leave .3182/0
pre-stratification 40 (reconstructed) {nudge 35, flag 5}
                                            nudge .8750/0.1250  flag .1250/0.8750  leave .0000/0
```

`always flag` on the 22-row subset = `{exact 0.1364, regretTotal 26, perTask 1.1818}`, which is
`bench/results/2026-10-27T00-43-19-911Z__needle3.json` verbatim.

### A3. Every record in `bench/results/`

| record | n | exact | refusals | p50 ms | p95 ms | $/1k | subset |
|---|---|---|---|---|---|---|---|
| `21-47-52__needle3` | 20 | 0.2500 | 20 | 30004 | 224764 | 0 | not recorded |
| `21-59-25__openrouter_z-ai_glm-5.3-flash` | 40 | 0.3500 | 0 | 1568 | 2939 | 0.2274 | not recorded |
| `22-18-46__needle3` | 3 | 0.3333 | 3 | 30006 | 30014 | 0 | not recorded |
| `22-42-18__needle3` | 22 | 0.1364 | 22 | 6800 | 19469 | 0 | nudge 12 / leave 7 / flag 3 |
| `22-59-13__needle3` | 22 | 0.1364 | 22 | 3776 | 5416 | 0 | nudge 12 / leave 7 / flag 3 |
| `23-21-59__needle3` | 3 | 0.3333 | 3 | 30002 | 30009 | 0 | flag 1 / nudge 1 / leave 1 |
| `23-24-18__slate-control-d8` | 40 | 0.1500 | 37 | 994 | 1210 | 0 | nudge 26 / flag 7 / leave 7 |
| `00-22-33__needle3` | 22 | 0.1364 | 22 | 2374 | 12648 | 0 | nudge 12 / leave 7 / flag 3 |
| `00-43-19__needle3` | 22 | 0.1364 | 22 | 2023 | 3109 | 0 | nudge 12 / leave 7 / flag 3 |

GLM selective block: `coverageAtThreshold {0.3:1, 0.5:1, 0.7:0.575, 0.9:0.025}`,
`accuracyAtCoverage {0.3:0.35, 0.5:0.35, 0.7:0.1739, 0.9:0}`. **Above 0.7 confidence the hosted
model is 0.1739 accurate against its own 0.35 base rate** — the ladder's routing signal is
anti-correlated with correctness, so `AGENTFLEET_THRESHOLD = 0.7` accepts 57.5% of decisions at
half the accuracy of accepting all of them.

### A4. Measured cycle time (`mine/out/decision-points.jsonl`, consecutive points per session)

```
404 gaps over 80 sessions
min 0.10   p10 0.70   p25 1.42   p50 4.14   p75 12.88   p90 35.87   p99 195.31 min
mean 16.46 min ; gaps ≤1 min: 74 ; ≤5 min: 221 ; ≤10 min: 282
```

### A5. Live fleet (`herdr agent list`, read-only)

```
panes 21   statuses {idle 17, done 4, working 0}
completion_seq === state_change_seq: 21/21
distinct foreground_cwd: 7 ; /home/andrew 15 (71%), then 1 each
response size 7820 bytes, one call
```

### A6. Prices (`src/decision/openrouter.ts`, checked 2026-10-26)

```
z-ai/glm-5.3-flash        in 0.15   out 0.50   per M   ← the measured tier
z-ai/glm-5.3-flash:batch  in 0.05   out 0.18
z-ai/glm-5.3-flashx       in 0.37   out 1.25
z-ai/glm-5.3-prime        in 2.80   out 8.80
z-ai/glm-flash-latest     in 0.0413 out 0.0758  ← 3.63x/6.60x cheaper, never benchmarked
```

### A7. Repository state

```
npm test  → 196 pass, 0 fail, 1.77 s   (README.md:79 still says "187 tests")
npx tsc   → not re-run; the task states it is clean and no source was modified
git status at session start → untracked: finetune/epoch_train.py (the operator's live trainer)
bench/results/ → 9 records + 5 .traces.jsonl (needle3 only; GLM and control-d8 have none)
finetune/out/slate/*.cact → absent for d4, d8, d20, triage; control-d8 only
live fleet → 21 panes, 17 idle / 4 done (A5)
```

**Concurrent work, not mine.** Between 21:06 and 21:11 the untracked directory `src/metrics/`
appeared in the working tree (`schema.ts`, `store.ts`, `render.ts`, `report.ts`, ~75 KB). Something
else wrote it while this review was being read — most likely another session working the same
flock. It is untouched by this review and nothing in it is cited here. It is worth one remark only
because it is the right response to §8: `report.ts`'s own header names the questions
"is the local model worth its latency" and "what fraction of a trigger yields something
actionable", i.e. it is the instrument that would settle experiments 1, 4 and 7. If it lands
before step 3 of §9 does, steps 1, 2, 4 and 7 get cheaper.

No source file was modified by this review, and no other file was written. The only file this
review wrote is this one.
