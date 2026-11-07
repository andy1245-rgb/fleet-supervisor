// C3 — the `.json` route. The only route that can search Reddit globally, which is the
// whole reason it is worth a credential when the alternative is "what does subreddit S
// think, if S is already known" (§2.1).
//
// The transport is the interesting part, not the parsing. Measured (§1.2): a `.json`
// request with a genuine Chrome header set over HTTP/2 still returns the 189,908 B branded
// wall, so **headers are not the gate** — the discriminator sits below the header layer.
// That makes TLS impersonation (`curl_cffi`, `impersonate="chrome131"`) the identified fix,
// and it is not installed on this box. This adapter therefore takes its transport by
// injection and reports the absence as a **standing condition**:
//
//   availability() → { available: false, detail: "curl_cffi is not importable: …" }
//
// The router reads that once and stops offering the route (`json` is never a candidate),
// so a missing optional dependency costs zero requests and zero retries and the pipeline
// runs in the no-session degraded mode of §2.3 rather than pretending. Nothing here
// installs, shells out to, or otherwise conjures the dependency.
//
// Two credential modes, one call path (§4.3.1): `bearer` (OAuth access token, 100 req /
// 600 s per client-id, refreshable) and `cookie` (an imported `reddit_session` jar, minted
// where the login surface is served — it cannot be minted here, §1.2). Only the header
// differs, so the routing decision is a config change and not a code change.

import { CAPABILITIES } from "./channel.ts";
import type { Availability, RedditChannel } from "./channel.ts";
import { BUCKET_LIMITS } from "./budget.ts";
import type { SessionIdentity } from "./identity.ts";
import { probeCurlCffi } from "./transport.ts";
import type { DependencyProbe, HttpResponse, Transport } from "./transport.ts";
import type { Capability, Envelope, FetchOpts, HitList, RawThread, ScopedQuery, TimeWindow } from "./types.ts";
import { mapJsonFailure, parseJsonHits, parseJsonThread } from "./parse-json.ts";

export const JSON_BASE = "https://www.reddit.com";

export interface JsonOptions {
	/** The TLS-impersonating transport. Absent means the route cannot send anything, which
	 *  is reported through `availability()` rather than by failing requests. */
	readonly transport?: Transport;
	/** Cookie mode: an imported identity (§4.3.4). */
	readonly identity?: SessionIdentity | null;
	/** Bearer mode: an OAuth access token. Preferred when both exist: no browser, no
	 *  cookie, refreshable (§4.3.1). */
	readonly bearer?: string | null;
	readonly base?: string;
	readonly now?: () => number;
	/** Injected so no test spawns a python interpreter. */
	readonly dependencyProbe?: DependencyProbe;
}

/** Reddit's `t` accepts `hour|day|week|month|year|all`, which is not the window vocabulary
 *  `ScopedQuery` uses. The mapping always picks a `t` that is **not narrower** than asked,
 *  and the exact cut is then applied client-side by `withinWindow`, so a 3-month window
 *  cannot silently become a 1-month one — it becomes a year on the wire and 3 months in
 *  the result. */
export function redditTimeParam(window: TimeWindow | null): string | null {
	if (window === null) return null;
	if (window.kind === "absolute") return null;
	return window.span === "1w" ? "week" : window.span === "1m" ? "month" : "year";
}

export function withinWindow(createdUtc: number, window: TimeWindow | null, now: number): boolean {
	if (window === null) return true;
	if (window.kind === "absolute") {
		const ms = createdUtc * 1000;
		return ms >= window.afterUtc && ms <= window.beforeUtc;
	}
	const days = window.span === "1w" ? 7 : window.span === "1m" ? 30 : window.span === "3m" ? 90 : 365;
	return createdUtc * 1000 >= now - days * 86_400_000;
}

export class JsonChannel implements RedditChannel {
	readonly id = "json" as const;
	readonly capabilities: ReadonlySet<Capability> = CAPABILITIES.json;
	readonly budget = BUCKET_LIMITS.json ?? { capacity: 10, refillPerSec: 100 / 600, basis: "unmeasured" };
	private readonly transport: Transport | null;
	private readonly identity: SessionIdentity | null;
	private readonly bearer: string | null;
	private readonly base: string;
	private readonly now: () => number;
	private readonly standing: Availability;

	constructor(options: JsonOptions = {}) {
		this.transport = options.transport ?? null;
		this.identity = options.identity ?? null;
		this.bearer = options.bearer ?? null;
		this.base = options.base ?? JSON_BASE;
		this.now = options.now ?? Date.now;
		this.standing = this.resolveStanding(options.dependencyProbe);
	}

	/** Checked before a token is taken. Two independent standing conditions, reported
	 *  separately because they have different remedies: install/bridge the transport, or
	 *  import a session that was minted somewhere else. */
	availability(): Availability {
		return this.standing;
	}

	/** Identity string for the envelope. The account name is not a secret; the cookie is,
	 *  and it never leaves this object. */
	get identityId(): string {
		return this.identity === null ? (this.bearer === null ? "json:uncredentialed" : "json:bearer") : `json:${this.identity.account}`;
	}

	async search(query: ScopedQuery, opts: FetchOpts): Promise<Envelope<HitList>> {
		const subreddit = query.subreddits[0];
		const params = new URLSearchParams({ q: query.phrase, sort: query.sort, limit: String(Math.min(query.limit, 100)), raw_json: "1" });
		if (subreddit === undefined) params.set("restrict_sr", "0");
		else params.set("restrict_sr", "1");
		const time = redditTimeParam(query.window);
		if (time !== null) params.set("t", time);
		if (query.after !== null) params.set("after", query.after);
		const path = subreddit === undefined ? "/search.json" : `/r/${encodeURIComponent(subreddit)}/search.json`;

		const sent = await this.send(`${this.base}${path}?${params.toString()}`, opts.deadlineAt);
		if (!sent.ok) return sent.envelope;

		const parsed = parseJsonHits(sent.response.text);
		if (!parsed.ok) return { kind: "error", code: parsed.code, channel: this.id, detail: parsed.detail };

		const hits = parsed.value.hits.filter((hit) => withinWindow(hit.createdUtc, query.window, this.now()));
		const fetchedAtUtc = Math.floor(this.now() / 1000);
		const cost = { requests: 1, bytes: sent.response.bytes, wallMs: sent.wallMs };
		if (hits.length === 0) return { kind: "empty", channel: this.id, notes: [] };
		return {
			kind: "ok",
			value: { channel: this.id, identity: this.identityId, query, fetchedAtUtc, hits, exhausted: parsed.value.exhausted, notes: [], cost },
			channel: this.id,
			identity: this.identityId,
			fetchedAtUtc,
			cost,
			notes: [],
		};
	}

	async fetchThread(postId: string, opts: FetchOpts): Promise<Envelope<RawThread>> {
		// `limit=100`, not 500: the payload is what the pipeline can use, and `.json` has no
		// `fields` selector so every comment is paid for at ~570 tok (§4.3.6).
		const limit = Math.min(opts.limit ?? 100, 100);
		const params = new URLSearchParams({ limit: String(limit), raw_json: "1" });
		const sent = await this.send(`${this.base}/comments/${encodeURIComponent(postId)}.json?${params.toString()}`, opts.deadlineAt);
		if (!sent.ok) return sent.envelope;

		const fetchedAtUtc = Math.floor(this.now() / 1000);
		const parsed = parseJsonThread(sent.response.text, { postId, fetchedAtUtc, limit });
		if (!parsed.ok) return { kind: "error", code: parsed.code, channel: this.id, detail: parsed.detail };
		if (parsed.value.comments.length === 0) return { kind: "empty", channel: this.id, notes: parsed.value.notes };

		const cost = { requests: 1, bytes: sent.response.bytes, wallMs: sent.wallMs };
		return {
			kind: "ok",
			value: {
				postId: parsed.value.postId ?? postId,
				subreddit: parsed.value.subreddit ?? opts.subreddit ?? "",
				title: parsed.value.title ?? "",
				createdUtc: parsed.value.createdUtc,
				channel: this.id,
				identity: this.identityId,
				fetchedAtUtc,
				comments: parsed.value.comments,
				truncated: parsed.value.truncated,
				collapsed: parsed.value.collapsed,
				treeKnown: parsed.value.treeKnown,
				cost,
			},
			channel: this.id,
			identity: this.identityId,
			fetchedAtUtc,
			cost,
			notes: parsed.value.notes,
		};
	}

	private resolveStanding(probe: DependencyProbe | undefined): Availability {
		const why = (detail: string): Availability => ({ available: false, detail });
		if (this.transport === null) {
			const tls = probeCurlCffi(probe);
			if (!tls.available) return why(tls.detail);
			// Importable is not the same as usable: this layer deliberately carries no
			// curl_cffi subprocess bridge, so the credential would be one this route cannot
			// spend (§11 step 8 — the transport comes before the session adapter, on purpose).
			return why("curl_cffi is importable but this layer carries no subprocess bridge for it: pass a Transport built on it (impersonate=chrome131, §4.5) or the browser's transport.");
		}
		if (this.identity === null && this.bearer === null) {
			return why("no session and no bearer token: a .json route with no credential gets the 1,522 B plain-Blocked wall (spec §1.2), so it is not a candidate until an identity is imported (§4.3.4).");
		}
		return { available: true, detail: this.bearer === null ? `cookie session for ${this.identity?.account ?? "?"}` : "bearer token" };
	}

	private headers(): Record<string, string> {
		const headers: Record<string, string> = { accept: "application/json, text/plain, */*", "accept-language": "en-US,en;q=0.9" };
		if (this.bearer !== null) headers["authorization"] = `bearer ${this.bearer}`;
		if (this.identity !== null) {
			headers["cookie"] = this.identity.cookie;
			// The jar's UA belongs to the identity and must match its TLS profile (§4.5): a
			// changing fingerprint on one cookie jar has no honest explanation.
			headers["user-agent"] = this.identity.ua;
		}
		return headers;
	}

	private async send(url: string, deadlineAt: number): Promise<{ readonly ok: true; readonly response: HttpResponse; readonly wallMs: number } | { readonly ok: false; readonly envelope: Envelope<never> }> {
		if (!this.standing.available || this.transport === null) {
			return { ok: false, envelope: { kind: "unavailable", channel: this.id, detail: this.standing.detail } };
		}
		const started = this.now();
		let response: HttpResponse;
		try {
			response = await this.transport({ url, headers: this.headers(), timeoutMs: Math.max(1_000, deadlineAt - started) });
		} catch (error) {
			return { ok: false, envelope: { kind: "error", code: "transport", channel: this.id, detail: error instanceof Error ? error.message : String(error) } };
		}
		const wallMs = this.now() - started;

		const failure = mapJsonFailure(response);
		if (failure === null) return { ok: true, response, wallMs };
		switch (failure.kind) {
			case "throttled":
				return { ok: false, envelope: { kind: "throttled", retryAfterMs: failure.retryAfterMs, channel: this.id, identity: this.identityId } };
			case "walled":
				return { ok: false, envelope: { kind: "walled", shape: failure.shape, channel: this.id, identity: this.identityId } };
			case "dead-session":
				return { ok: false, envelope: { kind: "dead-session", channel: this.id, identity: this.identityId } };
			case "transient":
				return { ok: false, envelope: { kind: "error", code: "transport", channel: this.id, detail: failure.detail } };
			default:
				return { ok: false, envelope: { kind: "error", code: failure.code, channel: this.id, detail: failure.detail } };
		}
	}
}
