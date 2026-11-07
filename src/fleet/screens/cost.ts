// Cost.
//
// The one arithmetic rule this screen may not break: the three totals nest, they do not
// add. A tick row prices the whole ladder trail, including a failed escalator; a decision
// row prices only the model whose opinion became the decision. So
// `sum(decision.costUsd) !== sum(tick.costUsd)` by construction, and the document prints
// both with the sentence that says so instead of a grand total nobody can reproduce.
//
// The multiplier is a fact about the clock, not a per-row field: the card doubles on
// weekdays 01–04 and 06–10 UTC. This document shows the rule, the multiplier now, and
// which multiplier applied to each row's own timestamp — it never re-derives a logged
// dollar figure.

import { PRICES, PEAK_RULE, PRICE_SOURCE, pricingBlock } from "./pricing.ts";
import { envelope, lagSecondsOf, tile } from "../envelope.ts";
import { distribution, ratio } from "../../metrics/report.ts";
import { peakMultiplier } from "../../decision/adapters/commandcode.ts";
import { reportVerb } from "../where.ts";
import type { DecisionEvent, TickEvent } from "../../metrics/schema.ts";
import type { Ctx, Doc } from "../types.ts";

function dayOf(ts: string): string {
	return ts.slice(0, 10);
}

export function buildCost(ctx: Ctx): Doc {
	const { events, now, opts } = ctx;
	const ticks = events.filter((event): event is TickEvent => event.kind === "tick");
	const decisions = events.filter((event): event is DecisionEvent => event.kind === "decision");

	const tickTotal = ticks.reduce((sum, tick) => sum + tick.costUsd, 0);
	const decisionTotal = decisions.reduce((sum, decision) => sum + decision.costUsd, 0);
	const today = new Date(now).toISOString().slice(0, 10);

	const tickRows = ticks
		.slice()
		.sort((a, b) => Date.parse(b.ts) - Date.parse(a.ts))
		.slice(0, 120)
		.map((tick) => ({
			ts: tick.ts,
			ageSeconds: lagSecondsOf(tick.ts, now),
			costUsd: tick.costUsd,
			multiplier: peakMultiplier(new Date(tick.ts)),
			dry: tick.dry,
			agents: tick.agents,
			moved: tick.moved,
			decisions: tick.decisions,
			escalated: tick.escalated,
			prompts: tick.prompts,
			held: tick.held,
			durationMs: tick.durationMs,
			models: tick.models,
		}));

	const ticksByDay = new Map<string, number>();
	for (const tick of ticks) ticksByDay.set(dayOf(tick.ts), (ticksByDay.get(dayOf(tick.ts)) ?? 0) + tick.costUsd);
	const decisionsByDay = new Map<string, number>();
	for (const decision of decisions) decisionsByDay.set(dayOf(decision.ts), (decisionsByDay.get(dayOf(decision.ts)) ?? 0) + decision.costUsd);
	const days = [...new Set([...ticksByDay.keys(), ...decisionsByDay.keys()])].sort();

	const byModel = new Map<string, { model: string; decisions: number; totalUsd: number; refused: number; latencies: number[] }>();
	for (const decision of decisions) {
		const entry = byModel.get(decision.model) ?? { model: decision.model, decisions: 0, totalUsd: 0, refused: 0, latencies: [] };
		entry.decisions += 1;
		entry.totalUsd += decision.costUsd;
		if (decision.refused) entry.refused += 1;
		entry.latencies.push(decision.latencyMs);
		byModel.set(decision.model, entry);
	}
	const modelRows = [...byModel.values()]
		.map((entry) => ({
			model: entry.model,
			decisions: entry.decisions,
			totalUsd: entry.totalUsd,
			share: ratio(entry.totalUsd, decisionTotal) ?? 0,
			refused: entry.refused,
			refusalRate: ratio(entry.refused, entry.decisions),
			latency: distribution(entry.latencies),
		}))
		.sort((a, b) => b.totalUsd - a.totalUsd || a.model.localeCompare(b.model));

	// The token split. `promptTokens` / `completionTokens` are optional on the row and
	// absent in every row written so far; cached and reasoning counts are not fields on the
	// row at all, only on the adapter's own accounting.
	const tokenField = (field: "promptTokens" | "completionTokens"): { present: number; absent: number; total: number | null; mean: number | null } => {
		const present = decisions.filter((decision) => typeof decision[field] === "number");
		const total = present.length === 0 ? null : present.reduce((sum, decision) => sum + (decision[field] ?? 0), 0);
		return { present: present.length, absent: decisions.length - present.length, total, mean: total === null ? null : total / present.length };
	};

	const pricing = pricingBlock(new Date(now));
	const multiplierNow = pricing.now.multiplier;
	const promptTokens = tokenField("promptTokens");
	const completionTokens = tokenField("completionTokens");

	const source = `events.jsonl, kind=tick (${ctx.window})`;
	const decisionSource = `events.jsonl, kind=decision (${ctx.window})`;
	const spendToday = decisions.filter((decision) => dayOf(decision.ts) === today);

	const tiles = [
		tile({
			id: "tickTotal",
			label: "Tick total",
			value: Number(tickTotal.toFixed(6)),
			unit: "USD",
			n: ticks.length,
			source,
			nullReason: ticks.length === 0 ? "no tick rows in this window" : null,
			detail: `the only row that prices a whole tick, ladder trails included; ${ticks.filter((tick) => tick.dry).length} of these ticks were dry`,
		}),
		tile({
			id: "decisionTotal",
			label: "Decision rows total",
			value: Number(decisionTotal.toFixed(6)),
			unit: "USD",
			n: decisions.length,
			source: decisionSource,
			nullReason: decisions.length === 0 ? "no decision rows in this window" : null,
			detail: "the deciding model only. This does not reproduce the tick total and the document never adds them",
		}),
		tile({ id: "multiplier", label: "Peak multiplier now", value: `${multiplierNow}×`, n: 1, source: PRICE_SOURCE, tone: multiplierNow > 1 ? "warn" : "neutral", note: PEAK_RULE, detail: "a fact about the clock. Each row below shows the multiplier that applied to its own timestamp" }),
		tile({ id: "promptTokens", label: "Prompt tokens", value: promptTokens.present === 0 ? null : promptTokens.total, n: promptTokens.present, source: decisionSource, nullReason: "no decision row carries promptTokens: the field is optional and nothing fills it yet", detail: "the adapter accounts it, the row does not store it" }),
		tile({ id: "completionTokens", label: "Completion tokens", value: completionTokens.present === 0 ? null : completionTokens.total, n: completionTokens.present, source: decisionSource, nullReason: "no decision row carries completionTokens: the field is optional and nothing fills it yet", detail: "reasoning tokens are inside completion and are billed as output" }),
		tile({
			id: "spendToday",
			label: `Decision spend, ${today} UTC`,
			value: Number((decisionsByDay.get(today) ?? 0).toFixed(6)),
			unit: "USD",
			n: spendToday.length,
			source: decisionSource,
			detail: "UTC day, from each row's own timestamp. A local-midnight total would disagree with this one",
		}),
		tile({ id: "models", label: "Models billed", value: modelRows.filter((row) => row.totalUsd > 0).length, n: modelRows.length, source: decisionSource, detail: "distinct deciding models with a non-zero cost" }),
	];

	const notes = [
		"Tick total and decision total are not additive: the tick prices the whole ladder trail, a decision row prices only the deciding model. Adding them counts the escalation twice.",
		`Prices are the verified card: input $${PRICES.input}/M, output $${PRICES.output}/M, cache read $${PRICES.cacheRead}/M, cache write $${PRICES.cacheWrite}/M, doubled ${PEAK_RULE}.`,
	];
	if (promptTokens.present === 0) notes.push("The token columns are null, not zero: `promptTokens` and `completionTokens` are optional on a decision row and no writer fills them yet. Cached and reasoning counts are not fields on the row at all — only the adapter's own accounting has them.");
	if (ticks.length === 0) notes.push("No tick rows: per-tick rates and the whole-tick cost are null, not zero.");

	return envelope(ctx, {
		route: "cost",
		screen: "cost",
		title: "Cost",
		n: ticks.length + decisions.length,
		tiles,
		notes,
		counts: { ticks: ticks.length, decisions: decisions.length, models: modelRows.length, days: days.length },
		data: {
			additive: false,
			additivity: {
				additive: false,
				tickTotalUsd: Number(tickTotal.toFixed(6)),
				decisionTotalUsd: Number(decisionTotal.toFixed(6)),
				why: "a tick row prices the whole ladder trail; a decision row prices the deciding model only",
			},
			ticks: tickRows,
			ticksTotal: ticks.length,
			byDay: days.map((day) => ({
				day,
				utc: true,
				ticksUsd: Number((ticksByDay.get(day) ?? 0).toFixed(6)),
				ticks: ticks.filter((tick) => dayOf(tick.ts) === day).length,
				decisionsUsd: Number((decisionsByDay.get(day) ?? 0).toFixed(6)),
				decisions: decisions.filter((decision) => dayOf(decision.ts) === day).length,
			})),
			byModel: modelRows,
			tokens: {
				promptTokens,
				completionTokens,
				cachedTokens: {
					present: 0,
					absent: decisions.length,
					total: null,
					mean: null,
					reason: "SCHEMA_VERSION 2 has no cached-token field on a decision row; the adapter accounts cache reads at $0.003/M and the row does not carry the count",
				},
				reasoningTokens: {
					present: 0,
					absent: decisions.length,
					total: null,
					mean: null,
					reason: "SCHEMA_VERSION 2 has no reasoning-token field on a decision row; reasoning is inside completion and is billed as output",
				},
			},
			pricing,
			cheapest: modelRows.length === 0 ? null : modelRows.reduce((a, b) => (a.totalUsd <= b.totalUsd ? a : b)),
			reportVerb: reportVerb(opts.agentFleetRoot || "", ctx.window),
		},
	});
}
