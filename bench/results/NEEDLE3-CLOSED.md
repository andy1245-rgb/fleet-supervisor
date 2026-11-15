# needle3 — the trial, closed

2026-11-15. This is the closing record for the Tier-0 pre-filter: the local 121M-parameter engine
(`needle3`) that was to decide one of four ops per moved pane so the hosted model was only paid for
the panes it refused. It is retired from the hot path and kept in the tree. Read this before any
`needle3` record in this directory.

**The verdict, in one sentence: not that the engine is bad in the abstract, but that when it is used
correctly it proposes `flag` at a confidence of about five thousandths and the engine withholds it —
a task-framing failure, not a decoding one.**

## The four usage faults, and the measurement behind each

For most of this trial's life the adapter was mis-configured in four independent ways. Every record
written before 2026-11-15 was produced under at least one of them, which is why the older write-ups
report "no parseable decision on any row" and then disagree about whether that means the model or the
plumbing.

| # | fault | the measurement |
|---|---|---|
| F1 | **decode budget 96 tokens**, shorter than this prompt's reasoning preamble | at 96 the reasoning is truncated mid-sentence and **no call is emitted in any of three system-prompt placements**; at 320–384 the model reaches one |
| F2 | **system prompt in the query**, with `needle_init` called with none — so the prefix was 156 tokens where passing `SYSTEM` builds 331, and the budget arithmetic priced a prefix it was not using | `needle_init` returns both numbers directly; the sidecar's own comment argued from 333 |
| F3 | **the withheld proposal and the engine's diagnostics were discarded** — `suppressed_calls` reduced to a count, `error`/`error_code`/`success`/`decode_tps`/`prefill_tps`/`validation` dropped entirely | "the engine proposed `flag` and withheld it at 0.03" and "the model said nothing" wrote the same row |
| F4 | **deadline 30 s** against decodes measured at 87–277 s on a loaded box | the bound records were statements about the deadline, not about the model |

All four are fixed in `ffc2fdf`; the reasoning for each is in `docs/needle3-usage-review-2026-11-14.md`.

## Which records they invalidate

**Twelve `needle3` records — one of them with a re-scored twin — and five `slate` records**, listed
one by one with the faults that applied and what each actually measured, in
`bench/results/INVALIDATED-needle3.md`. They stay in the tree — a record is what was measured — and
none of them may be cited as a statement about the model.

Three things inherit the same caveat and are named there too: `bench/results/SLATE.md` and
`bench/results/SLATE-residue.md` (their per-variant tables are 96-token measurements, so relative
comparisons inside one run survive and absolute claims do not), and every `decision` row in a live
supervisor's `events.jsonl` written before 2026-11-15.

## The corrected re-run

Same frozen task set as the two most recent superseded records — the residue, `taskSetSha`
`5107ea0a31d02527`, n = 24 — with the system prompt in the static prefix, a 320-token budget, the
withheld calls and the diagnostics carried onto the row, and a deadline above the engine's measured
latency. `bench/results/2026-11-15T09-52-19-800Z__needle3.json`.

| | |
|---|---|
| committed ops | **0 of 24** (`usableOutputRate` 0) |
| proposed and withheld | **20 of 24** — `flag` 14, `nudge` 2, `declare_done` 2, `leave` 2 |
| produced nothing | 4 — the engine's own `error_code: "truncated"`, `success: false` |
| confidence on its own answers | p25 0.0043 · **p50 0.0053** · p75 0.0118 · max 0.0605; none at zero |
| if every withheld proposal were taken as the answer | **3 of 24 = 12.5 %**, against the residue's `always nudge` constant of 54.2 % |

## Why this is a framing failure and not a decoding one

The distinction is the whole of the closure, so it is worth stating precisely rather than asserting:

- **Decoding worked.** With a correct budget the model produces a complete reasoning block on 20 of
  24 rows and a tool call on 20 of them. The four that failed did not fail at language; the engine
  says `truncated` and it is telling the truth about its own token budget. A decoding failure would
  be malformed output, unparseable envelopes, or self-repetition — none of which appears in the
  corrected record.
- **What it decodes to is an escape.** Fourteen of the twenty proposals are `flag`, the "a human
  should look at this" op. Six are actual decisions. That is not the behaviour of a model that cannot
  decode the grammar; it is the behaviour of a model that has not recognised what it is being asked.
- **The confidence says so.** p50 0.0053, and never once zero — the calibrated head is reporting
  nearly no belief, on every row, while the decode is clean. A model that had the task would put its
  probability mass somewhere; this one puts it nowhere and hands back the escape op.
- **The input is a state dump, not an utterance.** The package's design guidance for these tools is
  "one tool per action, names users would say, triggers in the descriptions". Ours are four
  supervisor verbs and an input that is a key–value block of pane state. The engine was trained to
  map *what a user said* onto tools; nothing in the prompt tells it that a supervision contract is
  the thing being decided. Its reasoning says as much, in its own words, on the rows that speak.

So the honest summary of the trial is: **the harness was broken, we fixed it, and behind the harness
was a framing mismatch.** Those are two different failures and only the first was ours to fix.

## What the closure does not claim, and what would change it

It does not claim that a small local engine cannot do this task. The levers that remain, in
increasing cost:

1. **Re-frame the input.** Serve the decision as an instruction — "this pane has been idle two
   minutes; should it be nudged?" — rather than a state block, so the model is asked a question in
   the shape it was trained on. Cheapest, untried, and the one the evidence points at.
2. **Shrink the tail** (`MAX_TAIL_CHARS`, 700 → ~450) to stop the four truncated rows truncating. A
   budget lever, not a framing one.
3. **A model with a trained probe.** The published AUROC figures that made this idea attractive
   belong to Cactus's post-trained `-hybrid` checkpoints, not to the base engine, which carries no
   trained confidence head for this distribution.
4. **Fine-tune on this corpus** — what the slate was for; its results are invalidated wholesale, so
   that experiment has not actually been run.

Any of these would be a new trial with a new record. None is scheduled, and nothing in the tree
should be read as saying one of them is underway.

## What stays in the tree

`src/decision/needle.ts`, `needle_sidecar.py`, the ladder, `finetune/` and every archive under
`finetune/out/` remain, out of the hot path (`AGENTFLEET_PRIMARY` still selects `needle3` for anyone
who wants it). The invalid records remain as history. The one citable needle3 number in this
directory is `2026-11-15T09-52-19-800Z__needle3.json`, and it says the engine refuses all 24 rows.
