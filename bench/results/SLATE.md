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


## Compute location

The 262.4s/step baseline above was measured on the loaded laptop (i5-1235U, 12 threads, under load 11-12 from `llama-server` plus two VMs). Moving the fine-tune to `dell321` (Core Ultra 7 258V, 8 cores / 8 threads, 31.6GB, CPU-only — the Arc 140V has no jax backend) removes the contention but **buys no measurable speedup at the configuration that was measured**: 258.2s/step against 262.4s/step, **1.02x**. The two chips are within noise of each other for this workload; dell321's newer cores are offset by its four fewer logical threads.

### Remote environment

`python -m venv .venv` at `C:/Users/andre/agentFleet-train/.venv`, then `.venv\Scripts\python.exe -m pip install "cactus-needle[train]"`. Resolved, from `importlib.metadata`:

| package | dell321 | this laptop |
|---|---|---|
| cactus-needle | 3.2.8 | 3.2.8 |
| jax | 0.10.2 | 0.12.0.1 |
| jaxlib | 0.10.2 | 0.12.0.1 |
| flax | 0.12.8 | 0.12.10 |
| optax | 0.2.8 | 0.2.8 |
| numpy | 2.4.6 | 2.5.4 |
| sentencepiece | 0.2.2 | 0.2.2 |
| safetensors | 0.8.0 | 0.8.0 |

`jax.default_backend()` is `cpu`, `jax.devices()` is `[CpuDevice(id=0)]`, `jax_enable_x64` False. `needle` is the same 3.2.8 on both machines, so the trainer code under measurement is identical; only the jax version and the silicon differ.

### Measured step rate

Same corpus, same flags, same file: a 48-row slice of `out/slate/d4/train.jsonl` holding the 48 longest rows, so `fit_max_len` stays in the 1024 bucket and 48 rows at batch 16 is exactly 3 optimizer steps. Step 1 carries the JIT compile and is excluded; the rate is the mean delta between consecutive `step N/M` log lines, with the wall clock taken by the harness.

```
.venv\Scripts\python.exe measure.py --label d321-<len> --jsonl <that slice> \
    --max-len <len> --epochs 1 --deadline <n> \
    --out C:\Users\andre\agentFleet-train\logs\d321-<len>.json
```

which invokes the baseline flags verbatim from `finetune/out/slate/_probe/d4/probe.log`:

```
needle finetune <slice> --checkpoint data/needle3.safetensors --epochs 1 --batch-size 16 \
    --lr 1e-4 --max-len <len> --val-split 0.0 --seed 0 --lora-rank 16 --lora-alpha 32 \
    --checkpoint-dir logs/d321-<len>/ckpt --out logs/d321-<len>/adapter.safetensors
```

| max-len | seq_len logged | step deltas (s) | s/step | s/epoch (29 steps) | min/epoch | speedup vs 262.4s/step | trains the corpus? |
|---|---|---|---|---|---|---|---|
| 1024 | 1024 | 235.7, 280.7 | **258.2** | 7487.8 | **124.8** | **1.02x** | yes — 452/452 intact |
| 768 | 768 | 130.6, 137.6 | 134.1 | 3888.9 | 64.8 | 1.96x | yes — 451/452 intact, 1 truncated |
| 512 | 512 | 105.2, 112.5 | 108.8 | 3156.6 | 52.6 | 2.41x | **no — 440/452 produce no gradient** |
| 256 | 256 | 37.3, 36.9 | 37.1 | 1075.9 | 17.9 | 7.07x | **no — 452/452 produce no gradient** |
| local @1024 (baseline) | 1024 | - | 262.4 | 7609.6 | 126.8 | 1.00x | yes |

`seq_len` is not a free parameter: `needle/model/finetune.py:272 fit_max_len` takes the longest rendered example, rounds it up to a 128/256/512/1024 bucket, then clamps to `--max-len`. The corpus renders to 503-775 tokens (mean 631), so cap 1024 and cap 512 are the only questions and 512 is not a bucket you can land between.

### Why 512 and 256 do not train

Shorter sequences are not a cheaper operating point on this corpus, they are a non-training configuration. `_encode` (`needle/model/finetune.py:216`) builds `mask = [0.0] * (1 + len(prompt_ids)) + [1.0] * (len(target_ids) + 1)` and only then truncates: `ids, mask = ids[:max_len], mask[:max_len]`. When the prompt alone fills the window the whole target is cut away, `mask.sum()` is 0, and the loss is `(ce * mask).sum() / max(mask.sum(), 1.0)` = 0.0 with a zero gradient. The trainer reports exactly that — every step at `--max-len 512` and `--max-len 256` logged `loss 0.0000`, against `0.6853 / 0.7548 / 0.7255` at 768 and `0.6853 / 0.7560 / 0.7253` at 1024.

Rendered lengths for the 452 training rows, counted against `_encode`'s own arithmetic (prompt 473-700 tokens, target 25-134):

| max-len | rows with all-zero mask | rows with target truncated | rows with target intact |
|---|---|---|---|
| 1024 | 0/452 | 0/452 | 452/452 |
| 768 | 0/452 | 1/452 | 451/452 |
| 704 | 0/452 | 13/452 | 439/452 |
| 512 | **440/452** | 11/452 | 1/452 |
| 256 | **452/452** | 0/452 | 0/452 |

The floor is set by the longest prompt (700 tokens + BOS), so anything at or below 701 trains almost nothing, and 768 is the cheapest length that still puts a gradient on every row. The 401-token static prefix is real but the decision content stacks on top of it: the mean row is 573 prompt tokens before the answer starts.

### Decision: not trained

The stated gate was "if dell321@512 projects to under ~45 min/epoch, run one full epoch of `d4`". **dell321@512 projects to 52.6 min/epoch, so the gate fails and no run was started.** It fails twice over: 52.6 > 45, and 512 is not a configuration that trains this corpus at all, so paying 52 minutes there would have produced an adapter fitted to a zero loss over 440 of 452 rows. The cheapest *valid* length, 768, projects to 64.8 min/epoch — still over the gate, and 12 epochs (the `SLATE_EPOCHS` default) would be ~13 hours on dell321 against ~25 hours here. A machine swap does not close the 600s/epoch budget gap; only a corpus-and-prefix change does, because the budget was always about 573 prompt tokens per row, not about which CPU runs them.

Two further reasons the projections above are floors rather than estimates:

- **Only 2 timed steps per configuration**, which is the minimum this measurement is allowed to rest on, and each pair drifts upward as the part heats: 235.7 -> 280.7 at 1024, 130.6 -> 137.6 at 768, 105.2 -> 112.5 at 512. The 258V is a 17-30W part, so a sustained 29-step epoch will sit below the burst rate these numbers come from. Treat every min/epoch in the table as optimistic.
- **Nothing was exported**, so there is no `.cact` from this work on either machine: `C:/Users/andre/agentFleet-train/out/` is empty, `finetune/out/slate/d4/` still holds only `data.json`, `train.jsonl` and `val.jsonl`, and `finetune/out/control-d8/control-d8.cact` remains the only archive in `finetune/out/`. The slate is still 0 of 4 fine-tuned variants, unchanged from the status above.

The remote workspace is left in place at `C:/Users/andre/agentFleet-train/` (venv, `data/` with the two splits, `tools.py`, the base checkpoint, `measure.py`, and `logs/d321-{1024,768,512,256}.json` with the raw trainer logs beside them). No process was left running; `Get-Process python` is empty and the box sits at 3-9% CPU.
