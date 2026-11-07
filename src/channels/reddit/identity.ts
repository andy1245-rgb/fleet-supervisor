// The credential plane for the `.json` route, and the one-request test that decides
// whether an imported session is usable.
//
// The measured fact this file exists for (spec §1.2): `/login/` returns the 189,954 B
// branded wall **to a real headless Chrome from this egress**, and `/api/login` is walled
// to curl. So a `reddit_session` cannot be created here at all — it has to be minted where
// the login surface is served and imported. Minting is therefore a different machine and a
// different process, and this file's contract is deliberately dumb: read a jar, build a
// header, spend exactly one request telling the operator which of four things happened.
//
// Nothing here logs, prints or returns a cookie value. A diagnostic names the cookies that
// were found, never their contents — a session token in a log line is a session token in
// whatever reads the log next.

import { existsSync, readFileSync } from "node:fs";
import type { HttpResponse } from "./transport.ts";
import { classify } from "./walls.ts";

/** §4.3.4. Pinned to one egress because a cookie minted under one address and used from
 *  another is the classic signal of a stolen session (§3.1), and because the identity's
 *  components must never be mixed. */
export interface IdentitySpec {
	readonly account: string;
	readonly egress: string;
	/** Must agree with `tlsProfile`'s Chrome version: a chrome131 fingerprint behind a
	 *  Chrome 156 UA is an inconsistency with no honest explanation (§4.5). */
	readonly ua: string;
	readonly tlsProfile: string;
	readonly cookieFile: string;
	readonly mintedAtUtc: number;
	readonly lastGoodAtUtc: number | null;
}

export interface JarCookie {
	readonly domain: string;
	readonly name: string;
	readonly value: string;
	readonly expiresAtUtc: number | null;
}

export interface SessionIdentity {
	readonly account: string;
	readonly egress: string;
	readonly ua: string;
	readonly cookie: string;
	readonly cookieNames: readonly string[];
	readonly mintedAtUtc: number;
	readonly lastGoodAtUtc: number | null;
}

/** Name only. Everything a diagnostic is allowed to say about a credential. */
export const SESSION_COOKIE = "reddit_session";

/** Netscape cookie jar → cookies.
 *
 *  Seven tab-separated fields, `#` comment lines, and the one comment that is not a
 *  comment: an HttpOnly cookie is written as `#HttpOnly_<domain>` and dropping it because
 *  it starts with `#` would drop exactly the cookie that matters. */
export function parseNetscapeJar(text: string): readonly JarCookie[] {
	const cookies: JarCookie[] = [];
	for (const line of text.split(/\r?\n/)) {
		const trimmed = line.trim();
		if (trimmed === "") continue;
		const httpOnly = trimmed.startsWith("#HttpOnly_");
		if (trimmed.startsWith("#") && !httpOnly) continue;
		const fields = (httpOnly ? trimmed.slice("#HttpOnly_".length) : trimmed).split("\t");
		if (fields.length < 7) continue;
		const [domain, , , , expiry, name, value] = fields;
		if (domain === undefined || name === undefined || value === undefined) continue;
		const expires = expiry === undefined ? Number.NaN : Number.parseInt(expiry, 10);
		cookies.push({ domain, name, value, expiresAtUtc: Number.isFinite(expires) && expires > 0 ? expires * 1000 : null });
	}
	return cookies;
}

/** The `Cookie` header for a reddit request: only cookies that are still alive and only
 *  ones scoped to reddit. A jar exported from a browser also holds cookies for every other
 *  site that browser visited, and sending them is both noise and a fingerprint. */
export function cookieHeader(cookies: readonly JarCookie[], now: number): string {
	return cookies
		.filter((cookie) => /(^|\.)reddit\.com$/i.test(cookie.domain))
		.filter((cookie) => cookie.expiresAtUtc === null || cookie.expiresAtUtc > now)
		.map((cookie) => `${cookie.name}=${cookie.value}`)
		.join("; ");
}

export type IdentityLoad = { readonly ok: true; readonly identity: SessionIdentity } | { readonly ok: false; readonly detail: string };

/** Spec + jar file → a usable identity, or the reason there is none.
 *
 *  Every failure here is a standing condition, not a request outcome: the route reports
 *  `unavailable` and the router stops offering it, so a missing cookie file costs nothing
 *  per query. */
export function loadIdentity(spec: IdentitySpec, deps: { readonly exists?: (path: string) => boolean; readonly read?: (path: string) => string; readonly now?: number } = {}): IdentityLoad {
	const exists = deps.exists ?? existsSync;
	const read = deps.read ?? ((path: string) => readFileSync(path, "utf8"));
	const now = deps.now ?? Date.now();

	if (!exists(spec.cookieFile)) return { ok: false, detail: `no cookie jar at ${spec.cookieFile}: the .json route has no credential, so it is not a candidate (§2.3 no-session mode)` };

	const cookies = parseNetscapeJar(read(spec.cookieFile));
	const names = cookies.map((cookie) => cookie.name);
	if (!names.includes(SESSION_COOKIE)) {
		// The measured shape of an anonymous browser: it mints `csv` and `edgebucket` and
		// no session until an account authenticates (§1.5). Naming them makes the mistake
		// "exported the jar from a browser that was not logged in" self-evident.
		return { ok: false, detail: `cookie jar has no ${SESSION_COOKIE} (found: ${names.length === 0 ? "none" : names.join(", ")}): an anonymous browser session holds no session cookie until an account authenticates (§1.5)` };
	}

	const header = cookieHeader(cookies, now);
	if (header === "") return { ok: false, detail: `cookie jar holds ${SESSION_COOKIE} but it has expired (minted ${new Date(spec.mintedAtUtc).toISOString()}): re-mint where the login surface is served` };

	return {
		ok: true,
		identity: { account: spec.account, egress: spec.egress, ua: spec.ua, cookie: header, cookieNames: names, mintedAtUtc: spec.mintedAtUtc, lastGoodAtUtc: spec.lastGoodAtUtc },
	};
}

export type ProbeOutcome =
	| { readonly kind: "ok"; readonly detail: string }
	/** 403 branded: the cookie was minted elsewhere and is bound to that address. */
	| { readonly kind: "address-bound"; readonly detail: string }
	/** 403 plain: the credential was seen and not accepted — expired, not stolen. */
	| { readonly kind: "credential-rejected"; readonly detail: string }
	/** 302 `/login`: there is no session at all. */
	| { readonly kind: "no-session"; readonly detail: string }
	| { readonly kind: "other"; readonly detail: string };

/** §4.3.5's four outcomes, in the order they must be tested.
 *
 *  This is the whole value of the credential plane in one function: minting off-egress and
 *  using here might work, and the only way to find out is a single request rather than a
 *  query that half-fails. Each outcome names a different remedy — pin the identity to its
 *  minting egress, re-mint, or enable it — so they must not be collapsed into "403". */
export function probeOutcome(response: HttpResponse): ProbeOutcome {
	const location = response.headers["location"] ?? "";
	if (response.status >= 200 && response.status < 300) {
		if (response.text.trimStart().startsWith("{") || response.text.trimStart().startsWith("[")) {
			return { kind: "ok", detail: "200 + JSON: the session works from this egress" };
		}
		return { kind: "other", detail: `200 but the body is not JSON (${response.bytes} B): the route answered something else` };
	}
	if ((response.status === 301 || response.status === 302 || response.status === 307) && /\/login/i.test(location)) {
		return { kind: "no-session", detail: `HTTP ${response.status} → ${location}: no session at all; re-mint` };
	}
	if (response.status === 403) {
		const verdict = classify(response.status, response.bytes);
		if (verdict.kind === "refused" && verdict.shape === "branded") {
			return { kind: "address-bound", detail: `403 branded wall (${response.bytes} B): this cookie is bound to its minting egress — pin the identity there, never use it here` };
		}
		return { kind: "credential-rejected", detail: `403 plain block (${response.bytes} B): the credential is present but not accepted — most likely expired; re-mint` };
	}
	if (response.status === 401) return { kind: "credential-rejected", detail: "HTTP 401: the token is not accepted; refresh once, then retire the credential" };
	return { kind: "other", detail: `HTTP ${response.status} (${response.bytes} B): not one of the four probe outcomes` };
}
