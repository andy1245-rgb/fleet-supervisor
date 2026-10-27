"""What the training window actually costs: static prefix, prompt spread, mask fit.

The engine's window is 1024 tokens and `_encode` truncates after building the mask,
so a prompt that fills `--max-len` leaves the target outside the window and the row
contributes a zero gradient while the loss still prints. This measures, with the
tokenizer the model itself uses, the three things that decide whether a `--max-len`
trains every row: the static prefix (SYSTEM + the four tool schemas), the spread of
prompt + target over a split, and the rows whose window has no target token left.

    python measure_window.py                        # out/train.jsonl
    python measure_window.py --split out/val.jsonl
"""
import argparse
import json
import os
import re
import statistics
import sys

from needle.model.finetune import render_example
from needle.model.tokenizer import get_tokenizer

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PROMPT_TS = os.path.join(ROOT, "src", "decision", "prompt.ts")
TOOLS_JSON = os.path.join(ROOT, "finetune", "out", "tools.json")
TRAIN = os.path.join(ROOT, "finetune", "out", "train.jsonl")
# The rendered query is SYSTEM, a blank line, then the state block.
STATE_MARK = "\n\npane: "
SEQS = (256, 512, 640, 768, 1024)


def system_text() -> str:
    """SYSTEM as the TS module declares it: one template literal, no interpolation."""
    with open(PROMPT_TS, encoding="utf-8") as handle:
        source = handle.read()
    match = re.search(r"export const SYSTEM = `([^`]*)`;", source)
    if not match:
        raise SystemExit(f"cannot find SYSTEM in {PROMPT_TS}")
    return match.group(1)


def read_rows(path: str) -> list[dict]:
    rows = []
    with open(path, encoding="utf-8", errors="surrogatepass") as handle:
        for line in handle:
            line = line.strip()
            if line:
                rows.append(json.loads(line))
    return rows


def state_of(row: dict) -> str:
    query = row["query"]
    index = query.find(STATE_MARK)
    return query[index + 2:] if index >= 0 else ""


def spread(values: list[int]) -> str:
    return f"min {min(values):3d}  mean {statistics.mean(values):6.1f}  max {max(values):3d}"


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--split", default=TRAIN)
    parser.add_argument("--tools", default=TOOLS_JSON)
    args = parser.parse_args(argv)

    tokenizer = get_tokenizer()
    system = system_text()
    with open(args.tools, encoding="utf-8") as handle:
        tools = json.load(handle)

    system_tokens = len(tokenizer.encode(system))
    tools_tokens = len(tokenizer.encode(json.dumps(tools, separators=(",", ":"), ensure_ascii=False)))
    static, _ = render_example({"query": f"{system}\n\n", "tools": tools})
    static_tokens = len(tokenizer.encode(static))

    rows = read_rows(args.split)
    prompts, targets, states, tails, totals = [], [], [], [], []
    unencodable, dead = 0, {seq: 0 for seq in SEQS}
    for row in rows:
        prompt, target = render_example(row)
        try:
            prompt_ids = tokenizer.encode(prompt)
            target_ids = tokenizer.encode(target)
        except (RuntimeError, ValueError):
            unencodable += 1
            continue
        state = state_of(row)
        prompts.append(len(prompt_ids))
        targets.append(len(target_ids))
        states.append(len(tokenizer.encode(state)))
        tails.append(len(state.partition("terminal tail:\n")[2]))
        totals.append(len(prompt_ids) + len(target_ids))
        for seq in SEQS:
            mask = [0.0] * (1 + len(prompt_ids)) + [1.0] * (len(target_ids) + 1)
            if sum(mask[:seq]) == 0.0:
                dead[seq] += 1

    print(f"split        {args.split}  ({len(rows)} rows)")
    print(f"system       {len(system)} chars -> {system_tokens} tokens")
    print(f"tools        {os.path.basename(args.tools)} -> {tools_tokens} tokens")
    print(f"prefix       {system_tokens + tools_tokens} tokens  (rendered with the chat and <tools> markers: {static_tokens})")
    print(f"state        {spread(states)} tokens")
    print(f"prompt       {spread(prompts)} tokens")
    print(f"target       {spread(targets)} tokens")
    print(f"tail chars   {spread(tails)}")
    print(f"row total    {spread(totals)} tokens")
    if unencodable:
        print(f"UNENCODABLE  {unencodable} rows the tokenizer refuses (lone surrogate)")
    for seq in SEQS:
        verdict = "every row trains" if dead[seq] == 0 else f"{dead[seq]}/{len(rows)} rows carry an all-zero mask"
        print(f"  seq {seq:<5} {verdict}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
