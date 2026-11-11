# Corpus policy — what may leave this machine

**This repository is public.** Everything else here follows from that one sentence.

## The rule

| what | where it may live | committed? |
|---|---|---|
| Mined decision points (session text, pane titles, terminal tails) | `mine/out/` (gitignored) | **never** |
| Bench task sets and their frozen snapshots | `bench/tasks/*.jsonl` (gitignored) | **never** |
| Fine-tune datasets and adapter archives | `finetune/out/` (gitignored) | **never** |
| Records — scores, ledgers, latencies, shas | `bench/results/` | yes |
| Code, schema, specs, docs | the rest of the repo | yes |

A record **cites** its task-set sha; it does not carry the rows. Anyone who needs to re-score
supplies the corpus out of band. That is the whole design: records are public, data is not.

## Why this is enforced rather than remembered

The failure mode is not malice, it is `git add -A` on a good day. So:

```
npm run check:corpus
```

It reads every **tracked** file — `git show HEAD:<path>`, so it tests what would actually be
published, not what is on disk — and fails on:

- any tracked file under a corpus path (`mine/out/`, `bench/tasks/*.jsonl`, `finetune/out/`)
- session text inside data-shaped files (`*.jsonl`, `*.csv`, `bench/results/**`, `bench/fixtures/**`):
  a `paneId`/`claimState`/`idleTicks` key, a `wN:pN` pane id, a `session:<hex>` id, or a `"tail"`
- credentials in **any** file: OpenAI/GitHub/AWS/Slack key shapes, private-key blocks, basic-auth
  URLs, and literal `password: "…"` assignments

It prints the path and line and **never the matched text** — a guard that echoes what it found is
the leak it was meant to stop.

Source files are allowed to *name* the schema keys. `"paneId"` in a type definition or a test is
not a leak; `"paneId"` in a `.jsonl` row is.

### Exemptions

`tools/corpus-allowlist.txt`, one path per line with a one-sentence reason. Adding an entry asserts
*"this content is authored, not captured"*. If you cannot say that sentence, it does not go in.
The current list has exactly one entry: a hand-written fixture that describes this repository's own
metrics backfill.

## Things this cannot catch, which you must still not commit

- **Prose in a doc.** A paragraph quoting what an agent actually said is session text with the
  quotes filed off. Do not do it; describe the shape instead ("a row whose tail ends mid-command").
- **Identifiers that are not the shapes above.** A hostname, a path, an account name, a URL.
- **Anything already in history.** This guard tests the current commit. If content was ever
  published, deletion is not enough — the commit still carries it, and rewriting public history is a
  separate decision for the operator, not something to do quietly.

## Standing rules for anything mining the corpus

1. **Read `~/.pi/agent/sessions/`, write only to an ignored path.** Never write mined rows into a
   tracked file, not even temporarily.
2. **Aggregate in documents.** Report counts, rates, distributions, shas, and windows. Never sample
   a row into a markdown file.
3. **Exclude rather than sanitise where you can.** A session that looks like it should not be in a
   corpus — credentials in terminal output, someone else's confidential material — is dropped at
   mine time and counted as dropped. A count of exclusions is fine to publish; their content is not.
4. **Run `npm run check:corpus` before every commit.** It is the only thing standing between a
   careless stage and a permanent public record.
