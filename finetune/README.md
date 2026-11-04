# Needle 3 decision classifier — fine-tuning scaffold

Supervised-agent state in, one of four tools out:

| label | tool | argument |
|---|---|---|
| `leave` | `leave(reason)` | short reason |
| `nudge` | `nudge(message)` | the instruction to send the agent |
| `declare_done` | `declare_done(summary)` | what was delivered |
| `flag` | `flag(problem)` | the problem |

The base model refuses this task. Measured through `eval.py` on the published
archive (`make smoke`), with the fleet's own system prompt and a fixture
decision point:

```
function_calls   []
suppressed_calls [{"name":"nudge","arguments":{...}}]
confidence       0.032        type "call"
REFUSALS  1/1 (100.0%)   1 call(s) withheld by the engine
```

The engine's grounding/confidence gate withheld the call and returned nothing —
a zero-shot refusal, which is why this scaffold exists. A separate hand-run
against a longer synthetic pane state withheld two calls at confidence 0.002, so
it is not a one-off. `eval.py`
reports that number first, because after the fine-tune a refusal is not an error:
the escalation ladder treats it as "escalate to a stronger model", which is the
designed path for a state the cheap model will not commit to.

## 1. Environment inspected

Recorded because everything below is version-specific.

| | |
|---|---|
| Package | `cactus-needle` **3.2.8** (`/home/operator/work/fleet-supervisor/.venv`) |
| Interpreter | CPython **3.14.7**, uv venv at `/home/operator/work/fleet-supervisor/.venv` |
| Engine library | `libneedle.so` **3.3.3**, cached at `~/.cache/cactus-needle/v3/3.3.3/` |
| Base weights | `needle3.cact` 35.3 MB, cached beside it |
| Installed | `huggingface_hub 2.3.0`, `tqdm`, `click`, `PyYAML` — **no pip in the venv** |
| **Not** installed | `jax`, `jaxlib`, `flax`, `optax`, `numpy`, `safetensors`, `sentencepiece` |
| Node | v24.21.0 (runs `.ts` directly by type stripping) |
| tsc | 5.9.3 at `fleet-supervisor/node_modules/.bin/tsc` |
| Model config | vocab 8192, 20 layers, 121M params, sliding window 1024, `max_position_embeddings` 8192 |

**The training stack is missing.** `needle finetune` and `needle build --lora`
die at `import numpy` today:

```
$ .venv/bin/needle finetune out/train.jsonl --epochs 20 ... --out checkpoints/needle_lora.safetensors
  File ".../needle/model/checkpoints.py", line 4, in <module>
    import numpy as np
ModuleNotFoundError: No module named 'numpy'
```

The package ships the fix as an extra (from `cactus_needle-3.2.8.dist-info/METADATA`):

```
Provides-Extra: train
Requires-Dist: numpy; extra == "train"
Requires-Dist: jax; extra == "train"
Requires-Dist: jaxlib; extra == "train"
Requires-Dist: flax>=0.10.2; extra == "train"
Requires-Dist: optax; extra == "train"
Requires-Dist: safetensors; extra == "train"
Requires-Dist: sentencepiece; extra == "train"
```

so `make deps` runs

```sh
uv pip install --python /home/operator/work/fleet-supervisor/.venv/bin/python "cactus-needle[train]"
```

`uv` because the venv has no `pip` (`python -m pip` → `No module named pip`).
Inference and `eval.py` do **not** need the extra: `import needle` is JAX-free.

## 2. Files

```
finetune/
├── tools.py        the four @needle.tool functions and the one canonical tools JSON
├── dataset.ts      decision-points.jsonl -> out/train.jsonl + out/val.jsonl
├── eval.py         .cact -> refusals, per-class accuracy, confidence calibration
├── Makefile        data -> train -> build -> eval
├── fixtures/       one hand-written decision-point file, so the pipeline runs before the miner finishes
└── out/            generated: tools.json, train.jsonl, val.jsonl, *_decision.cact, eval.json
```

## 3. Data format

The trainer reads one JSON object per line. `needle/model/finetune.py:201`:

```python
def render_example(example):
    tools = example.get("tools", [])
    tools_json = tools if isinstance(tools, str) else json.dumps(tools, separators=(",", ":"), ensure_ascii=False)
    answers = example.get("answers", example.get("function_calls", []))
    ...
    prompt = (prefix + IM_START + "user\n" + TOOLS_START + tools_json + TOOLS_END + "\n"
              + example["query"] + IM_END + "\n" + IM_START + "assistant\n")
    think = THINK_START + "\n" + reasoning + "\n" + THINK_END + "\n" if reasoning else ""
    target = think + TOOL_CALL_START + answers_json + TOOL_CALL_END + IM_END
```

So the keys are `query`, `tools`, `answers`, optional `reasoning`, optional
`system`. `read_examples` (`finetune.py:254`) also converts single-turn
`messages` chat lines, which this scaffold does not use.

One line `dataset.ts` writes, from a real mined row (`new_task` → `flag`),
elided:

```json
{"query": "You supervise one coding agent working unattended. ...\nintent: is the 70h powder from them worth it ...\nterminal tail:\nI detect research intent — searching for promo codes for a website. ...",
 "tools": [{"name":"leave","description":"Agent is on track, no action needed.","parameters":{...}}, ... four tools],
 "answers": [{"name":"flag","arguments":{"problem":"is the 70h powder from them worth it over chlorphine from syntharise?"}}],
 "reasoning": "\"is the 70h powder from them worth it over chlorphine from sy…\" -> problem"}
```

### The mined label is not the op

The miner labels each decision point with **the human's next instruction**, not
with the supervisor's action. Its header says so directly:

> A decision point is a completed agent turn that a human then answered: the
> state the agent left behind is the input, the human's next instruction is the
> label.

The vocabulary is `continue | nudge | redirect | stop | new_task`
(`src/labeling/label-to-op.ts:61`, imported by the miner), decided by regex shape:
halt word → `stop`; short affirmative acknowledgement → `continue`; over 200
characters → `new_task`; correction wording → `redirect`; otherwise `nudge`
(`mine/decision-points.ts:207-224`). The label → op table itself is **not** in this
directory and must not be re-added here: it lives in
`src/labeling/label-to-op.ts`, together with the per-row reasoning and the
argument for why `nudge` maps to an action rather than `leave`. The benchmark
imports the same table, so corpus and bench cannot disagree about what correct
means.

What the mapping produces on the 502 mined rows (`node dataset.ts`):

```
  classes   leave 7  nudge 406  declare_done 0  flag 89
  labels    continue:nudge 71  nudge:nudge 323  redirect:nudge 12  stop:leave 7  new_task:flag 89
  read      502 lines -> 502 examples  (train 452 / val 50)
```

Two notes on that balance. `leave` is 7 rows (1.4%) — the label set only records
points where a human spoke, so the corpus has almost no "nobody had to
intervene" state and the tuned model will rarely stay out of the way; treat its
`leave` recall as a 7-example statistic. `declare_done` is unreachable from these
five labels, so it is a zero-row class and the model cannot learn it here.
`bench/tasks/tasks.jsonl` has the same shape (nudge 406, flag 89, leave 7).

### Field mapping

| mined field | becomes |
|---|---|
| `label` | `LABEL_TO_OP[label]` → `answers[0].name` |
| `humanText` | `intent:` line of the state block; also the `nudge`/`flag` argument |
| `assistantText` | `terminal tail:` block; also the `leave`/`declare_done` argument |
| `toolCalls` | one extra `tool calls: name(summary)` line inside the tail, dropped first when the example is over budget |
| `cwd` | `cwd:` line |
| `paneId`/`status`/`title`/`phase`/`acceptance`/`claimState`/`last`/`idleTicks`/`tail` | passed through to the same `DecisionInput` fields when present (the miner does not emit them today) |
| `toolErrors` | **not used** |

The state block is rendered by `renderInput` and prefixed with `SYSTEM`, both
imported from `src/decision/prompt.ts` — the identical function and string the
fleet's adapters use, so the training text is the inference text, not a copy of
it. Fields the miner did not record render empty.

The argument is always **a span of the query**, which is what the engine's
grounding gate checks and what the `reasoning` line teaches:

| op | argument source |
|---|---|
| `leave` | first sentence of the assistant text, else of the human text |
| `nudge` | first sentence of the human text (the answer a supervisor relays) |
| `declare_done` | first sentence of the assistant text |
| `flag` | first sentence of the human text, else the tool-call line, else the assistant text |

A point whose label is unknown, whose texts are both empty, or that cannot be
made to fit the size budget is skipped and counted — never filled with a
placeholder.

Splits are 90/10 and selected by FNV-1a hash of the query, so re-running the
converter puts the same examples on the same side. Duplicates of
`(label, query)` are dropped.

### Token budget

Every example must fit `--max-len` (default 1024); the trainer truncates longer
ones silently. Measured on the real mined file, one rendered example is:

| piece | chars |
|---|---|
| `SYSTEM` (fleet prompt) | 709 |
| tools JSON (4 tools) | 779 |
| state block with an empty instruction and tail | 175 |
| target (`<think>`, reasoning, call JSON) | 180–330 |

The mined `assistantText` is clipped to 2000 characters (`CLIP_CHARS`,
`decision-points.ts:44`) and its median *is* 2000, so almost every example must
be trimmed to fit — 449 of 502 are, by design. `dataset.ts` computes the exact
overhead for each point, splits what is left 40/60 between the human instruction
and the terminal tail (`--max-human-chars 320`, `--max-tail-chars 900`), then
trims the exact overflow off the tail; if that would leave under 40 characters it
drops the mined tool-call line first and skips the point as a last resort. So the
cap is a guarantee, not a target:

```
  size      longest example 2360 chars, cap 2400  (~787 tokens at 3 chars/token)
```

Measured over the whole split: p50 2183 characters, max 2362. At 2.5
characters/token — pessimistic for this mix of prose and paths — that is 945
tokens, so everything fits `--max-len 1024` with the target included.

The token count itself is still an estimate: `sentencepiece` is not installed
here, so the tokenizer cannot be run. **The real number comes from the trainer's
own first lines**, which print after `make deps`:

```
  data      452 examples  seq_len 1024  cap 1024
```

`seq_len` is `fit_max_len` (`finetune.py:272`, called at `:418`): the longest
example in tokens, rounded up to a power of two. If it reads 1024 while your
longest example is well under the character cap, examples are being truncated —
raise `--max-example-chars`. If it reads 512, you have headroom, and a longer
tail is worth more than a shorter one.

## 4. The pipeline

```sh
cd /home/operator/work/fleet-supervisor/finetune

make deps      # uv pip install "cactus-needle[train]"   (once; network)
make data      # mine/out/decision-points.jsonl -> out/train.jsonl + out/val.jsonl
make train     # LoRA adapter -> checkpoints/needle_lora.safetensors
make build     # merge + slice to 8 layers -> out/needle-decision.cact
make eval      # score the .cact on out/val.jsonl -> out/eval.json
```

`make all` is `train build eval`. `make dry` runs the converter over
`fixtures/sample-points.jsonl` instead — twelve **synthetic** rows, invented for
this purpose, so the converter can be exercised without any real session data in
the tree — and `make smoke` scores the published base archive on that dry split.
Both work before the miner has written anything.

`make eval` pulls `train` and `build` first if their outputs are missing, so it
will start a fine-tune; use `make eval CACT=<existing .cact>` or
`python eval.py --weights <existing .cact>` to score an archive without
retraining. `train` and `build` also refuse to redo work: delete the artifact to
force a re-run.

The two commands that matter, expanded:

```sh
# make train
.venv/bin/needle finetune out/train.jsonl \
    --epochs 20 --batch-size 16 --lr 1e-4 \
    --max-len 1024 --val-split 0.1 --seed 0 \
    --lora-rank 16 --lora-alpha 32 \
    --checkpoint-dir checkpoints --out checkpoints/needle_lora.safetensors

# make build
.venv/bin/needle build --lora checkpoints/needle_lora.safetensors \
    --layers 8 --out out/needle-decision.cact
```

Notes that are easy to get wrong:

- LoRA trains on the **full 20-layer** base whatever `--layers` says; `build`
  merges the adapter and then slices the rung. One fine-tune serves every depth,
  so `make build LAYERS=4` costs nothing extra.
- `build` takes the base checkpoint from the adapter's recorded `base` field, so
  the positional checkpoint can be omitted (`build.py:38-40`).
- `build` fetches the published `needle3.cact` on every run (`build.py:18`,
  `fetch.fetch_weights(3, force=True)`) — it needs the huggingface cache warm.
- `--val-split 0.1` inside `train` is the trainer's own loss-monitoring holdout
  taken from `out/train.jsonl`. `out/val.jsonl` is separate and is what
  `eval.py` scores; nothing is scored twice.
- Epochs: a few hundred examples at batch 16 is ~13 steps/epoch, and 3 epochs
  barely moves a rank-16 adapter. Use 10–30. Judge the loss by the trend; it
  starts near 1.0 because the call's boilerplate is already predicted.
- The base checkpoint auto-downloads on the first `finetune` run
  (`finetune.py:400`, `DEFAULT_BASE = "checkpoints/needle3.safetensors"` at `:31`).

### What comes out

`out/needle-decision.cact` is the deployable archive: adapter merged, sliced to
`LAYERS`, quantised to the 4-bit weights the engine reads, tokenizer packaged.
Point the sidecar at it instead of the published base.

`build` prints the load line itself (`build.py:63`):

```
  next      needle.Needle(weights='out/needle-decision.cact', tools=[...])
```

## 5. Evaluation

```sh
make eval
# or, for a smoke run against the untuned base archive:
make smoke LIMIT=2
```

`eval.py` loads the archive through the Python API —
`needle.Needle(weights=..., tools=..., stateless=True)` (`__init__.py:191`) —
and calls `complete()` once per val line (`__init__.py:269`), so one example can
never see the one before it. It reports, in this order:

1. **`REFUSALS n/N`** plus how many calls the engine withheld. A refusal is
   `function_calls == []`; `suppressed_calls` carries what was withheld.
2. **Overall and answered accuracy** — the second is accuracy on the subset it
   was willing to answer, which is the one to watch while refusals are still high.
3. **Per-class support / predicted / correct / recall / precision** and the
   confusion matrix, with a `refused` column so a class that is never called is
   visible as a column of zeros.
4. **Confidence calibration**: accuracy per confidence decile, the mean
   confidence of each bucket, the gap, and ECE.
5. Up to ten misclassifications with the model's own reasoning line.

`--report out/eval.json` writes all of it, per-example rows included.
`--fail-under 0.8` makes it exit 1 below a threshold, for the Makefile later.

### Two things the eval will tell you about a local build

**(a) Confidence is `None`.** A local LoRA fine-tune does not train the
confidence head, and `build --lora` drops the head from the archive
(`build.py:48-50`):

```python
if ConfidenceHead.key in params:
    params = {k: v for k, v in params.items() if k != ConfidenceHead.key}
    print(f"  {'dropped':<9} the confidence head; it is not trained locally, so confidence reports None")
```

`Needle` then reports `confidence: None` for every call (`__init__.py:204-208`,
`:308`) and warns once. So the decile table is **empty by construction** on a
local build, and `eval.py` says so instead of inventing a score. Measured
against the base archive the same code path fills the buckets, so the report is
exercised both ways. `needle platform finetune` keeps and trains the head; that
is the only local-vs-platform difference that affects this scaffold.

**(b) The ladder will escalate every decision.** `src/decision/needle_sidecar.py`
does `confidence = float(out.get("confidence") or 0.0)`, which turns `None` into
`0.0`, and `ladder.ts` escalates whenever `confidence < threshold`. A locally
tuned .cact therefore escalates 100% of decisions until that is resolved. Not
fixed here (`src/` is out of scope) — see Open questions.

## 6. Verification log

Every command in the Makefile was checked against the installed package, not
recalled from docs.

### `needle --help` (installed 3.2.8)

```
usage: needle <command> [options]

  run            run a checkpoint on a query (JAX, Needle 3)
  finetune       train a LoRA adapter on JSONL data
  generate-data  synthesise training data via OpenRouter
  build          export a checkpoint (+ adapter) to a .cact archive
  ...
```

### `needle finetune --help`

```
usage: needle finetune [-h] [--checkpoint CHECKPOINT] [--epochs EPOCHS]
                       [--batch-size BATCH_SIZE] [--lr LR]
                       [--lora-rank LORA_RANK] [--lora-alpha LORA_ALPHA]
                       [--max-len MAX_LEN] [--val-split VAL_SPLIT]
                       [--seed SEED] [--generate GENERATE] [--model MODEL]
                       [--workers WORKERS] [--checkpoint-dir CHECKPOINT_DIR]
                       [--out OUT]
                       jsonl_path
```

Every flag in the `train` recipe appears above. There is no `--score` flag:
`--score` exists only as an attribute the trainer reads with
`getattr(args, "score", True)` (`finetune.py:490`), i.e. quantised held-out
scoring is always on.

### `needle build --help`

```
usage: needle build [-h] [--lora LORA] [--out OUT] [--upload]
                    [--layers LAYERS]
                    [--platform {...}]
                    [checkpoint]

  --lora LORA           LoRA adapter to merge before export
  --out OUT             Output .cact path
  --layers LAYERS       Export the N-layer rung of the base (2..20); default
                        the full 20
```

`--layers` bounds are enforced in `rung()` (`finetune.py:301-302`):

```python
if not 2 <= layers < config.num_layers:
    raise ValueError(f"--layers must be in [2, {config.num_layers}], got {layers}")
```
so `LAYERS=8` is valid and `LAYERS=20` means "no slicing".

### Flags parsed, then failed on the missing extra

Both recipes were executed for real; they got past `argparse` and stopped at the
first training import, which is the proof that no flag was invented:

```
$ .venv/bin/needle finetune out/train.jsonl --epochs 20 --batch-size 16 --lr 1e-4 \
    --max-len 1024 --val-split 0.1 --seed 0 --lora-rank 16 --lora-alpha 32 \
    --checkpoint-dir checkpoints --out checkpoints/needle_lora.safetensors
ModuleNotFoundError: No module named 'numpy'
```

(`argparse` would have exited 2 with `unrecognized arguments` otherwise.)

### The converter and the evaluator, run for real

```
$ node dataset.ts                      # over the real mine/out/decision-points.jsonl
  input     /home/operator/work/fleet-supervisor/mine/out/decision-points.jsonl
  read      502 lines -> 502 examples  (train 452 / val 50)
  classes   leave 7  nudge 406  declare_done 0  flag 89
  labels    continue:nudge 71  nudge:nudge 323  redirect:nudge 12  stop:leave 7  new_task:flag 89
  size      longest example 2355 chars, cap 2400  (~785 tokens at 3 chars/token)
  skipped   trimmed 462
  wrote     /home/operator/work/fleet-supervisor/finetune/out/train.jsonl  /home/operator/work/fleet-supervisor/finetune/out/val.jsonl

$ make dry                             # the same converter over the fixture
  read      12 lines -> 10 examples  (train 9 / val 1)
  classes   leave 1  nudge 6  declare_done 0  flag 3
  skipped   unreadable 2  trimmed 3
```

Two invariants were then checked outside the converter, over all 502 lines of
both splits:

```
rendered p50 2183 max 2362                      # render_example's own serialisation,
                                                # none over the 2400 cap
checked 512 examples, 0 arguments not a verbatim span of their query
```

The second one matters more than it looks: the engine's grounding gate withholds
a call whose argument is not in the input, so an argument that is edited rather
than quoted trains the model against a gate that will reject it. An earlier cut
of `firstSentence` appended `…` to a truncated argument and produced 93 such
examples; the check above is what caught it.

```
$ make smoke LIMIT=1     # real engine, real archive
needle decision eval
  weights     /home/operator/.cache/cactus-needle/v3/3.3.3/needle3.cact
  val         out/dry/val.jsonl  1 examples, 1 scored
  tools       train-exact JSON, 779 chars
              generation: 3
              confidence head: present

REFUSALS  1/1 (100.0%)   0 call(s) withheld by the engine
answered  0/1   accuracy   0.0% overall,   n/a on what it answered
latency   median 1371 ms/decision
...
  confidence calibration
    bucket           n  accuracy  mean conf     gap
    0.0-0.1          1      0.0%      0.028  -0.028
    ECE 0.028 over 1 calibrated call(s)
```

Latency varies widely run to run: the first call in a process pays engine load
and prefill and has been measured at 20-43 s on this CPU for the full 20-layer
archive, while a warm call is ~1.4 s. Budget the eval accordingly (`--limit`) and
expect a sliced 8-layer rung to be several times faster.

That is the whole reason for the fine-tune, reproduced through the scaffold:
the base model withholds its call on a decision point.

`dataset.ts` typechecks under the repo's own compiler and strictness:

```
$ node_modules/.bin/tsc --noEmit --strict --noUncheckedIndexedAccess --noImplicitOverride \
    --module NodeNext --moduleResolution NodeNext --allowImportingTsExtensions ...
$ echo $?
0
```

`make typecheck` reruns it. The file has no `any`, uses tabs, `.ts` import
specifiers, and `import type` for types, matching `src/decision/types.ts`.

## 7. Open questions

Marked `UNVERIFIED` where the code is written but the behaviour has not been
observed. Nothing else in this scaffold is inferred.

1. **`UNVERIFIED` — the exact token count of a rendered example.** `sentencepiece`
   is not installed, so `fit_max_len` cannot run here. The 2400-character cap is
   a bound, not a measurement (max rendered 2362 chars ≈ 945 tokens at 2.5
   chars/token); confirm with the trainer's `seq_len` line after `make deps`
   (section 3).
2. **`UNVERIFIED` — that a tuned archive lifts this task.** No adapter has been
   trained (`make train` needs the extra, and the miner is still writing data).
   The eval prints the number once one exists.
3. **`UNVERIFIED` — jax wheels for CPython 3.14.** The venv is 3.14; if
   `make deps` cannot resolve `jaxlib`, the training stack needs a 3.11–3.13 venv.
   Only `needle finetune`/`build` are affected, not inference or `eval.py`.
4. **`UNVERIFIED` — `--platform` engine builds.** `needle build --platform
   <folder>` exists in `--help` and is the documented deploy path, but no
   platform folder was built here. `LAYERS` + `--out` alone produce the archive
   the existing sidecar already loads.
5. **Tools JSON whitespace.** Training renders compact JSON
   (`finetune.py:203`), while `Needle(tools=[fn])` — what
   `needle_sidecar.py` passes — dumps with default separators
   (`__init__.py:212`). `eval.py --tools-style train` (default) matches training
   exactly by passing the JSON string; `--tools-style sidecar` reproduces the
   wire format. If production accuracy trails the eval, this is the first
   difference to test, and the fix belongs in `src/`.
6. **The `date:` system fact.** `Needle` prefixes `date: YYYY-MM-DD …` to the
   system text unless `auto_date=False` (`__init__.py:210`), and the sidecar
   keeps the default. Training lines carry no `system` key, so no system turn is
   rendered. The blog documents `"system"` as matching `Needle(system=...)`; a
   dated system turn in the data would go stale, so it is deliberately omitted.
7. **The ladder sees `confidence: None` as 0.0** and escalates everything
   (section 5b). Options, none applied: `needle platform finetune` (keeps the
   head), or have the sidecar map `None` to a constant when it loads tuned
   weights. Both are outside `finetune/`.
8. **`docs/` is absent.** The brief said metric definitions live in
   `/home/operator/work/fleet-supervisor/docs/`; there is no such directory in this workspace,
   so the metrics here are the ones the eval needs: per-class accuracy, decile
   calibration, refusal count.
9. **`UNVERIFIED` — that this label mapping is the one the ladder wants.** The
   mapping is now owned by `src/labeling/label-to-op.ts` (see "The mined label is
   not the op"), one table for both the corpus and the benchmark, but no eval has
   run against it: the tuned model and the bench models have not yet been scored
   on the same op definition, which is the comparison that would settle it.
   Changing a row is now a one-file edit plus `make data train eval`.
10. **`toolErrors` is unused.** 123 of 502 rows carry a non-zero count
   (`decision-points.ts:30`), and a tool error is plausibly the strongest single
   signal for `flag`. It is left out because the fleet's `DecisionInput` has no
   field for it, and inventing a line the inference prompt never renders would
   train on text production never shows.
11. **Class balance.** `nudge` is 406 of 502 rows, `leave` is 7 and
   `declare_done` is 0, so per-class recall on `leave` is a 7-example statistic
   and `declare_done` cannot be learned at all. If the eval shows `leave`
   collapsing, the fix is more `stop` points, not more epochs.
