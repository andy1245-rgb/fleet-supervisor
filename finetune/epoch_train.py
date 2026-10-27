"""`needle finetune`, with an adapter written after every epoch.

`needle finetune --epochs N` writes its adapter once, after the last epoch, and
takes no resume flag: a run killed at epoch N-1 keeps nothing it paid for, and a
1.5 h job has two chances to be killed. This drives the installed trainer's own
primitives — `load_checkpoint`, `fit_max_len`, `load_jsonl`, `configure_deploy`,
`cq_ste_params`, `init_lora`, `lora_target_paths`, `merge_lora`, `_training_rng`,
`_score_quantised`, `write_adapter` — through the identical loop, the identical
mask and the identical warmup+cosine schedule, and writes
`<checkpoint-dir>/epoch<N>.safetensors` at each epoch boundary. The model, the
loss, the quantisation and the optimiser are the package's; nothing about the
training semantics is reimplemented here, only when the adapter is persisted.

Every log line carries elapsed seconds, so progress can be read from the tail of
a log without a clock. `--report` writes the per-epoch marks as JSON.

    python epoch_train.py out/slate/d4/train.jsonl \
        --checkpoint checkpoints/needle3.safetensors \
        --epochs 3 --batch-size 16 --lr 1e-4 --max-len 640 --val-split 0.1 \
        --seed 0 --lora-rank 16 --lora-alpha 32 \
        --checkpoint-dir out/slate/d4/ckpt --out out/slate/d4/adapter.safetensors \
        --report out/slate/d4/timing.json
"""
import argparse
import json
import os
import time

import numpy as np

from needle.model import finetune as F
from needle.model.checkpoints import write_adapter
from needle.model.tokenizer import get_tokenizer


def parse_args(argv):
	parser = argparse.ArgumentParser(description=__doc__,
	                                 formatter_class=argparse.RawDescriptionHelpFormatter)
	parser.add_argument("jsonl_path")
	parser.add_argument("--checkpoint", default=None)
	parser.add_argument("--epochs", type=int, default=3)
	parser.add_argument("--batch-size", type=int, default=16)
	parser.add_argument("--lr", type=float, default=1e-4)
	parser.add_argument("--max-len", type=int, default=640)
	parser.add_argument("--val-split", type=float, default=0.1)
	parser.add_argument("--seed", type=int, default=0)
	parser.add_argument("--lora-rank", type=int, default=16)
	parser.add_argument("--lora-alpha", type=float, default=32)
	parser.add_argument("--checkpoint-dir", default="checkpoints")
	parser.add_argument("--out", default=None)
	parser.add_argument("--report", default=None)
	parser.add_argument("--no-score", dest="score", action="store_false", default=True)
	return parser.parse_args(argv)


def main(argv):
	args = parse_args(argv)
	import jax
	import jax.numpy as jnp
	import optax
	from needle.model.architecture import SimpleAttentionNetwork
	from needle.model.quantize import configure_deploy, cq_ste_params, WEIGHT_BITS
	from needle.model.run import load_checkpoint

	started = time.monotonic()

	def emit(message):
		print(f"[{time.monotonic() - started:8.1f}s] {message}", flush=True)

	base_path = args.checkpoint or F.DEFAULT_BASE
	params, config = load_checkpoint(base_path)
	config.dtype = "float32"
	params = jax.tree.map(lambda array: np.asarray(array).astype(np.float32), params)
	backend = jax.default_backend().lower()
	if backend == "metal":
		config.flash = False
		config.remat = False
		config.scan_unroll = config.num_layers
	params = jax.device_put(params)
	emit(f"  {'backend':<9} {backend}  float32")
	emit(f"  {'depth':<9} {config.num_layers} layers")
	tokenizer = get_tokenizer(config.vocab_size)
	max_len = F.fit_max_len(args.jsonl_path, tokenizer, args.max_len)
	seqs, masks = F.load_jsonl(args.jsonl_path, tokenizer, max_len)
	if len(seqs) == 0:
		raise SystemExit("no usable examples in " + args.jsonl_path)
	dead = int((masks.sum(axis=1) == 0).sum())
	emit(f"  {'data':<9} {len(seqs)} examples  seq_len {max_len}  cap {args.max_len}")
	# The trainer truncates after building the loss mask, so a row whose prompt
	# fills the window trains on nothing while the loss still prints: count them.
	emit(f"  {'mask':<9} {dead}/{len(seqs)} rows carry an all-zero mask at seq_len {max_len}")

	model = SimpleAttentionNetwork(config)
	configure_deploy(act_bits=getattr(config, "act_bits", 8),
	                 kv_bits=getattr(config, "kv_bits", 8))
	emit(f"  {'numerics':<9} CQ W{WEIGHT_BITS} STE + A8 (matches export)")
	paths = F.lora_target_paths(params)
	scale = args.lora_alpha / args.lora_rank
	seed = args.seed
	rng = F._training_rng(seed)
	lora = F.init_lora(params, paths, args.lora_rank, jax.random.PRNGKey(seed))
	emit(f"  {'lora':<9} rank {args.lora_rank}  alpha {args.lora_alpha:g}  {len(paths)} weight groups")

	n_val = min(int(len(seqs) * args.val_split), len(seqs) - 1)
	if n_val > 0:
		order = rng.permutation(len(seqs))
		seqs, masks = seqs[order], masks[order]
		val_seqs, val_masks = seqs[:n_val], masks[:n_val]
		seqs, masks = seqs[n_val:], masks[n_val:]
		emit(f"  {'holdout':<9} {n_val} examples for validation")

	batch, count = args.batch_size, len(seqs)
	steps_per_epoch = -(-count // batch)
	total_steps = args.epochs * steps_per_epoch
	warmup = min(max(1, total_steps // 20), total_steps - 1)
	schedule = optax.warmup_cosine_decay_schedule(
	    init_value=0.0, peak_value=args.lr,
	    warmup_steps=warmup, decay_steps=total_steps)
	optimizer = optax.chain(optax.clip_by_global_norm(1.0), optax.adamw(schedule))
	opt_state = optimizer.init(lora)
	emit(f"  {'schedule':<9} {total_steps} steps  warmup {warmup}  cosine decay  clip 1.0  (compiling...)")

	def loss_fn(lora, ids, mask):
		merged = cq_ste_params(F.merge_lora(params, lora, scale), WEIGHT_BITS)
		logits = model.apply({"params": merged}, ids, quant=True)
		logits, targets, mask = logits[:, :-1], ids[:, 1:], mask[:, 1:]
		ce = optax.softmax_cross_entropy_with_integer_labels(logits, targets)
		return (ce * mask).sum() / jnp.maximum(mask.sum(), 1.0)

	@jax.jit
	def train_step(lora, opt_state, ids, mask):
		loss, grads = jax.value_and_grad(loss_fn)(lora, ids, mask)
		updates, opt_state = optimizer.update(grads, opt_state, lora)
		return optax.apply_updates(lora, updates), opt_state, loss

	eval_step = jax.jit(loss_fn)

	def save(path):
		write_adapter(path, {
		    "lora": {"/".join(p): {"A": np.asarray(v["A"]), "B": np.asarray(v["B"])}
		             for p, v in lora.items()},
		    "scale": float(scale),
		    "base": base_path,
		    "rank": args.lora_rank,
		    "seed": seed,
		})
		return path

	os.makedirs(args.checkpoint_dir, exist_ok=True)

	every = max(1, total_steps // 50)
	step_i = 0
	marks, checkpoints = [], []
	last_epoch_started = time.monotonic()
	for epoch in range(args.epochs):
		order = rng.permutation(count)
		last = 0.0
		for start in range(0, count, batch):
			idx = order[start:start + batch]
			lora, opt_state, loss = train_step(lora, opt_state,
			                                   jnp.asarray(seqs[idx]), jnp.asarray(masks[idx]))
			last = float(loss)
			step_i += 1
			if step_i % every == 0:
				emit(f"  {'step':<9} {step_i}/{total_steps}  loss {last:.4f}")
		value = None
		if n_val > 0:
			value = float(np.mean([float(eval_step(lora, jnp.asarray(val_seqs[i:i + batch]),
			                                       jnp.asarray(val_masks[i:i + batch])))
			                       for i in range(0, n_val, batch)]))
			emit(f"  {'epoch':<9} {epoch + 1}/{args.epochs}  loss {last:.4f}  val {value:.4f}")
		else:
			emit(f"  {'epoch':<9} {epoch + 1}/{args.epochs}  loss {last:.4f}")
		at = time.monotonic() - started
		checkpoint = save(os.path.join(args.checkpoint_dir, f"epoch{epoch + 1}.safetensors"))
		checkpoints.append(checkpoint)
		marks.append({"epoch": epoch + 1, "loss": round(last, 6),
		              "val": None if value is None else round(value, 6),
		              "atSeconds": round(at, 1),
		              "seconds": round(time.monotonic() - last_epoch_started, 1)})
		last_epoch_started = time.monotonic()
		emit(f"  {'ckpt':<9} {checkpoint}  {os.path.getsize(checkpoint)} bytes")

	if n_val > 0 and args.score:
		correct, total = F._score_quantised(model, params, lora, scale, tokenizer,
		                                    args.jsonl_path, n_val, rng_seed=seed)
		if total:
			emit(f"  {'accuracy':<9} {correct}/{total} held-out calls exact, scored on the "
			     f"W{WEIGHT_BITS} weights the archive ships")

	out = args.out or os.path.join(args.checkpoint_dir, "needle_lora.safetensors")
	save(out)
	emit(f"  {'adapter':<9} {out}  {os.path.getsize(out)} bytes")

	result = {"jsonl": args.jsonl_path, "base": base_path, "rows": int(len(masks)) + n_val,
	          "trainedRows": int(len(seqs)), "seqLen": int(max_len), "cap": args.max_len,
	          "deadRows": dead, "epochs": args.epochs, "batchSize": batch,
	          "stepsPerEpoch": steps_per_epoch, "totalSteps": total_steps, "lr": args.lr,
	          "valSplit": args.val_split, "holdout": n_val, "seed": seed,
	          "loraRank": args.lora_rank, "loraAlpha": args.lora_alpha,
	          "epochMarks": marks, "wallSeconds": round(time.monotonic() - started, 1),
	          "adapter": out, "adapterBytes": os.path.getsize(out),
	          "checkpoints": checkpoints,
	          "at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())}
	if args.report:
		with open(args.report, "w", encoding="utf-8") as handle:
			json.dump(result, handle, indent="\t")
			handle.write("\n")
	emit("RESULT " + json.dumps(result))
	return 0


if __name__ == "__main__":
	raise SystemExit(main(__import__("sys").argv[1:]))
