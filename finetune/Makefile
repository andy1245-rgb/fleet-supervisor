# decision-point data -> LoRA adapter -> sliced .cact -> eval.
# Every command here is one the installed package actually accepts; the
# verification for each is pasted in README.md.

ROOT     := /home/andrew/agentFleet
VENV     := $(ROOT)/.venv
PY       := $(VENV)/bin/python
NEEDLE   := $(VENV)/bin/needle
NODE     ?= node
UV       ?= uv
TSC      := $(ROOT)/node_modules/.bin/tsc

POINTS   ?= $(ROOT)/mine/out/decision-points.jsonl
OUT      := out
CKPT     := checkpoints
TOOLS    := $(OUT)/tools.json
TRAIN    := $(OUT)/train.jsonl
VAL      := $(OUT)/val.jsonl
ADAPTER  := $(CKPT)/needle_lora.safetensors
CACT     ?= $(OUT)/needle-decision.cact
REPORT   := $(OUT)/eval.json

# The rung that ships: 2..20; build slices the tuned 20-layer adapter.
LAYERS   ?= 8
# A few hundred examples need many passes; see the loss guidance in README.md.
EPOCHS   ?= 20
BATCH    ?= 16
LR       ?= 1e-4
MAXLEN   ?= 1024
VALSPLIT ?= 0.1
LIMIT    ?= 0

BASE_ARCHIVE = $(shell $(PY) -c "from needle.agent import fetch; print(fetch.cache_dir(3) + '/' + fetch.base_weights(3))" 2>/dev/null)

.PHONY: help deps tools data dry train build eval all smoke typecheck clean slate slate-probe slate-status

# --- slate: several variants trained and exported together -------------------
# slate.json is the source of truth for what a variant is: its depth and its
# label scope. One variant = prepare -> finetune -> merge + slice
# (`needle build --lora ... --layers N`) -> out/<id>/<id>.cact. The probe pays
# for one epoch of the first variant first, so a slate that cannot fit the
# wall clock is abandoned after one epoch instead of after twelve.
SLATE_IDS    := $(shell $(PY) slate.py list 2>/dev/null)
SLATE        := $(PY) -u slate.py
SLATE_EPOCHS ?= 12
MAX_EPOCH_S  ?= 600
PROBE_ID     ?= $(firstword $(SLATE_IDS))

help:
	@echo "make deps      install the training extra into $(VENV) (jax, flax, optax, sentencepiece)"
	@echo "make tools     write $(TOOLS) from tools.py"
	@echo "make data      $(POINTS) -> $(TRAIN) + $(VAL) (90/10)"
	@echo "make dry       same, from fixtures/sample-points.jsonl, into $(OUT)/dry"
	@echo "make train     LoRA fine-tune -> $(ADAPTER)  (EPOCHS=$(EPOCHS) BATCH=$(BATCH) LR=$(LR))"
	@echo "make build     merge + slice to $(LAYERS) layers -> $(CACT)"
	@echo "make eval      score $(CACT) on $(VAL): refusals, per-class accuracy, calibration"
	@echo "make smoke     score the published base archive on the dry split, no training"
	@echo "make all       train build eval"
	@echo "make slate     every variant in slate.json: train -> merge -> build --layers N -> out/<id>/<id>.cact"
	@echo "make slate-probe  time one epoch of $(PROBE_ID) before paying for the whole slate"
	@echo "make slate-status rows, adapter and archive per variant"

deps:
	$(UV) pip install --python $(PY) "cactus-needle[train]"

$(TOOLS): tools.py
	mkdir -p $(OUT)
	$(PY) tools.py > $(TOOLS)
	@echo "  wrote $(TOOLS)  $$(wc -c < $(TOOLS)) bytes"

tools: $(TOOLS)

$(TRAIN) $(VAL) &: dataset.ts $(TOOLS)
	$(NODE) dataset.ts --input $(POINTS) --tools $(TOOLS) --out-dir $(OUT)

# The trainer holds out its own slice for loss monitoring; $(VAL) is the split
# eval.py scores, so --val-split runs on $(TRAIN) only.
$(ADAPTER): $(TRAIN)
	mkdir -p $(CKPT)
	$(NEEDLE) finetune $(TRAIN) \
		--epochs $(EPOCHS) --batch-size $(BATCH) --lr $(LR) \
		--max-len $(MAXLEN) --val-split $(VALSPLIT) --seed 0 \
		--lora-rank 16 --lora-alpha 32 \
		--checkpoint-dir $(CKPT) --out $(ADAPTER)

$(CACT): $(ADAPTER)
	$(NEEDLE) build --lora $(ADAPTER) --layers $(LAYERS) --out $(CACT)


data: $(TRAIN) $(VAL)
train: $(ADAPTER)
build: $(CACT)

# Always re-scores: an eval you cannot re-run is not a measurement.
eval: $(CACT) $(VAL)
	$(PY) eval.py --weights $(CACT) --val $(VAL) --report $(REPORT)

all: train build eval

dry: $(TOOLS)
	$(NODE) dataset.ts --input fixtures/sample-points.jsonl --tools $(TOOLS) --out-dir $(OUT)/dry

smoke: $(TOOLS) dry
	$(PY) eval.py --weights $(BASE_ARCHIVE) --val $(OUT)/dry/val.jsonl \
		$$(test $(LIMIT) -gt 0 && echo --limit $(LIMIT)) --report $(OUT)/smoke.json

# Each variant runs its own three steps, in order, through slate.py: the data
# filter, `needle finetune`, then `needle build --lora --layers N` (merge, slice,
# export). A variant whose label set was already trained reuses that adapter —
# LoRA trains the full 20-layer base, so only the export differs by depth.
slate: $(TRAIN) $(VAL)
	@for id in $(SLATE_IDS); do \
		$(SLATE) run --variant $$id --epochs $(SLATE_EPOCHS) || exit 1; \
	done
	@echo "  slate     archives:"
	@ls -l out/*/*.cact 2>/dev/null || echo "  slate     no .cact was written; see the failure above"

slate-probe: $(TRAIN) $(VAL)
	$(SLATE) probe --variant $(PROBE_ID) --max-epoch-seconds $(MAX_EPOCH_S)

slate-status:
	$(SLATE) status

typecheck:
	$(TSC) --noEmit --strict --noUncheckedIndexedAccess --noImplicitOverride \
		--target ES2023 --lib ES2023 --module NodeNext --moduleResolution NodeNext \
		--types node --allowImportingTsExtensions --verbatimModuleSyntax \
		--isolatedModules --forceConsistentCasingInFileNames --skipLibCheck \
		dataset.ts

clean:
	rm -rf $(OUT) $(CKPT)
