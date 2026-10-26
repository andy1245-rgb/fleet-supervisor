export type Op = "leave" | "nudge" | "declare_done" | "flag";

export const OPS: readonly Op[] = ["leave", "nudge", "declare_done", "flag"];

export function isOp(value: unknown): value is Op {
	return typeof value === "string" && (OPS as readonly string[]).includes(value);
}

/** Everything a decision model is allowed to see. Deliberately no transcript:
 *  the tail is the whole context, which keeps the call cheap and the window small. */
export interface DecisionInput {
	paneId: string;
	cwd: string;
	status: string;
	title: string;
	intent: string;
	phase: string;
	acceptance?: string;
	claimState: string;
	last: string;
	idleTicks: number;
	/** Last lines of terminal output, padding stripped. */
	tail: string;
	/** Assembled evidence for the tier-2 inspector: one block per pane, already
	 *  bounded by the inspector's own budget. Its own field because it is not a
	 *  decision's acceptance criteria and is deliberately larger than a tail. */
	brief?: string;
}

export interface Decision {
	op: Op;
	/** nudge → the instruction; declare_done → summary; flag → problem; leave → reason. */
	argument: string;
	/** Model's own confidence, 0..1. The ladder's routing signal. */
	confidence: number;
	model: string;
	costUsd: number;
	latencyMs: number;
	/** True when the model declined to commit to an op (needle suppresses ungrounded calls). */
	refused: boolean;
	raw: string;
}

export interface DecisionModel {
	readonly name: string;
	readonly costPerCallUsd: number;
	decide(input: DecisionInput): Promise<Decision>;
	/** Releases anything the adapter keeps alive out of band — the needle adapter's
	 *  resident python sidecar. Optional: a stateless HTTP adapter and a test fake
	 *  have nothing to release, and a caller must not have to know which is which. */
	close?(): void;
}

/** Shared defensive parse: every adapter returns model output that may be
 *  garbage, and a supervisor must never act on an unparsed op. */
export function parseDecision(raw: string, meta: { model: string; costUsd: number; latencyMs: number }): Decision {
	const base = { ...meta, raw, refused: false };
	const start = raw.indexOf("{");
	const end = raw.lastIndexOf("}");
	if (start === -1 || end === -1 || end <= start) {
		return { op: "flag", argument: "model returned no JSON object", confidence: 0, ...base, refused: true };
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw.slice(start, end + 1));
	} catch {
		return { op: "flag", argument: "model returned unparseable JSON", confidence: 0, ...base, refused: true };
	}
	if (typeof parsed !== "object" || parsed === null) {
		return { op: "flag", argument: "model returned non-object JSON", confidence: 0, ...base, refused: true };
	}
	const r = parsed as Record<string, unknown>;
	const op = isOp(r.op) ? r.op : undefined;
	const argument = typeof r.argument === "string" ? r.argument : "";
	const confidence = typeof r.confidence === "number" && Number.isFinite(r.confidence) ? Math.max(0, Math.min(1, r.confidence)) : 0;
	if (!op) return { op: "flag", argument: argument || "model named no valid op", confidence, ...base, refused: true };
	return { op, argument, confidence, ...base, refused: false };
}
