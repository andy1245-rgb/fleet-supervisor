"""Train and export the needle fine-tune slate defined by slate.json.

One variant is one directory. `out/slate/<id>/` holds the variant's filtered
training data, its adapter and the wall-clock it cost; `out/<id>/<id>.cact` is
the exported archive.

Every variant runs the same three steps:

  prepare  filter out/train.jsonl + out/val.jsonl by the variant's `labels`, in
           both places the class appears — the row's answer and the tool
           catalogue the row carries — so a 3-class variant is trained against a
           3-tool grammar instead of being told about a class it cannot emit.
  train    `needle finetune`, with every epoch timed from the child's own log
           lines. LoRA trains on the full 20-layer base whatever `layers` says.
  build    `needle build --lora <adapter> --layers N`, which merges the adapter
           and then slices the rung, then writes the .cact.

A variant whose labels match one already trained in this run reuses that
adapter: re-training byte-identical data buys nothing and costs the wall clock
twice. Credits go to the variant that trained it (`trained_by`).

    python slate.py list
    python slate.py probe --variant d4 --max-epoch-seconds 600
    python slate.py run --variant d4 --epochs 12
    python slate.py status
"""
import argparse
import hashlib
import json
import re
import subprocess
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
NEEDLE = ROOT / ".venv" / "bin" / "needle"
SLATE = HERE / "slate.json"
OUT = HERE / "out"
TRAIN_SRC = OUT / "train.jsonl"
VAL_SRC = OUT / "val.jsonl"
BASE_CHECKPOINT = HERE / "checkpoints" / "needle3.safetensors"
VARIANT_ROOT = OUT / "slate"
REPORT = VARIANT_ROOT / "slate-report.json"

OPS = ("leave", "nudge", "declare_done", "flag")
EPOCH_LINE = re.compile(r"^\s+epoch\s+(\d+)/(\d+)\s+loss")


def load_slate():
	raw = json.loads(SLATE.read_text(encoding="utf-8"))
	variants = raw.get("variants")
	if not isinstance(variants, list) or not variants:
		raise SystemExit(f"{SLATE}: no variants")
	seen = set()
	for variant in variants:
		for key in ("id", "layers", "labels", "description"):
			if key not in variant:
				raise SystemExit(f"{SLATE}: variant {variant.get('id')!r} has no {key!r}")
		ident = str(variant["id"])
		if ident in seen:
			raise SystemExit(f"{SLATE}: duplicate id {ident!r}")
		seen.add(ident)
		layers = variant["layers"]
		if not isinstance(layers, int) or not 2 <= layers <= 20:
			raise SystemExit(f"{SLATE}: {ident} layers must be 2..20, got {layers!r}")
		labels = variant["labels"]
		if not isinstance(labels, list) or not labels:
			raise SystemExit(f"{SLATE}: {ident} has an empty label set")
		unknown = [label for label in labels if label not in OPS]
		if unknown:
			raise SystemExit(f"{SLATE}: {ident} names labels outside {OPS}: {unknown}")
		variant.setdefault("train", True)
		if not isinstance(variant["train"], bool):
			raise SystemExit(f"{SLATE}: {ident} train must be true or false")
	return variants


def find_variant(variants, ident):
	for variant in variants:
		if variant["id"] == ident:
			return variant
	raise SystemExit(f"no variant {ident!r} in {SLATE}; have " + ", ".join(v["id"] for v in variants))


def read_jsonl(path):
	with path.open(encoding="utf-8") as handle:
		for line in handle:
			line = line.strip()
			if line:
				yield json.loads(line)


def digest(path):
	sha = hashlib.sha256()
	with path.open("rb") as handle:
		for chunk in iter(lambda: handle.read(1 << 20), b""):
			sha.update(chunk)
	return sha.hexdigest()[:16]


def prepare(variant):
	"""Filter the shared splits into the variant's own training files."""
	labels = variant["labels"]
	folder = VARIANT_ROOT / variant["id"]
	folder.mkdir(parents=True, exist_ok=True)
	meta = {"id": variant["id"], "layers": variant["layers"], "labels": labels,
	        "description": variant["description"], "files": {}}
	for split, source in (("train", TRAIN_SRC), ("val", VAL_SRC)):
		if not source.exists():
			raise SystemExit(f"{source} is missing; run `make data` first")
		kept, dropped, per_op, tools_chars = [], {}, {}, 0
		for row in read_jsonl(source):
			answers = row.get("answers") or []
			name = str(answers[0].get("name")) if answers else ""
			if name not in labels:
				dropped[name] = dropped.get(name, 0) + 1
				continue
			tools = [tool for tool in (row.get("tools") or []) if tool.get("name") in labels]
			row["tools"] = tools
			tools_chars = len(json.dumps(tools, separators=(",", ":"), ensure_ascii=False))
			kept.append(row)
			per_op[name] = per_op.get(name, 0) + 1
		target = folder / f"{split}.jsonl"
		target.write_text("".join(json.dumps(row, ensure_ascii=False) + "\n" for row in kept),
		                  encoding="utf-8")
		meta["files"][split] = {"path": str(target), "rows": len(kept), "perOp": per_op,
		                        "dropped": dropped, "sha256": digest(target),
		                        "toolsChars": tools_chars}
		print(f"  {'prepare':<9} {split:<5} {len(kept):>4} rows  sha {digest(target)}  "
		      f"tools {tools_chars} chars  kept {per_op}  dropped {dropped or '{}'}")
	meta["dataKey"] = ",".join(labels)
	(VARIANT_ROOT / variant["id"] / "data.json").write_text(json.dumps(meta, indent="\t") + "\n",
	                                                        encoding="utf-8")
	return meta


def stream(command):
	"""Run a child, print its log with elapsed stamps, keep the epoch marks."""
	started = time.monotonic()
	marks, steps = [], []
	process = subprocess.Popen([str(part) for part in command], stdout=subprocess.PIPE,
	                           stderr=subprocess.STDOUT, text=True, bufsize=1)
	assert process.stdout is not None
	for line in process.stdout:
		line = line.rstrip()
		now = time.monotonic() - started
		print(f"[{now:7.1f}s] {line}", flush=True)
		match = EPOCH_LINE.match(line)
		if match:
			marks.append((int(match.group(1)), now))
		if line.strip().startswith("step"):
			steps.append(now)
	process.wait()
	return process.returncode, marks, steps, time.monotonic() - started


def epoch_seconds(marks):
	"""Per-epoch wall clock. Epoch 1 carries the JIT compile, so it is reported
	rather than hidden, and the steady rate is taken from epoch 2 onward."""
	if not marks:
		return {"perEpoch": [], "first": None, "steadyMedian": None}
	times = [marks[0][1]] + [later[1] - earlier[1] for earlier, later in zip(marks, marks[1:])]
	steady = times[1:] or times
	steady.sort()
	middle = len(steady) // 2
	median = steady[middle] if len(steady) % 2 else (steady[middle - 1] + steady[middle]) / 2
	return {"perEpoch": [round(value, 1) for value in times],
	        "first": round(times[0], 1), "steadyMedian": round(median, 1)}


def train(variant, epochs, val_split=0.1, folder=None, tag="train"):
	"""One `needle finetune` run, timed per epoch from the trainer's own lines."""
	if not BASE_CHECKPOINT.exists():
		raise SystemExit(f"{BASE_CHECKPOINT} is missing; the trainer needs the base checkpoint "
		                 f"(needle download needle3.safetensors, then move it here)")
	dest = folder or (VARIANT_ROOT / variant["id"])
	dest.mkdir(parents=True, exist_ok=True)
	adapter = dest / "adapter.safetensors"
	command = [
		NEEDLE, "finetune", dest / "train.jsonl",
		"--checkpoint", BASE_CHECKPOINT,
		"--epochs", epochs, "--batch-size", 16, "--lr", "1e-4",
		"--max-len", 1024, "--val-split", val_split, "--seed", 0,
		"--lora-rank", 16, "--lora-alpha", 32,
		"--checkpoint-dir", dest / "ckpt", "--out", adapter,
	]
	print(f"  {'{0}'.format(tag):<9} {' '.join(str(part) for part in command)}", flush=True)
	code, marks, steps, total = stream(command)
	timing = {"epochs": epochs, "valSplit": val_split, "exit": code,
	          "wallSeconds": round(total, 1), "steps": len(steps),
	          "epochs_seen": [index for index, _ in marks],
	          **epoch_seconds(marks),
	          "adapter": str(adapter) if adapter.exists() else None,
	          "adapterBytes": adapter.stat().st_size if adapter.exists() else 0}
	print(f"  {'{0}'.format(tag):<9} exit {code}  wall {total:.1f}s  "
	      f"epochs {timing['perEpoch']}  steady {timing['steadyMedian']}s/epoch")
	if code != 0:
		raise SystemExit(f"needle finetune failed with exit {code}")
	if not adapter.exists():
		raise SystemExit("needle finetune reported success but wrote no adapter")
	return adapter, timing


def build(variant, adapter):
	"""Merge the adapter (when there is one) and slice the rung: --layers N, then
	export one .cact. A control variant passes the checkpoint positionally instead:
	no adapter, same rung, so the row prices the depth rather than the fine-tune."""
	folder = OUT / variant["id"]
	folder.mkdir(parents=True, exist_ok=True)
	archive = folder / f"{variant['id']}.cact"
	merge = ["--lora", adapter] if adapter else [BASE_CHECKPOINT]
	command = [NEEDLE, "build", *merge, "--layers", variant["layers"], "--out", archive]
	code, _, _, total = stream(command)
	if code != 0:
		raise SystemExit(f"needle build failed with exit {code}")
	if not archive.exists():
		raise SystemExit(f"needle build reported success but {archive} is not on disk")
	print(f"  {'export':<9} {archive}  {archive.stat().st_size} bytes  "
	      f"layers {variant['layers']}  {total:.1f}s")
	return {"path": str(archive), "bytes": archive.stat().st_size, "seconds": round(total, 1)}


def load_report():
	if REPORT.exists():
		try:
			return json.loads(REPORT.read_text(encoding="utf-8"))
		except json.JSONDecodeError:
			return {}
	return {}


def save_report(report):
	VARIANT_ROOT.mkdir(parents=True, exist_ok=True)
	REPORT.write_text(json.dumps(report, indent="\t") + "\n", encoding="utf-8")


def reused_adapter(report, variant):
	"""An adapter trained for the same label set, if this run already made one."""
	key = ",".join(variant["labels"])
	for other_id, record in report.items():
		if other_id == variant["id"]:
			continue
		if record.get("dataKey") != key:
			continue
		adapter = record.get("adapter")
		if adapter and Path(adapter).exists():
			return Path(adapter), other_id
	return None, None


def run_variant(variant, epochs, report):
	print(f"\n== {variant['id']}  layers {variant['layers']}  labels {variant['labels']}"
	      f"{'  control (no adapter)' if not variant['train'] else ''}")
	meta = prepare(variant)
	adapter, trained_by, timing = None, None, None
	if not variant["train"]:
		print(f"  {'control':<9} the published base checkpoint, no adapter: this row prices the "
		      f"depth, it is not a fine-tune")
	else:
		adapter, trained_by = reused_adapter(report, variant)
		if adapter:
			print(f"  {'reuse':<9} adapter from {trained_by}: labels {variant['labels']} train the "
			      f"identical rows, and LoRA trains the full {20}-layer base whatever --layers says")
		else:
			adapter, timing = train(variant, epochs)
			trained_by = variant["id"]
	export = build(variant, adapter)
	record = {**meta, "dataKey": ",".join(variant["labels"]),
	          "kind": "control" if not variant["train"] else "finetune",
	          "adapter": str(adapter) if adapter else None,
	          "trainedBy": trained_by, "epochs": epochs, "timing": timing, "export": export,
	          "recordedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())}
	report[variant["id"]] = record
	save_report(report)
	return record


def command_list(_args):
	for variant in load_slate():
		print(variant["id"])


def command_probe(args):
	"""One epoch on one variant, so the slate's cost is measured before it is paid."""
	variants = load_slate()
	variant = find_variant(variants, args.variant)
	folder = VARIANT_ROOT / "_probe" / variant["id"]
	folder.mkdir(parents=True, exist_ok=True)
	print(f"probe: {variant['id']}  epochs 1  val-split 0 (no held-out pass, so the number is "
	      f"the epoch)")
	prepare(variant)
	for name in ("train", "val"):
		source = VARIANT_ROOT / variant["id"] / f"{name}.jsonl"
		if not source.exists():
			raise SystemExit(f"{source} missing after prepare")
	(folder / "train.jsonl").write_bytes((VARIANT_ROOT / variant["id"] / "train.jsonl").read_bytes())
	adapter, timing = train(variant, 1, val_split=0.0, folder=folder, tag="probe")
	measured = timing["steadyMedian"] or timing["first"] or timing["wallSeconds"]
	verdict = "within budget" if measured <= args.max_epoch_seconds else "OVER BUDGET"
	result = {**timing, "variant": variant["id"], "measuredSecondsPerEpoch": measured,
	          "maxEpochSeconds": args.max_epoch_seconds, "verdict": verdict,
	          "at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())}
	(folder / "timing.json").write_text(json.dumps(result, indent="\t") + "\n", encoding="utf-8")
	report = load_report()
	report.setdefault("_probe", {}).update({variant["id"]: result})
	save_report(report)
	print(f"\nprobe: {measured}s/epoch  (epoch 1 with compile {timing['first']}s, "
	      f"max {args.max_epoch_seconds}s)  {verdict}")
	if measured > args.max_epoch_seconds:
		return 2
	return 0


def command_run(args):
	variants = load_slate()
	variant = find_variant(variants, args.variant)
	report = load_report()
	run_variant(variant, args.epochs, report)
	return 0


def command_status(_args):
	report = load_report()
	variants = load_slate()
	print(f"{'variant':<10}{'layers':>7}  {'rows':>5}  {'adapter':>10}  {'cact':>10}  "
	      f"{'sec/epoch':>10}  labels")
	for variant in variants:
		source = VARIANT_ROOT / variant["id"] / "train.jsonl"
		rows = sum(1 for _ in source.open(encoding="utf-8")) if source.exists() else 0
		adapter = VARIANT_ROOT / variant["id"] / "adapter.safetensors"
		archive = OUT / variant["id"] / f"{variant['id']}.cact"
		record = report.get(variant["id"]) or {}
		rate = ((record.get("timing") or {}).get("steadyMedian"))
		print(f"{variant['id']:<10}{variant['layers']:>7}  {rows:>5}  "
		      f"{adapter.stat().st_size if adapter.exists() else 0:>10}  "
		      f"{archive.stat().st_size if archive.exists() else 0:>10}  "
		      f"{rate if rate is not None else '-':>10}  {','.join(variant['labels'])}")
	return 0


def main(argv):
	parser = argparse.ArgumentParser(description=__doc__,
	                                 formatter_class=argparse.RawDescriptionHelpFormatter)
	commands = parser.add_subparsers(dest="command", required=True)
	commands.add_parser("list", help="print the variant ids, one per line")
	commands.add_parser("status", help="rows, adapter and archive per variant")
	status_parser = commands.add_parser("run", help="prepare, train, merge, slice, export")
	status_parser.add_argument("--variant", required=True)
	status_parser.add_argument("--epochs", type=int, default=12)
	probe_parser = commands.add_parser("probe", help="time one epoch before paying for the slate")
	probe_parser.add_argument("--variant", required=True)
	probe_parser.add_argument("--max-epoch-seconds", type=float, default=600.0)
	args = parser.parse_args(argv)
	if args.command == "list":
		return command_list(args)
	if args.command == "status":
		return command_status(args)
	if args.command == "probe":
		return command_probe(args)
	return command_run(args)


if __name__ == "__main__":
	raise SystemExit(main(sys.argv[1:]))
