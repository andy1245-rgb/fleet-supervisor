# Invalidated needle3 records — 2026-11-14

> The trial these records belong to is **closed**: read `bench/results/NEEDLE3-CLOSED.md` first. This
> file is the list of what the closing record invalidates.

Every `needle3` record in `bench/results/` was produced by an adapter that was mis-configured in at
least two independent ways, and every `slate` record by a bridge with the same decode budget. **None
of them measures the model.** They stay in the tree as history — a record is what was measured — but
nothing may cite them as a statement about needle3's capability. The faults and their measurements are
in `docs/needle3-usage-review-2026-11-14.md`; the short version:

- **F1 — the decode budget was 96 tokens**, shorter than this prompt's reasoning preamble, so the
  reasoning was truncated mid-sentence and no tool call was ever emitted. Measured: at 96 tokens,
  zero calls in three system-prompt placements; at 320–384, calls appear.
- **F2 — the system prompt went into the query while `needle_init` was called with none**, so the
  engine built a 156-token prefix where passing `SYSTEM` builds 331, and the budget arithmetic in the
  sidecar priced a prefix it was not using. (The fine-tune corpus and the slate bridge put `SYSTEM`
  in the query by design, so for the slate this is a consistency question rather than a fault — see
  the note at the end.)
- **F3 — the withheld proposal was discarded.** `suppressed_calls` is the call the engine declined to
  commit; the adapter kept a count and dropped the name, the argument, and the engine's `error`,
  `error_code`, `success`, `decode_tps` and `validation`. "The engine proposed `flag` and withheld it
  at confidence 0.03" was recorded as "the model produced nothing".
- **F4 — the deadline was 30 s** against decodes measured at 87–277 s on a loaded box, so a
  record's `refusals` could be a statement about the deadline rather than about the model.

## The list

| record | n | faults | what it actually recorded |
|---|---|---|---|
| `2026-10-26T21-47-52-144Z__needle3.json` | 20 | F1 F2 F3 F4 | 20/20 at the 30 s cap (p50 30,004 ms) |
| `2026-10-26T22-18-46-002Z__needle3.json` | 3 | F1 F2 F3 F4 | 3/3 at the 30 s cap |
| `2026-10-26T22-42-18-769Z__needle3.json` | 22 | F1 F2 F3 | the `run()` double-decode era, all refused |
| `2026-10-26T22-59-13-964Z__needle3.json` | 22 | F1 F2 F3 | the same rows after the one-decode fix, all refused |
| `2026-10-26T23-21-59-933Z__needle3.json` | 3 | F1 F2 F3 F4 | 3/3 at the 30 s cap |
| `2026-10-27T00-22-33-299Z__needle3.json` | 22 | F1 F2 F3 | all refused |
| `2026-10-27T00-43-19-911Z__needle3.json` (+ `.rescored.json`) | 22 | F1 F2 F3 | all refused; the rescore re-reads the same decisions |
| `2026-11-04T11-04-36-485Z__needle3.json` | 6 | F1 F2 F3 F4 | 6/6, p50 70,825 ms |
| `2026-11-04T11-05-56-783Z__needle3.json` | 22 | F1 F2 F3 F4 | 8 timeouts + 14 refusals |
| `2026-11-10T10-12-52-421Z__needle3.json` | 4 | F1 F2 F3 | the 600 s timeout probe: 4/4 refused, but with 96 tokens the probe could not have produced a call anyway |
| `2026-11-11T20-42-02-808Z__needle3.json` | 24 | F1 F2 F3 F4 | residue at the 30 s cap: 24/24 |
| `2026-11-11T20-57-21-479Z__needle3.json` | 24 | F1 F2 F3 | residue at a 600 s cap: 24/24 refused, p50 36,601 ms |
| `2026-10-26T23-24-18-841Z__slate-control-d8.json` | 40 | F1 F3 | 37/40 refused, p50 994 ms |
| `2026-11-11T20-33-43-775Z__slate-d4.json` | 24 | F1 F3 | 7/24 refused, exact 0.375 — **ops did emerge at 96 tokens**, which is exactly why this cannot be compared with the needle3 rows above: the two paths were not measuring the same configuration |
| `2026-11-11T20-39-26-872Z__slate-d8.json` | 24 | F1 F3 | 10/24 refused, exact 0 |
| `2026-11-11T20-52-42-495Z__slate-d20.json` | 24 | F1 F3 | 16/24 refused, exact 0.125 |
| `2026-11-11T20-57-36-550Z__slate-control-d8.json` | 24 | F1 F3 | 22/24 refused, exact 0.0417 |

Two consequences worth stating rather than leaving implicit:

- **`bench/results/SLATE.md` and `bench/results/SLATE-residue.md` inherit this.** Their per-variant
  tables are 96-token measurements. The *relative* comparison inside one slate run still has meaning
  — every variant got the same budget — but no absolute claim ("variant X is worse than chance", "the
  fine-tune changed nothing") survives, and no cross-run comparison between slate and needle3 does.
- **Every `decision` row in a live supervisor's `events.jsonl` written before 2026-11-14 carries the
  same four faults.** `~/.pi/agent/fleet-state/events.jsonl` and the observe span are not bench
  records, but they are not measurements of the model either.

## What is valid

**`2026-11-15T09-52-19-800Z__needle3.json`** — the first record from the corrected adapter (system
prompt in the static prefix, 320-token decode budget, withheld proposals and the engine's diagnostics
carried onto the row, a deadline above the engine's measured latency). It is the only needle3 record
to cite. Task set `bench/tasks/2026-11-11.5107ea0a31d02527.jsonl` (the residue, n = 24).

What it shows, and it is the same verdict reached honestly: **0 of 24 committed, 20 of 24 with a
proposal the engine withheld (`flag` 14, `nudge` 2, `declare_done` 2, `leave` 2), 4 truncated
(`error_code: "truncated"`), confidence p50 0.0053, and 3 of 24 correct if every withheld proposal
were taken as the answer against a 54.2 % constant.** The usage fix made the failure legible; it did
not make the engine pass. Its latency columns are unusable — the host suspended mid-run — and the
record says so in its own `notes`.

The 502-row task set the older records cite has not been re-run under the corrected adapter: at a
p50 of 54 s a row that is ~7.5 hours of median time with a multi-hour tail. Until it is,
`2026-10-26.b9765d1a55e18b4e` has **no valid needle3 measurement at all**, and the older records
remain exactly what they are — history, not evidence.

## The one caveat the correction introduces

The sidecar now passes `SYSTEM` to the constructor, and the engine prefixes it once. The fine-tune
corpus (`finetune/dataset.ts`) and the slate bridge (`finetune/slate_bridge.py`) both put `SYSTEM`
into the **query**, because that is the text their adapters were trained on. That is deliberate: a
LoRA variant must be served the prompt it was fitted to. It also means a `slate` record and a
`needle3` record now differ in prompt placement as well as in weights, and must not be compared
row-for-row. Each is internally consistent; the difference is stated here so nobody reads a gap
between them as a difference in the model.
