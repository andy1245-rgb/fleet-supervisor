// The settings on this box, and the one atomic writer they all use.
//
// Three things live here because they were five before: the decision-mode toggle (the
// supervisor's own `src/decision/mode.ts` owns the file, this module reports it), the
// fast switch for new work, and the tmp+rename writer the five copies in the tree each
// spelled out for themselves (`lib/decision-mode.mjs`, `lib/fast-setting.mjs`,
// `fleet-manager/src/notes.ts`, `src/manager/tick.ts`, `src/decision/mode.ts`). A
// truncated JSON read would be the worst failure this system can have — the supervisor
// reads `decision-mode.json` once per tick — so there is one writer and everyone
// imports it.
//
// What "fast" is, exactly, because the whole feature is wrong if this is wrong:
//
//   `commandcode/deepseek/deepseek-v4.1-flash`       reasoning: true
//   `commandcode/deepseek/deepseek-v4.1-flash-fast`  reasoning: true
//
// Two model **ids** in the provider catalogue, not a service tier, not a priority flag,
// not a reasoning level. `pi --help` has no `--fast`; the only speed-ish lever it
// exposes is `--thinking`. So "run new work fast" means "pass the other model id to
// `--model`". The near-miss `deepseek-v4.1-flash-ultrafast` is a *different* model with
// reasoning off — cheap and dumb, not fast — and mapping this switch onto it would
// quietly change what every new agent can do. It is not in the table and never will be.
//
// Switching off is **not** "reverse the transform": a profile can legitimately contain
// tiers that are fast on purpose (the orchestrator ships `fast` and `fast-high` tiers
// whose whole point is the fast id), so the file records what it changed and only that
// is put back.

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
	DECISION_MODES,
	DEFAULT_DECISION_MODE,
	decisionModePath,
	isDecisionMode,
	readDecisionMode,
	type DecisionMode,
	type ModeReading,
} from "../decision/mode.ts";
import { profilesFile, stateDir as defaultStateDir } from "./where.ts";
import { isBag } from "./types.ts";

export { DECISION_MODES, DEFAULT_DECISION_MODE, decisionModePath, isDecisionMode };
export type { DecisionMode, ModeReading };

/** `fast.json`, beside `policy.json`. A *sibling* file rather than a second key in
 *  `decision-mode.json`, because the supervisor's writer writes `{mode, updatedAt}` and
 *  nothing else: a key parked there would be erased the first time somebody flipped the
 *  other toggle. */
export const FAST_FILE = "fast.json";
export const FAST_KEY = "fastNewWork";

/** The model a new conversation runs under when the switch is on, and the one it runs
 *  under when it is off — which is also pi's own default. */
export const FAST_CHAT_MODEL = "commandcode/deepseek/deepseek-v4.1-flash-fast";
export const BASE_CHAT_MODEL = "commandcode/deepseek/deepseek-v4.1-flash";

/** The models this switch knows how to move, and only those. `v4-pro` is absent because
 *  the catalogue has no `-fast` variant of it: the hard tier stays where it is rather
 *  than being guessed at. */
export const FAST_VARIANTS: Readonly<Record<string, string>> = Object.freeze({
	"deepseek/deepseek-v4.1-flash": "deepseek/deepseek-v4.1-flash-fast",
	"deepseek/deepseek-v4-flash": "deepseek/deepseek-v4-flash-fast",
});

// --------------------------------------------------------------- the atomic writer

/** Write a sibling and rename it over the target. `rename` is atomic inside one
 *  filesystem, so a reader sees either the old bytes or the new ones and never a
 *  truncated object; the temp file is removed if the rename fails, so a read-only
 *  directory leaves no litter behind a failed write. */
export function writeJsonAtomic(path: string, value: unknown, options: { tmpSuffix?: string } = {}): void {
	const body = `${JSON.stringify(value, null, "\t")}\n`;
	const tmp = `${path}.${options.tmpSuffix ?? `${process.pid}.tmp`}`;
	try {
		writeFileSync(tmp, body);
		renameSync(tmp, path);
	} catch (error) {
		rmSync(tmp, { force: true });
		throw error;
	}
}

/** Write the file without dropping the keys that are not ours. Each writer preserves
 *  every key it does not own, so flipping one toggle cannot erase another. */
export function mergeJsonAtomic(path: string, patch: Record<string, unknown>): void {
	let existing: Record<string, unknown> = {};
	try {
		const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
		if (isBag(parsed)) existing = parsed;
	} catch {
		/* an absent or unreadable file is replaced; the caller reports the gap */
	}
	writeJsonAtomic(path, { ...existing, ...patch });
}

// ------------------------------------------------------------------ decision mode

export interface DecisionModeState extends ModeReading {
	path: string;
	updatedAt: string | null;
	modes: readonly DecisionMode[];
	default: DecisionMode;
}

/** The toggle as a surface reports it: the supervisor's own reading, plus the
 *  `updatedAt` the writer stamps, so "when did I change this" is answerable. */
export function decisionModeState(stateDir: string = defaultStateDir()): DecisionModeState {
	const path = decisionModePath(stateDir);
	const reading = readDecisionMode(path);
	let updatedAt: string | null = null;
	try {
		const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
		if (isBag(parsed) && typeof parsed.updatedAt === "string") updatedAt = parsed.updatedAt;
	} catch {
		/* an absent or unreadable file is already described by `reading` */
	}
	return { path, ...reading, updatedAt, modes: DECISION_MODES, default: DEFAULT_DECISION_MODE };
}

/** The write. Validated before it touches the disk, atomic when it does, and it reports
 *  what it replaced so a caller can say "was X, now Y" without guessing. */
export function writeDecisionMode(args: { mode: unknown; stateDir?: string }): {
	ok: boolean;
	code?: "bad_mode" | "write_failed";
	before?: DecisionMode;
	after?: DecisionMode;
	path?: string;
	updatedAt?: string | null;
	allowed?: readonly DecisionMode[];
	message?: string;
} {
	const stateDir = args.stateDir ?? defaultStateDir();
	if (!isDecisionMode(args.mode)) {
		return { ok: false, code: "bad_mode", message: `not a decision mode: ${JSON.stringify(args.mode)}`, allowed: DECISION_MODES };
	}
	const before = decisionModeState(stateDir);
	const path = decisionModePath(stateDir);
	try {
		mergeJsonAtomic(path, { mode: args.mode, updatedAt: new Date().toISOString() });
	} catch (error) {
		return { ok: false, code: "write_failed", message: `could not write ${path}: ${error instanceof Error ? error.message : "unknown error"}` };
	}
	const after = decisionModeState(stateDir);
	return { ok: true, before: before.mode, after: after.mode, path: after.path, updatedAt: after.updatedAt };
}

// -------------------------------------------------------------------- the fast switch

export function fastPath(stateDir: string = defaultStateDir()): string {
	return join(stateDir, FAST_FILE);
}

/** The `-fast` id for one model, keeping its provider prefix. `provider` is accepted
 *  separately because a caller reading a profile row has the two halves already split,
 *  and a caller holding a `<provider>/<model>` string passes it whole. */
export function fastModelFor(provider: string, model: string): string | null {
	if (typeof model !== "string" || model === "") return null;
	const bare = model.startsWith(`${provider}/`) ? model.slice(provider.length + 1) : model;
	const variant = fastVariantOf(bare);
	return variant === null ? null : `${provider}/${variant}`;
}

export function fastVariantOf(model: string | null | undefined): string | null {
	if (typeof model !== "string" || model === "") return null;
	const direct = FAST_VARIANTS[model];
	if (direct !== undefined) return direct;
	return model.endsWith("-fast") ? model : null;
}

export function unfastVariantOf(model: string | null | undefined): string | null {
	if (typeof model !== "string" || !model.endsWith("-fast")) return null;
	const base = model.slice(0, -"-fast".length);
	return FAST_VARIANTS[base] === model ? base : null;
}

export interface FastReading {
	fast: boolean;
	source: "default" | "file";
	note?: string;
}

/** The three-way reading the decision toggle already uses: the file decided, the file is
 *  simply absent (not a fault), or the file is unusable and the reason travels. A
 *  non-boolean is reported rather than coerced: `"yes"` is not `true`, and a toggle that
 *  accepted it would be inventing the operator's intent. */
export function readFastSetting(path: string): FastReading {
	let text: string;
	try {
		text = readFileSync(path, "utf8");
	} catch (error) {
		const code = typeof error === "object" && error !== null && "code" in error ? String((error as { code: unknown }).code) : "error";
		if (code === "ENOENT") return { fast: false, source: "default" };
		return { fast: false, source: "default", note: `could not read ${path}: ${error instanceof Error ? error.message : code}` };
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(text) as unknown;
	} catch {
		return { fast: false, source: "default", note: `${path} is not JSON; new work is started not-fast` };
	}
	if (!isBag(parsed)) return { fast: false, source: "default", note: `${path} is not a JSON object; new work is started not-fast` };
	const value = parsed[FAST_KEY];
	if (value === undefined) return { fast: false, source: "default" };
	if (typeof value !== "boolean") {
		return { fast: false, source: "default", note: `${path} has a non-boolean ${FAST_KEY} (${JSON.stringify(value)}); new work is started not-fast` };
	}
	return { fast: value, source: "file" };
}

export interface FastState {
	key: string;
	path: string;
	fast: boolean;
	source: "default" | "file";
	note: string | null;
	writable: boolean;
	profilePath: string;
	chatModel: string;
	applied: unknown[];
}

export function fastState(stateDir: string = defaultStateDir(), options: { writable?: boolean; profilePath?: string } = {}): FastState {
	const path = fastPath(stateDir);
	const setting = readFastSetting(path);
	const profilePath = options.profilePath ?? profilesFile();
	return {
		key: FAST_KEY,
		path,
		fast: setting.fast,
		source: setting.source,
		note: setting.note ?? null,
		writable: options.writable === true,
		profilePath,
		chatModel: setting.fast ? FAST_CHAT_MODEL : BASE_CHAT_MODEL,
		applied: readApplied(path),
	};
}

/** The ledger of tiers this switch moved, from the setting file. */
export function readApplied(path: string): unknown[] {
	try {
		const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
		if (isBag(parsed) && Array.isArray(parsed.applied)) return parsed.applied.filter((row) => isBag(row));
	} catch {
		/* an absent or unreadable ledger is an empty one */
	}
	return [];
}

interface Tier {
	name?: unknown;
	model?: unknown;
	[key: string]: unknown;
}

interface ProfileConfig {
	profiles?: Record<string, { tiers?: unknown }>;
	[key: string]: unknown;
}

function profileNames(config: ProfileConfig): string[] {
	const profiles = config.profiles;
	if (!isBag(profiles)) return [];
	return Object.keys(profiles);
}

function tiersOf(config: ProfileConfig, profileName: string): Tier[] {
	const tiers = config.profiles?.[profileName]?.tiers;
	return Array.isArray(tiers) ? (tiers as Tier[]) : [];
}

/** One profile's tiers, moved onto their fast variants (or back), as a pure transform.
 *  A tier whose model has no variant is left alone and named; a tier already fast is
 *  left alone, so applying twice is applying once; every field this function does not
 *  understand is preserved. */
export function applyFastToProfile(config: ProfileConfig, profileName: string, fast: boolean): { config: ProfileConfig; changed: string[]; skipped: string[] } {
	const profile = config.profiles?.[profileName];
	if (profile === undefined) return { config, changed: [], skipped: [] };
	if (!Array.isArray(profile.tiers)) return { config, changed: [], skipped: [] };

	const changed: string[] = [];
	const skipped: string[] = [];
	const moved = (profile.tiers as Tier[]).map((tier) => {
		if (!isBag(tier)) return tier;
		const name = typeof tier.name === "string" ? tier.name : "?";
		const model = typeof tier.model === "string" ? tier.model : "";
		if (model === "") {
			skipped.push(`${name} (no model)`);
			return tier;
		}
		const parts = model.split("/");
		const bare = parts.length > 2 ? parts.slice(1).join("/") : model;
		const prefix = parts.length > 2 ? `${parts[0]}/` : "";
		const target = fast ? fastVariantOf(bare) : unfastVariantOf(bare);
		if (target === null) {
			skipped.push(`${name} (${model} has no ${fast ? "fast" : "non-fast"} variant)`);
			return tier;
		}
		if (target === bare) return tier;
		changed.push(`${name}: ${model} -> ${prefix}${target}`);
		return { ...tier, model: `${prefix}${target}` };
	});
	if (changed.length === 0) return { config, changed, skipped };
	return { config: { ...config, profiles: { ...config.profiles, [profileName]: { ...profile, tiers: moved } } }, changed, skipped };
}

interface AppliedRow {
	profile: string;
	tier: string;
	from: string;
	to?: string;
}

function appliedRows(value: unknown): AppliedRow[] {
	if (!Array.isArray(value)) return [];
	return value.filter(
		(row): row is AppliedRow =>
			isBag(row) && typeof row.profile === "string" && typeof row.tier === "string" && typeof row.from === "string",
	);
}

/** Restore exactly the tiers this switch moved, and nothing else. A recorded tier that
 *  has since been re-rendered or deleted is skipped and named, rather than
 *  resurrected. */
export function restoreFromApplied(config: ProfileConfig, applied: unknown): { config: ProfileConfig; restored: string[]; missing: string[] } {
	const restored: string[] = [];
	const missing: string[] = [];
	const rows = appliedRows(applied);
	if (rows.length === 0) return { config, restored, missing };
	const profiles = config.profiles;
	if (!isBag(profiles)) return { config, restored, missing };

	const byProfile = new Map<string, AppliedRow[]>();
	for (const row of rows) {
		const list = byProfile.get(row.profile) ?? [];
		list.push(row);
		byProfile.set(row.profile, list);
	}

	const nextProfiles: Record<string, { tiers?: unknown }> = { ...profiles };
	for (const [profileName, entries] of byProfile) {
		const profile = profiles[profileName];
		if (profile === undefined || !Array.isArray(profile.tiers)) {
			for (const entry of entries) missing.push(`${entry.profile} · ${entry.tier} (no such profile)`);
			continue;
		}
		const wanted = new Map(entries.map((entry) => [entry.tier, entry]));
		const seen = new Set<string>();
		const tiers = (profile.tiers as Tier[]).map((tier) => {
			const name = isBag(tier) && typeof tier.name === "string" ? tier.name : null;
			const entry = name === null ? undefined : wanted.get(name);
			if (entry === undefined || !isBag(tier)) return tier;
			seen.add(name as string);
			restored.push(`${profileName} · ${String(name)}: ${String(tier.model)} -> ${entry.from}`);
			return { ...tier, model: entry.from };
		});
		for (const [tierName] of wanted) if (!seen.has(tierName)) missing.push(`${profileName} · ${tierName} (tier is gone)`);
		nextProfiles[profileName] = { ...profile, tiers };
	}
	return { config: { ...config, profiles: nextProfiles }, restored, missing };
}

/** The rows a pass actually moved, as `{profile, tier, from, to}`, read by diffing the
 *  before and after tier lists rather than by re-deriving the decision. */
function movedRows(before: ProfileConfig, after: ProfileConfig, profileName: string): AppliedRow[] {
	const rows: AppliedRow[] = [];
	const beforeTiers = tiersOf(before, profileName);
	const afterTiers = tiersOf(after, profileName);
	for (let index = 0; index < afterTiers.length; index += 1) {
		const from = beforeTiers[index]?.model;
		const to = afterTiers[index]?.model;
		if (typeof from === "string" && typeof to === "string" && from !== to) {
			rows.push({ profile: profileName, tier: String(afterTiers[index]?.name ?? "?"), from, to });
		}
	}
	return rows;
}

export interface SetFastResult {
	ok: boolean;
	code?: "bad_value" | "write_failed";
	fast?: boolean;
	path?: string;
	profilePath?: string;
	before?: boolean;
	changed: string[];
	skipped: string[];
	note: string | null;
	message?: string;
}

/**
 * Set the switch: persist it, then project it onto the profile's tier table.
 *
 * The setting is written first, because it is the thing the operator asked for and the
 * thing a spawn reads at start time. The profile is a projection of it and can be
 * re-applied by setting the switch again, so a profile that cannot be written leaves
 * the switch set and says so rather than leaving him with neither.
 */
export function setFast(args: { fast: unknown; ctx?: { dataDir?: string | null }; stateDir?: string; profilePath?: string }): SetFastResult {
	const fast = args.fast;
	if (typeof fast !== "boolean") {
		return { ok: false, code: "bad_value", changed: [], skipped: [], note: null, message: `not a boolean: ${JSON.stringify(fast)}` };
	}
	const state = args.stateDir ?? args.ctx?.dataDir ?? defaultStateDir();
	const profilePath = args.profilePath ?? profilesFile();
	const path = fastPath(state);
	const before = readFastSetting(path);
	try {
		mkdirSync(state, { recursive: true });
	} catch (error) {
		return { ok: false, code: "write_failed", changed: [], skipped: [], note: null, message: `could not create ${state}: ${error instanceof Error ? error.message : "unknown"}` };
	}

	const previous = readApplied(path);
	const result: SetFastResult = { ok: true, fast, path, profilePath, before: before.fast, changed: [], skipped: [], note: null };
	const commit = (applied: unknown[]): void => {
		mergeJsonAtomic(path, { [FAST_KEY]: fast, applied, updatedAt: new Date().toISOString() });
	};

	if (!existsSync(profilePath)) {
		result.note = `${profilePath} does not exist, so no subagent tier was moved; run the rulebook renderer when it does`;
		commit(previous);
		return result;
	}

	let config: ProfileConfig;
	try {
		const parsed = JSON.parse(readFileSync(profilePath, "utf8")) as unknown;
		if (!isBag(parsed)) {
			result.note = `${profilePath} does not hold an object; no subagent tier was moved`;
			commit(previous);
			return result;
		}
		config = parsed as ProfileConfig;
	} catch (error) {
		result.note = `${profilePath} is not valid JSON (${error instanceof Error ? error.message : "unparseable"}); no subagent tier was moved`;
		commit(previous);
		return result;
	}

	let next = config;
	let applied: unknown[] = previous;
	if (fast) {
		const ledger: AppliedRow[] = [];
		for (const name of profileNames(config)) {
			const pass = applyFastToProfile(next, name, true);
			next = pass.config;
			for (const entry of pass.changed) result.changed.push(`${name} · ${entry}`);
			for (const entry of pass.skipped) result.skipped.push(`${name} · ${entry}`);
			for (const row of movedRows(config, next, name)) ledger.push(row);
		}
		applied = ledger.length > 0 ? ledger : previous;
	} else {
		const restored = restoreFromApplied(next, previous);
		next = restored.config;
		result.changed.push(...restored.restored);
		result.skipped.push(...restored.missing.map((entry) => `${entry} — not restored`));
		applied = [];
	}

	if (result.changed.length > 0) {
		try {
			writeJsonAtomic(profilePath, next);
		} catch (error) {
			result.note = `${profilePath} could not be written (${error instanceof Error ? error.message : "unknown"}); the switch is set but the subagent tiers still name the old models`;
			result.changed = [];
			applied = previous;
		}
	}
	try {
		commit(applied);
	} catch (error) {
		result.ok = false;
		result.code = "write_failed";
		result.message = `could not write ${path}: ${error instanceof Error ? error.message : "unknown"}`;
	}
	return result;
}
