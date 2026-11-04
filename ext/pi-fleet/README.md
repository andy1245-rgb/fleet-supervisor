# pi-fleet

Every live pi session writes its own claim file. The fleet-supervisor supervisor
(`~/fleet-supervisor/src/manager/tick.ts`) reads one JSON claim per live pane from
`~/.pi/agent/fleet/<pane>.json` and decides from it what to say to that agent —
but it only ever sees a terminal, so it cannot know what a session was asked to
do or what phase it thinks it is in. The session knows, so the session writes it.

One file per pane is what makes concurrent writers safe: two sessions never touch
the same inode. The supervisor never writes a claim for a session it supervises;
the file is the session's own report.

```
~/.pi/agent/fleet/w2C_p1.json          # paneId "w2C:p1", colons sanitised
```

```json
{
	"paneId": "w2C:p1",
	"cwd": "/home/operator/work/fleet-supervisor",
	"intent": "Make every live agent session report its own state as a claim file.",
	"phase": "verify",
	"state": "done",
	"last": "bash npx tsc --noEmit 2>&1 | tail -20",
	"updated": "2026-10-26T22:05:36.326Z",
	"budget": { "tokens": 41230 }
}
```

## Load it

The extension must be loaded from **inside this repository**: it imports the
fleet registry (`../../src/fleet/registry.ts`) for the `Claim` shape and for the
atomic write, which is exactly what keeps its output parseable by the supervisor.
Copying the directory elsewhere breaks that import.

Three ways to load it, all verified against the installed pi 1.2.0:

1. **Discovery from the user extensions directory** — what `pi-herdr-title` and
   `pi-subforge` use. `~/.pi/agent/settings.json` declares no `extensions` array,
   so pi scans `~/.pi/agent/extensions/` (one level, no recursion) and loads
   `*.ts`/`*.js` files plus any subdirectory resolving to `index.ts`/`index.js`
   or to a `package.json` with a `pi.extensions` list
   (`dist/core/extensions/loader.js`, `resolveExtensionEntries`). Symlink this
   directory in and it loads in every session:

   ```sh
   ln -s /home/operator/work/fleet-supervisor/ext/pi-fleet ~/.pi/agent/extensions/pi-fleet
   ```

2. **This session only**, on the command line (`-e` / `--extension`, repeatable):

   ```sh
   pi -e /home/operator/work/fleet-supervisor/ext/pi-fleet
   pi -e /home/operator/work/fleet-supervisor/ext/pi-fleet/index.ts    # same thing
   ```

3. **Persistently in settings**, absolute path in the `extensions` array of
   `~/.pi/agent/settings.json` (`~` and absolute paths both resolve):

   ```json
   { "extensions": ["/home/operator/work/fleet-supervisor/ext/pi-fleet"] }
   ```

No runtime dependencies: `package.json` is private, `"type": "module"`, and its
only manifest entry is `pi.extensions`, which points at the same `index.ts` the
directory fallback would find. pi's jiti loader strips the types; nothing is
compiled. Node 24 strip-only rules apply (no enums, no namespaces, no parameter
properties), imports are relative and end in `.ts`.

## What it reports, and how

| Field | Rule |
|---|---|
| `paneId` | `process.env.HERDR_PANE_ID`. Not set → the extension registers nothing at all. |
| `cwd` | `ctx.cwd` at `session_start`. |
| `intent` | First user prompt of the session: first non-empty line, flattened, cut to 160 chars. Empty until that prompt arrives. |
| `phase` | From the tool being called: `research` for `read`/`grep`/`glob`/`find`/`ls`/`web_*`; `implement` for `write`/`edit*`; `verify` for a shell command that tests or builds (`npm test`, `npx tsc`, `vitest`, `cargo test`, `make`, …); otherwise the previous phase. Starts `idle`. |
| `state` | See below. |
| `last` | The tool name plus the argument that says what it touched (path, command, URL), one line, cut to 160 chars total. |
| `budget` | `{ tokens }`, summed from each assistant response's provider-reported usage on `message_end`. The field is **omitted** until a response actually reports usage; nothing is estimated. |
| `acceptance` | **Never written.** The human declares it; the extension does not guess. An existing value on disk is carried forward on every rewrite. |
| `group` | Same — declared by the human, carried forward, never invented. |
| `updated` | Stamped by `writeClaim` at rename time. |

### The `state` rule

Simple enough to defend line by line:

- `working` — a turn is streaming or a tool is running (`before_agent_start` on a
  user prompt, `turn_start`, `tool_execution_start`).
- `waiting` — between turns. This is also the state before the first prompt, and
  the state after any turn that ended without a completion phrase.
- `done` — only when one of these holds:
  - `turn_end` carried no tool results **and** no pending tool calls **and** the
    assistant's own last line reads as a completion phrase (`done`, `complete(d)`,
    `finished`, `all set`, `that's it/all/everything`, `wrapped up`, `shipped`,
    `ready to ship`, `task/work/job is done`), anchored at the start of that line
    so "I have not done that yet" cannot read as completion; or
  - the turn's outcome was `aborted`, or `agent_settled` reported an abort.

`done` is sticky: a rewritten claim keeps it until a new turn actually starts.
That keeps the extension from erasing a `done` the supervisor recorded.

### Continuity

- `session_start` with `resume` or `reload` continues the same work: intent,
  phase, last action, state and token total are adopted from the claim already on
  disk. A `/reload` must not blank a claim.
- `startup`, `new` and `fork` are new work in the same pane: the claim starts
  blank (`intent: ""`, `phase: "idle"`, `state: "waiting"`, no budget).

### When it stays silent

- `HERDR_ENV !== "1"` or no `HERDR_PANE_ID`: no hooks are registered and no file
  is touched. Outside herdr there is no pane to claim.
- `ctx.mode === "rpc"`: a nested runner (a forge subagent's `pi --mode rpc` child)
  inherits `HERDR_PANE_ID` but does not own the pane. It reports nothing, so it
  cannot clobber its parent's claim.
- Tool calls with `parentToolCallId` (a codemode script's own calls) are skipped:
  they are the parent tool's work, not the session's.

## Writes

`writeClaim` from `src/fleet/registry.ts` does the write — `<target>.<pid>.tmp`
then `renameSync` — so a supervisor read never sees half a claim, and the
filename sanitising is the supervisor's own. On top of that:

- **At most one write per 2 seconds.** Every event updates an in-memory claim and
  schedules a write; a burst of tool calls lands as a single file. The first event
  of a session writes immediately.
- **Flushed on `session_shutdown`**, so the final state never depends on a timer
  that dies with the process.
- **Never throws into the agent loop.** Every handler body and every write is
  wrapped: a claim file is a report, not a control path.
- `AGENTFLEET_REGISTRY` overrides the directory, exactly as the supervisor's
  `registryDir()` does.

## Self-check

```sh
node ext/pi-fleet/selfcheck.ts      # ~4s (two real coalescing windows)
```

Fabricates the event stream (session start, prompt, turn, read, tsc, usage, turn
end, shutdown), drives the real handlers through a fake `ExtensionAPI`, and prints
every claim file as it lands. It also checks the coalescing window (three events,
one write), the flush on shutdown, that no `*.tmp` survives, that the supervisor's
own `readClaim` parses the result back unchanged, both no-op guards, and the
resume-vs-fresh-start rule. Exits non-zero on any failure.

```sh
npx tsc --noEmit      # from /home/operator/work/fleet-supervisor; ext/ is in tsconfig include
```

The repository has no pi dependency, so `pi-api.d.ts` declares the slice of the
host API this extension uses — copied from
`~/.pi/agent/install/releases/<version>/node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/types.d.ts`,
which stays the source of truth.
