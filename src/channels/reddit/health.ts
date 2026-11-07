// Health is cheap to check and expensive to guess, so it is recorded rather than
// inferred: one entry per (channel, capability), and the breaker is per *capability*
// because that is today's observed state — Arctic's search queue is closed while its
// thread fetch runs at full rate (spec §5.2).
//
// The three wall shapes from walls.ts are the input. What differs between them is not
// the retry count, it is what gets blamed: a branded wall is the identity, a plain
// block is the transport, a 429 is the clock. Quarantining the identity because a
// bucket was empty would take a healthy 60 s channel out for 15 minutes.

import type { Capability, ChannelId } from "./types.ts";

export type FailureClass = "transient" | "structural" | "identity" | "budget";

export type OutcomeKind =
	| "ok"
	| "empty"
	/** 429. A clock, never a judgement about the identity (§3.4). */
	| "throttled"
	/** 403 branded / plain, or a `dead-session` redirect. */
	| "identity"
	/** Network error, 5xx, or Arctic's `422 Timeout`. */
	| "transient"
	/** A 4xx that will not change on a retry. */
	| "structural"
	/** The request never left: no transport, no credential, no bridge. */
	| "unavailable";

export interface HealthPolicy {
	/** §5.2: Arctic's search breaker is 60 s, and closed by one successful search. */
	readonly searchBreakerMs: number;
	/** §5.2: three consecutive `422 Timeout` answers open it. */
	readonly searchBreakerTimeouts: number;
	/** §2.2: a structural failure takes (capability, channel) out for 10 min. */
	readonly structuralHoldMs: number;
	/** §3.4: an identity is quarantined on the channel for 15 min after a wall. */
	readonly identityQuarantineMs: number;
	/** §2.4: no successful request in 24 h is not health, and silence must not read as
	 *  a healthy candidate. */
	readonly staleAfterMs: number;
	/** §3.4 keeps a rolling window of the last 20 outcomes. */
	readonly outcomeWindow: number;
}

export const DEFAULT_HEALTH_POLICY: HealthPolicy = {
	searchBreakerMs: 60_000,
	searchBreakerTimeouts: 3,
	structuralHoldMs: 10 * 60_000,
	identityQuarantineMs: 15 * 60_000,
	staleAfterMs: 24 * 60 * 60_000,
	outcomeWindow: 20,
};

export interface Usable {
	readonly ok: boolean;
	/** ms epoch at which it becomes usable again; absent when `ok`. */
	readonly until?: number;
	readonly why: string;
}

export interface AttemptOutcome {
	readonly channel: ChannelId;
	readonly capability: Capability;
	readonly kind: OutcomeKind;
	readonly now: number;
	readonly identity?: string | null;
	readonly detail?: string;
}

interface Entry {
	readonly channel: ChannelId;
	readonly capability: Capability;
	strikes: number;
	breakUntil: number;
	breakWhy: string;
	lastSuccessAt: number | null;
	lastAttemptAt: number | null;
	outcomes: OutcomeKind[];
}

export interface HealthSnapshot {
	readonly channel: ChannelId;
	readonly capability: Capability;
	readonly strikes: number;
	readonly breakUntil: number;
	readonly breakWhy: string;
	readonly lastSuccessAt: number | null;
	readonly outcomes: readonly OutcomeKind[];
}

function entryKey(channel: ChannelId, capability: Capability): string {
	return `${channel}|${capability}`;
}

function isSearch(capability: Capability): boolean {
	return capability === "search.global" || capability === "search.scoped";
}

export class HealthBoard {
	private readonly policy: HealthPolicy;
	private readonly entries = new Map<string, Entry>();
	private readonly quarantined = new Map<string, { until: number; why: string }>();

	constructor(policy: HealthPolicy = DEFAULT_HEALTH_POLICY) {
		this.policy = policy;
	}

	/** Can this (channel, capability) be attempted by this identity now? */
	usable(channel: ChannelId, capability: Capability, now: number, identity: string | null = null): Usable {
		const entry = this.entries.get(entryKey(channel, capability));

		if (entry !== undefined) {
			if (entry.breakUntil > now) return { ok: false, until: entry.breakUntil, why: entry.breakWhy };
			// Lazy close: an expired breaker hands the next attempt a clean strike count, so a probe
			// is not condemned by the failures of the previous window.
			if (entry.breakUntil !== 0) {
				entry.breakUntil = 0;
				entry.breakWhy = "";
				entry.strikes = 0;
			}
			if (entry.lastSuccessAt === null && entry.lastAttemptAt !== null && now - entry.lastAttemptAt > this.policy.staleAfterMs) {
				return { ok: false, why: `no successful request in ${Math.round(this.policy.staleAfterMs / 3_600_000)} h — silence is not health` };
			}
		}

		// Checked outside the entry lookup, because a quarantine belongs to the identity and the
		// channel, not to one capability: an identity walled out of `thread.fetch` is exactly as
		// walled out of `search.scoped`, which may never have been attempted.
		if (identity !== null) {
			const held = this.quarantined.get(`${channel}|${identity}`);
			if (held !== undefined && held.until > now) return { ok: false, until: held.until, why: held.why };
		}

		return { ok: true, why: entry === undefined ? "no history" : "usable" };
	}

	/** Record what happened. Breakers open here and only here, so there is one place to
	 *  read when asking "why did the pipeline stop using this route". */
	record(outcome: AttemptOutcome): void {
		const entry = this.entryFor(outcome.channel, outcome.capability);
		entry.lastAttemptAt = outcome.now;
		entry.outcomes.push(outcome.kind);
		if (entry.outcomes.length > this.policy.outcomeWindow) entry.outcomes.shift();

		switch (outcome.kind) {
			case "ok":
			case "empty":
				entry.lastSuccessAt = outcome.now;
				entry.strikes = 0;
				return;
			case "throttled":
				// Nothing about the identity changed and nothing about the route is broken.
				return;
			case "unavailable":
				// A standing condition. It is already reported by `availability()`; charging
				// it to the route's health would make a missing optional dependency look like
				// a failing channel.
				return;
			case "identity":
				entry.strikes += 1;
				if (outcome.identity) this.quarantine(outcome.channel, outcome.identity, outcome.now, outcome.detail ?? "walled");
				return;
			case "structural":
				entry.strikes += 1;
				this.openBreak(entry, outcome.now, this.policy.structuralHoldMs, outcome.detail ?? "structural failure");
				return;
			case "transient": {
				entry.strikes += 1;
				// Search is the scarce capability and its throttle answer is a queue, not a
				// fault: three in a row closes search for 60 s while fetch keeps its full rate.
				if (isSearch(outcome.capability) && entry.strikes >= this.policy.searchBreakerTimeouts) {
					this.openBreak(entry, outcome.now, this.policy.searchBreakerMs, outcome.detail ?? "search queue closed");
				} else if (entry.strikes >= this.policy.searchBreakerTimeouts) {
					this.openBreak(entry, outcome.now, this.policy.structuralHoldMs, outcome.detail ?? "repeated transient failure");
				}
				return;
			}
		}
	}

	openBreakFor(channel: ChannelId, capability: Capability, now: number, holdMs: number, why: string): void {
		this.openBreak(this.entryFor(channel, capability), now, holdMs, why);
	}

	/** §3.4: a wall quarantines the identity on this channel, not the channel. */
	quarantine(channel: ChannelId, identity: string, now: number, why: string): void {
		const key = `${channel}|${identity}`;
		const existing = this.quarantined.get(key);
		const until = now + this.policy.identityQuarantineMs;
		if (!existing || existing.until < until) this.quarantined.set(key, { until, why });
	}

	quarantineUntil(channel: ChannelId, identity: string): number {
		return this.quarantined.get(`${channel}|${identity}`)?.until ?? 0;
	}

	snapshot(): readonly HealthSnapshot[] {
		return [...this.entries.values()].map((entry) => ({
			channel: entry.channel,
			capability: entry.capability,
			strikes: entry.strikes,
			breakUntil: entry.breakUntil,
			breakWhy: entry.breakWhy,
			lastSuccessAt: entry.lastSuccessAt,
			outcomes: [...entry.outcomes],
		}));
	}

	private entryFor(channel: ChannelId, capability: Capability): Entry {
		const key = entryKey(channel, capability);
		const existing = this.entries.get(key);
		if (existing) return existing;
		const made: Entry = { channel, capability, strikes: 0, breakUntil: 0, breakWhy: "", lastSuccessAt: null, lastAttemptAt: null, outcomes: [] };
		this.entries.set(key, made);
		return made;
	}

	private openBreak(entry: Entry, now: number, holdMs: number, why: string): void {
		const until = now + holdMs;
		if (entry.breakUntil < until) {
			entry.breakUntil = until;
			entry.breakWhy = why;
		}
	}
}
