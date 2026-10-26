# Slate — needle fine-tune variants, measured

Generated 2026-10-26T23:24:18.841Z by `bench/runners/slate.ts`. Every number below comes from a `.cact` on disk; a variant with no archive has no row.

## Status

**0 of 4 fine-tuned variants exist on disk.** Measured this run: `control-d8`.

The slate was not trained. One epoch of `d4` measured **126.8 minutes** against a 600s per-epoch budget, so training was killed after two steps and the remaining variants were never started — `make slate` runs the whole sequence once the wall clock allows it. The command that produced this measurement, and its raw log, are named below.

- `d4` — not trained: `make slate` never reached this variant
- `d8` — not trained: `make slate` never reached this variant
- `d20` — not trained: `make slate` never reached this variant
- `triage` — not trained: `make slate` never reached this variant
- `control-d8` — control: the published base sliced to the rung, no adapter. It prices the depth and the refusal baseline; it is not a fine-tune and must not be read as one.

## Training cost actually paid

Probe before the slate (`cd finetune && ../.venv/bin/python slate.py probe --variant d4 --max-epoch-seconds 600`, raw log `finetune/out/slate/_probe/d4/probe.log`): `d4` measured **262.4s per training step** over 2 of 29 steps in an epoch, so **7609.6s (126.8 min) per epoch** against a 600s budget — OVER BUDGET. time box: an epoch costs more than 600s, so the run was killed after two steps.

| variant | layers | epochs | measured s/epoch | wall | adapter | adapter size |
|---|---|---|---|---|---|---|
| `control-d8` | 8 | 0 | none | 0.0 min | control — base checkpoint, no adapter | - |

LoRA trains on the full 20-layer base whatever `--layers` says: `needle build --lora` merges the adapter and *then* slices the rung, so the three depth variants share one fine-tune and differ only in what was exported.

## Comparison

| variant | layers | labels | exact | leave | nudge | declare_done | flag | refusals | p50 ms | p95 ms | $/1k | regret/task |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| `control-d8` | 8 | leave, nudge, declare_done, flag | 15.0% | 0.0% | 0.0% | n/a | 85.7% | 37/40 | 994 | 1210 | $0.00 | 1.150 |

Task set `b9765d1a55e18b4e`, 40 rows, identical for every variant.

`$0` per 1k is the marginal price of a local archive, not its cost: the real price of a depth rung is latency (below) and the size of the weights it loads. A refusal is scored as `flag`, the same convention `src/decision/types.ts parseDecision` uses for an unparsed answer, so the flag column carries the refusals and the refusal count is shown beside it.

## Strengths — which variant wins which op

- **leave** — `control-d8` at 0.0% recall over 7 row(s), the only variant measured on this op.
- **nudge** — `control-d8` at 0.0% recall over 26 row(s), the only variant measured on this op.
- **flag** — `control-d8` at 85.7% recall over 7 row(s), the only variant measured on this op.

## What is on disk

- `/home/andrew/agentFleet/finetune/out/d4/d4.cact` — **absent**: not trained: `make slate` never reached this variant
- `/home/andrew/agentFleet/finetune/out/d8/d8.cact` — **absent**: not trained: `make slate` never reached this variant
- `/home/andrew/agentFleet/finetune/out/d20/d20.cact` — **absent**: not trained: `make slate` never reached this variant
- `/home/andrew/agentFleet/finetune/out/triage/triage.cact` — **absent**: not trained: `make slate` never reached this variant
- `/home/andrew/agentFleet/finetune/out/control-d8/control-d8.cact` — 27411604 bytes, 8 layers, benchmarked

## Cloud row

`openrouter:z-ai/glm-5.3-flash` — not run — no key. A hand-written row would be a fabrication; the existing `bench/results` records are the only cloud numbers this workspace has.

## Coverage gaps that bound these results

- `declare_done` has **zero** targets in the corpus (502 mined rows: nudge 406, flag 89, leave 7, declare_done 0). No variant can learn it, so its column reads `n/a` and its precision is not evidence of anything. It is out of scope for `triage` for that reason.
- `triage` keeps the same rows as the full-label variants — `declare_done` has no rows to drop — so what distinguishes it is the 3-tool catalogue its training lines and its decode grammar carry, not the row set. That is the shape a real scope variant takes; on this corpus the scope difference is only in the grammar.
- `leave` has 7 rows corpus-wide, so its recall is a 7-example statistic in the corpus and a smaller one in any sample; a 10-point move on it is one row.
- The engine samples: three runs of the *same* `control-d8` archive over this same task set came back between 37/40 and 40/40 refusals, with flag recall between 0.86 and 1.00. One row of difference between two variants is therefore not signal; only a gap wider than this run-to-run wobble is worth acting on.

