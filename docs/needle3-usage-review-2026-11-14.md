# needle3: is it the model, or how we call it?

2026-11-14. The operator does not accept that needle3 "cannot work" and asked for a review of *how we
use it* before anyone retires it — tool schema shape, prompt format, argument grounding, timeout,
the call convention, and whether the adapter throws away something it should keep.

**Verdict: he is right that the usage is wrong — and the model still fails once it is right.** Four
independent faults are proven below, and every needle3 record in this repository was produced under at
least one of them. Correcting the two that matter most (the decode budget and where the system prompt
is passed) changes the failure from "produced nothing" to "proposed `flag` at confidence 0.003–0.007
and the engine withheld it" — measured on three rows, below. So both things are true: **the usage was
wrong enough to invalidate the evidence, and with it corrected the model does not do this task.**

## The measurement that settles the budget question

`needle_init(system, tools)` returns the static prefix it builds. Measured directly against the
engine this repo uses (`~/.cache/cactus-needle/v3/3.3.3/libneedle.so`, `needle 3.2.8`, the four
tools the sidecar registers):

| configuration | prefix tokens |
|---|---|
| `needle_init("", tools)` — what the sidecar actually does | **156** |
| `needle_init(SYSTEM, tools)` — what the sidecar's comment assumes | **331** |

Then one row of the residue task set, decoded under three configurations and two budgets. `tail_clean`
asks whether the reasoning block ends in punctuation — a truncated thought is the engine running out
of output tokens mid-sentence:

| system prompt placed | budget | op committed | withheld | confidence | reasoning chars | tail clean | wall clock |
|---|---|---|---|---|---|---|---|
| in the query (as shipped) | 96 | — | 0 | 0.0010 | 171 | **no** | 146 s |
| in the query (as shipped) | 320 | *exceeded a 200 s guard* | — | — | — | — | >200 s |
| at init | 96 | — | **1 (`flag`)** | 0.0290 | 134 | **no** | 135 s |
| at init | 320 | *exceeded a 200 s guard* | — | — | — | — | >200 s |
| none at all | 96 | — | 0 | 0.0074 | 123 | **no** | 128 s |
| none at all | 320 | — | **2 (`flag`, `flag`)** | 0.0031 | 171 | yes | 141 s |

Two things are unambiguous in that table.

**Fault 1 — the decode budget is too small to finish a thought.** At 96 tokens the reasoning is
truncated in all three configurations and **no call is emitted in any of them**. At 320 the model
reaches a call (twice, in the `none` configuration). `MAX_NEW_TOKENS = 96` is not a tuning choice that
turned out badly; it is below the length of this prompt's reasoning preamble, so the decode ends
before the decision starts. The window has room for ~370 output tokens (1024 − 156 prefix − ~160
system-in-query − ~330 state block), so 96 gives away about three quarters of the budget it is
supposed to be protecting.

**Fault 2 — the arithmetic in the sidecar justifies that budget with a configuration that is not
running.** The comment reads `1024 - 333 - 512 = 179`, i.e. it prices a 333-token prefix — the
`system`-at-init prefix — while the code passes `system` into the *query* and builds a 156-token
prefix. The input budget therefore is not the 595 tokens the comment claims, and the reasoning that
"96 is affordable" was done against the wrong number.

## Fault 3 — the adapter discards the very thing that answers "why"

The engine's envelope carries twelve fields. The sidecar reads four and keeps two:

```
envelope: confidence, decode_tps, error, error_code, function_calls, peak_ram_mb,
          prefill_tps, reason, reasoning, success, suppressed_calls, type, validation
kept:     function_calls[0].name, function_calls[0].arguments, confidence, reasoning
reduced:  suppressed_calls → a COUNT (`suppressed: 2`)
dropped:  error, error_code, success, reason, decode_tps, prefill_tps, peak_ram_mb,
          validation, type, and the name and arguments of every withheld call
```

`suppressed_calls` is not an absence — it is **the model's proposal that the engine declined to
commit**, and the engine's own `extract()` treats it as the answer (`function_calls or
suppressed_calls`). Measured above, the withheld calls were `flag` with a `problem` argument: a real
proposal with a real sentence. The sidecar reports that as `refused: true, op: null`, so every
downstream consumer — the ladder, the bench, three write-ups — learned "needle3 produced nothing"
when the truth was "needle3 proposed `flag` and the engine withheld it at confidence 0.03". `error`
and `error_code` are dropped too, which is why diagnosing this took a probe instead of a `grep`.

**One correction to an earlier claim in this repository:** the write-up of the timeout probe
attributed suppression to the *grounding gate*. The grounding gate (`_annotate_ungrounded`) only
validates numeric and temporal arguments, and ours are free strings. What actually withholds a call
is the confidence bar — the engine withholds below it and says so in `suppressed_calls`. That
distinction matters, because a grounding failure is a prompt bug and a confidence failure is a model
result.

## Fault 4 — the deadline is below the engine's own latency

The adapter gives one decode 30 s (`needle.ts:270`). Measured on this box at load 26–40, a 96-token
decode took **128–146 s**, i.e. ~1.4 s per token. The recorded records agree in direction: 3,776 ms
p50 on a quiet box (2026-10-26), 30,006 ms p50 on a loaded one, 31,670 ms for `d20` on the residue.
So on anything but an idle machine the adapter's deadline fires first, and the record written is a
statement about the deadline. The pass-1 write-up noticed the symptom ("the 30 s cap is still
reachable") and read it as variance rather than as a mis-set number.

## The corrected budget, and what it shows

Three more rows with the system at init and **384** output tokens — a budget the window can carry
(331 prefix + ~330 state block + 384 = 1,045, at the edge, and the engine handles the overflow the
way it always did: it truncates the thought, not the call):

| row | expected | op committed | withheld | confidence | reasoning chars | tail clean | wall clock |
|---|---|---|---|---|---|---|---|
| 0 | `leave` | — | 0 | 0.0068 | 762 | **no** | 277 s |
| 1 | `nudge` | — | **1 (`flag`)** | 0.0073 | 104 | yes | 87 s |
| 2 | `leave` | — | **3 (`flag`)** | 0.0031 | 85 | yes | 145 s |

Two of three reached a decision, and both proposed **`flag`** — repeatedly, up to three times — at
confidence 0.003–0.007, which is why the engine withheld them. The third still ran out of budget at
762 characters of reasoning and proposed nothing.

That is the fair test, and it is worth being precise about what it settles:

- **The usage was wrong, and it was wrong in ways that made every previous record unfair.** With 96
  tokens the decode never even reached the decision; with 384 it does, on two rows of three.
- **The model still does not do this task.** Given room, the answer it produces is `flag` at
  near-zero confidence on every row where it answers at all. The engine withholds those, and it is
  right to.
- **The earlier conclusion was right and its evidence was wrong.** "needle3 cannot work" was reached
  from runs that were mis-configured four ways; now the same verdict is reached from a run that is
  configured correctly. Both statements are true at once, and only the second is evidence.

## The corrected run

All four faults fixed, then the same frozen task set re-run: `bench/results/2026-11-15T09-52-19-800Z__needle3.json`,
task-set sha `5107ea0a31d02527` (the residue, n = 24 — the same set the two most recent superseded
records used), system prompt in the static prefix, 320-token budget, withheld calls and diagnostics
carried onto the row.

| | |
|---|---|
| committed ops | **0 of 24** (all refused; `usableOutputRate` 0) |
| rows where the engine proposed an op and withheld it | **20 of 24** — `flag` 14, `nudge` 2, `declare_done` 2, `leave` 2 |
| rows that produced neither a call nor a proposal | 4 — and the engine says why: `success: false, error_code: "truncated"` |
| confidence on its own answers | p25 0.0043 · **p50 0.0053** · p75 0.0118 · max 0.0605 (p50 0.0070 on the rows that proposed something) |
| confidence reported as zero | none — the engine always answered with a number, and the number is ~0.005 |
| if every withheld proposal were taken as the answer | **3 of 24 = 12.5 %**, against the residue's `always nudge` constant of 54.2 % |
| latency | p50 54 s · p95 264 s · max 11,868 s |

**The answer to the operator's question, plainly: the engine still fails the task.** Twenty-four of
twenty-four decisions were refused, the proposals it did make are wrong three times out of four
against a constant, and the confidence it attaches to them is five thousandths. Fixing the usage did
not rescue it.

**What the fix did change is that the failure is now legible.** Before, all 24 rows read "produced
nothing" and there was no way to tell a declining model from a wedged one. Now the record shows which
op the engine considered (`flag`, mostly — the same prior toward "a human should look" as every
earlier run), at what confidence, and, on the four rows that genuinely ran out of room, the engine's
own `error_code: "truncated"` — a field this adapter discarded until today.

Two caveats on the numbers above, both recorded rather than smoothed over:

- **The latency columns are not usable.** The host suspended at 01:21 (systemd-logind, 2026-11-15)
  while a row was in flight, so the 11,868 s max is a suspend, not a decode. The record's own `notes`
  field already says the raised cap makes latency non-comparable; the p50 of 54 s is the only figure
  worth reading, and on a quiet box the same decision is ~12 s.
- **Four rows still truncate at 320 tokens.** The window is the binding constraint: 331-token prefix
  + ~330 state block + 320 = 981 of 1024. Giving the reasoning more room means shrinking the tail
  (`MAX_TAIL_CHARS`, 700 today), not raising the budget — a lever nobody has pulled.

The 502-row task set the older records cite was not re-run: at a p50 of 54 s a row it is ~7.5 hours of
median time with a multi-hour tail, and the residue is the set that measures the question this
architecture asks. When the box is quiet, `node bench/runners/run.ts needle3 --limit=22
--taskset=bench/tasks/2026-10-26.b9765d1a55e18b4e.jsonl` re-measures the superseded 22-row records on
their own rows.
## What is not a bug

- **Tool schema shape.** `@needle.tool` with type hints and a docstring is the engine's own
  convention; `build_schema` produces `{name, description, parameters}` and the decode grammar is
  compiled from it. Nothing to fix.
- **`complete()` instead of `run()`.** `run()` executes the tool and re-decodes on the result, which
  is pointless when the tools return a sentinel; one decode per decision is right.
- **The extra `reset()`.** `complete()` already resets when `stateless=True`; the explicit call is
  redundant, not harmful.
- **The presence of a system prompt at all.** Removing it entirely (the `none` column) did not improve
  the answer.

## One hypothesis the experiment does not support

I expected the prompt format to be the culprit: our `SYSTEM` asks for `{"op": ..., "argument": ...}`
— a JSON envelope — while the engine's grammar can only emit reasoning plus a tool call. The
`none` configuration removed that instruction entirely and the model still answered `flag, flag` at
confidence 0.003. So the JSON instruction is **wrong on the design** (it asks for an output the
grammar cannot produce, and it explains why every reasoning trace reads like deliberation about the
task rather than a decision) but it is **not proven to be the cause** of the refusal. Say that
plainly rather than promoting a plausible story to a finding.

## What the corrected harness would be, and what it would cost to run

1. `MAX_NEW_TOKENS = 320`, and pass `system=SYSTEM` to `needle.Needle(...)` so the prefix carries it
   and the query is the state block alone (331 + ~330 + 320 = 981 < 1024).
2. Raise the adapter deadline to ≥ 180 s, or measure on a quiet box and record the load.
3. Keep `suppressed_calls`: surface `{op, argument, confidence}` from the first withheld call as
   `proposed` beside `refused`, so "the engine declined to commit this" stops reading as "the model
   said nothing".
4. Keep `error`, `error_code`, `success`, `decode_tps` on the decision row.
5. Replace the JSON instruction in `SYSTEM` with a tool-call instruction, or drop it.

**The cost of finding out is box time, not money**: one decode is 30–150 s here depending on load, so
the 24-row residue × 3 configurations is 1–3 hours on an idle machine and was not finishable today at
load 26–40. That is the run to do before anyone retires anything: **the same 24 rows, the correct
budget, the system in the prefix, the withheld calls surfaced** — and the number to beat is the
residue's majority constant, `always nudge` at 54.2 %.

Nothing is retired by this document. It says the verdict "needle3 cannot work" was reached on runs
that were mis-configured in four independent ways, that three of those are now measured rather than
suspected, and that the one corrected run we did get through still answers at confidence 0.003 — which
is a reason to run the fair test, not a reason to skip it.
