// The verified card and the peak rule, quoted from the adapter that charges it.
//
// Source of both: `src/decision/adapters/commandcode.ts` — `PRICES` and `peakMultiplier`.
// They are imported rather than copied, because a price the page states and a price the
// adapter charges are the same fact, and because a decision row's `costUsd` was measured
// with this multiplier: a document that re-derived the price would disagree with its own
// numbers.
//
// Nothing here re-derives a logged dollar figure. `costUsd` on a row is what the adapter
// measured at call time, multiplier included; this module only says *which* multiplier
// applied to a given instant, and what the card's rates are.

import { PRICES, peakMultiplier } from "../../decision/adapters/commandcode.ts";

export { PRICES, peakMultiplier };
import { envelope, tile } from "../envelope.ts";
import type { Ctx, Doc } from "../types.ts";

export const PRICE_SOURCE = "src/decision/adapters/commandcode.ts#PRICES";

export const PEAK_RULE = "weekdays 01:00–04:00 and 06:00–10:00 UTC are billed at 2×; weekends are 1×";

export interface PricingBlock {
	source: string;
	unit: string;
	rates: typeof PRICES;
	peakRule: string;
	now: { at: string; multiplier: number; utcDay: number; utcHour: number };
	dayStrip: { hour: number; multiplier: number }[];
	tokensOnRows: string;
}

/** The 24 UTC hours of one day, each with the multiplier that applies to it. A Saturday
 *  and a Sunday are all 1×, which is the visible difference between the rule and a fixed
 *  guess. */
export function dayStrip(dayUtc: Date | number): { hour: number; multiplier: number }[] {
	const date = dayUtc instanceof Date ? dayUtc : new Date(dayUtc);
	const row: { hour: number; multiplier: number }[] = [];
	for (let hour = 0; hour < 24; hour += 1) {
		const at = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), hour, 0, 0));
		row.push({ hour, multiplier: peakMultiplier(at) });
	}
	return row;
}

export function pricingBlock(at: Date): PricingBlock {
	return {
		source: PRICE_SOURCE,
		unit: "USD per million tokens",
		rates: PRICES,
		peakRule: PEAK_RULE,
		now: { at: at.toISOString(), multiplier: peakMultiplier(at), utcDay: at.getUTCDay(), utcHour: at.getUTCHours() },
		dayStrip: dayStrip(at),
		/** The card prices tokens; the log has been writing no token counts, which is a
		 *  fact about the adapter and not about this document. */
		tokensOnRows: "DecisionEvent.promptTokens and .completionTokens are optional and absent in every row written so far",
	};
}

export function buildPricing(ctx: Ctx): Doc {
	const block = pricingBlock(new Date(ctx.now));
	return envelope(ctx, {
		route: "pricing",
		screen: "pricing",
		title: "Pricing",
		n: 1,
		tiles: [
			tile({
				id: "multiplier",
				label: "Peak multiplier now",
				value: `${block.now.multiplier}×`,
				n: 1,
				source: PRICE_SOURCE,
				note: PEAK_RULE,
				tone: block.now.multiplier > 1 ? "warn" : "neutral",
				detail: "a fact about the clock. Every cost row shows the multiplier that applied to its own timestamp",
			}),
		],
		notes: [
			"Rates are the adapter's own table, imported rather than copied: the price this document states is the price the row was charged at.",
			`input $${PRICES.input}/M · output $${PRICES.output}/M · cache read $${PRICES.cacheRead}/M · cache write $${PRICES.cacheWrite}/M`,
		],
		counts: { rates: Object.keys(PRICES).length, hours: 24 },
		data: { pricing: block },
	});
}
