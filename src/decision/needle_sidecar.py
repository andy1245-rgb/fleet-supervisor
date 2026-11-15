"""Needle sidecar: loads the model once, then answers one decision per JSON line.

Spawned by src/decision/needle.ts. The engine maps the .cact weights in place, so
loading per decision would cost ~5s each — hence the long-lived process.

stdin  (one JSON object per line): {"system": str, "user": str}
stdout (one JSON object per line): {"ok": true, "raw": str, "confidence": float,
                                   "refused": bool, "latency_ms": int, ...}
                                   or {"ok": false, "error": str}

Four things here were wrong until 2026-11-14, and the review that found them is
docs/needle3-usage-review-2026-11-14.md. Every needle3 record written before this
change was produced under at least one of them, so every one of them is invalid as a
measurement of the model:

1. **The system prompt was concatenated into the query** while `needle_init` was
   called with no system at all. Measured: `needle_init("", tools)` builds a
   156-token static prefix; `needle_init(SYSTEM, tools)` builds 331. The prompt
   belongs in the prefix — that is what the constructor's `system=` argument is
   for — not re-tokenised inside the 1024-token window on every call.
2. **The decode budget was 96 tokens**, which is shorter than this prompt's
   reasoning preamble: at 96 the reasoning is truncated mid-sentence and no tool
   call is ever emitted (measured on three system-prompt placements). With 320 the
   model reaches a call. The window has room — 331 prefix + ~330 state block + 320
   = 981 of 1024 — so 96 was giving away three quarters of the budget it existed to
   protect.
3. **The withheld proposal and the engine's own diagnostics were discarded.** The
   envelope carries `suppressed_calls` — the call the engine declined to commit —
   plus `error`, `error_code`, `success`, `decode_tps`, `prefill_tps` and
   `validation`. This adapter kept a *count* of the first and none of the second, so
   "the engine proposed `flag` and withheld it at confidence 0.03" was reported as
   "the model produced nothing", and the reason was thrown away with it.
4. **No `reset()` before the engine binds.** `stateless=True` already resets per
   call; the explicit redundant call is gone so the convention is the library's.

What is still true: a withheld call is *not* an answer. `refused` stays true when
`function_calls` is empty, because the engine declined to commit and a supervisor
must not act on a proposal the engine would not stand behind. `proposed` is exported
so the record can say which op it was and at what confidence, which is a fact about
the model, not an instruction to act.
"""
import json
import os
import sys
import time

os.environ.setdefault("NEEDLE_TELEMETRY", "0")

# Decode budget. See (2) above: 96 truncated the reasoning before any call could be
# emitted; 320 fits the window with the system prompt in the prefix and leaves the
# reasoning room to finish on all but the longest rows.
MAX_NEW_TOKENS = 320

# Fields the engine reports about the decode itself. They are cheap to keep and were
# the reason a probe was needed to diagnose the faults above: `error`/`error_code`
# say why a turn produced nothing, `decode_tps`/`prefill_tps` say whether the box was
# the problem, and `success` distinguishes "declined" from "failed".
DIAGNOSTIC_FIELDS = ("success", "error", "error_code", "reason", "decode_tps", "prefill_tps", "peak_ram_mb")


def _first_argument(call):
    """The one string argument of a tool call, whichever name the schema gave it."""
    args = call.get("arguments") if isinstance(call, dict) else None
    if isinstance(args, dict) and args:
        return str(next(iter(args.values())))
    return ""


def main() -> None:
    import needle

    # A tool that returns None hands a caller raising max_steps a null result; the
    # engine reads the call, it never acts on it, but the sentinel is what the
    # library's own examples return and costs nothing to be consistent with.
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

    # The engine binds its system prompt at construction, and the prompt arrives with
    # the first request — so the bind is lazy. One engine, bound to one system text:
    # a later request carrying a different system rebuilds rather than silently
    # answering a different question, because a sidecar that quietly kept the old
    # prompt would be the same class of bug this file was just fixed for.
    bound = {"agent": None, "system": None, "rebinds": 0}

    def agent_for(system: str):
        if bound["agent"] is None or bound["system"] != system:
            previous = bound["agent"]
            if previous is not None:
                bound["rebinds"] += 1
                previous.close()
            # stateless=True makes every complete() start with reset(): without it
            # decision N is decoded conditioned on the unrelated panes of decisions
            # 1..N-1, and the shared conversation grows the prefix until it starves
            # the window. One request, one reset, no carry-over.
            bound["agent"] = needle.Needle(tools=tools, system=system, stateless=True)
            bound["system"] = system
            sys.stderr.write("needle: ready\n")
            sys.stderr.flush()
        return bound["agent"]

    sys.stderr.write("needle: sidecar up, engine binds on the first request\n")
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

        started = time.time()
        try:
            # The system text goes to the constructor, not into the query: the engine
            # prefixes it once at init, and re-sending it per call would spend window
            # budget on text the model has already been given.
            agent = agent_for(str(req.get("system", "")))
            out = agent.complete(str(req.get("user", "")), max_new_tokens=MAX_NEW_TOKENS)
        except Exception as exc:  # engine faults must not kill the sidecar
            sys.stdout.write(json.dumps({"ok": False, "error": f"{type(exc).__name__}: {exc}"}) + "\n")
            sys.stdout.flush()
            continue

        calls = out.get("function_calls") or []
        withheld = [call for call in (out.get("suppressed_calls") or []) if isinstance(call, dict)]
        call = calls[0] if calls and isinstance(calls[0], dict) else None
        first_withheld = withheld[0] if withheld else None
        confidence = float(out.get("confidence") or 0.0)
        validation = out.get("validation") or {}

        reply = {
            "ok": True,
            # What the engine committed to. Empty when it declined.
            "op": call.get("name") if call else None,
            "argument": _first_argument(call) if call else "",
            "confidence": confidence,
            "refused": not calls,
            "latency_ms": int((time.time() - started) * 1000),
            # What the engine proposed and did not commit. This is a fact about the
            # model — which op, at what confidence — and the record should carry it
            # even though nothing may act on it.
            "proposed": None
            if first_withheld is None
            else {
                "op": first_withheld.get("name"),
                "argument": _first_argument(first_withheld),
            },
            "suppressed": len(withheld),
            "reasoning": out.get("reasoning"),
            "type": out.get("type"),
            "validation": validation.get("ungrounded"),
            "diagnostics": {name: out.get(name) for name in DIAGNOSTIC_FIELDS if name in out},
            "rebinds": bound["rebinds"],
        }
        sys.stdout.write(json.dumps(reply) + "\n")
        sys.stdout.flush()


if __name__ == "__main__":
    main()
