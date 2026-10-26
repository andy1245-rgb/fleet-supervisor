"""Needle sidecar: loads the model once, then answers one decision per JSON line.

Spawned by src/decision/needle.ts. The engine maps the .cact weights in place, so
loading per decision would cost ~5s each — hence the long-lived process.

stdin  (one JSON object per line): {"system": str, "user": str}
stdout (one JSON object per line): {"ok": true, "raw": str, "confidence": float,
                                   "refused": bool, "latency_ms": int, ...}
                                   or {"ok": false, "error": str}
"""
import json
import os
import sys
import time

os.environ.setdefault("NEEDLE_TELEMETRY", "0")


def main() -> None:
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

    tools = [leave, nudge, declare_done, flag]
    agent = needle.Needle(tools=tools)
    sys.stderr.write("needle: ready\n")
    sys.stderr.flush()

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
        except json.JSONDecodeError as exc:
            sys.stdout.write(json.dumps({"ok": False, "error": f"bad request: {exc}"}) + "\n")
            sys.stdout.flush()
            continue

        text = f"{req.get('system', '')}\n\n{req.get('user', '')}"
        started = time.time()
        try:
            out = agent.run(text)
        except Exception as exc:  # engine faults must not kill the sidecar
            sys.stdout.write(json.dumps({"ok": False, "error": f"{type(exc).__name__}: {exc}"}) + "\n")
            sys.stdout.flush()
            continue
        # A grammar-constrained call may be withheld by the grounding check; that
        # is a refusal, not an action, and the ladder treats it as zero confidence.
        calls = out.get("function_calls") or []
        confidence = float(out.get("confidence") or 0.0)
        call = calls[0] if calls else None
        op = call.get("name") if isinstance(call, dict) else None
        args = call.get("arguments") if isinstance(call, dict) else None
        argument = ""
        if isinstance(args, dict) and args:
            argument = str(next(iter(args.values())))
        sys.stdout.write(
            json.dumps(
                {
                    "ok": True,
                    "op": op,
                    "argument": argument,
                    "confidence": confidence,
                    "refused": not calls,
                    "latency_ms": int((time.time() - started) * 1000),
                    "suppressed": len(out.get("suppressed_calls") or []),
                    "reasoning": out.get("reasoning"),
                }
            )
            + "\n"
        )
        sys.stdout.flush()


if __name__ == "__main__":
    main()
