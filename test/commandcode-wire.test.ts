// The wire. Every assertion here is about what leaves the socket and what the reader
// does with what comes back, because the response field names are the one thing no
// file on disk pinned before the capture in ./fixtures existed.

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { EFFORTS, accountUsage, buildRequest, commandcodeModel, decisionFrom, peakMultiplier, resolveCredential, type CommandCodeBody } from "../src/decision/adapters/commandcode.ts";
import { responsesReader, usageOf, type ResponsesOutcome } from "../src/decision/adapters/responses.ts";
import { SYSTEM } from "../src/decision/prompt.ts";
import type { DecisionInput } from "../src/decision/types.ts";
import { loadConfig } from "../src/manager/config.ts";
import { buildModel } from "../src/manager/tick.ts";

const FIXTURES = join(import.meta.dirname, "fixtures");

const INPUT: DecisionInput = {
	paneId: "w2C:p1",
	cwd: "/w/repo",
	status: "idle",
	title: "pi",
	intent: "pin the pure modules",
	phase: "implement",
	acceptance: "the mount is clean and tests pass",
	claimState: "working",
	last: "wrote test/detect.test.ts",
	idleTicks: 3,
	tail: "$ npm test\nok 187 tests",
};

const MODEL = "deepseek/deepseek-v4.1-flash";

function body(overrides: Partial<Parameters<typeof buildRequest>[1]> = {}): CommandCodeBody {
	return buildRequest(INPUT, { model: MODEL, ...overrides });
}

/** Feeds a list of `{type, ...}` events through the reader the way the transport does,
 *  one frame at a time. */
function read(events: readonly Record<string, unknown>[]): ResponsesOutcome {
	const reader = responsesReader();
	for (const event of events) reader.feed(`event: ${String(event.type)}\ndata: ${JSON.stringify(event)}\n\n`);
	return reader.finish();
}

test("the body is the responses envelope: input items, not messages", () => {
	const b = body();
	assert.equal(b.model, MODEL);
	assert.equal(b.stream, true);
	assert.equal(b.input.length, 2);

	const [system, user] = b.input;
	assert.deepEqual(system, { role: "system", content: SYSTEM });
	assert.equal(typeof system.content, "string");
	assert.equal(user.role, "user");
	const [part] = user.content;
	assert.ok(part);
	assert.deepEqual(user.content, [{ type: "input_text", text: part.text }]);
	assert.equal(part.type, "input_text");
	assert.match(part.text, /^pane: w2C:p1/m);
});

test("the body carries max_output_tokens, reasoning.effort and stream", () => {
	const b = body();
	assert.equal(b.max_output_tokens, 2048);
	assert.equal(buildRequest(INPUT, { model: MODEL, maxOutputTokens: 4096 }).max_output_tokens, 4096);
	assert.deepEqual(b.reasoning, { effort: "low", summary: "auto" });
	assert.equal(b.stream, true);
});

test("the body sends no include array, because this provider ignores the field", () => {
	// Phase 1 sent `["reasoning.encrypted_content"]` and assumed it was harmless. The
	// capture settles it: `encrypted_content` occurs 0 times in the 43 frames, the echo
	// carries no `include` field at all, and no error frame arrived — so the provider
	// neither returns the blob nor rejects the request. The blob is only useful to a
	// caller that replays reasoning items, which this adapter never does, so the field
	// is gone rather than documented as an intent the wire does not honour.
	const sent = body() as unknown as Record<string, unknown>;
	assert.equal("include" in sent, false, "an ignored field must not be in the body");
	assert.equal(JSON.stringify(sent).includes("encrypted_content"), false);
});

test("reasoning.effort is a value this provider accepts", () => {
	const legal = ["none", "minimal", "low", "medium", "high", "xhigh", "max"];
	assert.deepEqual([...EFFORTS], legal);
	for (const effort of EFFORTS) assert.equal(buildRequest(INPUT, { model: MODEL, effort }).reasoning.effort, effort);
	// `off` is the value this wire rejects with HTTP 400, so it is not in the set.
	assert.equal((EFFORTS as readonly string[]).includes("off"), false);
	// `none` is legal but it is not a decode lever: on one 145,746-byte body it cut the
	// prompt from 35,830 to 30,099 tokens by stopping the replay of reasoning items,
	// so it changes the request the model is scored on. The adapter
	// sends it as one field and nothing else moves.
	assert.deepEqual({ ...buildRequest(INPUT, { model: MODEL, effort: "none" }), reasoning: body().reasoning }, body());
});

test("the body has no completions-shaped field at all", () => {
	const b = body() as unknown as Record<string, unknown>;
	for (const forbidden of ["messages", "response_format", "instructions", "temperature", "max_tokens"]) {
		assert.equal(forbidden in b, false, `${forbidden} must not be sent`);
	}
	const serialised = JSON.stringify(b);
	assert.equal("text" in b, false, "no text.format: this wire has no output-constraint field");
	assert.equal(serialised.includes("json_object"), false);
	assert.equal(serialised.includes("json_schema"), false);
});

test("a healthy stream accumulates output text and terminates without a [DONE] sentinel", () => {
	const outcome = read([
		{ type: "response.created", response: { model: MODEL, id: "resp_1", status: "in_progress" } },
		{ type: "response.output_text.delta", delta: "{\"op\": \"leave\", " },
		{ type: "response.output_text.delta", delta: "\"argument\": \"on track\", \"confidence\": 0.9}" },
		{ type: "response.completed", response: { model: MODEL, id: "resp_1", status: "completed", usage: { input_tokens: 300, output_tokens: 12 } } },
	]);
	assert.equal(outcome.stop, "completed");
	assert.equal(outcome.text, "{\"op\": \"leave\", \"argument\": \"on track\", \"confidence\": 0.9}");
	assert.equal(outcome.unparseable, 0);
	assert.equal(outcome.model, MODEL);
});

test("a trailing [DONE] is ignored, not read as a status", () => {
	const reader = responsesReader();
	reader.feed(`event: response.output_text.delta\ndata: ${JSON.stringify({ type: "response.output_text.delta", delta: "ok" })}\n\n`);
	reader.feed("data: [DONE]\n\n");
	const outcome = reader.finish();
	assert.equal(outcome.text, "ok");
	assert.equal(outcome.stop, undefined, "a sentinel is not a terminal frame");
	assert.equal(outcome.unparseable, 0);
});

test("reasoning summary deltas are a second channel and never join the answer", () => {
	const outcome = read([
		{ type: "response.reasoning_summary_text.delta", delta: "the pane {idle}" },
		{ type: "response.output_text.delta", delta: "{\"op\":\"flag\",\"argument\":\"stuck\",\"confidence\":0.4}" },
		{ type: "response.completed", response: { model: MODEL, status: "completed" } },
	]);
	assert.equal(outcome.reasoning, "the pane {idle}");
	assert.equal(outcome.text, "{\"op\":\"flag\",\"argument\":\"stuck\",\"confidence\":0.4}");
	assert.equal(outcome.text.includes("{idle}"), false, "a summary that quotes a brace must not reach parseDecision");
});

test("reason == \"length\" is truncated, never unparseable", () => {
	const outcome = read([
		{ type: "response.output_text.delta", delta: "{\"op\": \"nudge\", \"argu" },
		{ type: "response.incomplete", response: { model: MODEL, status: "incomplete", incomplete_details: { reason: "length" }, usage: { input_tokens: 315, output_tokens: 1024, output_tokens_details: { reasoning_tokens: 900 } } } },
	]);
	assert.equal(outcome.stop, "truncated");
	assert.equal(outcome.incompleteReason, "length");

	const decision = decisionFrom(outcome, { model: MODEL, costUsd: 0, latencyMs: 1 });
	assert.equal(decision.refused, true);
	assert.equal(decision.argument, "truncated at 1024 output tokens");
	assert.notEqual(decision.argument, "model returned no JSON object");
	assert.notEqual(decision.argument, "model returned unparseable JSON");
});

test("the OpenAI spelling max_output_tokens is the same failure as length", () => {
	const outcome = read([
		{ type: "response.incomplete", response: { status: "incomplete", incomplete_details: { reason: "max_output_tokens" }, usage: { output_tokens: 64 } } },
	]);
	assert.equal(outcome.stop, "truncated");
	assert.equal(decisionFrom(outcome, { model: MODEL, costUsd: 0, latencyMs: 1 }).argument, "truncated at 64 output tokens");
});

test("a filtered turn with no message item classifies as filtered and does not throw", () => {
	// The shape R5 §5.5 records: the classifier cuts inside the reasoning channel, so
	// the stream carries reasoning items and no message item at all.
	const outcome = read([
		{ type: "response.created", response: { model: MODEL, id: "resp_cut", status: "in_progress" } },
		{ type: "response.output_item.added", output_index: 0, item: { id: "rs_1", type: "reasoning", summary: [], status: "in_progress" } },
		{ type: "response.reasoning_summary_text.delta", delta: "The agent is stuck " },
		{
			type: "response.incomplete",
			response: {
				model: MODEL,
				id: "resp_cut",
				status: "incomplete",
				output: [{ id: "rs_1", type: "reasoning", summary: [], status: "incomplete" }],
				incomplete_details: { reason: "content_filter", content_filter: { type: "OutputTextSensitiveContentDetected", details: "The request failed because the output text may contain sensitive information." } },
				usage: { input_tokens: 315, output_tokens: 40 },
			},
		},
	]);
	assert.equal(outcome.stop, "filtered");
	assert.equal(outcome.text, "");
	assert.equal(outcome.contentFilter?.type, "OutputTextSensitiveContentDetected");

	const decision = decisionFrom(outcome, { model: MODEL, costUsd: 0, latencyMs: 1 });
	assert.equal(decision.op, "flag");
	assert.equal(decision.refused, true);
	assert.equal(decision.argument, "content_filter: OutputTextSensitiveContentDetected");
});

test("a failed turn and a bare error frame both refuse with the provider's message", () => {
	const failed = read([{ type: "response.failed", response: { status: "failed", error: { code: "server_error", message: "upstream exploded" } } }]);
	assert.equal(failed.stop, "failed");
	assert.equal(decisionFrom(failed, { model: MODEL, costUsd: 0, latencyMs: 1 }).argument, "commandcode failed: upstream exploded");

	const errored = read([{ type: "error", code: "rate_limit_error", message: "You've reached your 5-hour usage limit" }]);
	assert.equal(errored.stop, "error");
	assert.match(decisionFrom(errored, { model: MODEL, costUsd: 0, latencyMs: 1 }).argument, /^commandcode error: You've reached/);
});

test("a stream that ends with no terminal frame is refused, not guessed at", () => {
	const outcome = read([{ type: "response.output_text.delta", delta: "{\"op\":" }]);
	assert.equal(outcome.stop, undefined);
	const decision = decisionFrom(outcome, { model: MODEL, costUsd: 0, latencyMs: 1 });
	assert.equal(decision.refused, true);
	assert.equal(decision.argument, "commandcode stream ended without a terminal event");
});

test("a frame that is not JSON is counted, not thrown", () => {
	const reader = responsesReader();
	reader.feed("event: proxy-notice\ndata: upstream is warming\n\n");
	reader.feed(`event: response.completed\ndata: ${JSON.stringify({ type: "response.completed", response: { status: "completed" } })}\n\n`);
	const outcome = reader.finish();
	assert.equal(outcome.unparseable, 1);
	assert.equal(outcome.stop, "completed");
});

test("a usage field the wire omitted reads as null, not as 0 and not as NaN", () => {
	const outcome = read([
		{
			type: "response.completed",
			response: { status: "completed", usage: { input_tokens: 315, output_tokens: 106, total_tokens: 421, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 30 } } },
		},
	]);
	assert.deepEqual(outcome.usage, { inputTokens: 315, outputTokens: 106, totalTokens: 421, cachedTokens: 0, cacheWriteTokens: null, reasoningTokens: 30 });
});

test("cache_write_tokens is absent from this provider's usage block, and the arithmetic reads it as 0", () => {
	// The block the capture's `response.completed` carries, verbatim: `input_tokens_details`
	// has `cached_tokens` and no `cache_write_tokens` key at all. The subtraction treats
	// the absence as "nothing was billed here" — the provider's own accounting does the
	// same — while `usage` keeps the null so the record does not claim a zero it measured.
	const usage = usageOf({ input_tokens: 315, output_tokens: 106, total_tokens: 421, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 30 } });
	assert.equal(usage?.cacheWriteTokens, null);
	const accounting = accountUsage(usage, new Date("2026-11-06T16:31:00Z"));
	assert.equal(accounting.cacheWriteTokens, 0);
	assert.equal(accounting.promptTokens, 315);
	assert.equal(accounting.costUsd, 0.00011085);
});

test("a cost that cannot be priced is null with a reason, never NaN and never a free call", () => {
	const at = new Date("2026-11-06T16:31:00Z");
	// Every one of these is reachable from `JSON.parse`: the fixture loader hands raw JSON
	// to accountUsage, and TypeScript does not check what JSON holds. Before the guard,
	// the first and second returned costUsd NaN and the tick summed the NaN into $NaN.
	const broken: [string, unknown][] = [
		["no input count", {}],
		["a non-numeric input count", { inputTokens: {}, outputTokens: 106 }],
		["no output count", { inputTokens: 315 }],
	];
	for (const [label, usage] of broken) {
		const accounting = accountUsage(usage as never, at);
		assert.equal(accounting.costUsd, null, label);
		assert.match(accounting.costReason ?? "", /usage block/, label);
		for (const value of Object.values(accounting)) assert.equal(typeof value === "number" && Number.isNaN(value), false, `${label}: ${String(value)} is NaN`);
	}
	// A non-finite number is an absence too, not a value.
	assert.equal(accountUsage({ inputTokens: Number.NaN, outputTokens: 106 } as never, at).costUsd, null);
	assert.equal(accountUsage({ inputTokens: 315, outputTokens: Number.POSITIVE_INFINITY } as never, at).promptTokens, 315);
});

test("promptTokens is the residual, not raw input_tokens", () => {
	// 10,000 in of which 9,000 were cache reads: billing raw input_tokens as prompt
	// would overbill the cached prefix by 50x (0.15 against 0.003 per million).
	const usage = { inputTokens: 10_000, outputTokens: 500, totalTokens: 10_500, cachedTokens: 9_000, cacheWriteTokens: 0, reasoningTokens: 120 };
	const accounting = accountUsage(usage, new Date("2026-11-06T16:31:00Z"));
	assert.equal(accounting.promptTokens, 1_000);
	assert.notEqual(accounting.promptTokens, usage.inputTokens);
	assert.equal(accounting.completionTokens, 500);
	assert.equal(accounting.reasoningTokens, 120);
	assert.equal(accounting.cacheReadTokens, 9_000);
	assert.equal(accounting.cacheWriteTokens, 0);
	assert.equal(accounting.costUsd, (1_000 * 0.15 + 9_000 * 0.003 + 500 * 0.6) / 1_000_000);
});

test("a cache write is subtracted too, and the residual never goes negative", () => {
	const written = accountUsage({ inputTokens: 10_000, outputTokens: 0, totalTokens: 10_000, cachedTokens: 1_000, cacheWriteTokens: 2_000, reasoningTokens: 0 }, new Date("2026-11-06T16:31:00Z"));
	assert.equal(written.promptTokens, 7_000);
	const impossible = accountUsage({ inputTokens: 10, outputTokens: 0, totalTokens: 10, cachedTokens: 10, cacheWriteTokens: 10, reasoningTokens: 0 }, new Date("2026-11-06T16:31:00Z"));
	assert.equal(impossible.promptTokens, 0);
});

test("an absent usage block reports zero tokens and a null cost with a reason", () => {
	assert.deepEqual(accountUsage(undefined, new Date("2026-11-06T16:31:00Z")), {
		promptTokens: 0,
		completionTokens: 0,
		reasoningTokens: 0,
		cacheReadTokens: 0,
		cacheWriteTokens: 0,
		costUsd: null,
		costReason: "the response carried no usage block",
	});
});

test("peak doubles on weekday 01-04 and 06-10 UTC and nowhere else", () => {
	// 2026-11-06 is a Friday.
	assert.equal(peakMultiplier(new Date("2026-11-06T00:59:00Z")), 1);
	assert.equal(peakMultiplier(new Date("2026-11-06T01:00:00Z")), 2);
	assert.equal(peakMultiplier(new Date("2026-11-06T03:59:00Z")), 2);
	assert.equal(peakMultiplier(new Date("2026-11-06T04:00:00Z")), 1);
	assert.equal(peakMultiplier(new Date("2026-11-06T06:00:00Z")), 2);
	assert.equal(peakMultiplier(new Date("2026-11-06T09:59:00Z")), 2);
	assert.equal(peakMultiplier(new Date("2026-11-06T10:00:00Z")), 1);
	assert.equal(peakMultiplier(new Date("2026-11-06T16:31:00Z")), 1);
	// 2026-11-07 is a Saturday: the same hours cost one times.
	assert.equal(peakMultiplier(new Date("2026-11-07T02:00:00Z")), 1);
	assert.equal(peakMultiplier(new Date("2026-11-07T07:00:00Z")), 1);
});

test("the fixture's own usage accounts to the documented card", () => {
	const parsed = JSON.parse(readFileSync(join(FIXTURES, "commandcode-decision.json"), "utf8")) as { usage: Parameters<typeof accountUsage>[0]; capturedAt: string; accounting: ReturnType<typeof accountUsage> };
	const accounting = accountUsage(parsed.usage, new Date(parsed.capturedAt));
	assert.deepEqual(accounting, parsed.accounting);
	assert.equal(accounting.promptTokens, 315);
	assert.equal(accounting.costUsd, 0.00011085);
});

function authFile(dir: string, name: string, contents: unknown): string {
	const path = join(dir, name);
	mkdirSync(join(path, ".."), { recursive: true });
	writeFileSync(path, JSON.stringify(contents));
	return path;
}

test("the credential comes from the env before any file", () => {
	const credential = resolveCredential({ env: { COMMAND_CODE_API_KEY: "from-env-a", COMMANDCODE_API_KEY: "from-env-b" }, authPaths: [] });
	assert.deepEqual(credential, { key: "from-env-a", from: "env:COMMAND_CODE_API_KEY" });
	assert.equal(resolveCredential({ env: { COMMANDCODE_API_KEY: "from-env-b" }, authPaths: [] }).key, "from-env-b");
});

test("inside a file the scoped commandcode.key beats the top-level apiKey", () => {
	const dir = mkdtempSync(join(tmpdir(), "cc-cred-"));
	try {
		const path = authFile(dir, "auth.json", { apiKey: "dead-legacy", authenticatedAt: "2026-11-01T00:00:00.000Z", commandcode: { type: "api", key: "live-scoped" } });
		const credential = resolveCredential({ env: {}, authPaths: [path] });
		assert.equal(credential.key, "live-scoped");
		assert.equal(credential.from, `${path}[commandcode.key]`);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a flat apiKey in an earlier file never shadows a scoped key in a later one", () => {
	// The trap as it exists on the development box: ~/.commandcode/auth.json carries
	// only a dead legacy apiKey, and the live credential is scoped in ~/.pi/agent/auth.json.
	const dir = mkdtempSync(join(tmpdir(), "cc-cred-"));
	try {
		const dead = authFile(dir, ".commandcode/auth.json", { apiKey: "dead-legacy" });
		const live = authFile(dir, ".pi/agent/auth.json", { apiKey: "also-dead", commandcode: { type: "api", key: "live-scoped" } });
		const credential = resolveCredential({ env: {}, authPaths: [dead, live] });
		assert.equal(credential.key, "live-scoped");
		assert.equal(credential.from, `${live}[commandcode.key]`);
		// With no scoped entry anywhere, the flat key is still reachable.
		assert.equal(resolveCredential({ env: {}, authPaths: [dead] }).key, "dead-legacy");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("no credential is a construction error, not a decision-time one", () => {
	assert.throws(() => resolveCredential({ env: {}, authPaths: [join(tmpdir(), "definitely-absent-auth.json")] }), /no commandcode credential/);
	const dir = mkdtempSync(join(tmpdir(), "cc-home-"));
	const previous = process.env.HOME;
	process.env.HOME = dir;
	try {
		assert.throws(() => commandcodeModel({ model: MODEL }), /no commandcode credential/);
	} finally {
		process.env.HOME = previous;
		rmSync(dir, { recursive: true, force: true });
	}
});

test("buildModel sends a commandcode/ name to the responses adapter", () => {
	const dir = mkdtempSync(join(tmpdir(), "cc-home-"));
	const previous = process.env.HOME;
	authFile(dir, ".pi/agent/auth.json", { commandcode: { type: "api", key: "test-key-never-sent" } });
	process.env.HOME = dir;
	try {
		const model = buildModel("commandcode/deepseek/deepseek-v4.1-flash");
		assert.equal(model.name, "commandcode:deepseek/deepseek-v4.1-flash");
		assert.equal(typeof model.decide, "function");
		assert.equal(model.close, undefined, "a stateless HTTP adapter has nothing to release");
		// The two existing routes are untouched by the new branch.
		assert.equal(buildModel("openrouter:z-ai/glm-5.3-flash").name, "openrouter:z-ai/glm-5.3-flash");
	} finally {
		process.env.HOME = previous;
		rmSync(dir, { recursive: true, force: true });
	}
});

test("the default primary is still needle3", () => {
	assert.equal(loadConfig({}).primary, "needle3");
	assert.equal(loadConfig({}).escalator, "z-ai/glm-5.3-flash");
	assert.equal(loadConfig({}).primary, loadConfig({ AGENTFLEET_PRIMARY: "" }).primary);
});
