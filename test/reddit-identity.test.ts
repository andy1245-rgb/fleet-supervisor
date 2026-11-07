// The credential plane and the two routes that depend on things this box does not have.
//
// This is where the "degrades cleanly" requirement is actually enforced. `curl_cffi` is the
// identified fix for the plain-HTTP wall (headers demonstrably do not pass, §1.2) and it is
// not installed here — so the `.json` route must report a standing condition with a reason,
// cost zero requests, and never turn into a retry loop. Same for the browser bridge, whose
// driver is a separate process this layer does not spawn.

import assert from "node:assert/strict";
import { test } from "node:test";
import { JsonChannel } from "../src/channels/reddit/json.ts";
import { BrowserChannel } from "../src/channels/reddit/browser.ts";
import type { BrowserBridge } from "../src/channels/reddit/browser.ts";
import { cookieHeader, loadIdentity, parseNetscapeJar, probeOutcome } from "../src/channels/reddit/identity.ts";
import type { IdentitySpec, SessionIdentity } from "../src/channels/reddit/identity.ts";
import { CHROME_PATH, probeBrowser, probeCurlCffi } from "../src/channels/reddit/transport.ts";
import type { DependencyProbe, HttpResponse, Transport } from "../src/channels/reddit/transport.ts";
import { FIXTURES, fixture } from "../src/channels/reddit/fixtures.ts";
import type { ScopedQuery } from "../src/channels/reddit/types.ts";

const T0 = 1_790_000_000_000;
const NOW_SEC = Math.floor(T0 / 1000);

function response(init: { status: number; body?: string; headers?: Record<string, string> }): HttpResponse {
	const body = init.body ?? "";
	return { status: init.status, headers: init.headers ?? {}, bytes: Buffer.byteLength(body, "utf8"), text: body, wallMs: 3 };
}

function probe(deps: { curl_cffi?: boolean; nodriver?: boolean; chrome?: boolean }): DependencyProbe {
	return {
		hasPythonModule: (module) => (module === "curl_cffi" ? (deps.curl_cffi ?? false) : module === "nodriver" ? (deps.nodriver ?? false) : false),
		hasFile: (path) => path === CHROME_PATH && (deps.chrome ?? false),
	};
}

const JAR = [
	"# Netscape HTTP Cookie File",
	"#HttpOnly_.reddit.com\tTRUE\t/\tTRUE\t2000000000\treddit_session\ts%3Dabc%3Ddef",
	".reddit.com\tTRUE\t/\tTRUE\t2000000000\ttoken_v2\ttok123",
	".reddit.com\tTRUE\t/\tTRUE\t1000000000\tstale_one\texpired",
	".example.com\tTRUE\t/\tTRUE\t2000000000\ttracker\tnope",
	"www.reddit.com\tFALSE\t/\tFALSE\t0\tsession_tracker\tabc",
].join("\n");

const SPEC: IdentitySpec = { account: "researcher", egress: "direct", ua: "Mozilla/5.0 (X11; Linux x86_64) Chrome/131.0.0.0 Safari/537.36", tlsProfile: "chrome131", cookieFile: "/tmp/jar.txt", mintedAtUtc: (NOW_SEC - 3_600) * 1000, lastGoodAtUtc: null };

const QUERY: ScopedQuery = { phrase: "krytox 205g0 worth it", subreddits: [], sort: "relevance", window: null, limit: 25, after: null };
const OPTS = { deadlineAt: T0 + 90_000 };

// ------------------------------------------------------------------ dependency probes

test("curl_cffi absence is a diagnostic, not an error", () => {
	const missing = probeCurlCffi(probe({}));
	assert.equal(missing.available, false);
	// The detail has to say *why* TLS impersonation is the identified fix, or the next reader
	// re-tries the header set that is measured not to pass.
	assert.match(missing.detail, /curl_cffi is not importable/);
	assert.match(missing.detail, /TLS impersonation/);
	assert.match(missing.detail, /189,908 B branded wall/);
	assert.match(missing.detail, /does not install it/);

	assert.equal(probeCurlCffi(probe({ curl_cffi: true })).available, true);
});

test("the browser bridge is reported as unwired rather than unavailable-in-general", () => {
	const present = probeBrowser(probe({ nodriver: true, chrome: true }));
	assert.equal(present.available, false);
	assert.match(present.detail, /no bridge is wired/);
	assert.match(present.detail, /session-mint sidecar/);

	const absent = probeBrowser(probe({}));
	assert.equal(absent.available, false);
	assert.match(absent.detail, /nodriver/);
});

// ------------------------------------------------------------------ the .json route

test("the .json route with no transport is not a candidate, and costs nothing to ask", async () => {
	const channel = new JsonChannel({ dependencyProbe: probe({}) });
	const availability = channel.availability();
	assert.equal(availability.available, false);
	assert.match(availability.detail, /curl_cffi is not importable/);

	// Both call paths return an `unavailable` envelope rather than throwing, so the router can
	// classify it once and drop the route from the candidate list.
	const searched = await channel.search(QUERY, OPTS);
	assert.equal(searched.kind, "unavailable");
	assert.equal((await channel.fetchThread("1tld3qq", OPTS)).kind, "unavailable");
});

test("a witness transport with no credential is still not usable", () => {
	const transport: Transport = () => Promise.resolve(response({ status: 200, body: "{}" }));
	const channel = new JsonChannel({ transport, dependencyProbe: probe({ curl_cffi: true }) });
	assert.equal(channel.availability().available, false);
	// Two standing conditions with two different remedies, reported separately: bridge the
	// transport, or import a session that was minted where the login surface is served.
	assert.match(channel.availability().detail, /no session and no bearer token/);
});

test("a cookie session over a witness transport parses and reports its identity", async () => {
	const identity: SessionIdentity = { account: "researcher", egress: "direct", ua: SPEC.ua, cookie: "reddit_session=abc", cookieNames: ["reddit_session"], mintedAtUtc: SPEC.mintedAtUtc, lastGoodAtUtc: null };
	const calls: { url: string; headers: Record<string, string> | undefined }[] = [];
	const transport: Transport = (request) => {
		calls.push({ url: request.url, headers: request.headers });
		const listing = {
			kind: "Listing",
			data: {
				after: null,
				children: [
					{ kind: "t3", data: { id: "abc", subreddit: "MechanicalKeyboards", title: "Is expensive lube worth it?", score: 88, num_comments: 412, created_utc: NOW_SEC - 86_400, author: "x", permalink: "/r/MechanicalKeyboards/comments/abc/x/", over_18: false, removed_by_category: null } },
					{ kind: "t3", data: { id: "old", subreddit: "olkb", title: "From 2019", score: 5, num_comments: 2, created_utc: NOW_SEC - 400 * 86_400, author: "y", permalink: "/r/olkb/comments/old/y/", over_18: false, removed_by_category: null } },
				],
			},
		};
		return Promise.resolve(response({ status: 200, body: JSON.stringify(listing) }));
	};
	const channel = new JsonChannel({ transport, identity, now: () => T0 });
	assert.equal(channel.availability().available, true);
	assert.equal(channel.identityId, "json:researcher");

	const run = await channel.search({ ...QUERY, window: { kind: "relative", span: "1y" } }, OPTS);
	assert.equal(run.kind, "ok");
	if (run.kind !== "ok") return;
	// The window is applied client-side as well as on the wire, so a `t` that is too broad can
	// never silently turn a 1-year question into a 5-year answer.
	assert.deepEqual(run.value.hits.map((hit) => hit.postId), ["abc"]);
	assert.match(calls[0]?.url ?? "", /\/search\.json\?/);
	assert.match(calls[0]?.url ?? "", /restrict_sr=0/);
	assert.match(calls[0]?.url ?? "", /t=year/);
	// The cookie travels; the account name travels in the envelope; the cookie value does not
	// appear anywhere a record could print it.
	assert.equal(calls[0]?.headers?.["cookie"], "reddit_session=abc");
	assert.equal(calls[0]?.headers?.["user-agent"], identity.ua);
});

test(".json failures map to the four shapes the router knows", async () => {
	const dead: Transport = () => Promise.resolve(response({ status: 302, headers: { location: "https://www.reddit.com/login/?reason=lor2" } }));
	const channel = new JsonChannel({
		transport: dead,
		identity: { account: "a", egress: "direct", ua: SPEC.ua, cookie: "reddit_session=abc", cookieNames: ["reddit_session"], mintedAtUtc: 0, lastGoodAtUtc: null },
	});
	const run = await channel.fetchThread("1tld3qq", OPTS);
	assert.equal(run.kind, "dead-session");
});

// ------------------------------------------------------------------ the browser route

test("the browser route without a bridge is unavailable, with the sidecar named", async () => {
	const channel = new BrowserChannel({ dependencyProbe: probe({ nodriver: true, chrome: true }) });
	assert.equal(channel.availability().available, false);
	const run = await channel.fetchThread("1tld3qq", OPTS);
	assert.equal(run.kind, "unavailable");
	if (run.kind === "unavailable") assert.match(run.detail, /session-mint sidecar/);
});

test("a witness bridge drives the same .json URLs and the same parser", async () => {
	const requested: string[] = [];
	const bridge: BrowserBridge = {
		id: "browser:test-profile",
		availability: () => ({ available: true, detail: "test bridge" }),
		navigate: (request) => {
			requested.push(request.url);
			return Promise.resolve(response({ status: 200, body: fixture(FIXTURES.jsonThread) }));
		},
	};
	const channel = new BrowserChannel({ bridge, now: () => T0 });
	const run = await channel.fetchThread("1tld3qq", OPTS);
	assert.equal(run.kind, "ok");
	if (run.kind !== "ok") return;
	assert.match(requested[0] ?? "", /\/comments\/1tld3qq\.json\?limit=100/);
	assert.equal(run.value.comments.length, 5);
	// The bridge owns the profile and its cookies: a browser identity is part of the tuple and
	// two processes sharing one profile corrupt it, so no cookie header is built here.
	assert.equal(run.value.identity, "browser:test-profile");
	assert.equal(run.value.collapsed, 10);
});

test("a rendered HTML page is reported as the sidecar's job, not as a parse bug", async () => {
	const bridge: BrowserBridge = { id: "browser:test", availability: () => ({ available: true, detail: "ok" }), navigate: () => Promise.resolve(response({ status: 200, body: "<html><body>a rendered thread</body></html>" })) };
	const run = await new BrowserChannel({ bridge }).fetchThread("1tld3qq", OPTS);
	assert.equal(run.kind, "error");
	if (run.kind === "error") {
		assert.equal(run.code, "parse");
		assert.match(run.detail, /sidecar/);
	}
});

// ------------------------------------------------------------------ the cookie jar

test("a Netscape jar drops non-reddit and expired cookies, and keeps the HttpOnly session", () => {
	const cookies = parseNetscapeJar(JAR);
	// `#HttpOnly_` is a comment that is not a comment: dropping it would drop the one cookie
	// that matters.
	assert.ok(cookies.some((cookie) => cookie.name === "reddit_session"));
	assert.equal(cookies.filter((cookie) => cookie.name === "tracker").length, 1);

	const header = cookieHeader(cookies, NOW_SEC * 1000);
	assert.match(header, /reddit_session=/);
	assert.match(header, /token_v2=/);
	assert.match(header, /session_tracker=/);
	assert.ok(!header.includes("stale_one"), "an expired cookie must not be sent");
	assert.ok(!header.includes("tracker=nope"), "a cookie for another site is not a reddit cookie");
});

test("an anonymous browser jar is diagnosed by naming the cookies it has", () => {
	// Measured: a fresh headless Chrome mints exactly `csv` and `edgebucket` and no session (§1.5).
	const anonymous = ".reddit.com\tTRUE\t/\tTRUE\t2000000000\tcsv\tabc\n.reddit.com\tTRUE\t/\tTRUE\t2000000000\tedgebucket\tdef";
	const loaded = loadIdentity(SPEC, { exists: () => true, read: () => anonymous, now: NOW_SEC * 1000 });
	assert.equal(loaded.ok, false);
	if (loaded.ok) return;
	assert.match(loaded.detail, /no reddit_session \(found: csv, edgebucket\)/);
	assert.match(loaded.detail, /until an account authenticates/);
});

test("a missing jar and a dead session are different diagnostics", () => {
	const missing = loadIdentity(SPEC, { exists: () => false, now: NOW_SEC * 1000 });
	assert.equal(missing.ok, false);
	if (!missing.ok) assert.match(missing.detail, /no cookie jar at/);

	// A jar whose session expired is present but unusable, and saying so points at the fix.
	const expired = "#HttpOnly_.reddit.com\tTRUE\t/\tTRUE\t1000000000\treddit_session\tgone";
	const loaded = loadIdentity(SPEC, { exists: () => true, read: () => expired, now: NOW_SEC * 1000 });
	assert.equal(loaded.ok, false);
	if (!loaded.ok) assert.match(loaded.detail, /has expired/);

	const good = loadIdentity(SPEC, { exists: () => true, read: () => JAR, now: NOW_SEC * 1000 });
	assert.equal(good.ok, true);
	if (good.ok) {
		assert.equal(good.identity.account, "researcher");
		// The value never leaves the identity object, and the diagnostic list is names only.
		assert.ok(good.identity.cookieNames.includes("reddit_session"));
	}
});

// ------------------------------------------------------------------ the one-request probe

test("the four probe outcomes each name a different remedy", () => {
	// §4.3.5, in the order the shapes are measured today.
	const ok = probeOutcome(response({ status: 200, body: '{"data":[]}' }));
	assert.equal(ok.kind, "ok");

	const branded = probeOutcome(response({ status: 403, body: "x".repeat(189_908) }));
	assert.equal(branded.kind, "address-bound");
	assert.match(branded.detail, /pin the identity there/);

	const plain = probeOutcome(response({ status: 403, body: "x".repeat(1_522) }));
	assert.equal(plain.kind, "credential-rejected");
	assert.match(plain.detail, /expired/);

	const redirect = probeOutcome(response({ status: 302, headers: { location: "https://www.reddit.com/login/?reason=lor2" } }));
	assert.equal(redirect.kind, "no-session");

	// A 200 that is not JSON means the route answered something else, and must not be read as
	// a working session.
	assert.equal(probeOutcome(response({ status: 200, body: "<html></html>" })).kind, "other");
});
