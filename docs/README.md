# docs

Every document in this repository, by purpose. Each one is a measurement or a protocol, not a
tutorial: where a number appears, the command that produced it is in the same file, and the record it
became is in [`../bench/results/`](../bench/results/).

## Measurement records

| file | what it holds |
|---|---|
| [stage0-residue-2026-11-10.md](stage0-residue-2026-11-10.md) | The seven process rules measured alone on the mined corpus; the idle rule and where its `N` came from; the residue the rules leave; the model scored on that residue; and observe mode's first live run. The source for the coverage numbers on the front page. |
| [retrospective-observe-2026-11-10.md](retrospective-observe-2026-11-10.md) | The local session corpus read as a supervisor record: the time-sampled decision point, the 60-second window and its sensitivity curve, what the miner excluded and why. |
| [needle3-usage-review-2026-11-14.md](needle3-usage-review-2026-11-14.md) | A review of *how* the local engine was called: the four adapter faults, each with the measurement that proves it, and the corrected configuration. |
| [needle3-timeout-probe-2026-11-10.md](needle3-timeout-probe-2026-11-10.md) | The probe that asked whether the engine ever emits an op given time rather than a deadline. Its record predates the adapter fix, so read it as harness history: see [../bench/results/INVALIDATED-needle3.md](../bench/results/INVALIDATED-needle3.md). |

## Live observation

| file | what it holds |
|---|---|
| [observe-protocol-2026-11-14.md](observe-protocol-2026-11-14.md) | Observe mode verified against a live fleet, the negative evidence that nothing was sent, the cost per day at the recorded per-call price, and the collection protocol. |
| [observation-running-2026-11-14.md](observation-running-2026-11-14.md) | The operator's note for a running span: what is recording, how to read the log at the end of it, and what counts as enough labelled rows to score anything. |

## Policy, metrics and design

| file | what it holds |
|---|---|
| [CORPUS-POLICY.md](CORPUS-POLICY.md) | Which content may be committed to a public repository, and the guard (`npm run check:corpus`) that fails a commit carrying session text or a credential. |
| [METRICS.md](METRICS.md) | The typed event vocabulary, the append-only store and the report over it; every metric defined, and every field deliberately absent explained rather than defaulted to zero. |
| [specs/agent-fleet-design.md](specs/agent-fleet-design.md) | Why the supervisor exists, the four decisions it is built on, and what was rejected. |
| [reviews/2026-10-26-plan-review.md](reviews/2026-10-26-plan-review.md) | An independent, read-only review of the plan that asks whether it can work rather than whether it is tidy, and names the part that could not. |
| [specs/LIMITATIONS.md](specs/LIMITATIONS.md) | The register of everything known to be wrong, blocked or unverified, in severity order, each entry saying what it blocks and the smallest thing that would resolve it. Written as a working file, so an entry states what was true when it was measured. |

## Specs — not implemented

These describe work that has no source change authorised by them. They are here because the
measurements they contain decided what was built, and what was not.

| file | what it holds |
|---|---|
| [specs/compact-syntax.md](specs/compact-syntax.md) | The tool grammar the local engine accepts and a line-oriented result format for feeding tool output back into its window, with the per-byte cost measured. |
| [specs/corpus-factory.md](specs/corpus-factory.md) | A design for authoring per-role training corpora and the checks a corpus must pass before a fine-tune may start on it. |

## Records

The scored runs live beside the harness that produced them, one file per run, each carrying the sha
of the task set it was scored against — [../bench/results/](../bench/results/):

| file | what it holds |
|---|---|
| [../bench/results/NEEDLE3-CLOSED.md](../bench/results/NEEDLE3-CLOSED.md) | The closing verdict on the local engine trial. Read first, before any other needle record. |
| [../bench/results/INVALIDATED-needle3.md](../bench/results/INVALIDATED-needle3.md) | The twelve records the four adapter faults invalidate, one by one, with what each actually measured. |
| [../bench/results/SLATE.md](../bench/results/SLATE.md), [../bench/results/SLATE-residue.md](../bench/results/SLATE-residue.md) | The fine-tune variants on two task sets. Their per-variant tables are 96-token measurements, so relative comparisons inside one run survive and absolute claims do not. |
| [../bench/results/NOTES-baselines.md](../bench/results/NOTES-baselines.md) | Two scoring defects and the four constant baselines that make a record checkable rather than asserted. |
| [../bench/results/NOTES-needle.md](../bench/results/NOTES-needle.md) | The sidecar's double-decode and starved-window defects, with the latency that separates a broken harness from a model verdict. |
