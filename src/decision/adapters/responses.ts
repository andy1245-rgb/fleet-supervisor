// The only module that knows the *responses* wire's field names.
//
// Every name below was read off a captured 200 for a decision-shaped call
// (`test/fixtures/commandcode-decision.sse.json`: 43 frames, `response.completed`,
// no `data: [DONE]`, sha256 `8d6658c5…`, captured 2026-11-06T16:31:09.581Z):
//
//   - a healthy stream terminates with a terminal frame — `response.completed`,
//     `response.incomplete`, `response.failed`, or `error`. This provider sends no
//     `[DONE]` sentinel (0 occurrences in the capture), so termination is the
//     terminal frame or EOF, never a sentinel; one that arrives anyway is accepted
//     and ignored rather than read as a status;
//   - the visible answer is `response.output_text.delta`; the thinking is a
//     *summary*, `response.reasoning_summary_text.delta`. They are accumulated as
//     two separate channels and the reasoning text never joins the answer, because
//     `parseDecision` strips to the outermost braces and a summary that quotes a
//     brace would corrupt the parse;
//   - the length stop is `incomplete_details.reason == "length"` on this provider
//     (the OpenAI spelling `max_output_tokens` is accepted too), and a classifier
//     stop is `"content_filter"` with a `content_filter.type` beside it;
//   - `usage.input_tokens` includes the cached prefix and the block omits
//     `cache_write_tokens` entirely — this provider's does — so a field the wire did
//     not carry is `null` here and 0 in the arithmetic, never `undefined` and never
//     NaN;
//   - the echo carries three fields no document mentions: `service_tier`, `store`,
//     and `caching: {"type":"disabled"}` — caching is off unless a
//     `prompt_cache_key` is sent, and the decision body sends none.
//
// Nothing here knows what an op is: the answer is text, and ./commandcode.ts turns
// it into a Decision.

/** One SSE frame: the `event:` name when the frame carried one, plus the joined
 *  `data:` payload verbatim. This wire names every frame, so `name` is normally set. */
export interface SseEvent {
	name?: string;
	data: string;
}

const FRAME_SEPARATOR = /\r?\n\r?\n/;

/** Splits a complete SSE body into frames. Kept separate from the reader because a
 *  fixture is a body in hand, and a live call is a body arriving in pieces. */
export function parseSseFrames(text: string): SseEvent[] {
	const frames: SseEvent[] = [];
	for (const block of text.split(FRAME_SEPARATOR)) {
		const frame = frameOf(block);
		if (frame) frames.push(frame);
	}
	return frames;
}

function frameOf(block: string): SseEvent | undefined {
	if (!block.trim()) return undefined;
	let name: string | undefined;
	const data: string[] = [];
	for (const line of block.split(/\r?\n/)) {
		if (line.startsWith(":")) continue;
		if (line.startsWith("event:")) name = line.slice("event:".length).trim();
		else if (line.startsWith("data:")) data.push(line.slice("data:".length).replace(/^ /, ""));
	}
	const frame: SseEvent = { data: data.join("\n") };
	if (name !== undefined) frame.name = name;
	return frame;
}

/** How a turn ended. `truncated` and `filtered` are different failures and are never
 *  merged: the first is the output budget running out, the second is a classifier
 *  verdict (SPEC §4.4). */
export type ResponsesStop = "completed" | "truncated" | "filtered" | "incomplete" | "failed" | "error";

export interface ResponsesUsage {
	/** Null when the block did not carry the field. `input_tokens` and
	 *  `output_tokens` are the two numbers the cost card cannot work without, so a
	 *  null there makes the cost null rather than free. */
	inputTokens: number | null;
	outputTokens: number | null;
	totalTokens: number | null;
	/** Null when `input_tokens_details.cached_tokens` is absent. */
	cachedTokens: number | null;
	/** Always null on this provider: `input_tokens_details` carries `cached_tokens`
	 *  and no `cache_write_tokens` key at all. The arithmetic reads an absent write
	 *  count as 0 — the provider's own accounting does the same — but absence is not
	 *  proof that nothing was written, only that nothing was billed here. */
	cacheWriteTokens: number | null;
	/** Null when `output_tokens_details.reasoning_tokens` is absent. */
	reasoningTokens: number | null;
}

/** One entry of `output[]` on an echoed response. Only the two kinds this wire has
 *  been seen to send are modelled, and every field is optional because the echo
 *  omits what the request asked for. */
export interface ReasoningOutputItem {
	type: "reasoning";
	id?: string;
	status?: string;
	/** The summary the `reasoning_summary_*` deltas spell out. The echo carries it on
	 *  the item; `response.reasoning` comes back as `{effort}` with `summary`
	 *  dropped, so a reader must not look for it there. */
	summary?: { type?: string; text?: string }[];
	/** The opaque blob `include: ["reasoning.encrypted_content"]` exists to return.
	 *  Typed optional because a field that is sometimes absent must not be typed as
	 *  always present — and on this provider it is always absent: 0 occurrences of
	 *  `encrypted_content` in the 43-frame capture, with no `include` echoed and no
	 *  error frame, i.e. the request was accepted and ignored. */
	encrypted_content?: string;
}

export interface MessageOutputItem {
	type: "message";
	id?: string;
	role?: string;
	status?: string;
	phase?: string;
	content?: { type?: string; text?: string }[];
}

export type ResponsesOutputItem = ReasoningOutputItem | MessageOutputItem | { type: string };

/** The `response` object as this provider echoes it, in the fields a decision reader
 *  can care about. Optional throughout, because the echo is not the request: it drops
 *  `include` entirely and reduces `reasoning` to `{effort}`. */
export interface ResponsesEcho {
	id?: string;
	model?: string;
	status?: string;
	object?: string;
	created_at?: number;
	max_output_tokens?: number;
	service_tier?: string;
	store?: boolean;
	/** `{"type":"disabled"}` on the capture. Sending a `prompt_cache_key` is what
	 *  turns caching on; the decision body does not send one, so every decision is a
	 *  cold prompt and `cached_tokens` is 0. */
	caching?: { type?: string };
	reasoning?: { effort?: string; summary?: string };
	incomplete_details?: { reason?: string; content_filter?: { type?: string; details?: string } };
	error?: { code?: string; message?: string };
	output?: ResponsesOutputItem[];
	/** Read only through `usageOf`, which is where the optionality is handled. */
	usage?: unknown;
}

export interface ResponsesOutcome {
	/** Accumulated `response.output_text.delta`. Never includes reasoning. */
	text: string;
	/** Accumulated reasoning summary text — both spellings of the channel. */
	reasoning: string;
	/** Undefined when the stream ended without a terminal frame, so a caller can
	 *  tell a refusal from a stream that never finished. */
	stop?: ResponsesStop;
	status?: string;
	incompleteReason?: string;
	contentFilter?: { type?: string; details?: string };
	/** The provider's own error, on `response.failed` and on an `error` frame. */
	error?: { code?: string; message?: string };
	usage?: ResponsesUsage;
	/** The model id the provider says it served, not the one that was asked for. */
	model?: string;
	responseId?: string;
	/** Frames that were not JSON. A stream of them is a transport problem, not a
	 *  refusal, so they are counted instead of thrown. */
	unparseable: number;
	events: number;
}

export interface ResponsesReader {
	/** Consumes decoded text; returns how many complete frames it handled, so a
	 *  caller can timestamp the last one. */
	feed(chunk: string): number;
	/** Handles a trailing frame with no terminating blank line and returns the state. */
	finish(): ResponsesOutcome;
}

/** A number the wire actually carried, or null. Nothing here invents a value: a 0
 *  the provider did not say is a wrong number, and the cost card would price it. */
function amount(value: unknown): number | null {
	return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function str(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

function record(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

/** The usage block, in the names the rest of the codebase uses. A field the provider
 *  omitted is null, not 0 and not undefined: ./commandcode.ts decides which absences
 *  the arithmetic can absorb (a missing cache-write count) and which make the cost
 *  uncomputable (a missing token count). */
export function usageOf(raw: unknown): ResponsesUsage | undefined {
	const usage = record(raw);
	if (!usage) return undefined;
	const input = record(usage.input_tokens_details);
	const output = record(usage.output_tokens_details);
	return {
		inputTokens: amount(usage.input_tokens),
		outputTokens: amount(usage.output_tokens),
		totalTokens: amount(usage.total_tokens),
		cachedTokens: amount(input?.cached_tokens),
		cacheWriteTokens: amount(input?.cache_write_tokens),
		reasoningTokens: amount(output?.reasoning_tokens),
	};
}

/** Classifies a terminal frame's `status` + `incomplete_details`. */
function stopOf(type: string, response: Record<string, unknown> | undefined): { stop: ResponsesStop; reason?: string; filter?: { type?: string; details?: string } } | undefined {
	if (type === "response.completed") return { stop: "completed" };
	if (type === "response.failed") return { stop: "failed" };
	if (type === "error") return { stop: "error" };
	if (type !== "response.incomplete") return undefined;

	const details = record(response?.incomplete_details);
	const reason = str(details?.reason);
	if (reason === "content_filter") {
		const filter = record(details?.content_filter);
		const verdict: { type?: string; details?: string } = {};
		const filterType = str(filter?.type);
		const filterDetails = str(filter?.details);
		if (filterType) verdict.type = filterType;
		if (filterDetails) verdict.details = filterDetails;
		return { stop: "filtered", reason, filter: verdict };
	}
	// This provider says "length"; the OpenAI spelling is accepted so a rename on
	// their side cannot turn a truncation into an unparseable answer.
	if (reason === "length" || reason === "max_output_tokens") return { stop: "truncated", reason };
	return { stop: "incomplete", reason };
}

/** An incremental reader over one SSE response body. */
export function responsesReader(): ResponsesReader {
	const state: ResponsesOutcome = { text: "", reasoning: "", unparseable: 0, events: 0 };
	let buffer = "";

	function apply(block: string): boolean {
		const frame = frameOf(block);
		if (!frame) return false;
		const payload = frame.data.trim();
		if (payload === "") return false;
		// Accepted and ignored: this provider terminates on the frame, not on a sentinel.
		if (payload === "[DONE]") return false;

		let event: Record<string, unknown>;
		try {
			const parsed: unknown = JSON.parse(payload);
			const asRecord = record(parsed);
			if (!asRecord) {
				state.unparseable += 1;
				return false;
			}
			event = asRecord;
		} catch {
			state.unparseable += 1;
			return false;
		}

		state.events += 1;
		const type = str(event.type) ?? frame.name ?? "";
		const response = record(event.response);
		const served = str(response?.model);
		if (served !== undefined) state.model = served;
		const id = str(response?.id);
		if (id !== undefined) state.responseId = id;

		switch (type) {
			case "response.output_text.delta":
				state.text += str(event.delta) ?? "";
				return true;
			case "response.reasoning_summary_text.delta":
			case "response.reasoning_text.delta":
				state.reasoning += str(event.delta) ?? "";
				return true;
			default:
				break;
		}

		const terminal = stopOf(type, response);
		if (!terminal) return true;
		state.stop = terminal.stop;
		const status = str(response?.status);
		if (status !== undefined) state.status = status;
		if (terminal.reason !== undefined) state.incompleteReason = terminal.reason;
		if (terminal.filter !== undefined) state.contentFilter = terminal.filter;
		const usage = usageOf(response?.usage);
		if (usage) state.usage = usage;
		const error = record(response?.error) ?? record(event.error) ?? (type === "error" ? event : undefined);
		if (error) {
			const detail: { code?: string; message?: string } = {};
			const code = str(error.code);
			const message = str(error.message);
			if (code !== undefined) detail.code = code;
			if (message !== undefined) detail.message = message;
			if (detail.code !== undefined || detail.message !== undefined) state.error = detail;
		}
		return true;
	}

	return {
		feed(chunk: string): number {
			buffer += chunk;
			const blocks = buffer.split(FRAME_SEPARATOR);
			buffer = blocks.pop() ?? "";
			let handled = 0;
			for (const block of blocks) if (apply(block)) handled += 1;
			return handled;
		},
		finish(): ResponsesOutcome {
			const tail = buffer;
			buffer = "";
			if (tail.trim()) apply(tail);
			return { ...state };
		},
	};
}
