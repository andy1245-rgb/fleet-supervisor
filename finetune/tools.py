"""The four decision tools, defined once, for training and for evaluation.

`needle.tool` turns each function into the schema the engine compiles its decode
grammar from, and `compact_json()` serialises those schemas exactly the way
`needle.model.finetune.render_example` serialises them into a training line:

    tools_json = json.dumps(tools, separators=(",", ":"), ensure_ascii=False)

Keeping one source of truth here is what makes the tools in `out/tools.json`
byte-identical to the ones the model was trained against. The docstrings are the
tool descriptions and are copied verbatim from src/decision/needle_sidecar.py, so
a tuned archive answers the same surface the sidecar already speaks.

    python tools.py          # compact JSON on stdout, for out/tools.json
    python tools.py --pretty # the same object, indented, for reading
"""
import json
import sys

import needle


@needle.tool
def leave(reason: str):
    "Agent is on track, no action needed. argument: short reason."


@needle.tool
def nudge(message: str):
    "Agent stopped before finishing. argument: the instruction to send it."


@needle.tool
def declare_done(summary: str):
    "Agent met its acceptance criteria. argument: what was delivered."


@needle.tool
def flag(problem: str):
    "Needs a human or a stronger model. argument: the problem."


TOOL_FUNCTIONS = (leave, nudge, declare_done, flag)

SCHEMAS = [needle.build_schema(fn) for fn in TOOL_FUNCTIONS]


def compact_json() -> str:
    """The tools string a training line renders, and the one eval hands the engine."""
    return json.dumps(SCHEMAS, separators=(",", ":"), ensure_ascii=False)


def main(argv: list[str]) -> int:
    if "-h" in argv or "--help" in argv:
        sys.stdout.write(__doc__ or "")
        return 0
    pretty = "--pretty" in argv
    if pretty:
        sys.stdout.write(json.dumps(SCHEMAS, indent=2, ensure_ascii=False) + "\n")
    else:
        sys.stdout.write(compact_json() + "\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
