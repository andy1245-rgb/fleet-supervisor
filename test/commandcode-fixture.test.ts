// The capture. `fixtures/commandcode-decision.sse.json` is 43 raw SSE frames from a
// real 200 for a decision-shaped body; nothing in this repo pinned those field names
// before it existed. These tests read that file and nothing else — no network.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { accountUsage, buildRequest, decisionFrom, peakMultiplier } from "../src/decision/adapters/commandcode.ts";
import { parseSseFrames, responsesReader, usageOf, type ReasoningOutputItem, type ResponsesEcho, type ResponsesOutcome } from "../src/decision/adapters/responses.ts";
import { OPS, type DecisionInput } from "../src/decision/types.ts";

const FIXTURES = join(import.meta.dirname, "fixtures");

interface SseFixture {
	capturedAt: string;
	source: string;
	request: Record<string, unknown>;
	http: { status: number; contentType: string; requestToStreamEndMs: number; latencyNote: string };
	sawDoneSentinel: boolean;
	rawSha256: string;
	rawBytes: number;
	events: { event?: string; data: string }[];
}

interface ParsedFixture {
	capturedAt: string;
	derivedFrom: string;
	httpStatus: number;
	servedModel: string;
	responseId: string;
	stop: string;
	events: number;
	unparseable: number;
	decision: { op: string; argument: string; confidence: number; refused: boolean; model: string; costUsd: number; latencyMs: number; raw: string };
	latencyNote: string;
	reasoningSummary: string;
	usage: { inputTokens: number | null; outputTokens: number | null; cachedTokens: number | null; cacheWriteTokens: number | null; reasoningTokens: number | null; totalTokens: number | null };
	accounting: ReturnType<typeof accountUsage>;
}

const raw = readFileSync(join(FIXTURES, "commandcode-decision.sse.json"), "utf8");
const sse = JSON.parse(raw) as SseFixture;
const recorded = JSON.parse(readFileSync(join(FIXTURES, "commandcode-decision.json"), "utf8")) as ParsedFixture;
/** The frames alone, without the request recorded beside them. A field the provider
 *  ignored can appear in the request and still be absent from every response. */
const framesText = sse.events.map((frame) => frame.data).join("\n");
const terminalFrame = (): ResponsesEcho => (JSON.parse(sse.events.at(-1)?.data ?? "{}") as { response: ResponsesEcho }).response;

/** The same walk the transport does, over the frames the provider actually sent. */
function replay(fixture: SseFixture): ResponsesOutcome {
	const reader = responsesReader();
	for (const frame of fixture.events) {
		const lines = frame.event === undefined ? [`data: ${frame.data}`] : [`event: ${frame.event}`, `data: ${frame.data}`];
		reader.feed(`${lines.join("\n")}\n\n`);
	}
	return reader.finish();
}

const outcome = replay(sse);
/** The served model, once asserted below; `ResponsesOutcome.model` is optional because a
 *  stream can fail before it names one. */
const servedModel = outcome.model ?? "";

test("the fixture is a real 200 with a recorded timestamp and the model actually served", () => {
	assert.equal(sse.http.status, 200);
	assert.equal(sse.http.contentType, "text/event-stream");
	assert.match(sse.capturedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
	assert.ok(Number.isFinite(Date.parse(sse.capturedAt)));
	assert.equal(sse.source, "POST https://api.commandcode.ai/provider/v1/responses");
	assert.equal(outcome.model, "deepseek/deepseek-v4.1-flash", "the served model, not the requested one");
	assert.equal(recorded.servedModel, servedModel);
	assert.match(String(recorded.responseId), /^resp_/);
	assert.ok(sse.rawBytes > 0);
	assert.match(sse.rawSha256, /^[0-9a-f]{64}$/);
});

test("a healthy 200 sends no [DONE] sentinel", () => {
	assert.equal(sse.sawDoneSentinel, false);
	assert.equal(sse.events.some((frame) => frame.data.trim() === "[DONE]"), false);
	// Termination is the frame, so the reader must reach a verdict without a sentinel.
	assert.equal(outcome.stop, "completed");
	assert.equal(outcome.status, "completed");
});

test("the recorded frames are exactly the events the provider named", () => {
	assert.equal(sse.events.length, 43);
	assert.equal(outcome.events, 43);
	assert.equal(outcome.unparseable, 0);
	const names = new Set(sse.events.map((frame) => frame.event));
	for (const expected of ["response.created", "response.output_text.delta", "response.reasoning_summary_text.delta", "response.completed"]) {
		assert.equal(names.has(expected), true, `${expected} must be in the capture`);
	}
	// The chat-completions spellings this wire does not use.
	assert.equal(sse.events.some((frame) => frame.data.includes("\"choices\"")), false);
});

test("the capture parses into an op, an argument and a confidence", () => {
	const decision = decisionFrom(outcome, { model: servedModel, costUsd: 0, latencyMs: 1 });
	assert.equal(decision.refused, false);
	assert.ok((OPS as readonly string[]).includes(decision.op));
	assert.equal(decision.op, "nudge");
	assert.ok(decision.argument.length > 20);
	assert.equal(decision.argument, recorded.decision.argument);
	assert.equal(typeof decision.confidence, "number");
	assert.ok(decision.confidence > 0 && decision.confidence <= 1);
	assert.equal(decision.confidence, recorded.decision.confidence);
	assert.match(decision.raw, /^\{"op":/);
});

test("the capture yields non-null tokens and a non-null cost", () => {
	const usage = outcome.usage;
	assert.ok(usage, "the completed frame carries a usage block");
	assert.equal(usage.inputTokens, 315);
	assert.equal(usage.outputTokens, 106);
	assert.equal(usage.reasoningTokens, 30);
	// This provider's block has no cache_write_tokens field: null on the wire view.
	assert.equal(usage.cacheWriteTokens, null);

	const accounting = accountUsage(usage, new Date(sse.capturedAt));
	assert.equal(accounting.promptTokens, 315);
	assert.equal(accounting.completionTokens, 106);
	assert.equal(accounting.costUsd, 0.00011085);
	for (const value of Object.values(accounting)) assert.equal(typeof value === "number" && Number.isNaN(value), false, `${String(value)} is NaN`);
	assert.deepEqual(accounting, recorded.accounting);
});

test("the recorded dollar figure is the card arithmetic on the real response", () => {
	const at = new Date(sse.capturedAt);
	const expected = (recorded.accounting.promptTokens * 0.15 + recorded.accounting.completionTokens * 0.6) / 1_000_000;
	assert.equal(peakMultiplier(at), 1, "the capture was taken off-peak");
	assert.equal(recorded.accounting.costUsd, expected);
	assert.equal(recorded.accounting.costUsd, 0.00011085);
});

test("the request recorded beside the capture is the envelope, not a completions body", () => {
	const request = sse.request;
	assert.equal(request.stream, true);
	assert.equal(request.max_output_tokens, 2048);
	assert.equal(Array.isArray(request.input), true);
	const items = request.input as { role: string; content: unknown }[];
	const [system, user] = items;
	assert.ok(system && user);
	assert.equal(system.role, "system");
	assert.equal(typeof system.content, "string");
	assert.equal(user.role, "user");
	const parts = user.content as { type: string; text: string }[];
	assert.equal(parts[0]?.type, "input_text");
	for (const forbidden of ["messages", "response_format", "instructions"]) assert.equal(forbidden in request, false);
});

test("the adapter's body is the recorded body, minus the field the provider ignores", () => {
	// The `request` in the capture is what phase 1 actually sent. The body built today
	// must equal it field for field except `include`, so any other drift between the two
	// is a regression rather than a decision — and the render of the captured input is
	// pinned by it too.
	const capturedInput: DecisionInput = {
		paneId: "w2C:p3",
		cwd: "/home/operator/work/fleet-supervisor",
		status: "idle",
		title: "pi - implement the responses adapter",
		intent: "add a hosted commandcode adapter without changing the default primary",
		phase: "implement",
		acceptance: "npx tsc --noEmit exits 0 and npm test passes",
		claimState: "working",
		last: "wrote test/commandcode-wire.test.ts",
		idleTicks: 3,
		tail: "$ npx tsc --noEmit\nsrc/decision/adapters/responses.ts(41,7): error TS2322: Type 'string | undefined' is not assignable to type 'string'.\n\n> next: fix the narrow, then run the wire test",
	};
	const sent = { ...(sse.request as Record<string, unknown>) };
	assert.deepEqual(sent.include, ["reasoning.encrypted_content"], "phase 1 did send it");
	delete sent.include;
	assert.deepEqual(buildRequest(capturedInput, { model: "deepseek/deepseek-v4.1-flash" }), sent);
});

test("cache_write_tokens is absent from this provider's usage block", () => {
	const usage = terminalFrame().usage as { input_tokens_details: Record<string, unknown>; output_tokens_details: Record<string, unknown> };
	assert.deepEqual(Object.keys(usage.input_tokens_details), ["cached_tokens"]);
	assert.equal("cache_write_tokens" in usage.input_tokens_details, false);
	assert.equal(framesText.includes("cache_write_tokens"), false, "no frame carries the field");
	// Null on the wire view so the record does not claim a zero it measured; 0 in the
	// arithmetic, where "absent" means "nothing was billed here".
	assert.equal(usageOf(usage)?.cacheWriteTokens, null);
	assert.equal(accountUsage(usageOf(usage), new Date(sse.capturedAt)).cacheWriteTokens, 0);
});

test("the envelope echoes caching disabled, service_tier default and store false", () => {
	const created = (JSON.parse(sse.events[0]?.data ?? "{}") as { response: ResponsesEcho }).response;
	assert.equal(created.service_tier, "default");
	assert.equal(created.store, false);
	assert.deepEqual(created.caching, { type: "disabled" });
	// Which is the mechanism behind the capture's zero: caching is off unless a
	// `prompt_cache_key` is sent, and the decision body sends none — so this cost is a
	// cold-prompt cost.
	assert.equal("prompt_cache_key" in (sse.request as Record<string, unknown>), false);
	assert.equal(outcome.usage?.cachedTokens, 0);
});

test("the reasoning echo keeps only effort, so a reader must not look for summary there", () => {
	const echo = terminalFrame().reasoning;
	assert.deepEqual(echo, { effort: "low" });
	assert.equal(terminalFrame().reasoning?.summary, undefined, "the request asked for summary:auto and the echo dropped it");
	// The summary text is on the reasoning item and in the deltas, which is where the
	// reader takes it from.
	const item = terminalFrame().output?.[0];
	assert.equal(item?.type, "reasoning");
	assert.ok("summary" in (item ?? {}));
	assert.equal((item as ReasoningOutputItem).summary?.[0]?.text, recorded.reasoningSummary);
	assert.equal(outcome.reasoning, recorded.reasoningSummary);
});

test("encrypted_content appears nowhere in the capture, though the request asked for it", () => {
	// The verdict, from the frames: (b) absent. Not "echoed but empty" — the echo has no
	// `include` field at all — and not "rejected" — the turn completed with no error
	// frame. The provider ignored the field, so the adapter stopped sending it.
	assert.deepEqual((sse.request as Record<string, unknown>).include, ["reasoning.encrypted_content"]);
	assert.equal(framesText.includes("encrypted_content"), false);
	assert.equal(framesText.includes("\"include\""), false);
	const reasoningItem = terminalFrame().output?.[0] as ReasoningOutputItem | undefined;
	assert.equal(reasoningItem?.type, "reasoning");
	assert.deepEqual(Object.keys(reasoningItem ?? {}).sort(), ["id", "status", "summary", "type"]);
	assert.equal(reasoningItem?.encrypted_content, undefined);
	assert.equal(outcome.stop, "completed", "no error frame: ignored, not rejected");
});

test("the recorded latency is the harness's request-to-stream-end, not the adapter's definition", () => {
	// Phase 1's harness read the body with one `res.text()`, so it could only time the
	// whole POST: that number is an upper bound on first-byte-to-last-event and not an
	// instance of it. The adapter labels which definition produced the number it emits.
	assert.equal(recorded.decision.latencyMs, sse.http.requestToStreamEndMs);
	assert.match(recorded.latencyNote, /UPPER BOUND/);
	assert.match(sse.http.latencyNote, /upper bound/);
	assert.equal("perFrameTimestamps" in sse.http, false, "this capture cannot yield the adapter's definition");
});

test("the parsed fixture is what the adapter derives from the SSE fixture", () => {
	// Re-derived rather than trusted: if either file is edited, this fails.
	const accounting = accountUsage(outcome.usage, new Date(sse.capturedAt));
	const decision = decisionFrom(outcome, { model: servedModel, costUsd: accounting.costUsd, latencyMs: sse.http.requestToStreamEndMs });
	assert.equal(recorded.derivedFrom, "commandcode-decision.sse.json");
	assert.equal(recorded.httpStatus, 200);
	assert.equal(recorded.stop, "completed");
	assert.equal(recorded.events, outcome.events);
	assert.equal(recorded.unparseable, 0);
	assert.deepEqual(recorded.decision, decision);
	assert.deepEqual(recorded.accounting, accounting);
	assert.deepEqual(recorded.usage, outcome.usage);
	assert.equal(recorded.reasoningSummary, outcome.reasoning);
	assert.equal(recorded.capturedAt, sse.capturedAt);
	assert.match(sse.http.latencyNote, /upper bound/);
});

test("no credential-shaped string survives in either fixture", () => {
	const shapes = [/\buser_[A-Za-z0-9_-]{8,}/, /\bcc_[A-Za-z0-9_-]{8,}/, /\bsk-[A-Za-z0-9_-]{8,}/, /\beyJ[A-Za-z0-9_-]{10,}\./, /Bearer\s+[A-Za-z0-9._-]{8,}/];
	for (const shape of shapes) assert.equal(shape.test(raw), false, `${shape} leaked into the capture`);
	assert.equal(raw.includes("authorization"), false, "the credential is not part of a captured body");
});

test("the reader tolerates a body split at an arbitrary byte", () => {
	// The transport feeds whatever the socket hands it, so the exact same frames must
	// reassemble from one-character chunks.
	const whole = sse.events.map((frame) => `${frame.event === undefined ? "" : `event: ${frame.event}\n`}data: ${frame.data}\n\n`).join("");
	const reader = responsesReader();
	for (const character of whole) reader.feed(character);
	const split = reader.finish();
	assert.equal(split.text, outcome.text);
	assert.equal(split.reasoning, outcome.reasoning);
	assert.equal(split.stop, "completed");
	assert.deepEqual(split.usage, outcome.usage);
});

test("parseSseFrames reads the capture into frames with names and payloads", () => {
	const text = sse.events.map((frame) => `event: ${frame.event}\ndata: ${frame.data}\n\n`).join("");
	const frames = parseSseFrames(text);
	assert.equal(frames.length, sse.events.length);
	assert.equal(frames[0]?.name, "response.created");
	assert.deepEqual(frames.map((frame) => frame.name), sse.events.map((frame) => frame.event));
	const terminal = JSON.parse(frames[frames.length - 1]?.data ?? "{}") as { response: { usage: unknown } };
	assert.equal(usageOf(terminal.response.usage)?.inputTokens, 315);
});
