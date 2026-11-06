// The capture, driven through the adapter itself: a stubbed socket replays the 43
// recorded frames into `decide()`, so the assertion is on what a tick would actually
// receive — op, argument, confidence, tokens and cost — rather than on the reader alone.
// A drift in any of those breaks this test instead of a tick.
//
// The second test here is the latency definition. SPEC §4.8 defines it as first byte to
// last event; phase 1's harness measured request to stream end, which is a different
// quantity and a larger number. The stub holds the body open after the terminal frame so
// the two definitions cannot both pass.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { commandcodeModel, type CommandCodeModel, type CommandCodeOptions } from "../src/decision/adapters/commandcode.ts";
import type { DecisionInput } from "../src/decision/types.ts";

const FIXTURES = join(import.meta.dirname, "fixtures");

interface SseFixture {
	capturedAt: string;
	request: Record<string, unknown>;
	http: { requestToStreamEndMs: number };
	events: { event?: string; data: string }[];
}

const sse = JSON.parse(readFileSync(join(FIXTURES, "commandcode-decision.sse.json"), "utf8")) as SseFixture;

/** The input the capture was rendered from. `commandcode-fixture.test.ts` pins this
 *  reconstruction against the recorded request, so it cannot rot silently. */
const CAPTURED_INPUT: DecisionInput = {
	paneId: "w2C:p3",
	cwd: "/home/andrew/work/fleet-supervisor",
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

const ARGUMENT =
	"Fix the TS2322 error in src/decision/adapters/responses.ts line 41 so the value is a string (e.g. narrow or default the optional string), then run npx tsc --noEmit and the commandcode wire test to confirm acceptance.";

const ANSWER = `{"op": "nudge", "argument": "${ARGUMENT}", "confidence": 0.85}`;

function framesOf(fixture: SseFixture): string[] {
	return fixture.events.map((frame) => (frame.event === undefined ? `data: ${frame.data}\n\n` : `event: ${frame.event}\ndata: ${frame.data}\n\n`));
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/** A body that hands over `steps[i].text` after `steps[i].delayMs` and closes at the end. */
function bodyOf(steps: readonly { delayMs: number; text: string }[]): ReadableStream<Uint8Array> {
	const encoder = new TextEncoder();
	let next = 0;
	return new ReadableStream<Uint8Array>({
		async pull(controller): Promise<void> {
			const step = steps[next];
			if (step === undefined) {
				controller.close();
				return;
			}
			next += 1;
			if (step.delayMs > 0) await sleep(step.delayMs);
			controller.enqueue(encoder.encode(step.text));
		},
	});
}

const WIRE_MODEL = "deepseek/deepseek-v4.1-flash";

/** Replaces the global fetch for the duration of one call and returns a model wired to
 *  the stubbed body. `apiKey` is a literal so no auth file is read. */
async function withStub<T>(steps: readonly { delayMs: number; text: string }[], clock: CommandCodeOptions["clock"], run: (model: CommandCodeModel) => Promise<T>): Promise<T> {
	const real = globalThis.fetch;
	globalThis.fetch = async (): Promise<Response> => new Response(bodyOf(steps), { status: 200, headers: { "content-type": "text/event-stream" } });
	const options = clock === undefined ? { model: WIRE_MODEL, apiKey: "stub-never-sent" } : { model: WIRE_MODEL, apiKey: "stub-never-sent", clock };
	try {
		return await run(commandcodeModel(options));
	} finally {
		globalThis.fetch = real;
	}
}

test("the capture replayed through the adapter yields the exact decision, tokens and cost", async () => {
	// The clock is pinned to the capture: the peak rule reads the wall clock, so without it
	// the same body would cost double between 01:00–04:00 and 06:00–10:00 UTC on a weekday
	// and the exact-dollar assertion would fail twice a day.
	const decision = await withStub([{ delayMs: 0, text: framesOf(sse).join("") }], () => new Date(sse.capturedAt), (adapter) => adapter.decide(CAPTURED_INPUT));

	// Exactly what the model said, through parseDecision unchanged.
	assert.equal(decision.op, "nudge");
	assert.equal(decision.argument, ARGUMENT);
	assert.equal(decision.confidence, 0.85);
	assert.equal(decision.refused, false);
	assert.equal(decision.raw, ANSWER);
	assert.equal(decision.model, WIRE_MODEL, "the served model, not the requested one");

	// The usage block, from the capture's own `response.completed`.
	assert.deepEqual(decision.accounting, {
		promptTokens: 315,
		completionTokens: 106,
		reasoningTokens: 30,
		cacheReadTokens: 0,
		cacheWriteTokens: 0,
		costUsd: 0.00011085,
	});
	assert.equal(decision.costUsd, 0.00011085, "the Decision carries the same figure the accounting priced");
	assert.equal(decision.latencyDefinition, "first-byte-to-last-event");
	assert.ok(Number.isFinite(decision.latencyMs) && decision.latencyMs >= 0);
	assert.ok(decision.latencyMs <= sse.http.requestToStreamEndMs, "a first-byte figure cannot exceed the whole-request figure");
});

test("latency is first byte to last event, not request to stream end", async () => {
	// The socket delivers the first frame immediately, the terminal frame 20 ms later, and
	// then holds the body open for another 150 ms with a comment frame that carries no
	// event before closing. Request-to-stream-end would read ~170 ms; the spec's definition
	// reads ~20 ms, and the gap between the bounds is what makes this a test rather than a
	// tautology.
	const frames = framesOf(sse);
	const decision = await withStub(
		[
			{ delayMs: 0, text: frames.slice(0, 1).join("") },
			{ delayMs: 20, text: frames.slice(1).join("") },
			{ delayMs: 150, text: ": keep-alive\n\n" },
		],
		undefined,
		(adapter) => adapter.decide(CAPTURED_INPUT),
	);

	assert.equal(decision.op, "nudge", "the trailing frame must not disturb the answer");
	assert.equal(decision.latencyDefinition, "first-byte-to-last-event");
	assert.ok(decision.latencyMs >= 15, `latencyMs ${decision.latencyMs} is below the 20 ms gap: the clock did not start at the first byte`);
	assert.ok(decision.latencyMs < 120, `latencyMs ${decision.latencyMs} includes the trailing 150 ms idle body: this is request-to-stream-end, not first-byte-to-last-event`);
});
