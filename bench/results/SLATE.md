# Slate — needle fine-tune variants, measured

Generated 2026-10-26T23:24:18.841Z by `bench/runners/slate.ts`. Every number below comes from a `.cact` on disk; a variant with no archive has no row.

> Commit hashes in this file were remapped on 2026-11-04, when history was rewritten to remove the private corpus (`git filter-repo --invert-paths --path bench/tasks/tasks.jsonl`). They name the same commits under new identities; the prose and the numbers are unchanged.

## Status

> **Correction — hand-added 2026-11-06, not generated.** The counts in this generated header are stale. `bench/runners/slate.ts` last ran at `2026-10-26T23:24:18.841Z`, before either variant was trained, and it has not been re-run because it rewrites this whole file from `slateMarkdown()` and would delete both hand-appended sections below (`## Compute location` and `# 2026-10-27 — trained slate`), which are the only record of the training that did happen. The generated count at `:9`, the per-variant `not trained` lines at `:13-16`, the absolute-path absence list under `## What is on disk` at `:47-50`, and the carrying sentence at `:137` are **superseded**. What is authoritative is this file's own `## What is on disk` inside `# 2026-10-27 — trained slate`, and `README.md:11` and `README.md:201`. Re-measured on disk 2026-11-06: **five `.cact` archives exist** — `d4` 15,378,708 B, `d8` 27,393,236, `d20` 63,437,076, which are one LoRA fit exported at three depths (the `d4` and `d8` adapters differ by a max tensor delta of 6.9e-3, i.e. float non-determinism, not two fits), plus the untuned controls `control-d4` 15,390,548 and `control-d8` 27,411,604. `triage` is the one variant that was never built and has no archive. So the correct count is **3 of the 4 declared fine-tunes exist and `triage` does not**, not 0 of 4. (Line numbers cited in this note are as of the file before it was inserted.)

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

- `/home/operator/work/fleet-supervisor/finetune/out/d4/d4.cact` — **absent**: not trained: `make slate` never reached this variant
- `/home/operator/work/fleet-supervisor/finetune/out/d8/d8.cact` — **absent**: not trained: `make slate` never reached this variant
- `/home/operator/work/fleet-supervisor/finetune/out/d20/d20.cact` — **absent**: not trained: `make slate` never reached this variant
- `/home/operator/work/fleet-supervisor/finetune/out/triage/triage.cact` — **absent**: not trained: `make slate` never reached this variant
- `/home/operator/work/fleet-supervisor/finetune/out/control-d8/control-d8.cact` — 27411604 bytes, 8 layers, benchmarked

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

`python -m venv .venv` at `<remote-workspace>/.venv`, then `.venv\Scripts\python.exe -m pip install "cactus-needle[train]"`. Resolved, from `importlib.metadata`:

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
    --out <remote-workspace>\logs\d321-<len>.json
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
- **Nothing was exported**, so there is no `.cact` from this work on either machine: `<remote-workspace>/out/` is empty, `finetune/out/slate/d4/` still holds only `data.json`, `train.jsonl` and `val.jsonl`, and `finetune/out/control-d8/control-d8.cact` remains the only archive in `finetune/out/`. The slate is still 0 of 4 fine-tuned variants, unchanged from the status above.

The remote workspace is left in place at `<remote-workspace>/` (venv, `data/` with the two splits, `tools.py`, the base checkpoint, `measure.py`, and `logs/d321-{1024,768,512,256}.json` with the raw trainer logs beside them). No process was left running; `Get-Process python` is empty and the box sits at 3-9% CPU.

---

# 2026-10-27 — trained slate: `d4` (this machine) and `d8` (dell321)

Hand-appended after the generated report above; `bench/runners/slate.ts` does not know about this run, and re-running it would overwrite this section.

Both variants were trained to completion and exported. The short version: **the archives exist, the measurement is real, and the fine-tune is not usable at any depth I measured** — best overall accuracy is 28% (`d4`) against 26% for its own untrained control, and the 8-layer tune turns 92% refusals into 82% wrong answers. `declare_done`, which has zero training rows, is the fine-tune's modal answer. Details and the numbers behind that sentence are below.

## The data this trained on, and what moved underneath it

| | |
|---|---|
| rows | `out/slate/{d4,d8}/train.jsonl`, **452** rows, sha `bc65ec827cf83feb` (identical for both) |
| per-op | `nudge` 366, `flag` 79, `leave` 7, `declare_done` **0** |
| val | `out/slate/{d4,d8}/val.jsonl`, **50** rows, sha `d6fb9ffd348b90c4` (`nudge` 40, `flag` 10) |
| tools | 665 chars, the same four schemas the decode grammar compiles from |
| window | `seq_len 640` (cap 640), prompt min 403 / mean 447.0 / max 573, row total max **641** |
| dead masks | **0/452** rows carry an all-zero mask at 640 — re-verified on the rebuilt rows, as the prompt-compaction run warned it must be |

The rebuild the compaction run asked for was done first, and it was necessary: `out/slate/*` still held the **old** SYSTEM in all 452 rows. Rebuilt through the Makefile (`make tools`, `node dataset.ts`) and `slate.py`'s own `prepare()`, then verified by grep:

- `"supervise one unattended coding agent. Pick exactly one action"` — **452/452** rows (new)
- `"supervise one coding agent working unattended"` — **0** rows (old)
- `"Reply with a single JSON object"` — **0** rows (old phrasing)

**A concurrent session rebuilt the corpus while this run was training.** `mine/out/decision-points.jsonl` was regenerated at 22:09 and `finetune/out/train.jsonl` at 22:12 (local), and commits `67ab9ea` ("the evidence that the learning half is unsound") and `3df75ef` ("rebuild the label vocabulary on evidence") landed mid-run. The rebuilt split is now **3 train rows / 1 val row** (`nudge` 2, `leave` 1). The slate rows this run trained on are the pre-change snapshot preserved at `out/slate/d4/` and `out/slate/d8/` (sha cited above); `out/train.jsonl` no longer matches them, so re-running `slate.py` today would prepare 3-row variants. Nothing was rebuilt a second time: the training in flight already held the 452-row snapshot, and 3 rows is not a trainable corpus.

## Training cost actually paid versus the 30.6 min projection

Both runs: `--epochs 3 --batch-size 16 --lr 1e-4 --max-len 640 --val-split 0.1 --seed 0 --lora-rank 16 --lora-alpha 32`, 26 steps/epoch, 78 steps total, 45-row internal holdout, an adapter written after **every** epoch.

| variant | host | epoch 1 (incl. compile) | epoch 2 | epoch 3 | total | steady s/epoch | vs 30.6 projection |
|---|---|---|---|---|---|---|---|
| `d4` | this machine (12 threads) | 1822.2 s = **30.4 min** | 1711.0 s = **28.5 min** | 1681.0 s = **28.0 min** | 5214.2 s = 86.9 min | 28.5 min | **1.07× better** |
| `d8` | dell321 (8 threads) | 2814.1 s = **46.9 min** | 2701.7 s = **45.0 min** | 2698.3 s = **45.0 min** | 8214.1 s = 136.9 min | 45.0 min | **1.47× worse** |

Measured step cost: **64.6 s/step** here, **103.9 s/step** on dell321 — **1.61×**, not the 1.02× the machine swap was recorded at. dell321 is 8 logical processors against 12 here and its JAX 0.10.2 (Windows) averaged 2.6 cores of work; the local JAX 0.12.0.1 held ~6.4. The 1.02× parity does not survive `--max-len 640` on these two builds.

Loss curves, per epoch (`val` is the trainer's own 45-row holdout, not the 50-row split the eval scores):

| variant | epoch 1 | epoch 2 | epoch 3 |
|---|---|---|---|
| `d4` | loss 0.9112 / val 0.8106 | loss 0.6859 / val 0.7402 | loss 0.6613 / **val 0.7241** |
| `d8` | loss 0.9079 / val 0.8122 | loss 0.6868 / val 0.7366 | loss 0.6571 / **val 0.7243** |

The two adapters are the same tune: comparing all 10 adapter tensors, the largest difference is **6.9e-3** (2.2% of the largest weight, 3.1e-1), i.e. float non-determinism across core counts, not a different fit. **So every difference between the `d4` and `d8` rows below is the export depth, not the training.**

## Comparison — 50-row held-out split, `train`-exact tools, `max_new_tokens` 96

One run per archive. `control-d4` and `control-d8` are the published base sliced to the same depth with no adapter (the `d20` row is a diagnostic: `d4`'s adapter exported at full depth, built to tell "depth broke it" from "the tune did nothing").

| archive | layers | adapter | exact | answered | refusals | nudge recall | flag recall | `declare_done` predicted | p50 | ECE |
|---|---|---|---|---|---|---|---|---|---|---|
| `control-d4` | 4 | none | 26.0% | 41/50 | 9 (18.0%) | 27.5% (11/40) | 20.0% (2/10) | 12 | 226 ms | 0.167 |
| **`d4`** | 4 | tuned | **28.0%** | 45/50 | 5 (10.0%) | **32.5%** (13/40) | 10.0% (1/10) | 19 | **206 ms** | n/a |
| `control-d8` | 8 | none | 0.0% | 4/50 | 46 (92.0%) | 0.0% | 0.0% | 0 | 340 ms | 0.069 |
| **`d8`** | 8 | tuned | **6.0%** | 41/50 | 9 (18.0%) | 7.5% (3/40) | 0.0% | **30** | 320 ms | n/a |
| `d20` | 20 | tuned | 10.0% | 26/50 | 24 (48.0%) | 10.0% (4/40) | 10.0% (1/10) | 10 | 1100 ms | n/a |

Confusion, true → predicted (`d4` / `d8`):

- `nudge` (40): `nudge` 13 / 3, `declare_done` 18 / 26, `flag` 4 / 5, `leave` 1 / 1, refused 4 / 5
- `flag` (10): `nudge` 6 / 2, `flag` 1 / 0, `declare_done` 1 / 4, `leave` 1 / 0, refused 1 / 4

Three things the table says that the summary line does not:

1. **Depth is a cliff, not a slope.** The untuned 8-layer base refuses 46/50 (0% exact); the untuned 4-layer base answers 41/50 and gets 26% by accident. Slicing to 8 produces something that will not commit; slicing to 4 produces something that commits to noise. Tuning the 8-layer rung moves it from "escalate everything" to "answer 41/50 and be wrong 38 times" — a **regression** for a ladder whose refusals route to a stronger model, and the single most important number in this table.
2. **The tune barely moves accuracy at 4 layers**: +2.0 points overall (26.0% → 28.0%), `nudge` +5.0 (27.5% → 32.5%), `flag` −10.0 (20% → 10%). What it does move is commitment: refusals 9 → 5.
3. **Full depth does not rescue it** (`d20`: 10.0%), so this is not "the slice was too small" — the adapter itself does not carry the op mapping, while it does carry the argument (the emitted `reasoning`/argument text follows the prompt; the op does not).

## `declare_done` — zero targets, and still the modal answer

`declare_done` has **0** rows in the corpus and stays unlearnable: no variant can recall it, and its precision column is meaningless because there is nothing to recall. That was known. What was not known is that the fine-tune **emits it anyway**: 19/50 decisions at `d4` and **30/50 at `d8`**, against 12/50 and 0/50 for the untuned controls. It is not a class the model learned and not a class it can be scored on; it is where the tuned weights put mass when the grammar offers a fourth tool. `triage` (3-tool scope) is the variant that would have tested whether removing the op from the grammar removes the attractor — it is **not trained**, and the corpus rebuild means it now cannot be trained from this data.

## Confidence calibration

`needle build --lora` **drops the confidence head**, so all three tuned archives report `confidence: None` for every call and their deciles are empty by construction: `d4`, `d8` and `d20` have no calibration number at all. The two controls keep the head and do report one — `control-d4` ECE 0.167 over 50 calls (45 of them in the 0.1-0.2 band, mean confidence 0.138 for 31% accuracy) and `control-d8` ECE 0.069 over 50 calls, but that second number is computed on 46 refusals binned at 0-0.2 and is not evidence of calibration. Any claim that the slate is "calibrated" would need `needle platform finetune` to keep the head.

## What is on disk

| path | bytes | layers | tensors |
|---|---|---|---|
| `finetune/out/d4/d4.cact` (and `finetune/out/slate/d4/d4.cact`) | **15,378,708** | 4 | 126 |
| `finetune/out/d8/d8.cact` (and `finetune/out/slate/d8/d8.cact`) | **27,393,236** | 8 | 238 |
| `finetune/out/d20/d20.cact` — diagnostic, `d4`'s adapter at full depth | 63,437,076 | 20 | 574 |
| `finetune/out/control-d4/control-d4.cact` — diagnostic, untuned 4-layer base | 15,390,548 | 4 | 133 |
| `finetune/out/control-d8/control-d8.cact` — pre-existing control | 27,411,604 | 8 | - |

Adapters: `finetune/out/slate/d4/adapter.safetensors` (7,906,640) and `finetune/out/slate/d8/adapter.safetensors` (7,906,632), plus `ckpt/epoch{1,2,3}.safetensors` per variant. Logs: `finetune/out/slate/{d4,d8}/train.log` (78 step lines each). Raw eval reports: `finetune/out/{d4,d8,d20,control-d4}/eval.json`, `finetune/out/control-d8/eval-slate.json`. `d8` was trained, exported and merged on dell321 (`needle build --lora ... --layers 8`, 27.39 MB) and the `.cact` copied back; `d4` was built here.

## Cloud row

`openrouter:z-ai/glm-5.3-flash` — **not run — no key**. `OPENROUTER_API_KEY` is unset in this workspace and the hosted comparison is the operator's to run; a hand-written row would be a fabrication.

## How this run deviates from the plan, and what bounds it

- **`d8`'s first checkpoint came at 46.9 minutes, past the 40-minute line.** It was not restarted or killed: it was stepping every ~103 s the whole time, so the "no checkpoint in 40 minutes" failure mode was a slow machine, not a dead run. This is the judgment call in the run; a machine that is 1.61× slower per step makes the 40-minute rule fire on a healthy job.
- **Both trainers' post-training exact-call pass was cut.** `_score_quantised` calls `generate()` per held-out example with `max_new_tokens=96`, and `generate` re-traces for every distinct `buf_len` (499-669 across this split), so 45 examples cost 45 compiles: `d4`'s pass ran 30 minutes without finishing and `d8`'s was stopped the moment its third epoch checkpoint landed. `eval.py` above is the measurement of record; the trainer's own `accuracy … held-out calls exact` line does not exist for either variant.
- **`finetune/epoch_train.py` is not from the installed package.** `needle finetune` writes its adapter once, after the last epoch, and has no resume flag, so per-epoch durability had to come from somewhere: that file drives the package's own primitives (`fit_max_len`, `load_jsonl`, `init_lora`, `merge_lora`, `cq_ste_params`, `write_adapter`) through the identical loop and schedule and adds the per-epoch `write_adapter`. Equivalence was checked before the real runs: on a 16-row micro set the CLI and this driver print the same losses to four decimals (`0.8169`/`0.8182`, `0.8023`/`0.7995`) and the same `0/4` held-out score. It was swept into commit `27d4921` by the concurrent session, not committed by this one.
- **One run each.** With 50 val rows a single row is 2 points, and the earlier control-d8 measurement recorded run-to-run wobble of 37-40 refusals of 40 on the bench set. The 28% vs 26% gap between `d4` and its control is roughly one row; the `d8` collapse (30 `declare_done`) and the refusal swing (46 → 9) are far outside that wobble and are the findings worth acting on.
- `leave` has **7** corpus rows and **0** val rows: its recall column is unmeasurable here, in both directions.
