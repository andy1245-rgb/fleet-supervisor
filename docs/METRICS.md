# Metrics — what the supervisor measures, and what a change in it means

The supervisor already wrote a human-readable log. This layer makes that log
*queryable*: a typed vocabulary every stage writes through, a store that can be
asked about a window and a group, and one report that answers the questions an
optimisation pass actually starts with.

```
node src/metrics/report.ts                 # last 24h, all groups, human tables
node src/metrics/report.ts --window=1h     # last hour
node src/metrics/report.ts --window=all    # the whole log
node src/metrics/report.ts --group=agentFleet
node src/metrics/report.ts --json          # the same numbers as a stable object
```

`--json` is the contract an optimisation script reads (`reportSchema: 1`). The
tables and the JSON are built from one object, so they cannot disagree.

| question | read this |
|---|---|
| Is the local model worth its latency? | `decisions.latencyByModel`, `decisions.cost.byModel`, `decisions.refusalByModel`, `decisions.opMix` |
| Which ops go unanswered? | `actions.byOp` (`skipped`/`rejected` per op), `actions.skippedByReason`, `actions.rejectedByReason` |
| How often does the gate hold? | `actions.hold` — overall, per policy, per fork kind |
| What fraction of triggers yield an actionable finding? | `inspections.proposed.rate`, `inspections.byTriggerKind[].rate`, `inspections.costUsd` |
| Is a tick getting slower or more expensive? | `ticks.durationMs`, `ticks.costUsd`, `ticks.models` |
| Is the primary enough, or is everything escalating? | `decisions.escalation`, `decisions.refusalByModel` |
| Was staying out of the way right, and was a finished job finished? | `outcomes.byOpKind`, `outcomes.silence` |

## The log

`<state>/events.jsonl`, append-only, one JSON object per line. Nothing rewrites a
line, ever: the supervisor only appends, and the store only reads.

Every row written from now on carries two fields:

- `schema` — `SCHEMA_VERSION` (`src/metrics/schema.ts`, currently `2`). A row
  whose version is not the current one is **not read**: `parseEvent` rejects it
  and the store counts it. A mixed-unit aggregate is worse than a smaller one.
- `ts` — ISO 8601. Every window, every per-day bucket and every ordering decision
  uses this field, never file order.

Rows that are not rows of this schema — the pre-taxonomy history, the
human-readable legacy kinds, a truncated write, a hand edit — are **skipped and
counted**, never repaired and never partially read. The count is
`source.ignoredRows` in the report and `IngestResult.ignoredTotal` from the store.
It is cumulative over the log, so it is the backfill answer as well: point the
report at an existing state directory and it will ingest that `events.jsonl`
without error and tell you how many lines it could not use.

```
node src/metrics/report.ts --log=/tmp/fleet-t1/events.jsonl --window=all
```

The store also writes a derived SQLite index beside the log
(`events.metrics.sqlite`), or `:memory:` when the log is absent. `node:sqlite`
is built into this Node (24.x) and is loaded lazily; if it is missing or the
database cannot be opened, the store falls back to scanning the JSONL and
`source.indexKind` says `scan`. No new dependency either way.

## The events

Every event is constructed by a `make*` function in `src/metrics/schema.ts`. No
stage builds its own object, so no stage can invent a shape: if the report reads a
field, every row of that kind has it, and a stage that cannot supply it honestly
leaves it optional and the report says so (`coverage`, and the `notes` block).

### `decision` — one ladder decision for one moved pane

Emitted by `src/manager/tick.ts`, once per moved pane, after the action is known
so `held` is the truth about the gate.

| field | meaning |
|---|---|
| `paneId`, `group` | the pane and the group key `src/fleet/groups.ts` assigned it |
| `model` | the model whose opinion became the decision — the escalator's, when it took over |
| `op` | `leave`, `nudge`, `declare_done` or `flag` |
| `confidence` | the model's own 0..1 number. Not an accuracy estimate |
| `refused` | the model declined to commit to an op (an unparseable answer is a refusal too) |
| `escalated` | the primary was found insufficient and the escalator was asked |
| `escalationFailed` | that attempt threw. A subset of `escalated`, not a rival to it |
| `latencyMs`, `costUsd` | the deciding model's own round trip and price |
| `policy` | the group's ask policy at decision time. Informational for `leave`/`flag`: neither is gated, so it was not consulted |
| `held` | the gate parked this decision's action instead of performing it |
| `promptTokens?`, `completionTokens?` | **absent in every row today** — no adapter reports usage. See "What is absent" |
| `labelOp?` | ground truth, when a bench join supplies it. Absent otherwise, which is why accuracy is null rather than invented |
| `decision?` | the human-readable one-liner (`describeDecision`), kept so the legacy line is not lost |

Where a change shows up: a rising `escalated` share means the primary is being
outvoted by its own threshold — either the model got worse or `threshold` is
wrong. A rising `refused` share on one model with flat escalation means the model
is declining rather than answering, which no amount of escalation fixes cheaply.

### `action` — one would-be action, and how far it got

Emitted by `src/manager/tick.ts` for ladder decisions and for actions an
inspector finding proposed. `leave` produces **no** action row: it is not an
action. `flag` produces one with `disposition: "skipped"`, `reason:
"flag-reported"` — it notified, it did not touch a pane.

| field | meaning |
|---|---|
| `op` | what was attempted. The inventory reports the pair: a nudge can be a prompt or a claim write |
| `disposition` | `sent` (performed), `held` (parked for the operator), `rejected` (the transport refused), `skipped` (never attempted now), `dry` (a rehearsal) |
| `reason` | short and stable: `ok`, `gate`, `cooldown`, `capped`, `dry`, `flag-reported`, or the transport's own refusal reason |
| `latencyMs` | the round trip where there was one; `0` when nothing was performed |
| `gated` | **the ask gate ran for this action**. The hold rate's denominator, and the reason a cooldown skip is not counted as a hold opportunity |
| `policy` | the policy in force |
| `forkKinds?`, `forkSeverities?` | the contests the gate saw, when there were any. Absent means "nothing was contested", which is a measurement, not missing data |

Where a change shows up: `skipped`/`cooldown` climbing with `sent` flat means the
cooldown is longer than a turn; `skipped`/`capped` climbing means
`maxPromptsPerTick` is the binding constraint and the fleet wants more turns than
it is allowed; `rejected` on one pane repeatedly means that pane is blocked and no
policy will fix it.

### `tick` — one pass over the fleet

Emitted by `src/manager/tick.ts` as the last row of a tick. The denominator for
every per-tick rate, and the only row that records the whole-tick cost.

Fields: `agents`, `moved`, `decisions`, `escalated`, `escalationFailed`,
`triggers`, `inspected`, `prompts`, `held`, `costUsd`, `durationMs`, `models[]`,
`dry`, plus `asks` kept as the legacy alias of `held`.

`costUsd` here sums every ladder call in the tick, escalator trail included. The
per-model cost rows (`decisions.cost.byModel`, `inspections.costUsd`) price only
the model that produced each row. **The two totals are not additive** and the
report says so in its notes.

`models[]` is what makes an A/B legible: a window where `needle3` stops appearing
is a window where the primary was degraded, without reading the config.

### `trigger` — a cross-agent condition, as the scan found it

Emitted by `src/manager/tick.ts` from `src/manager/triggers.ts`'s scan, one row
per trigger per tick. `triggerKind` (not `kind`: a row cannot be two things) is
`divergence`, `collision`, `churn` or `blocked`. A log-only trigger — `churn` with
the inspector off — is still an event: it says the condition fired, not that
anything was spent on it.

The legacy `trigger:<kind>` line is still written beside it, unchanged.

### `inspection` — one investigation of one trigger

Emitted by `src/manager/tick.ts` from the `Finding` returned by
`src/manager/inspector.ts`. `mode` is what ran (`cheap` or `deep`);
`degraded` is true when the requested path did not deliver — a `deep` child that
could not be spawned, timed out or answered in prose falls back to `cheap`, and a
model call that throws produces a finding that says it could not run. Both are
real events about the supervisor, not errors to hide.

`proposed` is the yield question: an inspection that produced nothing actionable
cost the same as one that did. `latencyMs` excludes the terminal reads that
assembled the brief, because a read is not an inspection.

Where a change shows up: `degraded.rate` above zero on a `deep` window means the
`pi` child is failing and you are paying cheap prices for deep intentions.

### `watchdog` — one process finding

Emitted by `src/manager/tick.ts` from `src/watchdog/rules.ts`'s
`findingFields(sample, verdict)`; the watchdog owns the rule id and the stall
verdict, so a row names the rule exactly as the classifier did, including
`no-rule`. `stalled` is present only when the scan re-sampled to tell slow from
hung — the per-tick scan does not pay for a second sample, so per-tick rows have
no `stalled`.

### `claim` — the worker-side read for a moved pane

Emitted by `src/manager/tick.ts` beside the decision it fed: `phase`, `state`
(`working`/`waiting`/`done`, or `none` when no claim file exists), `ageMs` (from
`claim.updated`, absent when there is no claim) and `diverged` — the worker says
`working` and herdr does not. That boolean is the disagreement the `divergence`
trigger is grounded in, recorded as a count instead of re-derived from prose.

### `outcome` — one decision, judged by what happened next

Emitted by `src/manager/tick.ts` when a decision's question closes: `op`,
`outcomeKind`, `ticksObserved`, `movedSinceDecision`, the decision's `argument`,
and the pane's own `status`/`idleTicks`/`cwd`/`title` at judgement. The verdict
itself comes from `judge` in `src/metrics/outcome.ts` unchanged — this row is a
report of that rule, not a second opinion on it.

The point of the row is that it is the only evidence in the log that no
transcript could produce. `completion_seq` advanced since the decision → the pane
moved, and it became `progressed` (or `reopened`, when the op was
`declare_done` and the pane carried on past its own declaration). It did not
advance, the pane is resting, and `DEFAULT_WINDOW_TICKS` (3) have elapsed → it
became `stalled` for a silent op, `satisfied` for a `declare_done`, and nothing
at all for a `nudge` — a nudge that produced no movement is a repair rate, not a
label. A pane that left the snapshot, or whose counter went backwards, is
`unobserved`: not seen moving and not seen still.

Open questions live in `<state>/pending.json`, beside the log they explain, one
entry per pane with the decision's `decidedAtSeq` and the ticks already spent.
It is rewritten atomically (tmp + rename, like `marks.json`) and only when it has
changed, and a malformed file is read as empty rather than stopping a tick. A
restart therefore resumes mid-window instead of restarting the clock.

## The metrics

All of these are counted from rows in the selected window. A rate with an empty
denominator is **null and printed as `—`**, never `0`: "no rows" and "zero" are
different facts and a report that conflates them is how a metric lies.

### Decisions

- **volume** — number of `decision` rows.
- **op mix** — count and share per op. Share is over all decisions, including
  `leave`; a fleet whose models are quiet shows a large `leave` share, which is
  the cheapest possible outcome and not a failure.
- **confidence distribution** — deciles, bucket = `floor(confidence * 10)`
  clamped to 9, so `1.0` lands in the last bucket and `0.0` in the first. Mean is
  over all rows.
- **accuracy by decile** — over rows that carry `labelOp` only:
  `correct = op === labelOp`, grouped by decile, and `null` for a decile no
  labelled row fell in (an empty bucket is unknown, not 0% accurate). This is how
  calibration is checked: if the 0.9 bucket is right 60% of the time, the threshold that routes
  on 0.7 is routing on a number that does not mean what it claims. Null when no
  row carries a label.
- **escalation** — `escalated / total`; `failedRate = failed / escalated`, i.e. a
  share of *attempted* escalations. `failed / total` is derivable and is not the
  interesting number.
- **refusal per model** — `refused / decisions` per deciding model.
- **latency per model** — nearest-rank percentiles over `latencyMs`. Nearest rank
  means every printed number is a value that actually occurred; there is no
  interpolation and no synthetic p95.
- **cost** — total, per model (each model's own calls) and per UTC day
  (`ts.slice(0, 10)`).

### Actions and holds

- **hold rate** — `held / gated`, where `gated` counts only actions the ask gate
  actually saw. An action skipped for cooldown short-circuits before the gate, so
  counting it in the denominator would understate the hold rate.
- **hold rate by policy** — the same ratio per policy. This is the one table that
  says whether a policy is doing what it was set to do.
- **hold rate by fork kind** — per fork kind carried by a gated action. An action
  with two kinds counts once in each; an action with no fork is in no bucket, so
  the buckets need not sum to `gated`. Kinds are read from the gate's own
  sentences (`forkKindOf`): irreversible, cross-agent, scope-change, at-cap.
  `other` catches a sentence the mapping does not know — which is what a new fork
  looks like in this table before the mapping is extended, so it is visible rather
  than silently bucketed.
- **prompt latency** — nearest-rank percentiles over the actions that made a
  transport call: a nudge that was sent or refused. A `declare_done` writes a
  claim file and takes no round trip, so it is not in this population; counting it
  would report a prompt median of 0 ms for a tick that prompted once.
- **skipped / rejected by reason** — counts per reason. `cooldown`, `capped` and
  `held` are the interesting three; anything else in this table is a new
  behaviour that arrived without a name.

### Ticks

Totals and per-tick means for agents, moved, decisions, inspected, prompts, held;
`durationMs` percentiles; whole-tick cost; the dry count; and which models were
consulted, in how many ticks.

### Triggers and inspections

- **trigger counts by kind** and `perTick`.
- **inspected share** — inspections summed from tick rows over triggers summed
  from tick rows. Read from the tick rather than from trigger rows because the
  tick is what decides how many of the triggers it saw were investigated.
- **inspections per tick**, **cost** (total and mean each), **latency
  percentiles**, **degraded share**, **proposed share** and **yield per trigger
  kind** (`proposed / inspected` for that kind).

### Watchdog and claims

- **findings by rule** — which rule keeps firing.
- **stalled** — `stalled / tested`, where `tested` counts only rows that recorded
  a verdict.
- **claims** — by state, divergence rate, and the age distribution of the claim
  files the supervisor read.

### Outcomes

- **counts by `(op, outcomeKind)`** — every pair that occurred, largest first. A
  pair that never occurred is absent, not zero, because `judge` cannot produce all
  twenty combinations.
- **counts by `outcomeKind`** — the whole taxonomy in order, zeros included:
  "never `reopened`" is a fact about the supervisor and an empty list would hide
  it.
- **silent-decision precision** — of the times the supervisor said nothing
  (`leave` or `flag`, i.e. `isSilent(op)`), what fraction of the panes moved
  anyway: `progressed / (progressed + stalled)`. A silent decision whose pane left
  the snapshot is `unobserved` and is excluded from the denominator and reported
  as `silence.dropped`, because it is no evidence either way.

  It is **not quoted below `MIN_SILENT_DECISIONS` (20) judged decisions**. Under
  twenty the 95% interval on a proportion is wider than the distinction being
  measured, so the report prints `insufficient data (n decisions; 20 needed)`
  instead of a rate. When it is quoted, it reads
  `50.0% of 24 silent decisions progressed`.

  Read it as *the supervisor's silence did not visibly cost anything*, not as
  *the silence was correct*: a pane that moved may have moved for its own
  reasons, and nothing here observes a reason.

## Bench rows from judged outcomes

```
node src/metrics/export-observed.ts                          # beside the log
node src/metrics/export-observed.ts --log=… --out=…          # explicit paths
```

`src/metrics/export-observed.ts` exports `outcome` rows as candidate bench tasks
in the shape `bench/tasks/tasks.jsonl` uses — `{id, input, expectedOp,
provenance}` — with `provenance: "observed"` so a mined row and an observed row
can never be confused afterwards. `humanText` is absent and stays absent: nobody
typed anything, which is the entire reason these rows exist.

| outcome | row |
|---|---|
| silent op, `stalled` | `expectedOp: "nudge"` — the counterexample |
| silent op, `progressed` | `expectedOp: "leave"` — the silence cost nothing visible |
| `declare_done`, `reopened` | `expectedOp: "nudge"` — a premature stop |
| anything else | skipped, counted, and printed with its reason |

**This is correlation, not causation.** A judged outcome says what the fleet
looked like some ticks later; it does not say why the pane moved or did not. An
agent may move after a nudge because the nudge worked, because the turn it was
already in finished, because a test runner returned, or because a human typed
into the pane. Nothing here observes a reason, so **a nudge followed by movement
can never become a positive label** — that direction is unidentifiable, and the
exporter never emits it.

The defensible use is the counterexample: the supervisor said nothing, the pane
rested, the window elapsed. Whatever the cause, the supervisor stayed out of the
way of a pane that then needed something. Those rows are the ones a transcript
cannot produce, because a transcript only records the moments a human spoke.

The rows are also thin on purpose: `outcome` carries the pane, the op, the
verdict and the pane's state, and no terminal output, claim or intent. The
`input` therefore has `tail: ""` and `phase: "unknown"`, and nothing is
reconstructed from a transcript this exporter does not have.

## What is absent, and why that is reported

Two fields are optional because no stage can supply them honestly:

- `decision.promptTokens` / `completionTokens` — none of the three adapters
  (needle sidecar, OpenRouter, `pi`) reports token usage to `Decision`. The
  report lists them under **field coverage** with the absent count and a note, and
  computes no token metric. When an adapter starts reporting usage, the fields
  are already in the schema and the report starts using them without a version
  bump — that is why they are optional rather than omitted.
- `decision.labelOp` — ground truth lives in `bench/` and `mine/`, not in the
  supervisor's log. Accuracy by decile is therefore `null` today. Joining a bench
  record into the log is the next step; until then, no accuracy number is printed
  rather than a number invented from confidence.

`watchdog.stalled` and `claim.ageMs` are absent only where they genuinely are
unknown (no re-sampling scan, no claim file), and coverage says how many rows.

## Rules this layer keeps

- Every number is derived from rows. Nothing is estimated, extrapolated or
  carried over from a previous run.
- Rates are `null`, not zero, when the denominator is empty.
- A rate is `null` below its stated floor as well: silent-decision precision needs
  `MIN_SILENT_DECISIONS` judged decisions before the report prints a percentage,
  and it prints the count and the floor until then.
- An `outcome` row is correlation, not causation. Nothing in this layer — or in
  the exporter built on it — claims that a supervisor's nudge caused movement.
- Percentiles are nearest-rank over values that occurred.
- Percentages are shares of the metric's own stated denominator, printed next to
  the ratio (`1/4 (25.0%)`), so a reader can always see what it was out of.
- A stage that cannot supply a field leaves it out and the report names it. A
  stage may not write a zero to mean "unknown".
- Adding a required field, or changing what one means, bumps `SCHEMA_VERSION`;
  old rows are then skipped instead of being mixed with new ones. The store's
  index follows the version through `parseEvent` and needs no migration: it keeps
  only rows the current build can read, and `rebuild()` re-derives everything from
  the file.

## What the legacy log still contains

The typed rows are added **beside** the human-readable ones; nothing that was
there before was removed or restructured:

| legacy line | still written | note |
|---|---|---|
| `decision` | yes | now schema-valid, and now written for every op, not just `leave` |
| `tick` | yes | now schema-valid, with `durationMs`, `models[]`, `dry` and `held` added |
| `watchdog` | yes | now schema-valid, with `stalled` added when the scan has one |
| `trigger:<kind>` | yes | the typed `trigger` row is written beside it |
| `nudge`, `done`, `flag`, `nudge_*`, `ask`, `ask_pending`, `inspector*`, `inspections_capped`, `watchdog_error` | yes | untouched; the typed `action`/`inspection` rows are written beside them |

So a consumer that greps the old kinds keeps working, and the report never reads
them: it reads only rows of the current schema, which is what keeps its
denominators exact.
