# Compact syntax — the tool grammar the engine will accept, and the result format a worker reads back

Status: spec, not implemented. No source change is authorised by this file.
Scope: the **shape contract** of the tool catalogue (what `needle_init` accepts, what the decode
grammar binds, what each byte costs) and a **line-oriented interchange format** for tool results
fed back into the window. Both measured against the real engine at
`~/.cache/cactus-needle/v3/3.3.3` (`libneedle.so`, `needle3.cact`, `needle 3.2.8`, vocab 8192).
Out of scope: which tools each role gets and their state blocks (`role-grammars.md`), the
`SYSTEM` compression and `renderInput` trimming (`prompt-trim.md`), confidence-head and archive
integrity (`train-serve-integrity.md`), corpus rows, training schedules. This file reopens none
of those decisions; it supplies the engine facts they each assumed and did not measure.

Every number here is from a probe in `/tmp`, reproduced by the script in the appendix. Nothing
in `~/agentFleet` was modified. Sample sizes are stated with every behavioural claim, because
several of them are small and one of the checked-in checkpoints refuses half of its own val set.

---

## 0. What this spec decides

1. **The tools block must be a JSON array of objects carrying `"name"`.** There is no terse
   syntax, no DSL, no one-line grammar. Anything else is not rejected — it is silently
   downgraded to *zero tools* at **confidence 1.0** (§1.4). That is the single most important
   fact in this document, because it makes a malformed catalogue look like a confident answer.
2. **The prefix has a closed form**, and `needle_init` returns it, so the cost of any candidate
   catalogue is a measurement, not an estimate:
   `prefix_tokens = tokens(system block) + 6 + tokens(canonical(tools_json))` (§1.2).
3. **Serialisation is free; content is charged.** Compact, spaced, pretty-printed and
   key-reordered forms of the same catalogue all cost the same `prefix_tokens`. So the
   "compact string vs `json.dumps` default" hazard is real at the *Python* level and **zero at
   the engine** (§1.3) — which corrects `role-grammars.md` §1.5.
4. **The only free key is `triggers`.** `description`, `required`, `type:object`, `$schema`,
   `title`, `examples`, `x-*` are all charged. Descriptions cost 49 of the 150 tokens of the
   stock four-tool catalogue (§1.5).
5. **A terse catalogue that the grammar accepts is not a catalogue the tuned model can use.**
   Shape acceptance and model usability are different tests and they disagree (§2.4).
6. **Tool results should be line-oriented, not JSON** — worth 86% on the engine envelope and
   14–38% on realistic payloads (§3).
7. **Train and serve must agree on tool *content*, not on tool *bytes*.** §5 states the exact
   invariants, and the one thing that must stay byte-identical is the query and target framing.

---

## 1. The engine contract, measured

### 1.1 How a tool definition becomes a grammar

`needle.tool` (`needle/agent/tools.py:193-199`) stamps `build_schema(fn)` onto the function as
`_needle_tool`. `build_schema` (`:140-171`) is the only producer of the catalogue, and it emits
exactly one shape:

```python
parameters = {"type": "object", "properties": properties}   # :164
if required:
    parameters["required"] = required                       # :166
out = {"name": fn.__name__}                                 # :167
if description:
    out["description"] = description                        # :169
out["parameters"] = parameters                              # :170
```

`description` is present only when the function has a docstring (`:146`, `:168`), which is why
deleting the four docstrings in `finetune/tools.py` shrinks the catalogue at all. Property
schemas come from `_json_type` (`:61-90`), which maps `str/int/float/bool/list/dict`,
`Literal`, `Enum`, `Annotated` and Pydantic models onto JSON Schema types, and `Field`
(`:20-51`) can attach `enum`, `const`, `minimum`, `maximum`, `minLength`, `maxLength`,
`pattern`, `format`, `minItems`, `maxItems`, `uniqueItems`. The full vocabulary is available —
but as §1.5 shows, everything except `name` and the property names is a token you pay for.

`Needle.__init__` passes the catalogue through to the engine in whatever form it is handed:

```python
tools_json = tools if isinstance(tools, str) else json.dumps(self._resolve(tools))   # __init__.py:212
...
if lib.needle_init(self._system, self._tools_json, self._tool_index_path) < 0:       # __init__.py:244
    raise RuntimeError("needle_init failed")
```

Note `:244`: the wrapper tests the return value for negativity and **discards it**. The value it
discards is the prefix token count — `_worker.py:92-96` forwards the same return as
`{"status": "ready", "prefix_tokens": prefix}`. The measurement this whole exercise needs is
already produced by the engine and thrown away by the Python API on every construction (§4.4).

### 1.2 The prefix has a closed form

`needle_init(system, tools, index)` returns the number of tokens in the prefix it compiles. With
the published 3.3.3 archive loaded and the real `SYSTEM` from `src/decision/prompt.ts`
(515 chars), and the real `finetune/out/tools.json` (665 chars):

| `system` | `tools` | `needle_init` | tokens(system block) | 6 + tokens(tools) |
|---|---|---:|---:|---:|
| `""` | `"[]"` | 7 | 0 | 6 + 1 |
| `SYSTEM` | `"[]"` | 182 | 175 | 6 + 1 |
| `""` | stock 4-tool | 156 | 0 | 6 + 150 |
| `SYSTEM` | stock 4-tool | **331** | 175 | 6 + 150 |

The decomposition is exact in every row: **`prefix_tokens = tokens(system block) + 6 +
tokens(tools_json)`**. The `6` is the tools framing (`<|im_start|>user\n<tools>…</tools>\n`).
The full static prefix the decoder sees also includes `<|im_start|>assistant\n`, 3 tokens, so
the figure before a single evidence token is **334**.

That is the number the repo rounds to 333. `needle_sidecar.py:18-30`, `src/decision/prompt.ts:47-55`
and `finetune/measure_window.py` all derive 333 as SYSTEM 170 + tools 150 + markers 13; the
marker count differs by one between that accounting and the engine's, and the engine's is the
one that binds. Use 331 (engine) or 334 (including the assistant header) and say which.

### 1.3 Serialisation is free; content is charged

The same four tools, serialised five ways, measured through `needle_init`:

| form | chars | tokens (tokenizer) | `needle_init` |
|---|---:|---:|---:|
| compact (`separators=(",",":")`) | 665 | 150 | **156** |
| `json.dumps` default (`", "`, `": "`) | 716 | 234 | **156** |
| `indent=2` | 1094 | 611 | **156** |
| keys reversed, compact | 665 | 150 | **156** |
| whitespace re-inserted into compact | 716 | 234 | **156** |

**The engine canonicalises the catalogue's serialisation before tokenizing it.** Whitespace,
indentation and key order are not charged; three candidate forms differing by 429 characters and
461 tokenizer tokens cost identically.

This contradicts `role-grammars.md` §1.5, which measures the spaced form with the tokenizer
(234 tokens), concludes the sidecar's prefix is 417 rather than 333, and on that basis declares
the spaced seven-tool orchestrator catalogue unviable at rung 1024 ("1064 — over the window").
The engine reports 156 for both forms. The **+84/+190/+197 spacing penalties in that table are
not real**; the orchestration-viability conclusion needs re-deriving from engine numbers.
`train-serve-integrity.md:693` has this right ("The engine canonicalises the tools JSON"). This
spec confirms it with the pretty-printed and key-reordered cases that were not tested there.

What is *not* canonicalised away: content. A monotonic growth test (padding each `description`
by increasing amounts) shows `needle_init` rising **exactly** with the token delta at every
step, with no plateau and no cap:

| padded chars in catalogue | `needle_init` | delta |
|---:|---:|---:|
| 481 | 112 | — |
| 493 | 124 | +8 |
| 541 | 172 | +32 |
| 733 | 364 | +128 |

There is no truncation of the tools block up to 733 chars / 364 tokens. Do not expect a large
catalogue to be silently shortened before the grammar breaks; expect the *grammar* to be built
in full and the *output budget* to be what fails (§2.5).

### 1.4 What the compiler accepts — and the silent no-tools path

`needle_init` performs **no validation**. Every string below returns a prefix count:

| tools argument | `needle_init` |
|---|---:|
| `"not json at all"` | 11 |
| `{"name":"leave"}` (object, not array) | 12 |
| `"[{name:leave}]"` (unquoted keys) | 13 |

The rejection happens at decode, and it is not a rejection. With a tuned archive (`d20`) and a
normal query, six malformed catalogues all produce this:

```
"reasoning": "no tools declared, returning the empty call"
"function_calls": []
"confidence": 1.0
"error": null
```

| tools string | verdict |
|---|---|
| `leave:reason` | no tools declared, confidence 1.0 |
| `[leave:reason]` | no tools declared, confidence 1.0 |
| `{"leave":"reason"}` | no tools declared, confidence 1.0 |
| `[{leave:reason}]` | no tools declared, confidence 1.0 |
| `["leave","nudge"]` | no tools declared, confidence 1.0 |
| `not json at all` | no tools declared, confidence 1.0 |
| 2-tool stock catalogue | `nudge`, confidence 1.0 |

**A custom one-line grammar is not possible.** The catalogue must be a JSON array of objects
with a `"name"` string. Anything else yields zero tools with a successful envelope and the
highest possible confidence — the engine's diagnostic text (`"no tools declared"`) is the only
signal, and nothing reads it as an error. This is the most dangerous failure in the whole
surface: a typo in a role's catalogue produces a profile that answers nothing, quickly, with
confidence 1.0, and the only place it surfaces is downstream accuracy.

### 1.5 Which keys are charged

Four stock tools, one extra key added to each tool entry, `needle_init` measured:

| extra key added per tool | chars | `needle_init` | delta |
|---|---:|---:|---:|
| — (baseline) | 665 | 155 | — |
| `triggers: ["a","b"]` | 729 | **155** | **0** |
| `title: "X"*20` | 769 | 247 | +92 |
| `$schema: …draft-07…` | 853 | 263 | +108 |
| `x-vendor: "deadbeefcafe"` | 749 | 207 | +52 |
| `examples: [1,2,3]` | 721 | 191 | +36 |
| `deprecated: true` | 717 | 183 | +28 |
| `readOnly: true` | 709 | 179 | +24 |
| `strict: false` | 705 | 175 | +20 |
| `returns: "string"` | 721 | 175 | +20 |
| `output: "string"` | 717 | 175 | +20 |

The baseline here is 155, not §1.6's 156, because this probe wrote the same 30-character
description into all four tools. **The deltas are the result; the absolute values are 1 low.**

**`triggers` is the only key the engine drops**, which is consistent with it existing for the
prompt-side catalogue and not the grammar (`agent/tools.py:196-197`). Every other key is
charged. Note the magnitude: `title` of 20 characters costs 92 tokens across four tools, because
a repeated character tokenises one piece at a time. `$schema` alone costs 108 tokens — more than
`required` and `type:object` combined.

The rule for an implementer: **the catalogue entry is `{"name": …, "parameters": …}` and
nothing else.** A `description` is allowed only when its words are load-bearing, and §2.4 shows
they are the one thing worth paying for.

### 1.6 The measured ladder of shape variants

Four tools, one string argument each. `needle_init` is the engine's own count; bytes are the
compact serialisation.

| shape | bytes | tokens | `needle_init` | vs stock |
|---|---:|---:|---:|---:|
| stock (`description` + `type:object` + `properties` + `required`) | 665 | 150 | 156 | — |
| drop `required` | 574 | 133 | 139 | −17 |
| drop `description` | 461 | 101 | 107 | −49 |
| flat `parameters` (`{a:{"type":"string"}}`, no `type:object`) | 450 | 108 | 114 | −42 |
| drop `description` + `required` | 370 | 84 | 90 | −66 |
| drop `description` + `required` + flat | 246 | 59 | 65 | −91 |
| drop `description` + `required`, 1-char arg names | 347 | 82 | 88 | −68 |
| all three, 1-char arg names | 223 | 57 | 63 | −93 |

The 109-of-150 claim in `finetune/tools.py:14` is close: the four descriptions are 49 tokens
(150 − 101) and the remaining 101 are structural. `prompt-trim.md` §4 measured the same 461
bytes / 101 tokens for the description-free catalogue, which is the cross-check that this probe
harness is the engine and not an approximation of it.

---

## 2. The minified tool syntax

Each candidate below was taken past `needle_init` to an actual decode — the grammar only
compiles when a token is generated. Decodes were run on two archives: the published base
3.3.3 (no learned refusal bias) and the tuned `finetune/out/d20/d20.cact`.

**Calibration warning, stated once and applying to every behavioural number in §2:** `d20`'s own
`eval.json` records **24 refusals in 50** val rows and accuracy **0.10** against a 0.81 majority
baseline (`AGENTS.md:59`); `d4` is 0.28 and `d8` is 0.06. These checkpoints are known-bad. A
single "zero calls" sample from `d20` is therefore *not* evidence about a grammar — it is
indistinguishable from the model's baseline refusal behaviour. Only the shape/wiring results
below (does the argument come back with the right key, does the engine say "no tools declared")
are conclusions; the quality deltas are directional and marked as such.

### 2.1 Positional-only arguments — rejected

`{"name":"leave","arguments":["reason"]}` (44 B, `needle_init` 17) and
`{"name":"leave","parameters":["reason"]}` (41 B, 18). Both compile and both emit
`{"reason": "…"}` with the correct key. The grammar derives a single-field object from an array
of names.

*What breaks:* position is not expressible in the reply. The engine always emits a keyed object,
so the field name survives but the ordering contract does not — with two names in the array it
emitted two calls, one per field (`{"summary":"…"}` then a second call), not one call with two
fields. Measured per tool: stock is 43 at `needle_init`, `arguments:["reason"]` is 17, so the
form is worth 26 tokens per tool — but only by rewriting the training corpus, and the
one-field description-free shape already reaches 31 (§2.6) without touching the surface the
model knows. **Not recommended.**

### 2.2 A single `args: string` field — rejected on cost, not on correctness

`{"name":"leave","description":"…","parameters":{"type":"object","properties":{"args":{"type":"string"}},"required":["args"]}}`
is 167 B / `needle_init` 43 — *identical* to stock's 43 for one tool, because the description
dominates. Without the description it is a flat single-string schema, which is the same thing as
§1.6's "flat" row. Decode returns `{"args": "…"}` correctly.

*What breaks:* nothing mechanically, and it costs the same as the shape it was meant to replace.
The one real benefit is that all four ops would share the literal key `args`, which is 4 tokens
across four tools — not worth the corpus rewrite (`prompt-trim.md` reached the same verdict on
1-char argument names: −4 tokens for a rename that touches `dataset.ts`, `types.ts`, every
target and every recorded number).

### 2.3 Terse JSON and the freed `type:object` nesting — accepted by the engine, and worth taking

`parameters` needs no `"type":"object"` and no `"properties"` wrapper. These all compile and all
return the argument under the right key:

| form | bytes (1 tool) | `needle_init` | decode |
|---|---:|---:|---|
| `{"a":{"type":"string"}}` | 106 | 26 | `{"reason": "…"}` ✓ |
| `{"a":"string"}` | 51 | 18 | `{"reason": "…"}` ✓ (2 calls, value split) |
| `{"a":{}}` | 91 | 23 | 2 calls, fragment values |
| `"a"` (bare string) | 40 | 16 | `{"reason": "…"}` ✓, conf 0.29 (base, highest observed) |

Across four tools the flat form saves 42 tokens (156 → 114). The bare-string form is 16 at
`needle_init` against stock's 43 for the same single tool — 27 tokens per tool, but see what
breaks below before taking it.

*What breaks:* the tuned archive. `{"name":"leave","parameters":"reason"}` on base 3.3.3 returns
a correct call at the highest confidence of any probe; on `d20` it returns **zero calls** with
`confidence: 0.9893` and the reasoning `"No tool available to check air quality or air quality."`
— the model does not recognise the surface at all. That is one sample from a bad checkpoint, so
treat it as a warning rather than a proof, but it is the expected direction: the tuned model saw
`{"name":…,"description":…,"parameters":{"type":"object","properties":…}}` in every one of its
training rows, and a surface with none of those keys is out of distribution in the part of the
prompt the model uses to identify the tool.

The flat form (`{"a":{"type":"string"}}`, keeping `type` inside the property) is the compromise:
it drops only the wrapper the engine demonstrably does not need, and it keeps the property
schema the model has seen.

### 2.4 What the descriptions are actually worth

The stock four tools carry 49 tokens of `description`, and `prompt-trim.md` §4 deletes them to
recover exactly those 49. The decode side says they are the one thing the model reads for
semantics. On `d20`, three queries, one seed each — **directional only**:

| catalogue | `needle_init` | q0 (all tests pass) | q1 (agent asks a question) | q2 (TypeError) |
|---|---:|---|---|---|
| stock | 156 | `nudge` conf 1.00 | `leave` conf 0.39 | `flag` conf 0.98 |
| no `required` | 139 | `flag` conf 1.00, **2 calls**, arg fragment | `leave` conf 0.48 | `flag` conf 0.95, **arg empty** |
| flat params | 114 | `nudge` conf 1.00 | `declare_done` conf 0.54 | `flag` conf 0.87, **arg empty** |
| no `description` | 107 | `flag` conf 0.48 | **0 calls** conf 1.00 | `flag` conf 0.63 |

Stock is the only catalogue where all three queries return one call with a complete argument.
Every minification loses argument integrity on at least one query. With n=3 and a checkpoint
refusing half its val set, that is a signal and not a proof — but it points the opposite way from
`prompt-trim.md` §4, and it is the reason this spec does not recommend deleting descriptions.

**The consistency that matters is different from the one that was optimised.** The catalogue in
the window and the catalogue in the training rows must be the same catalogue. If descriptions
are deleted, they must be deleted from `finetune/tools.py` **and** every corpus row regenerated,
because the model does not read a catalogue the way a parser does — it reads it as text it must
have seen before. `prompt-trim.md` does say this ("the same edit goes into both"); the decode
evidence suggests the cost of getting it wrong is argument quality, not just tokens.

### 2.5 Output budget binds before input budget does

The grammar is compiled in full, so a wide tool does not truncate — it **exhausts the 96 output
tokens**:

| catalogue | `needle_init` | result |
|---|---:|---|
| 24 string properties, all `required` | 257 | `error: "tool call truncated: token budget exhausted"`, `error_code: "truncated"` |
| 2 string properties, both `required` | 39 | `error: "tool call truncated: token budget exhausted"` |
| 6 levels of nested object | 192 | 0 calls, conf 0.96 |
| `enum` of 120 values | 426 | 0 calls, conf 1.0 |

The top two rows are clean and reported (`error_code: "truncated"`). The bottom two are the
silent kind — zero calls, no error, high confidence — and because `d20` refuses ~half its
prompts they cannot be attributed to the grammar from these samples.

A well-formed call costs 19 output tokens (81 B); with the `<think>` block the model actually
emits, 37–58 tokens (`<think>…</think>` + `<tool_call>[{"name":…,"arguments":{…}}]</tool_call>`).
**At `max_new_tokens = 96` there is room for one call with one or two short fields, and no
more.** Any role profile that needs three populated fields in one call must raise
`MAX_NEW_TOKENS`, which is charged against the same 1024 window the prefix is charged against.

### 2.6 Recommendation

| role profile shape | catalogue | `needle_init` (tools) | rationale |
|---|---|---:|---|
| 1 tool, 1 string arg | `{"name":…,"parameters":{"type":"object","properties":{a:{"type":"string"}},"required":[a]}}` | 31 | keep `required`; it binds the argument into the call |
| 1 tool, 1 string arg, description worth keeping | same + `"description"` | 43 | +12 for a one-sentence description |
| 3–7 tools | stock shape, no `description` unless load-bearing | 107 for four | this is `prompt-trim.md` §4's chosen patch, unchanged |

Take the **42-token flat-`parameters` saving only together with a retrain and a re-measured
refusal rate**, never as a serving-side change. Take the **`required` key as non-negotiable**:
dropping it is −17 tokens and it produced `"arguments":{}` in the probes, both here and in
`prompt-trim.md` §4.

Do not attempt: a custom DSL, a bare-string `parameters`, a bare name with no `parameters`, or a
description-free catalogue applied only at serve time. Each is either not a grammar at all
(§1.4) or a catalogue the tuned model has never read (§2.3, §2.4).

---

## 3. The compact output format

### 3.1 What the model reads back today

`Needle.run()` executes each call and feeds the results back as JSON (`__init__.py:364`):

```python
response = self._complete(json.dumps(results, default=_jsonable), max_new_tokens, ground=False)
```

The engine's own envelope for one call is 358 B / **132 tokens**: `type`, `success`, `error`,
`error_code`, `reason`, `function_calls`, `suppressed_calls`, `reasoning`, `confidence`,
`prefill_tps`, `decode_tps`, `peak_ram_mb`, `validation`. Six of those fields are telemetry the
model will never use, and `confidence` is a float the model cannot condition on.

The sidecar already avoids this: `needle_sidecar.py:26-30` decodes once rather than calling
`run()`, precisely because the loop "only ever fed meaningless results back into the window".
But the same loop is the mechanism every role profile will use for multi-step work
(`role-grammars.md:368` relies on `run()` iterating), so the result format is a real budget item
and not a hypothetical one.

### 3.2 The format

```
<status> <verb> [k=v ...]
<field> <value>
...
```

- Line 1 is the header: `ok` or `err`, then the operation, then scalars as `k=v`.
- One line per repeated item; no per-item keys, no braces, no quotes.
- `err` replaces the header only: `err fetch timeout=30000 host=docs.python.org`
- Positional, not keyed, on continuation lines: the field order is fixed by the tool's contract
  and both sides know it, so the key is paid once in the header or not at all.
- No `null`, no `false` — omit. Absence is the value.
- Floats: 2 significant figures max. A confidence the model cannot use is not worth 3-4 tokens.

Three payloads, measured:

| payload | JSON today | line format | saving |
|---|---:|---:|---:|
| engine envelope, one call | 358 B / **132 tok** | 50 B / **18 tok** | **86%** |
| search shortlist, 6 hits with title + url | 642 B / **269 tok** | 375 B / **187 tok** | **30%** |
| worker completion record | 224 B / **94 tok** | 124 B / **58 tok** | **38%** |
| fetched page summary + 3 links | 405 B / **147 tok** | 352 B / **127 tok** | **14%** |

The page summary saves least because its tokens are mostly prose that does not disappear when
the punctuation does. That is the honest shape of the win: **the saving is proportional to how
much of the payload is structure rather than content.** A record with 9 short fields saves 38%;
the engine envelope with 13 fields, 6 of them unused, saves 86%; a prose summary saves 14%.

The 86% is not a formatting result, it is a *selection* result — dropping `prefill_tps`,
`decode_tps`, `peak_ram_mb`, `reason`, `success`, `error_code` and the nested `validation`
object is most of it. **Deleting fields the model cannot use is worth more than any syntax
change**, and it is the first thing to do.

### 3.3 Why line-oriented and not minified JSON

Minified JSON for the search shortlist is 642 B and line-oriented is 423 B for the same
information, because JSON pays for a key on every record (`{"title":…,"url":…}` × 6). Line
format pays for the field order once, in the tool's contract. Measured bytes/token also shifts
in the right direction: JSON in this corpus is 4.41 B/token (dense punctuation, cheap tokens),
prose is 2.79 B/token, line format lands at 2.0–2.8 B/token — i.e. **the same *character*
budget buys more *tokens* of meaning**, which is what the window is short of.

### 3.4 Where the format must not be applied

- **Not to the tool call.** The call is grammar-constrained by the engine and its shape is fixed
  by §1.4. This format is for results flowing *into* the window.
- **Not to `SYSTEM`.** `prompt-trim.md` §3 already compresses it and the text is load-bearing.
- **Not across a train/serve boundary without retraining.** If a profile is trained on
  line-oriented results, the serving side must emit exactly that format; see §5.

---

## 4. The payoff, numerically

### 4.1 Input budget as a function of prefix

Window 1024, `max_new_tokens = 96`, so `input = 1024 − prefix − 96`. Bytes are given at two
conversion rates: **2.79 B/token**, measured on the real 53-row val split's evidence text, and
the 3.2 B/token figure the repo's own comments assume.

| configuration | prefix | input tok | bytes @2.79 | bytes @3.2 |
|---|---:|---:|---:|---:|
| documented today (SYSTEM 170 + tools 150 + 13) | 333 | 595 | 1660 | 1904 |
| **serve truth today, engine-measured** | **331** | **597** | **1666** | **1910** |
| full SYSTEM, no `required` | 314 | 614 | 1713 | 1965 |
| full SYSTEM, flat `parameters` | 289 | 639 | 1783 | 2045 |
| full SYSTEM, no descriptions | 282 | 646 | 1802 | 2067 |
| full SYSTEM, no descriptions + no `required` | 265 | 663 | 1850 | 2122 |
| trimmed SYSTEM, stock tools | 270 | 658 | 1836 | 2106 |
| **trimmed SYSTEM, no descriptions** | **221** | **707** | **1973** | **2262** |
| trimmed SYSTEM, no descriptions + no `required` | 204 | 724 | 2020 | 2317 |
| empty tools (floor: SYSTEM block + 6-token frame) | 121 | 807 | 2252 | 2582 |

The full-SYSTEM rows are engine measurements. The trimmed rows substitute `prompt-trim.md`
§3's 324-char `SYSTEM` (109 tokens) for the current 515-char one and add the same 5 marker
tokens measured on the full block (515 chars = 170 tokens, block = 175) — they are arithmetic
on two measured quantities, not a decode.

Description deletion alone — §2.6's recommendation — moves 331 to 282, **49 input tokens, 137
bytes**. Adding `prompt-trim.md`'s `SYSTEM` trim as well moves 331 to 221: **110 tokens, 307
bytes, +18.4% of the input budget.** They add exactly, because the two patches remove different
text: 49 from the catalogue, 61 from `SYSTEM`.

### 4.2 The marginal value of one prefix token

At prefix 331, one token removed is one token of evidence added: 1/597 = **0.17% of the input
budget**, 2.79 bytes. At the recommended 221 it is 0.14%. There is no cliff and no
non-linearity — the case for minifying is simply that the stock 156-token four-tool catalogue is
about a quarter of the evidence budget (597 tokens), and evidence is the only thing that
improves grounding.

### 4.3 Five profiles, not one

`role-grammars.md` establishes that each role gets its own catalogue. Rebuilding those catalogues
from that document's `@needle.tool` blocks and measuring them gives `needle_init` figures that
reproduce its table **exactly, offset by the 6-token frame**: its 147 / 361 / 133 / 157 / 123 is
153 / 367 / 139 / 163 / 129 here. So the two documents agree on what a catalogue costs.

What that document does not price is the description-free variant, which is the patch
`prompt-trim.md` already specifies for the four-tool catalogue:

| profile | tools | stock (`needle_init`) | description-free | saving |
|---|---:|---:|---:|---:|
| `hi` | 3 | 153 | **104** | 49 |
| `orch` (leaf licence) | 7 | 367 | **259** | 108 |
| `worker` | 3 | 139 | **98** | 41 |
| `fetch` | 3 | 163 | **114** | 49 |
| `search` | 3 | 129 | **82** | 47 |

The seven-tool orchestrator catalogue that `role-grammars.md` §1.5 budgets at 1064 runtime
tokens and declares over the window is, description-free, **259 + SYSTEM + 96** — which fits with
room to spare, and fits at 367 even with every description kept. And because the engine charges
content and not serialisation (§1.3), the spaced-form penalties that document prices at +62 to
+197 are zero. Its orchestration-viability conclusion needs re-deriving; the catalogue cost is
not the constraint it was thought to be.

**Nothing here changes what a role's tool is; it changes what the catalogue costs to state.**
The per-role decision belongs to `role-grammars.md`; the price list belongs to this file.

### 4.4 A free regression guard

`needle_init` returns the prefix count and `__init__.py:244` throws it away. A one-line change
to `Needle._bind` — store the return value as `self.prefix_tokens` — would make every profile's
static cost an assertable number instead of a comment. The check that matters is not "is the
catalogue small" but "is `prefix_tokens` equal to what the corpus was built against", and the
engine will answer it for free on every construction.

---

## 5. What must stay identical between training and inference

### 5.1 Byte-identical

| artefact | why |
|---|---|
| `SYSTEM` text | never canonicalised; tokenised directly. A whitespace change is a real prompt change |
| the query / state block | same, and `renderInput`'s field order is the model's only positional cue |
| the target framing `<think>…</think><tool_call>…</tool_call><\|im_end\|>` | fixed by `model/finetune.py:211-212`; the grammar emits into this frame |
| the argument **names** and the property **order** within a tool | the grammar keys on them; a rename is a different tool |

`render_example` (`model/finetune.py:201-213`) is the single producer of both sides:

```python
prompt = (prefix + IM_START + "user\n" + TOOLS_START + tools_json + TOOLS_END + "\n"
          + example["query"] + IM_END + "\n" + IM_START + "assistant\n")            # :209-210
target = think + TOOL_CALL_START + answers_json + TOOL_CALL_END + IM_END             # :212
```

### 5.2 Content-identical, bytes free

| artefact | why |
|---|---|
| the tools JSON | the engine canonicalises serialisation before tokenising (§1.3): compact, spaced, pretty and key-reordered forms all measure 156. A byte diff is not observable at the model |

So the enforceable invariant is **schema content equality plus equal `prefix_tokens`**, not byte
equality — which is `train-serve-integrity.md` §4.2's P2 and is now confirmed on the pretty and
reordered cases. The corollary is a real licence: `finetune/tools.py` may serialise however it
likes, and a sidecar may pass a Python list of functions rather than a string
(`__init__.py:212`), at no cost. **The "+84 tokens from `json.dumps` default separators"
hazard in `role-grammars.md` §1.5 does not exist.** Its recommendation — every sidecar passes
`compact_json()`, never the function list — is still good hygiene, but it is not worth 62–83
tokens per profile and it is not the difference between a working orchestrator and a suppressed
one.

### 5.3 Where a minified format creates a real mismatch

1. **Description deletion at serve time only.** The catalogue is inside `<tools>`, which is
   inside the prompt. Deleting descriptions from `needle_sidecar.py` without regenerating the
   corpus puts 49 tokens of training-visible text out of the prompt. §2.4's argument-integrity
   losses are the expected symptom.
2. **Any shape the grammar accepts but the corpus never contained.** `parameters:"reason"` and
   `parameters:["reason"]` both compile and both return correct calls on the base archive; the
   tuned archive does not recognise the surface (§2.3). Acceptance by the compiler and
   familiarity to the model are independent properties, and only the first is testable with
   `needle_init`.
3. **Line-oriented tool results.** If the format changes, every multi-step training row that
   feeds a result back must change with it. No such rows exist today (`run()` is not used in
   training), so this is a constraint on the corpus being built, not a migration.
4. **`triggers`.** Free at the engine (it is dropped, §1.5) but still real text in the JSON, so
   a tokenizer-based measurement counts it and an engine measurement does not — exactly how the
   two accounting methods drift apart. It makes the *content* differ between two catalogues that
   cost the same, which fails §5.2's content-equality test for no benefit. Either always set it
   or never.

### 5.4 The one place a mismatch silently costs everything

A catalogue that fails §1.4 — a typo, a truncation, a hand-written DSL — does not error. It
produces `"no tools declared, returning the empty call"` at confidence 1.0. Nothing in the
Python wrapper distinguishes that from a good answer: `function_calls` is empty,
`suppressed_calls` is empty, `error` is `null`. The sidecar maps the empty call list to
`"refused": not calls` (`needle_sidecar.py:105`) and passes the engine's confidence through
untouched, so a dead grammar arrives at the ladder as a refusal at confidence **1.0**. The one
field that says what happened — `reasoning` — is forwarded on line 108 and never inspected.
**Any deployment that minifies a catalogue needs an assertion that the parsed catalogue is
non-empty and that `needle_init` returned a prefix above the empty-tools floor**, or it will
ship a profile that cannot call anything.

---

## 6. Failure modes hit, and one that did not

| # | failure | evidence | status |
|---|---|---|---|
| F1 | malformed catalogue → zero tools, conf 1.0, no error | §1.4, 6 shapes | **silent, severe** |
| F2 | `needle_init` never validates, so init success is not grammar success | §1.4 | silent, must be guarded |
| F3 | wide/deep schema exhausts the 96-token output budget | §2.5, `error_code: "truncated"` | clean, reported |
| F4 | dropping `required` → `"arguments":{}` | §2.4, matches `prompt-trim.md` §4 | clean, visible in the call |
| F5 | `enum` binds the grammar (an undocumented capability) | 3-value enum emitted `"a"` regardless of query | works, costs tokens |
| F6 | prefix uncounted by the Python API | `__init__.py:244` discards `needle_init`'s return | silent, fix is one line |
| F7 | argument split across two calls in one decode | `{"a":{}}` and flat/array forms, §2.3 | silent, changes arity |

### 6.1 The crash that did not reproduce

`AGENTS.md:43` records, from a sibling project: *"Grammar-constrained decoding crashes llama.cpp
on large probability-array schemas. Send the grammar for small schemas, plain prompting for big
ones (localjev's `LOCALJEV_GRAMMAR_MAX_OUTCOMES`, default 8)."* The analogue here — a wide
`enum`, a deep nest, a 24-property object — was run through `needle_complete`:

| stress | `needle_init` | outcome |
|---|---:|---|
| `enum` of 120 values (841 B) | 426 | no crash; 0 calls, conf 1.0 |
| 6 × nested object, each `required` (694 B) | 192 | no crash; 0 calls, conf 0.96 |
| 24 string properties, all `required` (776 B) | 257 | no crash; 0 calls or `truncated` |

**`libneedle.so` 3.3.3 does not crash on large grammars in the range tested.** Every process
exited 0. The failure mode is the *opposite* of the documented one and worse for diagnosis: the
grammar is accepted, the decode runs, and the call comes back empty with high confidence (F1).
The lesson from `LOCALJEV_GRAMMAR_MAX_OUTCOMES` — keep outcome spaces small — still applies, but
for a different reason: not to avoid a crash, to avoid a silent no-op.

Not tested, and worth knowing before relying on it: an `enum` large enough that its own
serialisation exceeds the window (an 800-value enum measured 3108 prefix tokens, over 1024),
which this spec did not decode.

### 6.2 The window is an attention window, not a hard cap

`sliding_window = 1024` (`model/architecture.py:67`) and `max_seq_len = 4096` (`:49`). A
1103-token prompt — past the sliding window, with the `<tools>` block at position 0 fully
outside it — decoded without error and returned a well-formed call. So the 1024 figure in the
sidecar's budget comment (`needle_sidecar.py:18-30`) is a *reachability* budget, not an input
limit: exceeding it does not fail, it silently drops the oldest tokens, and the oldest tokens are
`SYSTEM` and the catalogue. That is a second reason to keep the prefix small — it is not only
competition for the window, it is the first thing evicted from it.

---

## Appendix — reproduce

All probes ran under `~/agentFleet/.venv/bin/python` against
`~/.cache/cactus-needle/v3/3.3.3/{libneedle.so,needle3.cact}`, cact tag `0x5e12a84`, and were
kept out of the repository. The three primitives everything above is built from:

```python
import ctypes, json, os, sys
sys.path.insert(0, "/home/andrew/agentFleet/.venv/lib/python3.14/site-packages")
from needle.model.tokenizer import get_tokenizer

V3 = os.path.expanduser("~/.cache/cactus-needle/v3/3.3.3")
lib = ctypes.CDLL(os.path.join(V3, "libneedle.so"))
lib.needle_init.argtypes = [ctypes.c_char_p] * 3
lib.needle_init.restype = ctypes.c_int          # <-- the prefix token count
lib.needle_load.restype = ctypes.c_int
lib.needle_load.argtypes = [ctypes.c_char_p, ctypes.c_uint64]
lib.needle_complete.restype = ctypes.c_int
lib.needle_complete.argtypes = [ctypes.c_char_p, ctypes.POINTER(ctypes.c_float),
                                ctypes.c_int, ctypes.c_int, ctypes.c_char_p, ctypes.c_int]
lib.needle_reset.argtypes = []

w = open(os.path.join(V3, "needle3.cact"), "rb").read()
assert lib.needle_load(w, len(w)) >= 0

tools = json.dumps(TOOLS, separators=(",", ":")).encode()
prefix = lib.needle_init(b"", tools, None)     # exact cost, in the engine's own tokens
buf = ctypes.create_string_buffer(65536)
lib.needle_reset()
rc = lib.needle_complete(query.encode(), None, 0, 96, buf, len(buf))   # the decode: does the grammar compile?
print(buf.value.decode())
```

Three traps found the hard way, worth recording:

1. **`needle_init` is not a validator.** It returns a count for any bytes. Negative means failure
   to compile the prefix, not a bad catalogue. Always follow it with a decode.
2. **Load the archive before `needle_init`.** `needle_load` on the published base and on a tuned
   `.cact` both return 0 and are interchangeable for shape probing; the base archive is the one
   to use for grammar questions, because a bad checkpoint's refusal rate will be mistaken for a
   grammar failure.
3. **`max_new_tokens = 96` is the binding constraint for wide catalogues**, not the prefix. A
   probe that reports "no call" on a 24-property schema may be reporting the output budget, the
   model's refusal, or the grammar — check `error_code` before concluding anything.

The behavioural numbers in §2.4 and §2.5 are **n=3 and n=1 per cell respectively** — small, and
deliberately not dressed up as more. They are on checkpoints whose own `eval.json` puts them
below the majority baseline (`d20`: 0.10 against 0.81, 24/50 refusals). They are reported because
the direction is consistent and because `prompt-trim.md` §4's rejection of those shapes was made
on four rows without any assertion about argument integrity. **Before any of this is applied,
re-run §2.4 on an archive that scores above the baseline**; a sweep of 40 decodes across four
catalogues was started for this document and abandoned when the host's load average passed 30,
so the larger sample does not exist yet. The token numbers in §1, §3 and §4 do not depend on the
checkpoint and can be used as they stand.
