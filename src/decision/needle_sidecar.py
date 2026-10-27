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

# One decode per decision, and 96 generated tokens rather than the stock 512.
# Both numbers come from the engine's 1024-token sliding window and the 333-token
# static prefix that needle_init() builds from the system text and the four tool
# schemas: at max_new_tokens=512 the input budget is 1024 - 333 - 512 = 179 tokens
# (~570 chars), which no real fleet tail fits, so the engine degenerates into a
# self-repeating reasoning block until the adapter's 30s timeout fires. At 96 the
# input budget is 595 tokens (~1900 chars).
#
# Decode once, not via run(): run() is a tool-execution loop, and even at
# max_steps=1 it re-decodes after executing the tool and returns *that* second
# decode. Our tools record nothing, so the loop only ever fed meaningless results
# back into the window and doubled the cost of every decision.
MAX_NEW_TOKENS = 96


def main() -> None:
    import needle

    # The sidecar reads the call, it never acts on it, but a tool that returns None
    # hands the engine a null result; a sentinel is what a caller raising max_steps
    # would need to feed back.
    @needle.tool
    def leave(reason: str):
        "Agent is on track; no action."
        return {"ok": True}

    @needle.tool
    def nudge(message: str):
        "Agent stopped before finishing; send this."
        return {"ok": True}

    @needle.tool
    def declare_done(summary: str):
        "Criteria met; what was delivered."
        return {"ok": True}

    @needle.tool
    def flag(problem: str):
        "Needs a human or stronger model."
        return {"ok": True}

    tools = [leave, nudge, declare_done, flag]
    # stateless=True makes every complete() start with reset(): without it decision N
    # is decoded conditioned on the unrelated panes of decisions 1..N-1, and the
    # shared conversation grows the prefix until it re-starves the 1024-token window
    # (the failure above, reached slowly). One request, one reset, no carry-over.
    agent = needle.Needle(tools=tools, stateless=True)
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
            agent.reset()
            out = agent.complete(text, max_new_tokens=MAX_NEW_TOKENS)
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
