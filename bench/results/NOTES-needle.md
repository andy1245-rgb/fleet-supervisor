# needle3 sidecar — two defects fixed, verdict: still not a usable pre-filter

**Defect 1 (loop).** `run()` defaults to `max_steps=8`: it executes the tool, feeds the
results back, and decodes again. Even `max_steps=1` is two decodes and returns the *second*
one — our tools record nothing, so the loop priced a decision at 2× and returned a re-decode
of the sentinel. Measured on one prompt: `complete(96)` 2432ms vs `run(max_steps=1,96)` 4043ms.
Fix: `complete(text, max_new_tokens=96)`, one decode, no tool execution; tools now return
`{"ok": True}` anyway so raising max_steps later can't feed `None` back.

**Defect 2 (window).** 1024-token window, 401-token static prefix, so stock `max_new_tokens=512`
left 111 input tokens ≈ 421 chars — smaller than any fleet tail (p50 1609, max 2491 chars).
At 96 the input budget is 527 tokens ≈ 2000 chars. The budget is **total prompt**, not tail:
SYSTEM is 709 chars and the one-line field block ~370, so `MAX_TAIL_CHARS` is 700 (not 1500 —
1500 would put the prompt at 2552 chars, over budget, and measured 4447–4913ms vs 2530–3281ms).

**Before → after** (`--limit=22`, 7 `leave` / 12 `nudge` / 3 `flag`):
refusals 22 → 22; exactMatch 0.1364 → 0.1364; perOpRecall `nudge 0, leave 0, flag 1` → unchanged;
p50 6800 → 3776ms; p95 19469 → 5416ms; calls at the 30s adapter timeout: 3 → 0 (trace max 7894ms).
`npm test` 160/160, `tsc --noEmit` 0.

**Targets missed, and the residual is not these defects.** p50 3776 > 1500 and p95 5416 > 3000.
Prefill is the whole cost: an empty query is 40ms, SYSTEM alone (709 chars) 421–1455ms, the full
prompt ~1.6ms/char — the 30s/6800ms was the loop and the starved window, this leftover is the
engine's prefill rate on a box also running llama-server and two VBox VMs. No max_steps or token
budget fixes it; the SYSTEM prompt alone already exceeds a 1500ms prefill.

**Verdict: useless as a cheap pre-filter until the finetune lands.** 22/22 refusals, coverage 0.0
at every threshold 0.3–0.9, `leave` recall 0 on all 7 rows — the one op worth 5 regret. The ladder
escalates 100% of rows and pays ~3.8s for the privilege, so the "cheap" stage saves nothing. The
refusals are not wrong, they are just uninformative: fix here is weights that emit calls at usable
confidence, not more prompt plumbing.

---

# 2026-10-27 — the static prefix, compacted: 403 → 333 tokens

The window was never the problem; the ~400-token prefix (401 in the note that recorded it, 403 as
re-measured here with the chat and `<tools>` markers counted) paid for itself out of every prompt. The 452
rows in `finetune/out/train.jsonl` said so: prompt 473–700 tokens (mean 573) with only
~170 tokens of it being the pane. Compacting the prefix is the one lever that buys a shorter
sequence without touching what the model is asked to decide.

Measured with the engine's own tokenizer (`needle.model.tokenizer.get_tokenizer`, the sentencepiece
model the fine-tune trains against), not a character estimate:

    .venv/bin/python finetune/measure_window.py       # train split
    .venv/bin/python finetune/measure_window.py --split finetune/out/val.jsonl

| | before | after |
|---|---|---|
| `SYSTEM` (`src/decision/prompt.ts`) | 709 chars → **216** tokens | 515 chars → **170** tokens |
| four tool schemas (`finetune/out/tools.json`) | 780 chars → **174** tokens | 666 chars → **150** tokens |
| prefix, SYSTEM + tools | **390** tokens | **320** tokens |
| prefix as rendered (chat + `<tools>` markers) | **403** tokens | **333** tokens |

`≤ 200` was not reachable, and the reason is structural rather than stylistic. `needle.build_schema`
emits `{"name","description","parameters":{"type","properties","required"}}` per tool, and that
boilerplate alone is **109 tokens for four tools before a single description is written**; the tool
and parameter names cost another ~55. The floor with *empty* docstrings is 109 + SYSTEM, so even a
90-token SYSTEM could not carry four op definitions and the JSON reply contract. What shipped is the
honest minimum: 515 chars of SYSTEM that still defines all four ops and pins
`{"op" ..., "argument": ..., "confidence": ...}`, one short sentence per tool, and the meaning of
each op left where the model reads it (SYSTEM), not duplicated in a schema.

**What that bought** (`finetune/out/train.jsonl`, 452 rows, `make data` → `node finetune/dataset.ts`
with `maxExampleChars` 2400 → 1850):

| | before | after |
|---|---|---|
| prompt | 473 / 572.8 / 700 | 403 / 447.0 / 573 |
| target | 25 / 55.9 / 134 | 25 / 51.0 / 134 |
| state block (pane fields + tail) | 70 / 169.8 / 297 | 70 / 114.0 / 240 |
| terminal tail, chars | 20 / 251 / 267 | 20 / 113.6 / 122 |
| longest row, prompt + target | **773** | **641** |
| rows with an all-zero mask at `--max-len 512` | **440 / 452** | **3 / 452** |

So `prompt_max + target_max` does **not** fit 512 — 573 + 134 = 707 — but no single row does both.
The longest *row* is 641, which is why 512 still loses 3 rows and why 640 trains all of them. Those 3
are not a budget miss that another cap would fix: their target alone is 124–134 tokens (a 140-char
argument quoted verbatim) on top of a field block that cannot shrink below ~80 tokens. Capping
`ARGUMENT_CHARS` (140) in `dataset.ts` would recover them, at the cost of changing the argument
length the model is taught to emit — left alone deliberately, reported rather than silently applied.

**Cost of the shorter window, stated plainly:** the terminal tail is the evidence a decision is made
from, and fitting 512 halved it — 251 → 114 chars per row. That is the trade the window forces, not a
side effect of the prefix work (with the old 403-token prefix the same tails needed 768).

**Step rate**, this box, this corpus, 2 steady steps each with step 1 (load + JAX compile) excluded:

    .venv/bin/python -u finetune/timesteps.py 3 -- .venv/bin/needle finetune finetune/out/train.jsonl \
      --epochs 1 --batch-size 16 --lr 1e-4 --max-len {512,640,768} --val-split 0.1 --seed 0 \
      --lora-rank 16 --lora-alpha 32 --checkpoint-dir /tmp/ckpt-... --out /tmp/lora-....safetensors

| `--max-len` | steady steps | s/step | min/epoch @29 steps | rows trained |
|---|---|---|---|---|
| 512 | 58.5, 57.4 | **57.9** | **28.0** | 449 / 452 |
| 640 | 64.0, 62.5 | **63.2** | **30.6** | 452 / 452 |
| 768 | 94.7, 95.2 | **94.9** | **45.9** | 452 / 452 |

Against the recorded baselines: 512 is **2.32×** the 134.1 s/step @768, and **4.46×** the 258.2 s/step
@1024. But 768 re-measured on this box *today* is 94.9 s/step, not 134.1 — the box was 1.41× more
loaded when that baseline was taken, so the part of the speedup that belongs to the compaction is
**1.64×** (94.9 → 57.9), not 2.32×. The trainer plans 26 steps for this corpus (452 rows, 10% held
out, batch 16), so a real epoch is 25.1 min at 512, 27.4 at 640, 41.1 at 768. 640 is the
recommendation: every row trains, and it costs 9% more than a 512 that does not.

**Quality is NOT validated.** Everything above is a token count and a step rate. The prompt is now
terser, the tail shorter, and neither has been scored against a model that can actually decide:
needle zero-shot refuses 22/22 regardless of the wording, so a refusal-heavy local run cannot
distinguish a compact prompt from a broken one. Before the fine-tune is trusted, the compact SYSTEM
must be compared head-to-head with the 709-char one on a model that emits calls — the hosted
comparison (`bench/runners/run.ts openrouter:<model>`, run by the operator, needs
`OPENROUTER_API_KEY`) — and the tail budget re-checked against decision quality, not just fit.

**Adapter parsing is unchanged.** `--limit=22`, same task set (`taskSetSha b9765d1a55e18b4e`), before
and after:

| record | exactMatch | perOpRecall | refusals | p50 / p95 |
|---|---|---|---|---|
| `2026-10-27T00-22-33-299Z__needle3` (709-char SYSTEM) | 0.1364 | nudge 0, leave 0, flag 1 | 22 | 2374 / 12648 ms |
| `2026-10-27T00-43-19-911Z__needle3` (515-char SYSTEM) | 0.1364 | nudge 0, leave 0, flag 1 | 22 | 2023 / 3109 ms |

Identical scoring, so the sidecar still parses what the grammar emits; the p95 drop is the shorter
prefill, which is prefill and not accuracy.

**Fixed on the way through:** the repack found a row whose mined tail ended mid-emoji, leaving a lone
surrogate (`\ud83d`) that sentencepiece refuses to encode — that row would have crashed
`needle finetune`, not merely trained badly. `dataset.ts` now cuts tails, intents and first sentences
on a pair boundary (`cutPrefix`), and `clipTail` in `prompt.ts` drops a leading low surrogate for the
same reason on the live path. `npm test` 196/196, `npx tsc --noEmit` exit 0; the golden `renderInput`
renders in `test/prompt.test.ts` did not need updating because `renderInput` itself did not change.

Stale by this change, and rebuildable rather than rebuilt here: `finetune/out/slate/*` and
`finetune/out/dry` carry the old SYSTEM in their `query` text (`make dry` was re-run; `make slate`
was not).
