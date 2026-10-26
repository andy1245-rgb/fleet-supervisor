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
