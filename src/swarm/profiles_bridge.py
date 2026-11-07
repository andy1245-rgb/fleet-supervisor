"""One request per invocation: JSON on stdin, one JSON object on stdout.

The role profiles are Python (`profiles/`) and the runtime is TypeScript, so the
adapter is a process boundary rather than an import. It is deliberately one-shot and
not a long-lived sidecar: what crosses is data and arithmetic — a table, a rendered
state block, a ceiling predicate — that costs ~30 ms to compute, and a package holding
no engine has nothing to keep warm.

    {"op": "snapshot"}                                -> {"roles": {...}}
    {"op": "render", "role", "licence", "state"}      -> {"text": "..."}
    {"op": "may_spawn", "role", "depth",
                        "parentBudget", "childBudget"} -> {"allowed": bool, "reason": str}

`may_spawn` is here, and only here, because `profiles/common.py` is the single
definition of both ceilings. A TypeScript copy of that predicate would be a second
definition, and the second definition is the one that drifts.
"""
from __future__ import annotations

import json
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, ROOT)


def snapshot() -> dict:
    from profiles import ROLES, caps, catalogue_of, system

    roles = {}
    for name in ROLES:
        cap = caps(name)
        # `orch` is the only role with two catalogues; the rest have one, and it is the
        # leaf one (RG §2.3: a leaf's grammar must not contain `spawn` at all).
        variants = ("leaf", "inner") if name == "orch" else ("leaf",)
        licences = {}
        for licence in variants:
            tools = []
            for tool in catalogue_of(name, licence):
                properties = tool["parameters"].get("properties", {})
                required = tool["parameters"].get("required", list(properties))
                tools.append(
                    {
                        "name": tool["name"],
                        "args": [
                            {"name": arg, "enum": properties.get(arg, {}).get("enum", [])}
                            for arg in required
                        ],
                    }
                )
            licences[licence] = {"system": system(name, licence), "tools": tools}
        roles[name] = {
            "caps": {
                "maxNewTokens": cap.max_new_tokens,
                "depth": cap.depth,
                "chainCeiling": cap.chain_ceiling,
                "binCeiling": cap.bin_ceiling,
                "window": cap.window,
                "totalChars": cap.total_chars,
            },
            "licences": licences,
        }
    return {"roles": roles}


def main() -> int:
    request = json.load(sys.stdin)
    op = request.get("op")
    if op == "snapshot":
        reply = snapshot()
    elif op == "render":
        from profiles import render

        licence = request.get("licence", "leaf")
        reply = {"text": render(request["role"], request["state"], licence)}
    elif op == "may_spawn":
        from profiles import caps
        from profiles.common import may_spawn

        delegation = may_spawn(
            int(request["depth"]),
            int(request["parentBudget"]),
            int(request["childBudget"]),
            caps(request["role"]),
        )
        reply = {"allowed": delegation.allowed, "reason": delegation.reason}
    else:
        reply = {"error": f"unknown op {op!r}"}
    json.dump(reply, sys.stdout)
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as error:  # noqa: BLE001 - the caller needs the reason, not a traceback
        json.dump({"error": f"{type(error).__name__}: {error}"}, sys.stdout)
        sys.stdout.write("\n")
        sys.exit(1)
