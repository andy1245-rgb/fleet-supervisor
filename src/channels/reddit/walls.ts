// Reddit's refusals are not one thing, and which one you got is a diagnosis.
//
// Measured from this egress on 2026-10-27 (spec §1.1), all three on www.reddit.com:
//
//   shape            status  bytes      what it is
//   ---------------- ------- ---------- ------------------------------------------
//   branded wall     403     189,908    this client class is refused on this route
//                                       class ("You've been blocked by network
//                                       security"). A real headless Chrome gets the
//                                       same page 46 B larger, so this is not a
//                                       header or JS problem (§1.5).
//   plain `Blocked`  403     1,522      same refusal on an API-shaped route with a
//                                       non-JS body. Appeared exactly when an
//                                       `Authorization` header was present, so the
//                                       first hypothesis is a wrong credential path,
//                                       not a dead egress (§3.4).
//   empty            429     0          rate bucket empty; `x-ratelimit-reset` is
//                                       authoritative and says when it refills.
//
// The byte count is the discriminator between the first two — both are 403 and no
// response header distinguishes them. So the bands are wide (100 KB) around a
// measurement that came in twice at ~190 KB, rather than an exact match on 189,908:
// the Chromium variant is 189,954 and a re-render will move it again.

/** The three measured refusal shapes. A 429 is a shape, not a wall: it is the one
 *  refusal that says "come back", so it gets its own envelope kind. */
export type WallShape = "branded" | "plain" | "login-redirect";

/** The consequence. Three shapes, three consequences, and they differ in what they
 *  blame: the identity, the transport, or the clock. */
export type Diagnosis = "blocked" | "challenged" | "rate-limited";

/** Body size at or above this on a 403 is the branded wall. Measured 189,908 B (curl)
 *  and 189,954 B (Chrome); every API-shaped refusal measured 1,522 B. */
export const BRANDED_WALL_FLOOR_BYTES = 100_000;

/** `old.reddit.com/...json` 302s to `/login/`; `.json` with a dead cookie does the
 *  same on www. Following the redirect lands on a wall, so the Location is read and
 *  the redirect is not followed (§4.3.3). */
export const LOGIN_REDIRECT_PATTERN = /\/login(?:[/?#]|$)/i;

export type Verdict =
	| { readonly kind: "served" }
	| { readonly kind: "refused"; readonly shape: WallShape; readonly diagnosis: Diagnosis; readonly bodyBytes: number; readonly detail: string }
	| { readonly kind: "throttled"; readonly diagnosis: "rate-limited"; readonly bodyBytes: number; readonly detail: string }
	| { readonly kind: "failed"; readonly status: number; readonly bodyBytes: number; readonly detail: string };

/** Classify one response by the only two things that reliably identify it: status and
 *  body size. `location` is needed only for the redirect case. */
export function classify(status: number, bodyBytes: number, location: string | null = null): Verdict {
	if (status >= 200 && status < 300) return { kind: "served" };

	if (status === 302 || status === 301 || status === 303 || status === 307) {
		if (location !== null && LOGIN_REDIRECT_PATTERN.test(location)) {
			return {
				kind: "refused",
				shape: "login-redirect",
				diagnosis: "challenged",
				bodyBytes,
				detail: `HTTP ${status} → ${location}: the web session is gone; do not follow it, it lands on a wall`,
			};
		}
		return { kind: "failed", status, bodyBytes, detail: `HTTP ${status} → ${location ?? "(no location)"}` };
	}

	if (status === 429) {
		// `x-ratelimit-remaining` reads 0.0 even on a 200 for the RSS bucket, so a 429
		// here is not "you used more than you thought" — it is the bucket, full stop.
		return { kind: "throttled", diagnosis: "rate-limited", bodyBytes, detail: `HTTP 429, ${bodyBytes} B body` };
	}

	if (status === 403 && bodyBytes >= BRANDED_WALL_FLOOR_BYTES) {
		return {
			kind: "refused",
			shape: "branded",
			diagnosis: "blocked",
			bodyBytes,
			detail: `HTTP 403 branded wall, ${bodyBytes} B: this egress/client class is refused on this route class — route around it, do not retry it`,
		};
	}

	if (status === 403) {
		return {
			kind: "refused",
			shape: "plain",
			diagnosis: "challenged",
			bodyBytes,
			detail: `HTTP 403 plain block, ${bodyBytes} B: the request was seen and rejected on credential/fingerprint grounds — escalate the transport before blaming the egress`,
		};
	}

	return { kind: "failed", status, bodyBytes, detail: `HTTP ${status}, ${bodyBytes} B body` };
}

/** What a diagnosis costs. `rate-limited` never touches identity health, because a
 *  full bucket is a clock, not a judgement about who is asking (§3.4). */
export const DIAGNOSIS_EFFECT: Readonly<Record<Diagnosis, { readonly action: "quarantine-identity" | "escalate-transport" | "wait-next-eligible"; readonly holdMs: number }>> = {
	// 15 min on (identity, channel): long enough that the pipeline stops spending the
	// egress on a refused route, short enough that a transient edge decision heals.
	blocked: { action: "quarantine-identity", holdMs: 15 * 60_000 },
	// Escalate curl → curl_cffi → browser on the *same* identity first (§5.5 case 5).
	// When the stronger transport is absent the escalation is not possible, and the
	// caller gets `unavailable` with that reason instead of a silent 10-minute nap.
	challenged: { action: "escalate-transport", holdMs: 0 },
	"rate-limited": { action: "wait-next-eligible", holdMs: 0 },
};
