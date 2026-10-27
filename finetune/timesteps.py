"""Time the first steps of a `needle finetune` run, then kill it.

Step 1 carries the JAX compile, so it is reported but excluded from the rate: the
number that matters is the steady-state cost of one step at a given --max-len.

    python timesteps.py 3 -- .venv/bin/needle finetune ...
"""
import os
import signal
import subprocess
import sys
import time

keep = int(sys.argv[1])
cmd = sys.argv[sys.argv.index("--") + 1:]
marks = []
started = time.time()
proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                        text=True, bufsize=1, start_new_session=True)
try:
    for line in proc.stdout:
        text = line.rstrip()
        stamp = time.time() - started
        if text.strip().startswith("step "):
            marks.append(stamp)
            print(f"[{stamp:7.1f}s] {text}", flush=True)
            if len(marks) >= keep:
                break
        elif any(k in text for k in ("schedule", "epoch", "read ", "batch", "lora", "len ", "error", "Error", "Traceback")):
            print(f"[{stamp:7.1f}s] {text}", flush=True)
finally:
    try:
        os.killpg(os.getpgid(proc.pid), signal.SIGKILL)
    except ProcessLookupError:
        pass
    proc.wait()

if len(marks) >= 2:
    steady = [b - a for a, b in zip(marks[:-1], marks[1:])]
else:
    steady = []
if marks:
    print(f"steps seen: {len(marks)}  step1 (compile + load) {marks[0]:.1f}s")
else:
    print("no step logged")
if steady:
    rate = sum(steady) / len(steady)
    per = "  ".join(f"{x:.1f}" for x in steady)
    print(f"steady steps: {per}  -> {rate:.1f}s/step  -> {rate * 29 / 60:.1f} min/epoch at 29 steps")
