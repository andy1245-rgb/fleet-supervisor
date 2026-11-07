// Total spend for the UTC day, across every agent on this machine.
//
// The fleet's own cap (`./daily.ts`) measures what the supervisor spent. This module
// measures what *everything* spent, because the supervisor is one client of one
// account: a fleet that stops at $0.50 while six panes and a handful of subagents run
// unbounded has a cap on the wrong quantity.
//
// The source is `~/.pi/agent/usage.jsonl`, which is the only local record of per-call
// cost that covers every agent. Every pi process appends one row per assistant
// message that carried usage, `cost` is the resolved dollar cost of that request, and
// `ts` is epoch milliseconds, so a row is attributable to a day. Choosing it is
// argued in the phase report; the short version is that the alternative,
// `~/.pi/accounts/route-log.jsonl`, is a strict *subset* of the same sessions (0
// route-only sessions against 1,026 shared), so a cap built on it would under-count —
// and under-counting is the only error a cap must not make.
//
// What it cannot see, stated rather than discovered later:
//   - another machine. The file is local, so spend on a second box or a VM is
//     invisible here, and no local file could fix that.
//   - a client that does not load the usage logger: a bare `curl`, a scraper's own
//     HTTP, an editor plugin. Only pi's own processes are in it.
//   - model attribution: `model` is `"unknown"` on every row today because the
//     harness does not fill it. The cost is right; which model it was is not known,
//     and nothing here needs to know.
//   - rows older than the logger's 30-day prune, which cannot matter to a day cap.
//
// The supervisor's own model calls are *not* in that file — it talks to providers
// directly, without going through pi — so the total is the agent log plus the day's
// tick rows from `events.jsonl`. Counting both is what makes this cap cover the
// supervisor instead of excluding it.

import { dailySpend, utcDay, type DaySpend } from "./daily.ts";
import { tailLines } from "./tail.ts";

/** What every agent plus the supervisor has cost on one UTC day. */
export interface GlobalSpend {
	/** The UTC day this answers for, `YYYY-MM-DD`. */
	day: string;
	/** Summed `cost` of every usage row in the day, or `null` when the log could not
	 *  be read. Never `0` in that case: "cannot see" and "nothing spent" are the two
	 *  readings this module exists to keep apart. */
	agentsUsd: number | null;
	/** The supervisor's own ticks in the day, from `events.jsonl`. */
	supervisorUsd: number;
	/** `agentsUsd + supervisorUsd`, or `null` when `agentsUsd` is unknown. */
	totalUsd: number | null;
	/** Usage rows counted in the day. Zero rows and a `0` total is a quiet day; zero
	 *  rows and a `null` total is a source nobody could look at. */
	rows: number;
	/** Where the agent half came from, or that it could not be read at all. */
	source: "usage.jsonl" | "unavailable";
	/** Why it could not be read, naming the path and what the filesystem said. */
	reason?: string;
	/** Tick rows in the UTC day that the *global* cap stopped, and that recorded the
	 *  source as unreadable: the two once-a-day markers, taken from the log rather
	 *  than from process memory so a restart cannot re-send them. */
	globalCappedTicks: number;
	unavailableTicks: number;
}

interface AgentBucket {
	usd: number;
	rows: number;
}

const buckets = new Map<string, Map<string, AgentBucket>>();

/** Folds one `usage.jsonl` line into its UTC day. The row is
 *  `{ ts, model, sessionId, input, output, cacheRead, cacheWrite, cost }`; anything
 *  without a parseable `ts` or a finite `cost` is skipped, because a row that cannot
 *  be placed in a day or priced is not evidence about either. */
function ingest(cache: Map<string, AgentBucket>, line: string): void {
	if (line.trim() === "") return;
	let raw: unknown;
	try {
		raw = JSON.parse(line);
	} catch {
		return;
	}
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return;
	const bag = raw as Record<string, unknown>;
	const ts = bag.ts;
	const cost = bag.cost;
	if (typeof ts !== "number" || !Number.isFinite(ts)) return;
	if (typeof cost !== "number" || !Number.isFinite(cost)) return;
	const day = utcDay(ts);
	const bucket = cache.get(day);
	if (bucket === undefined) cache.set(day, { usd: cost, rows: 1 });
	else {
		bucket.usd += cost;
		bucket.rows += 1;
	}
}

/** The agent log's day, and whether it could be read at all. */
function agentSpend(logPath: string, nowMs: number): { usd: number | null; rows: number; reason?: string } {
	let cache = buckets.get(logPath);
	if (cache === undefined) {
		cache = new Map();
		buckets.set(logPath, cache);
	}
	const held = cache;
	const status = tailLines({
		key: `usage:${logPath}`,
		logPath,
		// The usage log is pruned by a rewrite once a month, so this is not hypothetical:
		// the buckets below describe the file as it was, and the file it is now has to be
		// counted from zero or every pruned row is counted twice.
		onRestart: () => held.clear(),
		onLine: (line) => ingest(held, line),
	});
	const day = utcDay(nowMs);
	const bucket = held.get(day);
	const rows = bucket?.rows ?? 0;
	if (status === "ok") return { usd: bucket?.usd ?? 0, rows };
	return {
		usd: null,
		rows,
		reason:
			status === "missing"
				? `${logPath} does not exist, so no agent spend can be seen (a fresh install, or a fleet whose agents log elsewhere)`
				: `${logPath} could not be read, so no agent spend can be seen`,
	};
}

/** Where the UTC day stands for every agent on this machine plus this supervisor.
 *
 *  Called only when the global cap is enabled: a disabled cap does no work and reads
 *  no file, which is what makes "off" cost nothing rather than merely forbear. */
export function globalSpend(args: { usagePath: string; eventsPath: string; nowMs: number }): GlobalSpend {
	const supervisor: DaySpend = dailySpend(args.eventsPath, args.nowMs, "utc");
	const agents = agentSpend(args.usagePath, args.nowMs);
	const totalUsd = agents.usd === null ? null : agents.usd + supervisor.spentUsd;
	return {
		day: utcDay(args.nowMs),
		agentsUsd: agents.usd,
		supervisorUsd: supervisor.spentUsd,
		totalUsd,
		rows: agents.rows,
		source: agents.usd === null ? "unavailable" : "usage.jsonl",
		...(agents.reason === undefined ? {} : { reason: agents.reason }),
		globalCappedTicks: supervisor.globalCappedTicks,
		unavailableTicks: supervisor.unavailableTicks,
	};
}
