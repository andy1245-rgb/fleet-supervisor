// C4 — the browser. Last resort, and not a scraper.
//
// Measured (§1.5): a real headless Chrome from this egress gets the **same wall** as curl
// (189,954 B vs 189,908 B — the same page with a client hint appended), and `/login/`
// returns 0 password inputs even to that browser. So the browser is not an escape hatch
// around the refusal. Its value is being the only component on the box whose TLS
// fingerprint is genuinely a browser's, and the only one that can hold a session where the
// login surface *is* served (§4.4).
//
// That makes this channel a **transport** rather than a parser: it navigates the same
// `.json` URLs the session route uses and hands the body back, so `parse-json.ts` stays the
// single description of what a Listing looks like. Driving the browser is the
// `session-mint` sidecar's job (§4.3.4) — a separate process this layer consumes as a
// file — so the standing condition here is "no bridge wired", which is true, checkable, and
// reported once instead of failing every request inside a query.

import { CAPABILITIES } from "./channel.ts";
import type { Availability, RedditChannel } from "./channel.ts";
import { BUCKET_LIMITS } from "./budget.ts";
import { probeBrowser } from "./transport.ts";
import type { DependencyProbe, HttpRequest, HttpResponse } from "./transport.ts";
import type { Capability, Envelope, FetchOpts, HitList, RawThread, ScopedQuery } from "./types.ts";
import { parseJsonHits, parseJsonThread } from "./parse-json.ts";
import { redditTimeParam, withinWindow } from "./json.ts";

export const BROWSER_BASE = "https://www.reddit.com";

/** One navigation. The bridge owns the profile and its cookies, so no cookie header is
 *  built here: a browser profile is part of the identity tuple and two processes sharing
 *  one `user_data_dir` corrupt it (§3.2). */
export interface BrowserBridge {
	readonly id: string;
	availability(): Availability;
	navigate(request: HttpRequest): Promise<HttpResponse>;
}

export interface BrowserOptions {
	readonly bridge?: BrowserBridge | null;
	readonly base?: string;
	readonly now?: () => number;
	/** Injected so the standing diagnostic is testable without touching the box. */
	readonly dependencyProbe?: DependencyProbe;
}

export class BrowserChannel implements RedditChannel {
	readonly id = "browser" as const;
	readonly capabilities: ReadonlySet<Capability> = CAPABILITIES.browser;
	readonly budget = BUCKET_LIMITS.browser ?? { capacity: 1, refillPerSec: 1 / 6.5, basis: "unmeasured" };
	private readonly bridge: BrowserBridge | null;
	private readonly base: string;
	private readonly now: () => number;
	private readonly standing: Availability;

	constructor(options: BrowserOptions = {}) {
		this.bridge = options.bridge ?? null;
		this.base = options.base ?? BROWSER_BASE;
		this.now = options.now ?? Date.now;
		this.standing = this.bridge === null ? probeBrowser(options.dependencyProbe) : this.bridge.availability();
	}

	availability(): Availability {
		return this.standing;
	}

	async search(query: ScopedQuery, opts: FetchOpts): Promise<Envelope<HitList>> {
		const subreddit = query.subreddits[0];
		const params = new URLSearchParams({ q: query.phrase, sort: query.sort, limit: String(Math.min(query.limit, 100)), raw_json: "1" });
		params.set("restrict_sr", subreddit === undefined ? "0" : "1");
		const time = redditTimeParam(query.window);
		if (time !== null) params.set("t", time);
		if (query.after !== null) params.set("after", query.after);
		const path = subreddit === undefined ? "/search.json" : `/r/${encodeURIComponent(subreddit)}/search.json`;

		const sent = await this.navigate(`${this.base}${path}?${params.toString()}`, opts.deadlineAt);
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
		const limit = Math.min(opts.limit ?? 100, 100);
		const params = new URLSearchParams({ limit: String(limit), raw_json: "1" });
		const sent = await this.navigate(`${this.base}/comments/${encodeURIComponent(postId)}.json?${params.toString()}`, opts.deadlineAt);
		if (!sent.ok) return sent.envelope;

		const fetchedAtUtc = Math.floor(this.now() / 1000);
		const parsed = parseJsonThread(sent.response.text, { postId, fetchedAtUtc, limit });
		if (!parsed.ok) {
			// A rendered search or thread page is HTML, and turning HTML into a thread is the
			// sidecar's job, not this layer's. Saying so beats a parse error that looks like a
			// shape change.
			return { kind: "error", code: "parse", channel: this.id, detail: `the bridge returned a body that is not a Listing (${sent.response.bytes} B): rendered HTML is the session-mint sidecar's job (§4.4), not this layer's` };
		}
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

	get identityId(): string {
		return this.bridge === null ? "browser:no-bridge" : this.bridge.id;
	}

	private async navigate(url: string, deadlineAt: number): Promise<{ readonly ok: true; readonly response: HttpResponse; readonly wallMs: number } | { readonly ok: false; readonly envelope: Envelope<never> }> {
		if (this.bridge === null || !this.standing.available) {
			return { ok: false, envelope: { kind: "unavailable", channel: this.id, detail: this.standing.detail } };
		}
		const started = this.now();
		try {
			const response = await this.bridge.navigate({ url, timeoutMs: Math.max(1_000, deadlineAt - started) });
			return { ok: true, response, wallMs: this.now() - started };
		} catch (error) {
			return { ok: false, envelope: { kind: "error", code: "transport", channel: this.id, detail: error instanceof Error ? error.message : String(error) } };
		}
	}
}
