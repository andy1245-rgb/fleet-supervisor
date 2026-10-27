# Baselines — the `leave` column and the four constant policies

2026-10-27. Two defects in `bench/runners/run.ts` scoring, both fixed here. Nothing in
`bench/results/` was modified: the existing records stand exactly as committed, and this file is
the note that says how to read them.

## Defect 1 — the regret matrix priced abandonment at zero

`REGRET` was typed `Record<Op, Record<Exclude<Op, "leave">, number>>`, so no row had a `leave`
column, and `regretOf` closed with `?? 0`. Predicting `leave` therefore cost nothing whatever the
expectation was, and **`always leave` was the exact optimum of `regret.perTask`** — the headline
metric every record carries — while matching 7 of 502 rows.

The matrix is now `Record<Op, Record<Op, number>>`, square and total, and `regretOf` is a single
cell read with no fallback, so a row missing a cell is a compile error:

```
TS2741: Property 'leave' is missing in type '{ nudge: number; declare_done: number; flag: number; }'
        but required in type 'Record<Op, number>'
```

| expected → | `leave` | `nudge` | `declare_done` | `flag` |
|---|---|---|---|---|
| `leave` | 0 | 5 | 4 | 2 |
| `nudge` | **6** | 0 | 4 | 1 |
| `declare_done` | 5 | 5 | 0 | 2 |
| `flag` | **6** | 1 | 1 | 0 |

The `leave` column is the abandon column and is priced as the worst thing that can happen on the
two rows that owed action: `nudge → leave` and `flag → leave` are 6, because the agent was
mid-work and was left sitting, which loses the whole cycle it was running. `declare_done → leave`
is 5 — that turn had already reported itself finished, so the loss is a stale claim rather than a
stalled pane. The `leave` row is unchanged from the old table (5/4/2): nudging or flagging a
rested agent buys a wasted turn, and nudging one that had already finished is worse than flagging
it because the nudge makes it work again. Correct pairs are 0 and are the only free cells.

## The corrected baseline table

Computed by `baselineModels()` — four `DecisionModel`s that return a fixed `Decision` with
confidence 1 and cost 0 — scored through `score()` like any other model. Corpus 502 rows:
nudge 406 / flag 89 / leave 7 / declare_done 0.

```
full corpus (n=502: nudge 406 / flag 89 / leave 7)
  baseline:always-leave          exact 0.0139   regret/task 5.9163   total 2970
  baseline:always-nudge          exact 0.8088   regret/task 0.2470   total  124
  baseline:always-declare_done   exact 0.0000   regret/task 3.4681   total 1741
  baseline:always-flag           exact 0.1773   regret/task 0.8367   total  420

stratified 40 (n=40: nudge 26 / flag 7 / leave 7)
  baseline:always-leave          exact 0.1750   regret/task 4.9500   total  198
  baseline:always-nudge          exact 0.6500   regret/task 1.0500   total   42
  baseline:always-declare_done   exact 0.0000   regret/task 3.4750   total  139
  baseline:always-flag           exact 0.1750   regret/task 1.0000   total   40

stratified 22 (n=22: nudge 12 / leave 7 / flag 3)
  baseline:always-leave          exact 0.3182   regret/task 4.0909   total   90
  baseline:always-nudge          exact 0.5455   regret/task 1.7273   total   38
  baseline:always-declare_done   exact 0.0000   regret/task 3.5909   total   79
  baseline:always-flag           exact 0.1364   regret/task 1.1818   total   26
```

Three of the four rows are **numerically identical to the pre-fix values**, and that is the check
that the fix did what it claims: `always nudge`, `always flag` and `always declare_done` never
predict `leave`, so they never touched the missing column and their cells did not move. Only
`always leave` moved, and it moved from the best regret score in the table to the worst:

| subset | `always leave` regret/task before | after |
|---|---|---|
| full corpus | 0.0000 | **5.9163** |
| stratified 40 | 0.0000 | **4.9500** |
| stratified 22 | 0.0000 | **4.0909** |

Do-nothing is now the worst constant policy on every subset, which is the correct ranking: it is
the one policy that abandons 495 of 502 rows.

`always declare_done` scores exact 0.0000 because the corpus has **zero** `declare_done` rows —
no label maps to it. Its regret is non-zero and highest of the correct-seeking constants, which is
the only honest thing a record can say about an op with no training target.

## Every record predating this change is void as a model quality number

**No record in `bench/results/` written before this change may be quoted as a model quality
number.** Not "should be read with care" — must not be quoted.

Two independent reasons, and the first is fatal on its own:

1. **Those records were scored against a matrix that priced `leave` at zero.** Any record whose
   model predicted `leave` even once has a `regret.total` that is understated by 5 or 6 per such
   row, and its `regret.perTask` is not comparable with any record written after this change. The
   metric they were scored on had a degenerate optimum, so a number from it measures agreement
   with a broken objective, not quality.
2. **None of them carry a `baselines` block**, so none of them can be anchored. The relevant fact
   is not subtle: on the full corpus `always nudge` scores **0.8088** exact match, and every
   committed record is below it — GLM-5.3-flash 0.3500, `slate-control-d8` 0.1500, `needle3`
   0.1364. On their own subsets they are below the constant too: `always nudge` is 0.8750 on the
   pre-stratification 40-row set, 0.6500 on the stratified 40, 0.5455 on the 22. No model in this
   repository has yet beaten a one-line constant predictor, and before this file no record said
   so.

Records written from now on carry the block, so the comparison is on the record itself:
`ops.exactMatch` against `baselines.alwaysNudge.exactMatch`, and `regret.perTask` against
`baselines.alwaysNudge.regretPerTask`. A record that loses to the constant has not measured
signal.

## `needle3`'s exact match is `always flag` in disguise

`bench/results/2026-10-27T00-43-19-911Z__needle3.json`: n=22, exactMatch 0.1364, regret 26 /
1.1818, refusals 22. Its trace file has 22 rows and **22 of them carry `predictedOp: "flag"`.**
`parseDecision` maps every refusal and every unparseable answer to `flag` with `refused: true`, so
a model that refuses on every row emits `flag` on every row.

That makes the record numerically identical to the `always flag` baseline on the same 22 rows —
exact 0.1364, regret total 26, perTask 1.1818 — because it *is* `always flag`, reached by a
different route. Its `perOpRecall` reads `{nudge: 0, leave: 0, flag: 1}`, and that `flag: 1` is
not a skill: it is the three `flag` rows in the subset coinciding with the refusal class.

So `needle3` does not score "poorly" on this benchmark; it scores *as a constant*, and the
constant it equals is the one that means "I could not decide". Its 0.1364 is a floor, not a
measurement of the model's judgment — the same floor `slate-control-d8` sits one row above
(0.1500 with 37 of 40 refusals). This is why the baselines are now in the record: a refusal-driven
record and a constant policy are indistinguishable by `exactMatch` alone, and printing the
constant beside it makes that visible instead of impressive-sounding.

Note that `regret.weights` in a record (`{leave: 5, declare_done: 4, flag: 2, nudge: 1}`) is the
legacy flat per-op summary and cannot express the square matrix. `REGRET` in
`bench/runners/run.ts` is the authoritative table; the field is kept so old and new records keep
the same shape.

## Reproducing the table

No model and no network — constants scored against the local task file:

```
node --input-type=module -e '
import { baselineModels, loadTasks, score } from "./bench/runners/run.ts";
const { tasks, sha } = loadTasks();
for (const model of baselineModels()) {
  const decisions = [];
  for (const row of tasks) decisions.push(await model.decide(row.input));
  const record = score(model.name, tasks, decisions, sha);
  console.log(model.name, record.ops.exactMatch, record.regret.perTask);
}'
```

`test/bench-scoring.test.ts` pins the same claims: all sixteen `(expected, predicted)` pairs are
priced and only a correct pair is free; `always leave` is no longer the regret optimum; a constant
baseline outscores a deliberately adversarial fake model; and each baseline scores identically
through `score()` as through the record's `baselines` block.

`npm test` 238 pass / 0 fail. `npx tsc --noEmit` clean.
