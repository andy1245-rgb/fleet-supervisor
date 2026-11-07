// What needs the operator, in the order it needs him.
//
// The page had eight tiles and no answer to "so what do I do". This is that answer: one
// small list, built from the same files every other screen reads, carried on every
// document so the top of every screen says the same thing. It is computed once, in
// `envelope()`, so two screens cannot disagree about how many asks are waiting.
//
// Each item carries its own count, its own file and the sentence a reader needs, because
// the rule from the tiles applies here too: no number without provenance. The two items
// that compare claims against the pane list name that list from the load they read, never
// the live one: on fixture data this list used to claim "claim files vs herdr agent list"
// over two fixture files.

import { paneListSource } from "./source.ts";
import type { Ctx } from "./types.ts";

export interface AttentionItem {
	id: string;
	label: string;
	count: number;
	href: string;
	tone: string;
	source: string;
	detail: string;
}

function diverged(source: Ctx["source"]): number {
	let n = 0;
	for (const pane of source.panes.panes) {
		const entry = source.claims.claims.get(pane.pane_id);
		if (entry !== undefined && entry.claim.state === "working" && pane.agent_status !== "working") n += 1;
	}
	return n;
}

function staleClaims(source: Ctx["source"], staleAfterMs: number, now: number): number {
	let n = 0;
	for (const pane of source.panes.panes) {
		const entry = source.claims.claims.get(pane.pane_id);
		if (entry === undefined) continue;
		const at = Date.parse(entry.claim.updated);
		if (!Number.isFinite(at) || now - at > staleAfterMs) n += 1;
	}
	return n;
}

function orphanClaims(source: Ctx["source"]): number {
	const known = new Set(source.panes.panes.map((pane) => pane.pane_id));
	return [...source.claims.claims.keys()].filter((paneId) => !known.has(paneId)).length;
}

function supervisorStopped(ctx: Ctx): { ageSeconds: number; ts: string } | null {
	const ticks = ctx.allByKind("tick");
	if (ticks.length === 0) return null;
	const newest = ticks.reduce((a, b) => (Date.parse(a.ts) >= Date.parse(b.ts) ? a : b));
	const ageSeconds = Math.max(0, Math.round((ctx.now - Date.parse(newest.ts)) / 1000));
	if (ageSeconds * 1000 <= ctx.stopAfterMs) return null;
	return { ageSeconds, ts: newest.ts };
}

/** Only the items with something in them, worst first. `href` is a hash route so the
 *  list is a set of links rather than a set of numbers. */
export function attentionItems(ctx: Ctx): AttentionItem[] {
	const source = ctx.source;
	const paneList = paneListSource(source);
	const items: AttentionItem[] = [];

	const held = source.asks.pending.length;
	if (held > 0) {
		items.push({
			id: "asks",
			label: held === 1 ? "ask waiting on you" : "asks waiting on you",
			count: held,
			href: "#/asks",
			tone: "warn",
			source: "asks.jsonl (folded, last line per id wins)",
			detail: "actions the gate parked and nobody has released. Each one names the exact command that releases it",
		});
	}

	const blocked = source.panes.panes.filter((pane) => pane.agent_status === "blocked").length;
	if (blocked > 0) {
		items.push({
			id: "blocked",
			label: blocked === 1 ? "pane blocked" : "panes blocked",
			count: blocked,
			href: "#/fleet",
			tone: "bad",
			source: paneList.short,
			detail: "a blocked pane will not resolve itself: it is the only status that needs a person",
		});
	}

	const split = diverged(source);
	if (split > 0) {
		items.push({
			id: "diverged",
			label: split === 1 ? "claim disagrees with its pane" : "claims disagree with their panes",
			count: split,
			href: "#/fleet",
			tone: "bad",
			source: `claim files vs ${paneList.short}`,
			detail: `the claim says working and ${paneList.short} does not report working. This is the case the supervisor exists to catch`,
		});
	}

	const stale = staleClaims(source, ctx.staleAfterMs, ctx.now);
	if (stale > 0) {
		items.push({
			id: "stale",
			label: stale === 1 ? "stale claim" : "stale claims",
			count: stale,
			href: "#/fleet",
			tone: "warn",
			source: `claim files · older than ${Math.round(ctx.staleAfterMs / 1000)}s`,
			detail: "the claim file is older than three tick intervals, or its `updated` will not parse",
		});
	}

	const orphans = orphanClaims(source);
	if (orphans > 0) {
		items.push({
			id: "orphans",
			label: orphans === 1 ? "claim with no pane" : "claims with no pane",
			count: orphans,
			href: "#/fleet",
			tone: "warn",
			source: `claim files vs ${paneList.short}`,
			detail: "nothing in the tree deletes a claim, so these outlive their panes. The page shows them and leaves them on disk",
		});
	}

	const stopped = supervisorStopped(ctx);
	if (stopped !== null) {
		items.push({
			id: "stopped",
			label: "supervisor stopped writing",
			count: 1,
			href: "#/health",
			tone: "bad",
			source: "events.jsonl (newest tick row)",
			detail: `the newest tick row is ${stopped.ageSeconds}s old, past twice the tick interval. Everything above is as stale as that row`,
		});
	}

	return items;
}
