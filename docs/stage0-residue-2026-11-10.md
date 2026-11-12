# Silence first: the rules as a baseline, and the model on the residue

2026-11-10. The architecture is: decide silence by rule, and spend a model only on what survives.
Two things follow from it that had not been measured — **how good the rules are on their own**, and
**what the model does once the rules have taken their share**. This is both, plus the mode that lets
the pair be observed on a live fleet without sending anything.

Nothing here retires the model. `src/decision/`, `finetune/` and the ladder all stay; the question
this document answers is what they are worth, not whether they should exist.

## Stage 0 is a contract, not a code path

Two stages, and the second one only ever sees what the first leaves:

```
stage 0   rules      is this pane in a state that ever needs a word?   deterministic, no labels
stage 1   model      only on rows stage 0 fired: what should the word be?
```

`src/watchdog/needs-a-word.ts` — `needsAWord(pane, samples) → {speak, rule, why}` — built on the
seven rules in `src/watchdog/rules.ts`. It adds exactly two things to them:

- **attribution**, structurally by each process's own working directory (`/proc/<pid>/cwd`), so a
  pane is judged on its own tree. Not ancestry: two panes in one directory both see the process, and
  that is the right answer for both, while attributing one pane's runaway to another is the failure
  that matters;
- **the second half of the verdict** — a process past its allowance that is still burning CPU is
  working rather than hung, so the answer for it is silence, and a *distinguishable* silence
  (`working: true`).

The seven rules it is built on are ordered, first match wins, and each carries its own `why`:

| rule | allowance | what it means |
|---|---|---|
| `inference-server` | forever | llama.cpp servers are long-lived; idle looks like hung |
| `idle-shell` | forever | a bare shell is a prompt, not a running command |
| `background-service` | forever | no tty, no agent above it → nobody is waiting |
| `infrastructure` | forever | pi, herdr, sshfs, systemd, docker, the watchers themselves |
| `agent-tui` | forever | an agent retitled its process; there is no command line to judge |
| `build` | 20 min | tsc/npm/pytest/cargo are legitimately slow |
| **`command`** | **5 min** | the catch-all: something is running and it is not a build |

Eligibility is structural, not a name list: a process counts as "a command" only if it is an
agent's descendant or a terminal's foreground job.

Every silent path returns the rule that permitted it and that rule's own sentence. A pane with
nothing running says so, and says which of those two facts it is. Ten tests pin the contract,
including that a working process in a pane does not mask a hung one beside it.

The detector is not a proposal. The rules caught a runaway command on a live fleet while the
decision model produced nothing — **the silence detector already existed, and it already worked.**

### The action contract: report, never stop

The rule is absolute: **the watchdog never stops, kills or signals anything.** A
flagged command gets exactly three things and there is no fourth:

1. **the owning agent is prompted** — with the command, its pid, its age, the rule and that rule's
   sentence, and in as many words that *the final decision is its own*;
2. **the operator is notified** of the same facts, and the message says the command is still running;
3. **the command carries on in the background**, untouched.

The contract is code, not prose: `WordAction` in `src/watchdog/needs-a-word.ts` carries
`signal: "none"` and `leavesRunning: true` as literals, because a boolean would be a switch waiting
for a caller. `wordActionFor` is the single author of both sentences.

What makes it structural rather than a habit is that there is no capability to misuse:

- `src/watchdog/` imports no `child_process`, spawns nothing, signals nothing and calls no
  `process.exit` — it reads `/proc` and prints;
- `HerdrPort` (`src/herdr/types.ts`) has exactly `list`, `get`, `read` and `prompt`. There is no
  `stop`, `close`, `kill` or `terminate` for a caller to reach for, so a fleet process cannot be
  stopped by this supervisor even by mistake;
- the op vocabulary has no stop op, so no model can propose one — `leave`, `nudge`, `declare_done`,
  `flag` are the whole of it.

`test/no-terminate.test.ts` pins all four absences against the source text, and it was verified the
way a guard should be: adding a `process.kill` to `src/watchdog/rules.ts` fails it, and removing it
passes. Four comments that say "never" are not a guarantee; a test that fails on the fifth commit is.

**Audit of every kill site in the repo**, for the record: `src/herdr/cli.ts`, `src/decision/pi.ts`,
`src/decision/needle.ts`, `src/fleet/start.ts`, `src/manager/inspector.ts`, `src/swarm/engine.ts`
and `finetune/timesteps.py` each kill a subprocess **the supervisor itself spawned**, behind a
deadline or on shutdown — the `herdr` CLI call, the `pi -p` inspector child, the needle python
sidecar, a conversation it started. None of them can reach a pane's command, none is on the watchdog
path, and the ones in the decision adapters are what stop a timed-out *request of the supervisor's* from hanging
the tick. They are left alone deliberately: removing them would leak the supervisor's own children and break the
deadline tests, and would not change the one thing the rule is about.

## The rules measured alone, on the mined corpus

`node bench/runners/stage0.ts` → 1,363 points, **1,073 scorable**, 292 sessions, window 60 s.

**The translation, which bounds every number below.** A rule watches a process: class, age, and
whether a second sample showed progress. A transcript records a tool call: tool name, duration,
result. So the tool call *is* the process — its `dur_ms` is the age, its result text is the only
evidence of the command line (the argv is not in a transcript), and CPU progress is **not available
at all**. The transcript therefore fires on age alone, which is what the per-tick scan does too; the
standalone `--stalled` scan is strictly better evidence and nothing here can see it.

Five of the seven rules suppress rather than fire, and they are applied to the synthetic sample
exactly as the live table applies them — which means they can only ever *remove* a firing. **The
firing count is an upper bound and the precision below is a lower bound.**

| | |
|---|---|
| turns containing a call past its rule's allowance | **34 of 1,363** (2.5 %) |
| of those, scorable | 24 |
| rule that fired | `command` (5 min) on all 34; `build` never (no build ran past 20 min) |
| longest call any of them fired on | 33.6 min |

| label | stage 0 fired | stage 0 silent | fired share |
|---|---|---|---|
| `quiet` (→ `leave`) | 11 | 579 | 1.9 % |
| `instruction` (→ `nudge`) | 10 | 375 | 2.6 % |
| `redirect` (→ `nudge`) | 2 | 26 | 7.1 % |
| `continue` (→ `nudge`) | 1 | 15 | 6.3 % |
| `question` (→ `nudge`) | 0 | 51 | 0.0 % |
| `stop` (→ `flag` on the residue) | 0 | 3 | 0.0 % |

Over the 483 rows where a word was owed (the residue mapping below):

- **precision 54.2 %** — P(a word was owed | stage 0 fired), 13 of 24, against a **45.0 %** base rate;
- **recall 2.7 %** — P(stage 0 fired | a word was owed), 13 of 483.

**Read plainly: the rules are a good alarm and a poor gate.** When they fire, the human was about to
speak a little more often than not — a real nine-point lift over the base rate. But they see 2.7 % of
the turns that owed a word, because what they detect is a *runaway process*, and what the corpus is
mostly made of is a *pane that has stopped*. A supervisor that used them as the only gate would be
silent through almost every moment a human later had to intervene.

That is a fact about the seven rules, not about the architecture: the table has no rule for "an agent
finished a turn and is waiting", which is the state the corpus is made of. Adding one is a rule
question with no process evidence behind it — the honest options are a clock (`idleTicks`, which the
supervisor already has) or a content check, which is stage 1 wearing stage 0's coat.

## The residue: what is left for the model

`mine/out/tasks-residue.jsonl`, sha `5107ea0a31d02527`, 24 rows, relabelled with
`RESIDUE_LABEL_TO_OP` (`src/labeling/label-to-op.ts`) — the same table as the general one except
`stop → flag`, because on a row where a rule has already fired, a human halting the work is evidence
that a human was needed.

| op | rows | share |
|---|---|---|
| `nudge` | 13 | 54.2 % |
| `leave` | 11 | 45.8 % |
| `flag` | 0 | 0.0 % |
| `declare_done` | 0 | 0.0 % |

| constant | exact match | regret / task |
|---|---|---|
| always `nudge` | **54.2 %** | 2.2917 |
| always `leave` | 45.8 % | 3.2500 |
| always `flag` | 0.0 % | **1.4583** |
| always `declare_done` | 0.0 % | 4.0000 |

The residue **inverts the corpus's balance**: `leave` is 55.3 % of all rows and 45.8 % here, so on
the rows the rules select, doing nothing is no longer the majority answer. That is the stage-0 idea
working as designed — it is the *coverage* that fails, not the selection.

Twenty-four rows is a signal, not a result: one row moves exact match by 4.2 points, and the needle3
engine's own run-to-run wobble is larger than that (three runs of one archive over one task set came
back between 37/40 and 40/40 refusals). Everything below is read with that in mind.

## The model, on the residue — the fair test the ladder never had

Now the model, on those 24 rows and nowhere else — the fairest test the ladder has ever had, because
it is asked only the question the architecture leaves it. Three runs: `needle3` twice (its stock 30 s
adapter deadline, then a 600 s cap, since the first run measures the deadline rather than the engine),
and the four slate archives that exist.

| model | exact | `leave` | `nudge` | refusals | p50 | regret / task |
|---|---|---|---|---|---|---|
| **always `nudge`** (constant) | **54.2 %** | — | 100 % | — | — | 2.2917 |
| **always `flag`** (constant) | 0.0 % | — | — | — | — | **1.4583** |
| always `leave` (constant) | 45.8 % | 100 % | — | — | — | 3.2500 |
| `d4` (4 layers, tuned) | **37.5 %** | 0.0 % | 69.2 % | 7/24 | 6,088 ms | 1.8333 |
| `d20` (20 layers, tuned) | 12.5 % | 9.1 % | 15.4 % | 16/24 | 31,670 ms | 1.4167 |
| `control-d8` (8 layers, no adapter) | 4.2 % | 0.0 % | 7.7 % | 22/24 | 13,096 ms | 1.4167 |
| `d8` (8 layers, tuned) | 0.0 % | 0.0 % | 0.0 % | 10/24 | 14,208 ms | 2.2917 |
| `needle3` @ 600 s cap | 0.0 % | 0.0 % | 0.0 % | **24/24** | 36,601 ms | 1.4583 |
| `needle3` @ 30 s cap | 0.0 % | — | — | 24/24 | 30,006 ms | 1.4583 |

**Nothing beats the constant, and the fair test says so more clearly than the unfair one did.** The
best variant is `d4` at 37.5 % against always-nudge's 54.2 % — eight points of accuracy short on a
24-row set, i.e. two rows. `d20` and `control-d8` do edge past always-flag on regret (1.4167 against
1.4583), and that is **one point of regret over the whole set**, which is one row: at n = 24 it is
indistinguishable from noise, and it is claimed here as such rather than as a win.

`needle3` is the cleanest result in the table: **24 of 24 refusals at a 600 s cap**, p50 36.6 s. It is
not being cut off — it declines. The 30 s run beside it is a measurement of the adapter's deadline on
a loaded box (p50 exactly 30,006 ms, every row at the cap), which is why it is shown and not quoted.

What this means for the trial, stated plainly: on the rows the rules select, the model is still the
wrong side of a constant. The trial stays open because the residue is far too small to close it — and
because the way to grow it is `AGENTFLEET_OBSERVE` below, not another threshold. But nobody should
read this document as evidence that the model is coming good under the new architecture. It is not.

## `AGENTFLEET_OBSERVE=1`

The mode that makes all of this observable on a live fleet without sending anything: the whole
pipeline runs — stage 0's verdict for every pane, the model's proposal for every pane that moved —
every row is written, every decision is left as a question for the next tick to judge, and **nothing
leaves the process**: no prompt, no notification, no parked ask, no claim file.

The channel is wrapped once (`observingNotifier`) rather than guarded at each of the dozen call
sites, because a mode whose guarantee depends on remembering it is a mode that will one day send
something. The failure path uses the same channel.

It is **not** `dry`, and the difference is load-bearing: a dry tick judges nothing and records no
pending decision, so there is nothing to join to what happened next. Observe judges, records pending
and saves marks — the three things that make the log a dataset.

The pipeline's first end-to-end pass was a dry tick: 10 agents, 10 moved, 10 decisions, 0 triggers,
0 inspected, 0 escalated, 0 escalations failed, 0 prompts, 0 held, **$0.003950**. That exercises
herdr read → movement detection → decision → gate → no action, and it spends the model not at all.

Live run on the development machine, four consecutive ticks against 17 live panes, in a throwaway
state dir, **$0.002852 total**:

```
fleet tick: 17 agents, 17 moved, 17 decisions, 9/17 spoke, 0 triggers, 0 inspected,
            0 escalated, 0 escalations failed, 0 prompts, 0 held, $0.002852 (observe)
fleet tick: 17 agents, 0 moved, 0 decisions, 9/17 spoke, ... $0.000000 (observe)   ×3
```

- **68 `stage0` rows** over the four ticks, 17 per tick: **36 spoke**, 28 were `idle-shell` and 4
  `background-service`. The silences are in the log with their rules, which is the whole point of a
  returned value.
- **17 decisions**, 16 of them `flag`, written as `flag_observed`; **35 `notify_observed`** rows;
  and **0 prompts, 0 held, 0 asks** — every message the pipeline would have sent is a log line.
- `pending.json` held 17 open questions after tick 1, and by tick 3 **16 `outcome` rows** had been
  written, all `stalled`: the pane did not move after the supervisor stayed its hand. That is the
  join the mode exists for, exercised end to end on real panes.

Two things the live run shows that the corpus does not. The rules spoke for **9 of 17 panes**
(53 %), against 2.5 % of mined turns — because a live fleet has long-lived processes in it and the
corpus has none. All nine fired on the same ~4.8-hour process seen from different panes in one
directory, which is the attribution rule doing what it was designed to do and also a warning that
the rules' live firing rate is dominated by whatever daemon happens to be running. And the model
flagged 16 of 17, which is the same prior toward action that cost it on the corpus.

## The idle rule (second pass)

The first pass's conclusion was precise and useless: the seven rules see 2.7 % of the turns that owed
a word, because they detect a runaway *process* and the corpus is overwhelmingly a pane that has
*stopped*. So the missing rule is the pane-level one — **an agent that finished a turn and has taken
no input for N ticks** — and `N` comes from the timestamps, not from taste.

### N, and where it comes from

On the fit half of the sessions (every other session by a hash of its id, so the split does not
depend on file order and stays fixed if the corpus grows), the operator's reply latency after a turn
end is:

```
n = 561 replies    p25 0.13   p50 1.38   p75 6.07   p90 61.28   (minutes)
```

**Half of all replies arrive inside 1.38 minutes.** So the first whole tick at which a reply has
stopped being the likely next event is the **second**, and that is `IDLE_TICKS = 2` in
`src/watchdog/needs-a-word.ts`. The rule was picked from that distribution alone — no label was
consulted, and nothing was re-picked after the numbers came in. The rule is a clock, and the corpus
supplies the clock directly: a row's `gapMs` is exactly "how long was the human away".

N is a *tick* count rather than a duration because that is how the supervisor experiences time
(`AGENTFLEET_INTERVAL_MS`, and `idleTicks` on every mark), and at the default 60 s interval two ticks
is two minutes.

### Fire rate, precision and coverage, before and after

| | before (process rules) | after (process ∪ idle) |
|---|---|---|
| fire rate, all turns | 2.5 % (34/1,363) | **54.1 % (738/1,363)** |
| precision — was the pane actually blocked? | 54.2 % (13/24) | **62.9 %** |
| coverage — of turns that owed a word, how many the rule sees | 2.7 % (13/483) | **41.6 %** (held out) |
| label mix among fired rows | `leave` 11 / `nudge` 13 | `nudge` 464 / `leave` 274 / `flag` 0 |

The idle rule alone, measured on both halves so the held-out number is the one to quote:

| | fit | held out |
|---|---|---|
| fire rate | 53.1 % (366/689) | 53.1 % (358/674) |
| label mix among fired | `nudge` 230 / `leave` 136 | `nudge` 220 / `leave` 138 |
| precision | 62.8 % | **61.5 %** |
| coverage of owed words | 42.3 % (230/544) | **41.6 %** (220/529) |

Fit and held out differ by 1.3 points of precision and 0.7 of coverage, which is what a rule chosen
from a distribution rather than from the score looks like.

### The same definitions, and why they cannot judge this rule

Scored on pass 1's label — "did a human speak inside the 60 s window after the turn ended" — the idle
rule is **0 % precise and 0 % recall**, on both halves. That is not a bug and not a bad rule: the
rule fires only on turns whose window expired with nobody speaking, so its evidence *is* the
complement of the label's, one tick later. A rule that fires after the label's window cannot be
scored by the label's window; the number is reported here so that the tautology is visible rather
than described.

The label that fits the firing instant is the human's **eventual** message, and the corpus supplies
it on every quiet row (`nextLabel`). An intervention means the pane was blocked; a halt would mean a
human was needed; no message at all means nobody ever came back. Timing selects the rows, content
judges them.

### What that precision actually is

62.9 % is an average of two very different populations, and the split is the finding:

| how long the human was away, on fired rows | rows | precision |
|---|---|---|
| 2–10 min | 236 | **98.3 %** |
| 10 min – 1 h | 118 | 94.1 % |
| 1–6 h | 63 | 95.2 % |
| > 6 h | 49 | 95.9 % |
| **never came back** | **258** | **0 %** (by construction) |

So the rule's errors are **entirely** the panes nobody ever came back to — 258 of 724 firings, 36 %.
On the panes still in a live conversation it is right about 95 % of the time.

But that 95 % is weaker evidence than it looks, and the reason matters: on the mined corpus **every
slow reply is an intervention** (of 590 quiet rows, 443 are instructions, 101 questions, 26
continues, 20 redirects, and *zero* are halts). Any human message that arrives late says something.
So the corpus cannot tell a blocked pane from a finished one using content — the only variation the
label carries is "did anybody ever come back", which is a fact about the session, not about the pane.

### The residue, and the question it now asks

The residue stage 0 leaves — rows where a process rule fired or the pane has been idle two ticks — is

```
738 of 1,363 points (54.1%)   ·   nudge 464   leave 274   flag 0   ·   precision 62.9%
```

which passes the brief's test: the residue is **mostly word-owed**, no longer mostly `leave`. On the
1,073 scorable rows alone it is 450 rows and 100 % `nudge` — because a scorable row is one that got a
reply, and every slow reply is an intervention.

That last number is the one to sit with. **The residue's discriminating class is exactly the class
this corpus cannot label.** The 274 `leave` rows are the censored ones: nobody ever came back, which
is what a finished pane looks like and also what a transcript that ended looks like. A model scored
on the scorable residue would score 100 % by always answering `nudge`.

So the honest statement of what the residue is worth: stage 0 now selects the right *moment* — a live
pane that has gone quiet — and whether a model is worth anything *at* that moment cannot be answered
from mined transcripts at all. It needs the observe log: a pane the supervisor left alone and which
then never moved is the counterexample (`outcome: stalled`), and that row exists only live.

### Is stage 0 a gate, or still only an alarm?

**It is now a gate for attention and still not a gate for judgement.** It selects 54 % of turns and
covers 42 % of the words that were owed — against 2.5 % and 2.7 % before — so the model is no longer
being asked about every turn, and the population it is asked about is 63 % word-owed. What it cannot
do is tell a pane that has finished from a pane that is stuck: its 36 % error rate is exactly that
distinction, no rule in the table can make it, and this corpus cannot even label it. That bit is
stage 1's, and the only corpus that can score it is the one `AGENTFLEET_OBSERVE` writes.

## What this implies

1. **A finding is a sentence, never a signal.** The watchdog reports, the agent decides, the command
   keeps running. Everything below is measured under that rule and nothing in it licenses a
   terminate.
2. **The rules are worth keeping, and after the second pass they select.** 2.5 % coverage was an
   alarm nobody could build on; the idle rule takes it to 41.6 % and the fire rate to 54 %, so stage
   0 now picks the moment rather than waiting for a hung process. It is not wired as a live gate yet
   — there is no `AGENTFLEET_STAGE0` switch, and stage 0's verdicts are computed and logged in
   observe only. Wiring it is now a cost question (it would save a model call on the 46 % of turns it
   does not select) rather than a coverage one.
3. **The residue is big enough to score and still not scorable.** 738 rows, 63 % word-owed — but its
   discriminating class is "finished versus stuck", and the only rows that carry that label are the
   censored ones, where nobody ever came back. A model scored on the scorable residue would score
   100 % by always saying `nudge`. The corpus that can score it is the one `AGENTFLEET_OBSERVE`
   writes: every stage-0 verdict and every proposal joined to what the pane did next, for days, at a
   few cents a day.
4. **The trial's outcome is unchanged by this work.** The model is still under the constant on the
   full corpus and, above, on the residue. Nothing here says the idea fails; it says the fair
   test is small, and the way to make it big is to observe rather than to argue.
5. **What the wider project carries.** `fleet-manager` should end up carrying the watchdog rules,
   the notification channel, the events schema and the spend caps. `src/decision/`, `finetune/`
   and the ladder stay in place and out of the hot path: the trial is open, not closed.

## How to reproduce

```sh
node mine/time-sampled-points.ts            # 292 sessions → 1,363 points (needs the CLI cache)
node bench/runners/stage0.ts                # process rules alone + the residue task set
node bench/runners/stage0.ts --idle         # the idle rule: N from the fit half, held out, residue
node bench/runners/run.ts needle3 --limit=24 --taskset=mine/out/tasks-residue.jsonl
node bench/runners/slate.ts --limit=24 --taskset=mine/out/tasks-residue.jsonl --report=SLATE-residue.md

# observe, on a throwaway state dir so the real marks survive
AGENTFLEET_OBSERVE=1 AGENTFLEET_ONCE=1 AGENTFLEET_STATE=/tmp/obs/marks.json \
  AGENTFLEET_STATE_DIR=/tmp/obs node src/manager/tick.ts
```
