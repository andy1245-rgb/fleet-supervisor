// The two toggles, as a screen and as writes.
//
// The supervisor decides which path makes a decision from one file in its state dir
// (`src/decision/mode.ts`), read once at the top of every tick. This document is the other
// side of that file: it shows the value, it says what each mode does and costs, and the
// write validates the operator's choice before touching the disk.
//
// Nothing here calls a model. The switch writes a word and the next tick does the work, and
// the decisions document shows it — every decision row carries the mode that produced it,
// so the change is visible in the log rather than only here.
//
// `fast` is the sibling switch for new work, and it has two halves: the setting (which a
// spawn reads) and the profile's tier table (which the forge runtime reads at dispatch, and
// which is how the switch reaches subagents). `setFast` writes both, in that order.

import { envelope, tile } from "../envelope.ts";
import { decisionModeState, fastState, setFast, DECISION_MODES, DEFAULT_DECISION_MODE, FAST_VARIANTS, FAST_KEY } from "../settings.ts";
import type { Ctx, Doc } from "../types.ts";

/** What each mode is, in the operator's terms: what it does and what it costs. The figures
 *  are the measured ones, not estimates — a toggle that describes its options in adjectives
 *  is not a cost control. */
export const MODE_FACTS: Readonly<Record<string, { label: string; what: string; cost: string; catch: string }>> = {
	adapter: {
		label: "Adapter + escalator",
		what: "One hosted `responses` call, then the rule-based escalator when a fact about the answer earns a second one.",
		cost: "~$0.00010 and ~0.9-1.2 s per decision, plus a second call when a rule fires.",
		catch: "The escalator is GLM over OpenRouter. With no key on this box every escalation fails, so the ladder's top rung has never answered.",
	},
	pi: {
		label: "pi, one call",
		what: "One `pi -p` subprocess on the same model, reasoning off, with a short purpose-built system prompt.",
		cost: "~$0.00005 and ~2.1-2.5 s per decision (measured p50 2.1 s, p95 2.5 s). No second call, ever.",
		catch: "Slower by ~1.2 s of process start, and there is no falsifier: a bad answer is not re-asked.",
	},
};

export function buildSettings(ctx: Ctx): Doc {
	// The server's own state dir, not wherever the data on this document came from: in
	// fixture mode `source.stateDir` is the fixtures directory, and writing the live
	// supervisor's toggle into a checked-in sample would be the worst possible place.
	const stateDir = ctx.opts.dataDir ?? ctx.source.stateDir;
	const setting = decisionModeState(stateDir);
	const fast = fastState(stateDir, { writable: ctx.opts.enableSettings, profilePath: undefined });
	const writable = ctx.opts.enableSettings === true;

	const rows = DECISION_MODES.map((mode) => ({
		mode,
		current: mode === setting.mode,
		isDefault: mode === DEFAULT_DECISION_MODE,
		...MODE_FACTS[mode],
	}));

	return envelope(ctx, {
		route: "settings",
		screen: "settings",
		title: "Settings",
		n: rows.length,
		tiles: [
			tile({
				id: "mode",
				label: "decision mode",
				value: setting.mode,
				n: 1,
				source: "decision-mode.json",
				detail: `read from ${setting.path}`,
				note: setting.source === "file" ? "set by the operator" : "the default — nothing has been written yet",
				tone: setting.source === "file" ? "ok" : "neutral",
			}),
			tile({
				id: "fast",
				label: "new work",
				value: fast.fast ? "fast" : "standard",
				n: 1,
				source: "fast.json (fastNewWork)",
				detail: `read from ${fast.path}; a spawn runs ${fast.chatModel}`,
				note: fast.source === "file" ? "set by the operator" : "the default — nothing has been written yet",
				tone: fast.fast ? "warn" : "neutral",
			}),
			tile({
				id: "writable",
				label: "writable from here",
				value: writable ? "yes" : "no",
				n: 1,
				source: "--enable-settings",
				detail: writable ? "the write routes are armed" : "the write routes are off, which is the default guard",
				note: writable ? "--enable-settings was given" : "restart with --enable-settings to change a setting from the page",
				tone: writable ? "ok" : "dim",
			}),
		],
		notes: [
			`read once per tick by the supervisor, from ${setting.path}`,
			"a change takes effect on the next tick, not on a restart",
			`the fast switch moves ${Object.keys(FAST_VARIANTS).length} model ids onto their -fast variant and records exactly which tiers it moved, so switching off puts back only those`,
		],
		data: {
			decisionMode: {
				current: setting.mode,
				source: setting.source,
				note: setting.note ?? null,
				path: setting.path,
				updatedAt: setting.updatedAt,
				writable,
				fallback: `an unreadable or unknown value keeps ${DEFAULT_DECISION_MODE} and records the reason on the next tick`,
				options: rows,
			},
			fast: {
				key: FAST_KEY,
				fast: fast.fast,
				source: fast.source,
				note: fast.note,
				path: fast.path,
				profilePath: fast.profilePath,
				chatModel: fast.chatModel,
				applied: fast.applied,
				variants: FAST_VARIANTS,
				writable,
			},
		},
		counts: { options: rows.length },
	});
}

/** The two writes, as documents. Kept here rather than in the route so a verb and a route
 *  answer with one shape. */
export function applyFast(ctx: Ctx, value: boolean): Record<string, unknown> {
	const result = setFast({ fast: value, ctx: { dataDir: ctx.opts.dataDir }, profilePath: undefined });
	return {
		ok: result.ok,
		code: result.code ?? null,
		fast: result.fast ?? value,
		before: result.before ?? null,
		changed: result.changed,
		skipped: result.skipped,
		note: result.note,
		message: result.message ?? null,
		path: result.path ?? null,
		profilePath: result.profilePath ?? null,
	};
}
