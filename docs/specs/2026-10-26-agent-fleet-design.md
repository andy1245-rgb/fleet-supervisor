# agentFleet — design record

2026-10-26. What the supervisor is for, the four decisions it is built on, what was rejected, and how any of it is supposed to be believed.

## The problem

A machine runs a dozen or two live agent panes at once. Each one is a long-running session that streams for a while and then stops, waiting for a human to say something else. Most of the time the right next input is obvious from the pane's own state: the agent asked a question and wants a yes, or it already answered and wants nothing, or it stopped halfway through the change it was making. A human cycling through 21 panes to type `yes` costs attention that is worth more than the typing.

So: a supervisor that watches the fleet, and for each pane that moved since the last look, decides exactly one thing — leave it alone, nudge it, declare it done, or flag it for a human — and then acts through the same channel the human would use. There is no new agent loop here. The agents already loop; this decides what to say to a loop that has stopped.

The constraint that shapes everything: a tick must be cheap enough to run every minute over 21 panes forever, and quiet enough that a wrong decision costs a phone notification rather than a wrecked worktree.

## Four decisions, and what was rejected

### 1. `herdr` is the only observation and action boundary

Observe with `herdr agent list` / `agent read`, act with `herdr agent prompt`. One module (`src/herdr`) shells out; everything else takes a `HerdrPort` interface. The module returns *envelopes*, not exceptions: `agent_blocked` on a prompt is a decision input ("this agent needs a human"), not a transport failure, so folding codes into throws would delete information the ladder wants.

Rejected: **owning the PTYs.** Re-implementing pane management means owning resize, scrollback, escape sequences and the terminal's actual semantics, to gain nothing this supervisor needs. Rejected: **scraping `tmux capture-pane` or reading session JSONL files as the live view.** Both exist, both are more work to keep correct than to call the tool that already tracks agent status, and neither gives a status the agent itself asserts.

Rejected: **a proxy or shim in front of `herdr`,** because the wire contract is small and versioned (protocol 22) and the envelope shape is the interesting part; a shim would only move the parsing somewhere less obvious.

### 2. Workers write their own claims; the supervisor only reads them

A terminal is not a session. `herdr` can say a pane is idle and what its title bar reads, but not what the session was asked to do, what phase it thinks it is in, or what it just completed. Only the session knows, so `ext/pi-fleet` makes every live pi session write `~/.pi/agent/fleet/<pane>.json`: `intent`, `phase`, `state`, `last`, optional `acceptance`/`group`/`budget`. The supervisor reads that file and never writes one.

This inverts the obvious design, and the inversion is the point: **the claim is a report, not a control path.** The extension wraps every handler body and every write, so a bookkeeping bug can never break a turn. Fields the session cannot know — `acceptance`, `group` — are never invented; the extension carries an existing value forward and otherwise omits it.

One file per pane is what makes concurrent writers safe: two sessions never share an inode, and the write is `<target>.<pid>.tmp` + `renameSync`, so a reader never sees half a claim. Writes are coalesced to at most one per 2 s, flushed on shutdown, and suppressed entirely outside `herdr`, under `--mode rpc` (a forge child inherits `HERDR_PANE_ID` but does not own the pane, so letting it write would clobber its parent), and for nested tool calls.

Rejected: **the supervisor inferring intent and phase from the terminal tail.** That inference is exactly what the decision model is for, and doing it twice — once in a heuristic that writes a claim, once in a model that reads it — means two disagreeing opinions about the same pane with no way to tell which one the decision used. Rejected: **a shared registry database or a supervisor-owned state file per pane**, because then the supervisor writes claims and reads them back, and "the agent says it is in `verify`" becomes indistinguishable from "the supervisor guessed `verify`".

### 3. Change detection is integer sequence comparison, not diffing

`herdr` exposes two monotonic counters per pane: `completion_seq` (bumped when a turn completes) and `state_change_seq` (bumped on any lifecycle transition). A mark file per pane holds the last seen values. A pane moved iff either counter advanced, its status changed, or it is new. Everything else is a single integer comparison, and the resting ticks accumulated for a pane that did not move are the divergence signal.

This is the cost gate for the entire system. Reading 21 terminals and asking a model about each one, every minute, is unaffordable and mostly pointless; an agent that did not move has no news. Because the marks are persisted on disk, the supervisor survives restarts without re-deciding the whole fleet.

Rejected: **hashing the terminal tail.** Output changes on every spinner frame and every clock; it would report motion for a pane that is merely idling, and it costs a terminal read per pane — the exact expense the seq comparison exists to avoid. Rejected: **wall-clock timestamps or file mtimes** for the same reason plus a worse one: a timestamp tells you a pane was touched, not whether a turn completed, so it cannot distinguish "the agent finished" from "the agent redrew". Rejected: **watching session JSONL files,** which duplicates `herdr`'s own bookkeeping and pins the supervisor to a file format that is pi's to change.

The mark file is also the reason a dry tick was safe to build: `AGENTFLEET_DRY` decides and logs but never saves marks, so a rehearsal cannot consume the change.

### 4. One cheap decision per moved agent, and exactly one escalation

The decision is a single JSON op — `leave`, `nudge`, `declare_done`, `flag` — with one sentence of argument and a self-reported confidence. The primary model answers everything; the escalator is consulted only if the primary refused or scored below `AGENTFLEET_THRESHOLD` (default 0.7), and only once. Escalation is capped at one step so a bad primary cannot multiply cost per decision; a *good* primary is never re-asked.

Both adapters share one prompt and one input renderer (`src/decision/prompt.ts`), field-per-line so a small model can ground on individual values, and both pass through the same defensive parse, which turns anything unparseable into `flag` with `refused: true` rather than an action. A supervisor must never act on an op it did not successfully parse.

Rejected: **one strong model for every pane**, which is the simplest design and the one the cost model forbids: the marginal decision is usually trivial ("it answered, leave it"), and paying a large model's price to establish that is how a supervisor becomes too expensive to leave running. Rejected: **a rules engine with no model** — the classifier this fleet actually needs has to read a terminal tail and a one-line claim and judge whether the work is finished, which is a language judgement; a rules engine would encode the author's guesses about wording and then fail silently on the passthrough. Rejected: **a full second agent loop as the supervisor** (a supervisor agent that can call tools, read files, retry), because it has unbounded cost per tick, unbounded latency, and its own failure mode — it can decide to go do the work itself — which the four-op vocabulary deliberately makes impossible.

Rejected along the way and worth naming separately: **two different label→op tables.** The miner labels a decision point with the human's next instruction (`continue | nudge | redirect | stop | new_task`); something has to translate that into an op. There used to be two somethings — the benchmark scored against one mapping while the fine-tune trained against another, which makes every bench result untransferable to the tuned model. There is now exactly one table, `src/labeling/label-to-op.ts`, imported by both consumers, with the reasoning for each row written next to it.

## Data flow

One tick (`src/manager/tick.ts`):

1. `herdr agent list` → the fleet snapshot.
2. `src/fleet/registry` reads every claim file; `src/fleet/detect` compares counters against the marks and produces `moves` plus per-pane `idleTicks`.
3. `src/manager/triggers` scans the *whole* fleet against the claims for the four cross-agent conditions, and updates repeat history.
4. For each move only: `herdr agent read` gives the terminal tail (40 lines, trailing column padding stripped — the TUI pads to pane width), the claim gives the rest of the input, and `src/decision/ladder` produces one decision. Reads and decisions run in a small pool (`AGENTFLEET_CONCURRENCY`, default 4).
5. Act, per op: `leave` → log only. `flag` → notify, change nothing. `declare_done` → write the claim's state to `done` (unless dry) and notify. `nudge` → respect the cooldown, respect `AGENTFLEET_MAX_PROMPTS`, then `herdr agent prompt … --wait --until working`, which confirms the turn actually started; a *rejected* prompt notifies as an alert instead of retrying.
6. Triggers are logged, and `collision` / `divergence` / `blocked` also notify.
7. Watchdog (unless disabled) scans processes and reports anything past its rule.
8. Marks are saved (never in dry mode), trigger history and cooldowns are written, and one `tick` line is appended to `events.jsonl` with counts and cost.

Everything observable about a tick ends up in `events.jsonl` as append-only JSON lines: decisions, actions, skipped actions with a reason, triggers, watchdog findings, and the tick summary.

Offline, with no fleet involved: `mine/` turns session transcripts into labelled decision points, `bench/tasks/from-captures.ts` turns those into tasks with an `expectedOp` from the single label table, and `bench/runners/run.ts` scores a model on a fixed prompt and task set, writing a record into `bench/results/`. `finetune/` consumes the same corpus with the same prompt and the same table.

## Failure modes considered

**Step repetition.** The agent does a turn, completes, and starts the same turn again — same phase, same last action — forever. A per-agent decision can fail to notice it, because each individual state looks fine and the input carries no memory. So the supervisor keeps `ClaimHistory` per pane and fires a `churn` trigger when phase *and* last action are unchanged for `churnRepeats` consecutive turns (default 2, i.e. the third identical turn fires). Related: the extension's `done` state is sticky until a new turn actually starts, so a rewrite cannot erase a completion the supervisor recorded, and a resumed session adopts the claim on disk rather than starting blank.

**Claim-versus-reality divergence.** The session says `working`; `herdr` says the pane has been resting for N ticks. Either the session is lying (a hung turn, a lost write, a killed process) or it is finished and does not know. `divergence` fires at `divergenceTicks` (default 3 consecutive resting ticks) and notifies. `blocked` is always reported, because an agent cannot free itself from a blocked prompt. The claim is never trusted as the only source: every trigger is grounded in a disagreement between what the worker claims and what `herdr` observes, and that is deliberate — the two are independently produced.

**File collisions.** Two working agents in the same tree will stomp each other's writes, and no per-agent decision can see it, because each pane's own state looks correct. Collisions aggregate by resolved `foregroundCwd` and fire when two or more agents are `working` in one tree. Grouping is a heuristic with two deliberate exclusions: a declared `group` on the claim overrides cwd, and `$HOME` is *not* a group — over half a real fleet lives there, so bucketing it would collapse the fleet into one meaningless group. A path that was never reported is `unknown`, never `home`, because `resolve("")` would otherwise file an agent under whatever tree the supervisor happens to sit in.

Also handled, each with a specific consequence in the code rather than a general "handle errors":

- **A blocked agent rejects the prompt.** `agent_blocked` comes back as an envelope; the supervisor notifies "it needs you" instead of retrying into the same wall, and does not record a nudge that never happened.
- **A missing venv or a dead sidecar.** The ladder degrades to the escalator alone, and reports that it degraded, rather than failing the tick: a supervisor that stops supervising because its cheap model is unavailable is worse than an expensive one.
- **An escalator outage.** The primary's opinion is kept, annotated, and the failure is visible in the argument text.
- **A half-written claim.** Reads are best-effort and a parse failure is skipped, because the next turn rewrites it; a stale claim is a divergence signal anyway.
- **A hung process.** The watchdog defines "command" structurally rather than by elapsed time, so `init`, pipewire, idle login shells and browser helpers never reach the age rules; `--stalled` re-samples CPU time so "slow" and "hung" are different verdicts.
- **An unattended tick doing too much.** `maxPromptsPerTick` (3) and `nudgeCooldownMin` (10) are hard caps in the config, not intentions, and both skips are logged with a reason.

## Measurement plan

The rule this repository is built on: **measured over asserted.** A design decision that is not backed by a record in `bench/results/` is not a decision yet, and records are committed because they are the empirical history.

- **Fixed input.** One prompt, one renderer, one task set, one scorer. The only variable in a record is the model. Records carry `taskSetSha` so a comparison across time can be proven or refused.
- **Task set from real work.** Mined decision points, not invented examples: the state the agent left behind is the input, and the human's next instruction is the ground truth for `expectedOp` via the single label table.
- **Asymmetric regret**, because the ops do not fail symmetrically: a false `leave` strands a working agent (5), a false `declare_done` claims a delivery that was never accepted (4), a false `flag` merely buys an escalator call (1–2), and a false `nudge` when silence was right is the most expensive cell of all (5). Under-reacting is not priced in the `nudge` and `flag` rows, deliberately.
- **Selective accuracy.** For each threshold, what the ladder's real operating curve looks like: coverage at that threshold and accuracy on what it covered. This is the number the escalation ladder is tuned by, since it is the decision to escalate that changes cost.
- **Refusals reported first, and per class support**, because a class that is never predicted must be visible as a column of zeros rather than averaged away.
- **Cost and latency per record**, in dollars from a token table and p50/p95 from measured calls, so the ladder's cost centre has a number attached to it rather than a claim.
- **Strided subsets, never head slices**, so a `--limit` run does not benchmark one project. The stride's composition is part of the record's meaning: the n = 20 and n = 40 records happen to contain no `leave` target at all.

Not yet measured, and named as such: whether the escalation ladder's pair beats either model alone (no record scores a primary and its escalator on the same task set); whether a tuned `.cact` lifts the local engine (no adapter has been trained — the training extra is not installed); `declare_done` (no target exists); and `leave` (7 rows, and no bench record contains one). Those are open questions, not results.
