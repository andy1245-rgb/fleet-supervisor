"""Run one exported .cact archive over a task file, one decision per line.

`bench/runners/slate.ts` owns the comparison: it renders the prompt, picks the
stratified task set, scores and writes the record. This process only loads one
archive, calls the engine and reports what came back, so every variant is
measured through the same code path as every other variant.

The prompt arrives already rendered because the TypeScript side uses the same
`src/decision/prompt.ts` that built the training text — the score is over the
text the model was trained on, not a re-implementation of it.

    python slate_bridge.py --weights out/d8/d8.cact --labels leave,nudge \\
        --tools out/tools.json --tasks /tmp/slate-tasks.jsonl --out /tmp/d8.jsonl
"""
import argparse
import json
import sys
import time
import warnings

import needle

import tools as tool_module


def parse_args(argv):
	parser = argparse.ArgumentParser(description=__doc__,
	                                 formatter_class=argparse.RawDescriptionHelpFormatter)
	parser.add_argument("--weights", required=True, help="Exported .cact archive")
	parser.add_argument("--labels", required=True,
	                    help="Comma separated op names; the decode grammar is built from these "
	                         "only, so a scope variant cannot emit a class it was not trained on")
	parser.add_argument("--tasks", required=True, help="JSONL of {id, query} from the harness")
	parser.add_argument("--out", required=True, help="JSONL of one decision per task")
	parser.add_argument("--max-new-tokens", type=int, default=96)
	parser.add_argument("--tools-style", choices=("train", "sidecar"), default="train")
	parser.add_argument("--warmup", action="store_true", default=True,
	                    help="Paying engine load and prefill on the first task would otherwise be "
	                         "reported as that task's latency (default: on)")
	parser.add_argument("--no-warmup", dest="warmup", action="store_false")
	return parser.parse_args(argv)


def catalogue(labels, style):
	"""The four tool schemas, cut down to the variant's label set, in file order."""
	wanted = {label.strip() for label in labels.split(",") if label.strip()}
	known = [schema.get("name") for schema in tool_module.SCHEMAS]
	unknown = sorted(wanted - set(known))
	if unknown:
		raise SystemExit(f"--labels names tools that do not exist: {unknown} (have {known})")
	selected = [schema for schema in tool_module.SCHEMAS if schema.get("name") in wanted]
	if not selected:
		raise SystemExit("--labels selected no tools")
	if style == "train":
		return json.dumps(selected, separators=(",", ":"), ensure_ascii=False), [s["name"] for s in selected]
	return json.dumps(selected), [s["name"] for s in selected]


def read_tasks(path):
	tasks = []
	with open(path, encoding="utf-8") as handle:
		for line in handle:
			line = line.strip()
			if line:
				tasks.append(json.loads(line))
	return tasks


def call(agent, query, max_new_tokens):
	started = time.time()
	try:
		response = agent.complete(query, max_new_tokens=max_new_tokens)
	except Exception as error:  # a crash on one task must not lose the other rows
		return {"op": None, "argument": "", "confidence": None, "refused": True,
		        "suppressed": 0, "reasoning": "", "error": f"{type(error).__name__}: {error}",
		        "latencyMs": int((time.time() - started) * 1000)}
	calls = response.get("function_calls") or []
	suppressed = response.get("suppressed_calls") or []
	name = None
	argument = ""
	if calls and isinstance(calls[0], dict):
		raw_name = calls[0].get("name")
		name = str(raw_name) if raw_name else None
		arguments = calls[0].get("arguments")
		if isinstance(arguments, dict):
			first = next(iter(arguments.values()), "")
			argument = str(first)
	confidence = response.get("confidence")
	return {"op": name, "argument": argument,
	        "confidence": float(confidence) if isinstance(confidence, (int, float)) else None,
	        "refused": name is None, "suppressed": len(suppressed),
	        "reasoning": str(response.get("reasoning") or ""), "error": None,
	        "latencyMs": int((time.time() - started) * 1000)}


def main(argv):
	args = parse_args(argv)
	tasks = read_tasks(args.tasks)
	if not tasks:
		raise SystemExit(f"{args.tasks} has no tasks")
	tools_json, names = catalogue(args.labels, args.tools_style)
	with warnings.catch_warnings(record=True) as caught:
		warnings.simplefilter("always")
		agent = needle.Needle(weights=args.weights, tools=tools_json, stateless=True)
	for warning in caught:
		print(f"  note      {warning.message}", file=sys.stderr)
	print(f"  weights   {args.weights}", file=sys.stderr)
	print(f"  grammar   {names}", file=sys.stderr)
	if args.warmup:
		call(agent, tasks[0]["query"], args.max_new_tokens)
	rows = []
	for task in tasks:
		row = {"id": task["id"], **call(agent, task["query"], args.max_new_tokens)}
		rows.append(row)
		print(f"  {row['id']:<18} {str(row['op']):<13} {row['latencyMs']:>6} ms"
		      f"{'  refused' if row['refused'] else ''}", file=sys.stderr)
	with open(args.out, "w", encoding="utf-8") as handle:
		for row in rows:
			handle.write(json.dumps(row, ensure_ascii=False) + "\n")
	metric = {name: sum(1 for row in rows if row["op"] == name) for name in names}
	print(json.dumps({"weights": args.weights, "rows": len(rows), "predicted": metric,
	                  "refusals": sum(1 for row in rows if row["refused"])}))
	return 0


if __name__ == "__main__":
	raise SystemExit(main(sys.argv[1:]))
