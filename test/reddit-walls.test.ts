// The three measured refusal shapes and what each one costs.
//
// Every byte count here is from the specification's measurement table (§1.1), and the
// point of the test is that the *diagnosis* differs, not that the parsing does: a 403 with
// a 190 KB body and a 403 with a 1.5 KB body are the same status code and different facts
// about who is asking, and a 429 is neither of them.

import assert from "node:assert/strict";
import { test } from "node:test";
import { BRANDED_WALL_FLOOR_BYTES, DIAGNOSIS_EFFECT, classify } from "../src/channels/reddit/walls.ts";

test("the branded wall is 403 with the full HTML body, and it blames the identity", () => {
	const verdict = classify(403, 189_908);
	assert.equal(verdict.kind, "refused");
	if (verdict.kind !== "refused") return;
	assert.equal(verdict.shape, "branded");
	assert.equal(verdict.diagnosis, "blocked");
	// The measured Chromium variant is 46 B larger — the same page with a client hint — and
	// must classify identically, which is why the discriminator is a band and not the literal.
	const chromium = classify(403, 189_954);
	assert.equal(chromium.kind, "refused");
	if (chromium.kind === "refused") assert.equal(chromium.shape, "branded");
});

test("the plain block is 403 with a small body, and it blames the transport first", () => {
	const verdict = classify(403, 1_522);
	assert.equal(verdict.kind, "refused");
	if (verdict.kind !== "refused") return;
	assert.equal(verdict.shape, "plain");
	assert.equal(verdict.diagnosis, "challenged");
	// §5.5 case 5: escalate curl → curl_cffi → browser on the same identity before retiring it.
	assert.match(verdict.detail, /escalate the transport/);
});

test("the 403 band boundary is the only thing separating the two walls", () => {
	const below = classify(403, BRANDED_WALL_FLOOR_BYTES - 1);
	const at = classify(403, BRANDED_WALL_FLOOR_BYTES);
	assert.equal(below.kind === "refused" ? below.shape : null, "plain");
	assert.equal(at.kind === "refused" ? at.shape : null, "branded");
});

test("a 429 is a clock, not a wall and not an identity problem", () => {
	const verdict = classify(429, 0);
	assert.equal(verdict.kind, "throttled");
	if (verdict.kind !== "throttled") return;
	assert.equal(verdict.diagnosis, "rate-limited");
	// The consequence is the thing being tested: a full bucket must not quarantine the
	// identity, because then a healthy 60 s channel is out of service for 15 minutes.
	assert.equal(DIAGNOSIS_EFFECT["rate-limited"].action, "wait-next-eligible");
	assert.equal(DIAGNOSIS_EFFECT["rate-limited"].holdMs, 0);
	assert.equal(DIAGNOSIS_EFFECT.blocked.action, "quarantine-identity");
	assert.equal(DIAGNOSIS_EFFECT.blocked.holdMs, 15 * 60_000);
	assert.equal(DIAGNOSIS_EFFECT.challenged.action, "escalate-transport");
});

test("a 302 to /login is a dead session, and any other 302 is not", () => {
	const login = classify(302, 0, "https://www.reddit.com/login/?reason=lor2");
	assert.equal(login.kind, "refused");
	if (login.kind === "refused") {
		assert.equal(login.shape, "login-redirect");
		assert.match(login.detail, /do not follow it/);
	}
	const elsewhere = classify(302, 0, "https://www.reddit.com/r/MechanicalKeyboards/");
	assert.equal(elsewhere.kind, "failed");
});

test("served and unclassified statuses", () => {
	for (const status of [200, 204, 299]) assert.equal(classify(status, 100).kind, "served");
	assert.equal(classify(401, 41).kind, "failed");
	assert.equal(classify(500, 100).kind, "failed");
	assert.equal(classify(400, 56).kind, "failed");
});
