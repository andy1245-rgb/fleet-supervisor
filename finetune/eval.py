"""Score an exported .cact on the held-out split of decision points.

Three numbers, in the order they matter:

  refusals     the engine withheld the call. For this task a refusal is not an
               error: the ladder escalates it to a stronger model, which is the
               designed path for a state the cheap model will not commit to.
  per-class    which of leave/nudge/declare_done/flag it gets right, and which
               it trades against which.
  calibration  accuracy per confidence decile. A local LoRA build reports
               `confidence` as None (needle build drops the untrained head), so
               the buckets fill only for a base or platform-fine-tuned archive.
               The report says which case it is instead of inventing a score.

    python eval.py --weights out/needle-decision.cact --val out/val.jsonl
"""
import argparse
import json
import sys
import time
import warnings
from pathlib import Path

import needle

import tools as tool_module

OPS = ("leave", "nudge", "declare_done", "flag")
DECILES = 10


class Prediction:
    def __init__(self, label: str, predicted: str | None, refused: bool, suppressed: int,
                 confidence: float | None, reasoning: str, latency_ms: int, error: str | None):
        self.label = label
        self.predicted = predicted
        self.refused = refused
        self.suppressed = suppressed
        self.confidence = confidence
        self.reasoning = reasoning
        self.latency_ms = latency_ms
        self.error = error

    @property
    def correct(self) -> bool:
        return self.predicted == self.label


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--weights", required=True, help="Exported .cact to score")
    parser.add_argument("--val", default="out/val.jsonl", help="Held-out JSONL from dataset.ts")
    parser.add_argument("--report", default=None, help="Write the full report as JSON here")
    parser.add_argument("--limit", type=int, default=0, help="Score only the first N examples")
    parser.add_argument("--max-new-tokens", type=int, default=96,
                        help="A decision is one short call; 96 is well past it (default: 96)")
    parser.add_argument("--tools-style", choices=("train", "sidecar"), default="train",
                        help="train: the compact JSON the training lines carry (default). "
                             "sidecar: the spaced JSON Needle(tools=[fn]) sends, i.e. what "
                             "src/decision/needle_sidecar.py puts on the wire")
    parser.add_argument("--fail-under", type=float, default=None,
                        help="Exit 1 when answered accuracy is below this value")
    parser.add_argument("--quiet", action="store_true", help="Only the summary numbers")
    return parser.parse_args(argv)


def load_split(path: Path) -> list[dict]:
    examples = []
    with path.open(encoding="utf-8") as handle:
        for number, line in enumerate(handle, 1):
            line = line.strip()
            if not line:
                continue
            example = json.loads(line)
            answers = example.get("answers") or []
            if not answers or not isinstance(example.get("query"), str):
                raise SystemExit(f"{path}:{number} is not a training line (needs query + answers)")
            examples.append({"query": example["query"], "label": str(answers[0].get("name"))})
    return examples


def tools_text(style: str) -> str:
    if style == "train":
        return tool_module.compact_json()
    # Needle(tools=[fn]) / the sidecar: json.dumps' default separators.
    return json.dumps(tool_module.SCHEMAS)


def build_agent(weights: str, style: str) -> tuple[needle.Needle, list[str]]:
    notes = []
    with warnings.catch_warnings(record=True) as caught:
        warnings.simplefilter("always")
        # stateless: one decision per pane, so no example may see the one before it.
        agent = needle.Needle(weights=weights, tools=tools_text(style), stateless=True)
    for warning in caught:
        notes.append(str(warning.message))
    return agent, notes


def predict(agent: needle.Needle, query: str, label: str, max_new_tokens: int) -> Prediction:
    started = time.time()
    try:
        response = agent.complete(query, max_new_tokens=max_new_tokens)
    except Exception as exc:
        return Prediction(label, None, True, 0, None, "", int((time.time() - started) * 1000),
                          f"{type(exc).__name__}: {exc}")
    calls = response.get("function_calls") or []
    suppressed = response.get("suppressed_calls") or []
    predicted = None
    if calls and isinstance(calls[0], dict):
        name = calls[0].get("name")
        predicted = str(name) if name else None
    raw_confidence = response.get("confidence")
    confidence = float(raw_confidence) if isinstance(raw_confidence, (int, float)) else None
    return Prediction(label, predicted, predicted is None, len(suppressed), confidence,
                      str(response.get("reasoning") or ""), int((time.time() - started) * 1000),
                      None)


def confusion(rows: list[Prediction]) -> dict[str, dict[str, int]]:
    table = {label: {op: 0 for op in OPS} | {"refused": 0} for label in OPS}
    for row in rows:
        column = row.predicted if row.predicted in OPS else "refused"
        if row.label in table:
            table[row.label][column] += 1
    return table


def per_class(rows: list[Prediction]) -> list[dict]:
    stats = []
    for op in OPS:
        support = sum(1 for row in rows if row.label == op)
        predicted = sum(1 for row in rows if row.predicted == op)
        correct = sum(1 for row in rows if row.label == op and row.predicted == op)
        stats.append({
            "op": op,
            "support": support,
            "predicted": predicted,
            "correct": correct,
            "recall": correct / support if support else None,
            "precision": correct / predicted if predicted else None,
        })
    return stats


def calibration(rows: list[Prediction]) -> list[dict]:
    buckets = [{"lo": i / DECILES, "hi": (i + 1) / DECILES, "n": 0, "correct": 0,
                "confidence_sum": 0.0} for i in range(DECILES)]
    for row in rows:
        if row.confidence is None:
            continue
        index = min(DECILES - 1, max(0, int(row.confidence * DECILES)))
        bucket = buckets[index]
        bucket["n"] += 1
        bucket["correct"] += 1 if row.correct else 0
        bucket["confidence_sum"] += row.confidence
    return buckets


def expected_calibration_error(buckets: list[dict], total: int) -> float | None:
    if total == 0:
        return None
    error = 0.0
    for bucket in buckets:
        if not bucket["n"]:
            continue
        accuracy = bucket["correct"] / bucket["n"]
        mean_confidence = bucket["confidence_sum"] / bucket["n"]
        error += (bucket["n"] / total) * abs(accuracy - mean_confidence)
    return error


def percent(value: float | None) -> str:
    return "  n/a" if value is None else f"{value * 100:5.1f}%"


def describe_archive(path: Path) -> list[str]:
    lines = []
    for name, label in (("_weight_generation", "generation"),
                        ("_confidence_head_present", "confidence head")):
        reader = getattr(needle, name, None)
        if reader is None:
            continue
        try:
            value = reader(str(path))
        except Exception as exc:
            lines.append(f"{label}: unreadable ({type(exc).__name__}: {exc})")
            continue
        lines.append(f"{label}: {value}" if label == "generation"
                     else f"{label}: {'present' if value else 'absent'}")
    return lines


def report(args: argparse.Namespace, rows: list[Prediction], notes: list[str],
           archive: list[str], examples: int) -> int:
    total = len(rows)
    refused = sum(1 for row in rows if row.refused)
    suppressed = sum(row.suppressed for row in rows)
    errors = sum(1 for row in rows if row.error)
    correct = sum(1 for row in rows if row.correct)
    answered = total - refused
    scored = [row for row in rows if row.confidence is not None]
    buckets = calibration(rows)
    ece = expected_calibration_error(buckets, len(scored))
    latencies = sorted(row.latency_ms for row in rows)
    median_latency = latencies[len(latencies) // 2] if latencies else 0

    print("needle decision eval")
    print(f"  {'weights':<11} {args.weights}")
    print(f"  {'val':<11} {args.val}  {examples} examples, {total} scored")
    print(f"  {'tools':<11} {args.tools_style}-exact JSON, {len(tools_text(args.tools_style))} chars")
    for line in archive:
        print(f"  {'':<11} {line}")
    if errors:
        print(f"  {'errors':<11} {errors} call(s) raised; counted as refusals")

    print()
    print(f"REFUSALS  {refused}/{total} ({refused / total * 100:.1f}%)"
          f"   {suppressed} call(s) withheld by the engine")
    print(f"answered  {answered}/{total}   accuracy {percent(correct / total if total else None)}"
          f" overall, {percent(correct / answered if answered else None)} on what it answered")
    print(f"latency   median {median_latency} ms/decision")

    if not args.quiet:
        print()
        print(f"  {'class':<13}{'support':>8}{'predicted':>10}{'correct':>9}{'recall':>8}{'precision':>10}")
        for stat in per_class(rows):
            print(f"  {stat['op']:<13}{stat['support']:>8}{stat['predicted']:>10}"
                  f"{stat['correct']:>9}{percent(stat['recall']):>8}{percent(stat['precision']):>10}")

        print()
        header = "".join(f"{op[:11]:>12}" for op in OPS)
        print(f"  {'true \\ pred':<13}{header}{'refused':>9}")
        table = confusion(rows)
        for label in OPS:
            cells = "".join(f"{table[label][op]:>12}" for op in OPS)
            print(f"  {label:<13}{cells}{table[label]['refused']:>9}")

        print()
        print("  confidence calibration")
        if not scored:
            print("    no confidence values: this archive has no trained head, so the")
            print("    engine reports None for every call (needle build drops it after a")
            print("    local LoRA fine-tune). The deciles are empty by construction, not")
            print("    by failure; run `needle platform finetune` to keep the head.")
        else:
            print(f"    {'bucket':<12}{'n':>6}{'accuracy':>10}{'mean conf':>11}{'gap':>8}")
            for bucket in buckets:
                if not bucket["n"]:
                    continue
                accuracy = bucket["correct"] / bucket["n"]
                mean_confidence = bucket["confidence_sum"] / bucket["n"]
                span = f"{bucket['lo']:.1f}-{bucket['hi']:.1f}"
                print(f"    {span:<12}{bucket['n']:>6}{accuracy * 100:>9.1f}%"
                      f"{mean_confidence:>11.3f}{accuracy - mean_confidence:>8.3f}")
            print(f"    ECE {ece:.3f} over {len(scored)} calibrated call(s)"
                  if ece is not None else "    ECE n/a")
            missing = total - len(scored)
            if missing:
                print(f"    {missing} call(s) reported no confidence and are outside the buckets")

        if notes:
            print()
            for note in notes:
                print(f"  note: {note}")
        wrong = [row for row in rows if not row.correct and not row.refused]
        if wrong:
            print()
            print("  misclassified")
            for row in wrong[:10]:
                print(f"    want {row.label:<13} got {row.predicted:<13} {row.reasoning[:70]}")
            if len(wrong) > 10:
                print(f"    ... {len(wrong) - 10} more")

    if args.report:
        payload = {
            "weights": args.weights,
            "val": args.val,
            "tools_style": args.tools_style,
            "examples": examples,
            "scored": total,
            "refused": refused,
            "suppressed_calls": suppressed,
            "errors": errors,
            "accuracy": correct / total if total else None,
            "accuracy_answered": correct / answered if answered else None,
            "median_latency_ms": median_latency,
            "per_class": per_class(rows),
            "confusion": confusion(rows),
            "calibration": [bucket for bucket in buckets if bucket["n"]],
            "ece": ece,
            "confidence_available": bool(scored),
            "notes": notes,
            "archive": archive,
            "rows": [{"label": row.label, "predicted": row.predicted, "refused": row.refused,
                      "suppressed": row.suppressed, "confidence": row.confidence,
                      "latency_ms": row.latency_ms, "error": row.error} for row in rows],
        }
        Path(args.report).parent.mkdir(parents=True, exist_ok=True)
        Path(args.report).write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
        print(f"\n  {'report':<11} {args.report}")

    if args.fail_under is not None:
        accuracy = correct / answered if answered else 0.0
        return 0 if accuracy >= args.fail_under else 1
    return 0


def main(argv: list[str]) -> int:
    args = parse_args(argv)
    weights = Path(args.weights)
    if not weights.exists():
        raise SystemExit(f"{weights} does not exist — run `make build` first")
    examples = load_split(Path(args.val))
    if args.limit:
        examples = examples[: args.limit]
    try:
        agent, notes = build_agent(str(weights), args.tools_style)
    except Exception as exc:
        raise SystemExit(f"could not load {weights}: {type(exc).__name__}: {exc}") from exc
    rows = []
    try:
        for examplenum, example in enumerate(examples, 1):
            row = predict(agent, example["query"], example["label"], args.max_new_tokens)
            rows.append(row)
            if not args.quiet:
                outcome = row.predicted or "refused"
                flag = "ok " if row.correct else "   "
                sys.stderr.write(f"\r  scoring {examplenum}/{len(examples)}  {flag}{row.label} -> {outcome}"
                                 + " " * 20)
                sys.stderr.flush()
    finally:
        agent.close()
    if not args.quiet and rows:
        sys.stderr.write("\r" + " " * 78 + "\r")
        sys.stderr.flush()
    archive = describe_archive(weights)
    return report(args, rows, notes, archive, len(examples))


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
