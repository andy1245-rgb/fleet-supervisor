"""Validate a tool catalogue before it reaches the engine, and account for its cost.

`needle_init` does not validate its tools argument. A malformed catalogue returns
a token count instead of raising, and at decode the engine answers
"no tools declared, returning the empty call" with `confidence 1.0` and
`error: null`. A supervisor reading that sees a model declining to act; the model
never saw a tool. Every catalogue therefore passes `validate` first — the failure
is silent and confident, which is the one combination a gate cannot be added to
after the fact.

Measurement is deliberately out-of-process. `needle_init` installs the decode
grammar as process-global state, so building a second catalogue in a live process
replaces the first one's grammar rather than adding to it. `measure_prefix` spawns
a short-lived interpreter instead, which keeps this module safe to call from a
process that is already serving a profile.

    python src/decision/catalogue.py --selftest
    echo '{"system":"...","tools":[...]}' | python src/decision/catalogue.py --measure
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
from dataclasses import dataclass

# The engine charges a fixed frame around the tool block. Measured across every
# catalogue shape tried: the count is `tokens(system block) + FRAME + tokens(canon)`
# and nothing else moves it.
FRAME_TOKENS = 6

WINDOW = 1024


class CatalogueError(ValueError):
    """A catalogue the engine would silently refuse to compile."""

    def __init__(self, code: str, detail: str):
        super().__init__(f"{code}: {detail}")
        self.code = code
        self.detail = detail


def validate(raw: str | bytes | list) -> list[dict]:
    """Return the catalogue as a list of tool dicts, or raise CatalogueError.

    Accepts the wire form (a JSON string, as the sidecar receives it) or an
    already-parsed list. Every rejection names the defect, because "the model
    refused" and "the model had no tools" must never be confusable.
    """
    if isinstance(raw, (bytes, bytearray)):
        raw = raw.decode("utf-8", "replace")
    if isinstance(raw, str):
        try:
            catalogue = json.loads(raw)
        except json.JSONDecodeError as exc:
            raise CatalogueError("not_json", f"tools block is not JSON: {exc}") from exc
    else:
        catalogue = raw

    if not isinstance(catalogue, list):
        raise CatalogueError("not_list", f"tools must be a JSON array, got {type(catalogue).__name__}")
    if not catalogue:
        raise CatalogueError("empty", "no tools declared; the engine would answer with an empty call")

    for index, tool in enumerate(catalogue):
        where = f"tools[{index}]"
        if not isinstance(tool, dict):
            raise CatalogueError("element_not_object", f"{where} is {type(tool).__name__}, not an object")
        name = tool.get("name")
        if not isinstance(name, str) or not name.strip():
            raise CatalogueError("missing_name", f"{where} has no string 'name'")
        parameters = tool.get("parameters")
        if not isinstance(parameters, dict):
            raise CatalogueError("missing_parameters", f"{where} ({name}) has no 'parameters' object")
        if parameters.get("type") != "object":
            raise CatalogueError(
                "bad_parameters",
                f"{where} ({name}) parameters.type is {parameters.get('type')!r}, must be 'object'")
        properties = parameters.get("properties")
        if not isinstance(properties, dict):
            # A zero-argument tool is legitimate and `done()` in the `hi` profile is
            # one, so an EMPTY properties map is fine. An ABSENT one is not: the
            # engine compiles the decode grammar from this key.
            raise CatalogueError("missing_properties", f"{where} ({name}) has no 'properties' object")
    return catalogue


@dataclass(frozen=True)
class Prefix:
    """What the engine spends before the first token of evidence."""

    system: int
    frame: int
    tools: int

    @property
    def total(self) -> int:
        return self.system + self.frame + self.tools

    def input_budget(self, max_new_tokens: int, window: int = WINDOW) -> int:
        return window - self.total - max_new_tokens


def measure_prefix(system: str, catalogue: list[dict] | str) -> Prefix:
    """Ask the engine what (system, tools) costs, in a throwaway interpreter."""
    tools = catalogue if isinstance(catalogue, str) else json.dumps(catalogue, separators=(",", ":"))
    validate(tools)
    payload = json.dumps({"system": system, "tools": tools})
    proc = subprocess.run([sys.executable, os.path.abspath(__file__), "--measure"],
                          input=payload, capture_output=True, text=True, timeout=180)
    if proc.returncode != 0:
        raise RuntimeError(f"prefix measurement failed: {proc.stderr.strip()[:400]}")
    row = json.loads(proc.stdout)
    return Prefix(system=int(row["system"]), frame=int(row["frame"]), tools=int(row["tools"]))


def check_window(prefix: Prefix, min_state_tokens: int, max_new_tokens: int,
                 window: int = WINDOW) -> str | None:
    """Return a complaint when a profile cannot fit, or None when it can."""
    needed = prefix.total + min_state_tokens + max_new_tokens
    if needed <= window:
        return None
    return (f"over window: prefix {prefix.total} + state {min_state_tokens} + "
            f"new {max_new_tokens} = {needed} > {window}")


def _engine():
    import ctypes
    import glob

    libs = sorted(glob.glob(os.path.expanduser("~/.cache/cactus-needle/v3/*/libneedle.so")))
    weights = sorted(glob.glob(os.path.expanduser("~/.cache/cactus-needle/v3/*/needle3.cact")))
    if not libs or not weights:
        raise RuntimeError("no cactus-needle engine or weights in ~/.cache/cactus-needle/v3")
    lib = ctypes.CDLL(libs[-1])
    lib.needle_init.argtypes = [ctypes.c_char_p] * 3
    lib.needle_init.restype = ctypes.c_int
    lib.needle_load.argtypes = [ctypes.c_char_p, ctypes.c_size_t]
    lib.needle_load.restype = ctypes.c_int
    blob = open(weights[-1], "rb").read()
    if lib.needle_load(blob, len(blob)) != 0:
        raise RuntimeError(f"needle_load failed for {weights[-1]}")
    return lib


def _measure_main() -> int:
    """Child process: load the engine, count one (system, tools) pair, exit."""
    request = json.load(sys.stdin)
    lib = _engine()
    tools = request["tools"]
    with_tools = lib.needle_init(request["system"].encode(), tools.encode(), b"")
    bare = lib.needle_init(request["system"].encode(), b"[]", b"")
    if with_tools < 0 or bare < 0:
        raise RuntimeError(f"needle_init failed ({with_tools}, {bare})")
    # `bare` already carries the frame (it is system block + frame + an empty
    # catalogue), so the catalogue's own cost is the plain difference and the
    # system block is `bare` less the frame. Subtracting the frame twice here
    # mislabelled six tokens: it reported tools=143 for a catalogue the tokenizer
    # counts at 150.
    json.dump({"system": bare - FRAME_TOKENS, "frame": FRAME_TOKENS, "tools": with_tools - bare},
              sys.stdout)
    return 0


def _selftest() -> int:
    tools_path = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                              "..", "..", "finetune", "out", "tools.json")
    real = open(tools_path, encoding="utf-8").read()
    failures: list[str] = []

    def expect_reject(payload, code):
        try:
            validate(payload)
        except CatalogueError as exc:
            if exc.code != code:
                failures.append(f"expected {code}, got {exc.code}")
            return
        failures.append(f"expected rejection {code}, got acceptance")

    expect_reject("not json at all", "not_json")
    expect_reject("[]", "empty")
    expect_reject("{}", "not_list")
    expect_reject('[{"name":"x"}]', "missing_parameters")
    expect_reject('[{"name":"x","parameters":{"type":"object"}}]', "missing_properties")
    # A zero-argument tool must be accepted: `hi`'s `done()` is one.
    zero_arg = validate('[{"name":"done","parameters":{"type":"object","properties":{}}}]')
    if zero_arg[0]["name"] != "done":
        failures.append("zero-argument tool was not accepted")
    expect_reject('[{"name":"x","parameters":{"type":"array","properties":{"a":{}}}}]', "bad_parameters")
    expect_reject('["x"]', "element_not_object")
    expect_reject('[{"parameters":{"type":"object","properties":{"a":{}}}}]', "missing_name")

    catalogue = validate(real)
    if len(catalogue) != 4:
        failures.append(f"real catalogue has {len(catalogue)} tools, expected 4")

    # The failure this module exists to prevent: unvalidated text reaching the
    # engine is accepted, so the gate is the only thing standing between a typo
    # and a confidently empty call.
    lib = _engine()
    if lib.needle_init(b"sys", b"not json at all", b"") < 0:
        failures.append("engine rejected malformed tools; the silent-empty-call premise is wrong")

    prefix = measure_prefix("You supervise one unattended coding agent.", catalogue)
    spaced = json.dumps(catalogue)
    spaced_prefix = measure_prefix("You supervise one unattended coding agent.", spaced)
    if prefix.total != spaced_prefix.total:
        failures.append(f"serialisation mattered: {prefix.total} != {spaced_prefix.total}")

    for line in failures:
        print(f"  FAIL {line}")
    print(f"  {'ok' if not failures else 'FAILED'}  {len(failures)} failure(s); "
          f"real catalogue prefix={prefix.total} (system {prefix.system} + frame {prefix.frame} "
          f"+ tools {prefix.tools}), input budget at 96 new tokens "
          f"{prefix.input_budget(96)}")
    return 1 if failures else 0


if __name__ == "__main__":
    if "--measure" in sys.argv:
        sys.exit(_measure_main())
    if "--selftest" in sys.argv:
        sys.exit(_selftest())
    print(__doc__)
    sys.exit(2)
