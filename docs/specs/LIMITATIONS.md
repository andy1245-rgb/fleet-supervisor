# Limitations register

Everything known to be wrong, blocked, or unverified in this project as of 2026-10-27.
Written to be worked from, not read through: each entry says what it is, what it blocks,
and the smallest thing that would resolve it.

Severity: **B** = blocks building as designed. **M** = misleading or latent, will bite.
**U** = unmeasured, so unknown. **L** = a real limit of the approach, not a bug.

Nothing here is committed to git. All numbers were measured on the development machine unless marked.

---

## A. Hard blockers — cannot be built as designed

### A1. The orchestrator is not trainable. `B`
7 tools need ~1,120 rows at the 160/op target. The honest budget at the measured
262.4 s/step is **~432 rows**, which gives **C=61** — below any usable floor. It is
simultaneously the widest grammar, the most expensive corpus, and the tightest window.
*Blocks:* the orchestration role entirely.
*Smallest resolution:* shrink the grammar to 3 tools, or cut the role from v1, or get
the row budget to 864 via the prefix trim + seq 512 (see A3).

### A2. `hi` and `search` cannot pass the corpus diversity check. `B`
Their only span-carrying argument is an id (`s01`, `h4`). Measured on 160 real `cite`
rows: **8 distinct values, 1 distinct template** (`s#`), against floors of 40 and 10.
No generation strategy fixes this; the grammar has nothing else to offer.
*Blocks:* the human-interfacer and search-worker corpora.
*Smallest resolution:* widen the id to carry structure, add a prose argument, or scope
I1 per-operation instead of per-role — but that last one needs an argument for why the
check still means anything.

### A3. The row budget was over-counted by 2×. `B`
`R_BUDGET = 864` assumed 133 s/step, which requires `maxLen 512`, which requires
`p95 prompt ≤ 416`. The orchestrator's **empty prompt is already 555 tokens**, so four
of five profiles train at 1024 → 262.4 s/step → **~432 rows**. `plan.py` also divided
hours by 2.0 optimistically while `check_i8` measured the real value, and the optimistic
path was the one gating: the plan said "23.6 h, trainable" where measurement said
**47.2 h, fail**.
*Blocks:* the training plan for every role except the 3-tool ones.
*Smallest resolution:* re-derive `R_BUDGET` from the measured step time in one place,
and stop dividing by two.

---

## B. Enforcement gaps — invariants that look real and are not

Thirteen instances of one pattern: the rule exists in a comment and a test, and the code
never applies it. This is the single largest risk in the codebase because each one *looks*
verified, and they are why three of the reviews found more than the build agents did.

| # | what | evidence |
|---|---|---|
| B1 | Claim exclusivity is a convention, not arbitration. The claim filename embeds the *holder*, so `O_EXCL` cannot collide between holders. | 6 concurrent processes, one path → **5 of 6 granted** |
| B2 | `store.guard()` — "the only thing between an expired lease and a stomped file" — has **zero call sites** in `src/`. | grep; tested only in `test/swarm-board.test.ts` |
| B3 | `spawn` never debits the parent. A budget-6 root authorised **10 actions**. The unit test pins the inequality at *plan* time, so it looks pinned. | `/tmp/sec/budget-leak.mjs` |
| B4 | Escalations return `action:"revoke_grant"`; the grant is never revoked. | `grant_revoked` rows: 0 |
| B5 | `I0` (row schema + render agreement) is computed, printed, and **absent from the gate table**. A corpus with 60 corrupted `renderedState` values is **ACCEPTED, exit 0**. | r1 B1 |
| B6 | `I9`'s relabel arm returns `ok=True` when no artifact is supplied, so the gate reads `pass` on an unmeasured property. | r1 B4 |
| B7 | `trainable` requires `not unmeasured`, and one unconditional `"unmeasured"` row makes it **structurally impossible to be True**. | r1 B5 |
| B8 | `I5` prints a **hardcoded** `"L1-L2 0 duplicates"` on a corpus it just rejected. | r1 M2 |
| B9 | Gate 19 "manifests" recomputes hashes from the profile and never reads the manifest. `deadbeef`/`cafe` is accepted. | r1 M6 |
| B10 | `ArgRule.field` — "this argument must come from THAT field" — is derived and never read. `item` copied from `tail` passes. | r1 M3 |
| B11 | Three modules claim span validation; **none is field-scoped**, and the only field-scoped one (`check_span`) has **zero callers**. A failing corpus hits the strongest (I4); a failing runtime hits the weakest (`verify.ts`). | r2 M3 |
| B12 | A refused `bind()` leaks the spawned process and the host cannot exit. | `timeout 4` → exit 124 |
| B13 | A steer is deleted at intake *before* anything that can fail, and the ledger records `steer_delivered` for a message no consumer saw. | r3 M5 |

Fixing these one at a time will not stop the fourteenth. See
`docs/specs/plan-invariants.md` for the mechanism-level question.

---

## C. Spec numbers that are wrong

Every one of these was believed until measured, and each changed a decision.

| # | claim | correct |
|---|---|---|
| C1 | Prefix costs in `role-grammars.md` §1.5 labelled "measured" | They are **enum-free** catalogue costs. The delta is exactly the enum arrays: hi +89, orch +60, worker +23, fetch +26, search +12. Correct: **354 / 550 / 566 / 282 / 320 / 265** |
| C2 | A spaced tools JSON costs +84 prefix tokens | **Zero.** The engine canonicalises: compact/spaced/pretty/reordered all give identical `needle_init` |
| C3 | A rebuilt 20-layer archive is 1.80× too large (a bug) | Not fixable: 2-bit ternary is **decode-only** in this package (`_cq_pack` raises for any width but 4). 4-bit is the only writable archive, and the better one |
| C4 | JSON spacing caused a train/serve skew | Does not exist |
| C5 | The static prefix is 333 tokens | Training-side. Serve-side with 4 tools it is **156** compact; the frame is **12**, not 13 and not 6 |
| C6 | `max_tail_chars 900` vs serve 700 was the train/serve tail mismatch | The real defect was **direction**: training kept the head, serving keeps the end |
| C7 | `R_BUDGET = 864` | ~432 on the development machine (A3) |
| C8 | The corpus's `declare_done` collapse was undertraining | The corpus was **99.43% one class**; there was nothing to learn |

---

## D. Unmeasured — genuinely unknown

- **D1.** Whether `kv_window: 256` is a hard retention bound. A real d8 prompt measured
  **445 tokens** against a declared window of 256. If 256 is hard, every profile's state
  budget is far tighter than the 595–697 planned against. Settles in one experiment.
- **D2.** The clean decode cost. Everything measured was under load 17–217; `eval.json`
  says 206/320/1100 ms for d4/d8/d20 but a contended re-measure gave 20–25 s. **Do not
  size an architecture on either number until the machine is quiet.**
- **D3.** The 4.1× speedup from `seq 640` (63.3 vs 262.4 s/step) — measured under load.
  Load-bearing for the whole budget question, so it must be re-taken on a quiet box.
- **D4.** Whether the noise floor of the leak estimators is acceptable at C=60–100. At 60
  rows the per-member spread reaches **0.133** against a 0.10 margin, and I3e's `BA_all`
  spans 0.250–0.400 against a 0.25 margin. Defensible at C=160; not below. No experiment
  has established the floor at production size.
- **D5.** Whether the factory's leak numbers are *reproducible*: they depend on line
  order (`attempts.bucket` 0.350→0.217 on the same rows shuffled), so `checks.json`
  cannot be recomputed from `corpusSha`.
- **D6.** Reddit: whether a minted session is obtainable at all from this egress. The
  login surface refuses even real Chrome; global search has **no working channel**
  without either a minted cookie or egress diversity. Arctic Shift covers fetch only.
- **D7.** Cross-model agreement for the factory's `M4` probe — never run, which is what
  makes `trainable` permanently false (B7).

---

## E. Limits of the approach — not bugs

- **L1. needle sees ~0.8% of a Reddit thread.** A 13-comment tree measured 7,416 tokens
  = 7.2× the entire window. The needle is a verdict machine over a ~600–900 character
  projection, and every projection is scaffold work. This is architectural.
- **L2. No FFN means no generation.** Measured: the best sub-200M model fabricated 2% of
  the time at 600M parameters and **21–28% at 125–270M**; with a format-locked scaffold it
  degraded to string interpolation. The talker workstream is dead and the prose surfaces
  must be templates.
- **L3. The judge spends its life saying "leave", and the only corpus available recorded
  the opposite.** The original miner emits a row only when a human spoke, so
  `P(intervened) = 1` and the class the supervisor most needs is structurally absent.
- **L4. 1024 tokens is a hard ceiling on grammar + state + output.** With 265–566 already
  spent on prefix, a 7-tool profile has ~380 tokens for evidence and 96 for output. Tool
  count is bounded by arithmetic, not preference.
- **L5. The model's competence is selection, verifiably.** Its one demonstrated strength is
  copying a span and picking from a closed set. Every design that asked it to enumerate,
  count, or compose has failed or been redesigned.
- **L6. Training on the development machine is ~2 h/epoch per profile at seq 1024.** Five profiles × 12
  epochs is ~120 h. That is a hardware limit, not a scheduling one.

---

## F. Environment and dependency limits

- **F1. `.venv` is not ours to patch.** The confidence-head drop and the 2-bit writer both
  live in the installed package; one is worked around and the other cannot be fixed.
- **F2. No GPU is usable by JAX on either machine.** Both are Intel iGPUs; JAX has no
  Vulkan backend; `libneedle.so` has no GPU path at all (pthreads + nothing else).
  Vulkan *is* a training backend in `ggml`, but unwired and unstable here.
- **F3. The trainer has no resume.** `finetune.py:497` writes once, no optimizer state.
  Any GPU session must complete one profile inside its window.
- **F4. Free cloud needs `jax[cuda12]` explicitly.** `cactus-needle[train]` pulls bare
  `jax`, which is CPU-only and silent; the docs recommend `cuda13`, which needs SM ≥7.5 and
  the free P100 is SM 6.0 — so following the docs yields a CPU run.
- **F5. `curl_cffi` is not installed** and plain HTTP is walled. Headers do not pass; a
  TLS fingerprint is the only identified fix.
- **F6. Reddit rate limits are per-egress and UA-independent.** 1 request/60 s, one global
  bucket. Changing user-agent buys nothing.
- **F7. Subagent work stops when the LLM account runs out of credits,** mid-phase, with the
  provider returning an empty completion rather than an error.

---

## G. Decisions only you can make

1. **Orchestrator**: cut, shrink to 3 tools, or split into router + verifier. (A1)
2. **Id-only arguments**: widen the id, add a prose argument, or scope the check per-op. (A2)
3. **Prompt trim**: do it or not. It is the only lever that reaches `maxLen 512`, and it
   is what restores the budget from 432 to 864. (A3)
4. **Cloud or local**: local is ~2 h/epoch and has no resume; cloud is ~2 min/epoch.
5. **Reddit egress**: a proxy pool, a second box that can mint a session, or drop global
   search and accept fetch-only. (D6)
6. **Scope**: which roles ship in v1. Five of five is not achievable at the measured budget.

---

## H. What is actually solid

Worth stating so the register does not read as total failure:

- **407 runtime tests pass**, including claim contention, chain ceiling, leaf-cannot-spawn,
  and refusal-escalation as tested properties — the *tests* are real even where the
  production path has holes.
- **The corpus factory's five fixture controls each fire the right gates**, including the
  `shibboleth` case that only the token-level test catches.
- **85 Reddit tests pass**; parsers, router and cache verified against recorded fixtures;
  no secret reaches any log path; no HTML error page is ever parsed as data; no prototype
  pollution; no `eval`.
- **`build_profile.py` recovers the confidence head** for 18,368 bytes and reports
  `confidence=0.4614` where the stock build reports `None`.
- **All five profiles fit the window** with 227–607 tokens of headroom.
- **`catalogue.py` rejects eight classes of malformed catalogue** before `needle_init`,
  and proves the engine would otherwise accept them silently.
