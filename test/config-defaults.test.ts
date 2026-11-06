// The three settings phase 3 changed, asserted by name rather than by reading the diff:
// the primary is the hosted model, `reasoning.effort` is `low` and never `none` by
// default, and one decision call is allowed 90 s.
//
// The wire assertions stub `globalThis.fetch`, so nothing here needs a key, a credential
// or a network: what is being pinned is the body and the deadline the adapter sends, and
// both are decided before the socket opens.

import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_TIMEOUT_MS } from "../src/decision/adapters/commandcode.ts";
import type { DecisionInput } from "../src/decision/types.ts";
import { DEFAULT_EFFORT, loadConfig, normalizeEffort } from "../src/manager/config.ts";
import { buildLadderModels, buildModel } from "../src/manager/tick.ts";

const INPUT: DecisionInput = {
	paneId: "p1",
	cwd: "/home/operator/work/fleet-supervisor",
	status: "idle",
	title: "pi",
	intent: "",
	phase: "unknown",
	claimState: "unknown",
	last: "",
	idleTicks: 1,
	tail: "",
};

/** Runs `fn` with a stubbed fetch and the two credential env vars pinned, restoring all
 *  four afterwards. The stub never reaches a socket. */
async function withFetch<T>(stub: typeof fetch, fn: () => Promise<T>, env: Record<string, string> = {}): Promise<T> {
	const realFetch = globalThis.fetch;
	const savedEnv = new Map(Object.keys(env).map((key) => [key, process.env[key]]));
	globalThis.fetch = stub;
	for (const [key, value] of Object.entries(env)) process.env[key] = value;
	try {
		return await fn();
	} finally {
		globalThis.fetch = realFetch;
		for (const [key, value] of savedEnv) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	}
}

function bodyOf(init: RequestInit | undefined): { reasoning: { effort: string } } {
	const body = init?.body;
	if (typeof body !== "string") throw new Error("the request body must be a string");
	return JSON.parse(body) as { reasoning: { effort: string } };
}

test("the shipped primary is the hosted model, and the escalator is unchanged", () => {
	const config = loadConfig({});
	assert.equal(config.primary, "commandcode/deepseek/deepseek-v4.1-flash");
	assert.equal(config.escalator, "z-ai/glm-5.3-flash");
});

test("AGENTFLEET_PRIMARY still overrides, and needle3 stays selectable", () => {
	assert.equal(loadConfig({ AGENTFLEET_PRIMARY: "needle3" }).primary, "needle3");
	assert.equal(loadConfig({ AGENTFLEET_PRIMARY: "openrouter:z-ai/glm-5.3-flash" }).primary, "openrouter:z-ai/glm-5.3-flash");
	// An empty string is "unset", not an override: the default stands.
	assert.equal(loadConfig({ AGENTFLEET_PRIMARY: "" }).primary, "commandcode/deepseek/deepseek-v4.1-flash");

	// The name still routes to the local engine rather than falling through to an
	// OpenRouter model, which would build happily and hide the mistake. A python path
	// that cannot exist makes the branch say so, on any machine.
	const saved = process.env.NEEDLE_PYTHON;
	process.env.NEEDLE_PYTHON = "/nonexistent/needle/python";
	try {
		assert.throws(() => buildModel("needle3"), /needle python not found/);
		assert.throws(() => buildModel("needle"), /needle python not found/);
	} finally {
		if (saved === undefined) delete process.env.NEEDLE_PYTHON;
		else process.env.NEEDLE_PYTHON = saved;
	}
});

test("the effort default is low, and no default path asks for none", async () => {
	assert.equal(DEFAULT_EFFORT, "low");
	assert.equal(loadConfig({}).effort, "low");
	assert.equal(loadConfig({ AGENTFLEET_EFFORT: "" }).effort, "low");
	// `off` is not a value this wire accepts: it is HTTP 400, so it is not passed on.
	assert.equal(normalizeEffort("off"), "low");
	assert.equal(normalizeEffort(undefined), "low");
	// `none` is legal and selectable, but only when it is asked for by name.
	assert.equal(loadConfig({ AGENTFLEET_EFFORT: "none" }).effort, "none");

	const config = loadConfig({});
	let sent: { reasoning: { effort: string } } | undefined;
	const decided = await withFetch(
		async (_url: string | URL | Request, init?: RequestInit): Promise<Response> => {
			sent = bodyOf(init);
			return new Response("stub: no socket in this test", { status: 503 });
		},
		async () => {
			const model = buildModel(config.primary, { effort: config.effort, timeoutMs: config.decisionTimeoutMs });
			return model.decide(INPUT);
		},
		{ COMMAND_CODE_API_KEY: "test-key-never-sent" },
	);
	assert.equal(decided.refused, true, "the 503 is a refusal, not a throw");
	assert.equal(sent?.reasoning.effort, "low", "the request carries the default, not the cheapest value");
});

test("a decision call is allowed 90 s, and the deadline is the config's", async () => {
	assert.equal(DEFAULT_TIMEOUT_MS, 90_000);
	assert.equal(loadConfig({}).decisionTimeoutMs, 90_000);
	assert.equal(loadConfig({ AGENTFLEET_DECISION_TIMEOUT_MS: "1500" }).decisionTimeoutMs, 1_500);
	// Garbage is not a deadline: it falls back rather than becoming 0, which would time
	// out every call before it started.
	assert.equal(loadConfig({ AGENTFLEET_DECISION_TIMEOUT_MS: "soon" }).decisionTimeoutMs, 90_000);

	// The number has to reach the adapter, not just the Config object. Built through the
	// same builder a tick uses, with the deadline small enough to wait for.
	const config = loadConfig({ AGENTFLEET_DECISION_TIMEOUT_MS: "25", AGENTFLEET_PRIMARY: "commandcode/deepseek/deepseek-v4.1-flash" });
	const decided = await withFetch(
		(_url: string | URL | Request, init?: RequestInit): Promise<Response> =>
			new Promise((_resolve, reject) => {
				init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
			}),
		async () => buildLadderModels(config).primary.decide(INPUT),
		{ COMMAND_CODE_API_KEY: "test-key-never-sent" },
	);
	assert.equal(decided.refused, true);
	assert.equal(decided.argument, "commandcode timeout after 25ms", "the config's deadline is the one enforced");
});
