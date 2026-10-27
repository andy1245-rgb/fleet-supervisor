// The metric vocabulary. One union, one version, one parser.
//
// Every row the supervisor writes about what it did goes through this file: the
// tick emits decisions, actions, claims and a summary; the inspector's findings
// carry their mode here; the trigger scan emits triggers; the watchdog emits
// findings. No stage invents its own shape, because a report is only as
// trustworthy as the log under it — a stage writing its own private keys is a
// stage whose numbers cannot be compared with any other stage's, or with its own
// from last week.
//
// Three rules hold for every event here:
//
//   * `schema` is on the row, not implied by the file's age. `parseEvent` rejects
//     a row whose version is not SCHEMA_VERSION, so a line written by an older
//     supervisor is counted and skipped instead of being averaged in.
//   * required means required. A field a stage cannot supply honestly is
//     optional — `promptTokens`, `labelOp`, `stalled`, a claim's `ageMs` — and
//     the report names the fields that were absent rather than reading absence
//     as zero.
//   * the numeric fields are the ones a stage can be *judged* on. A field that
//     nothing can act on is not here; the human-readable log stays where it is.

import { isOp, type Op } from "../decision/types.ts";
import type { Phase } from "../fleet/registry.ts";
import type { AgentStatus } from "../herdr/types.ts";
import type { AskPolicy } from "../manager/ask.ts";
import type { TriggerKind } from "../manager/triggers.ts";
import type { OutcomeKind } from "./outcome.ts";

/** Bumped whenever a required field changes meaning or a kind is added/removed.
 *  Old rows are then skipped by `parseEvent`, which is the point: a mixed-unit
 *  aggregate is worse than a smaller one.
 *
 *  v2 adds the `outcome` kind. A v1 log is therefore no longer aggregated: its
 *  rows are counted in `ignoredRows` and named as skipped, rather than being
 *  averaged in beside judgments that did not exist when they were written. */
export const SCHEMA_VERSION = 2;

/** Which path produced a finding, and therefore what its cost and latency mean. */
export type InspectionMode = "cheap" | "deep";

/** What happened to a would-be action. `held` is the gate parking it in
 *  asks.jsonl; `dry` is a rehearsal that touched nothing. */
export type ActionDisposition = "sent" | "held" | "rejected" | "skipped" | "dry";

/** A claim's state as the metric layer sees it: the worker's three states plus
 *  `none`, for a pane that moved with no claim file on disk. */
export type ClaimMetricState = "working" | "waiting" | "done" | "none";

// ------------------------------------------------------------- compile guards
//
// The literal sets below are typed as full Records of the enums they validate,
// so adding a member to TriggerKind / AskPolicy / Phase / a claim state without
// adding it here is a compile error rather than a row the parser rejects in
// production a week later.

const TRIGGER_KINDS: Readonly<Record<TriggerKind, true>> = {
	divergence: true,
	collision: true,
	churn: true,
	blocked: true,
};

const ASK_POLICIES: Readonly<Record<AskPolicy, true>> = {
	never: true,
	fork: true,
	often: true,
	always: true,
};

const PHASES: Readonly<Record<Phase, true>> = {
	research: true,
	experiment: true,
	implement: true,
	verify: true,
	idle: true,
	unknown: true,
};

const CLAIM_STATES: Readonly<Record<ClaimMetricState, true>> = {
	working: true,
	waiting: true,
	done: true,
	none: true,
};

const DISPOSITIONS: Readonly<Record<ActionDisposition, true>> = {
	sent: true,
	held: true,
	rejected: true,
	skipped: true,
	dry: true,
};

const MODES: Readonly<Record<InspectionMode, true>> = { cheap: true, deep: true };

const OUTCOME_KINDS: Readonly<Record<OutcomeKind, true>> = {
	progressed: true,
	stalled: true,
	satisfied: true,
	reopened: true,
	unobserved: true,
};

const AGENT_STATUSES: Readonly<Record<AgentStatus, true>> = {
	idle: true,
	working: true,
	blocked: true,
	done: true,
	unknown: true,
};

function known<K extends string>(set: Readonly<Record<K, true>>, value: unknown): value is K {
	return typeof value === "string" && Object.hasOwn(set, value);
}

// ---------------------------------------------------------------- the events

interface Base {
	/** Taxonomies are versioned per row so a log spanning an upgrade stays
	 *  readable: the report quotes this number instead of guessing. */
	schema: typeof SCHEMA_VERSION;
	/** ISO 8601. Every aggregate windows on this, never on file order. */
	ts: string;
}

/** One ladder decision for one moved pane. The row a "was the model worth it"
 *  question is answered from: model, latency, cost and self-reported confidence
 *  travel together, so no join is needed to price a model. */
export interface DecisionEvent extends Base {
	kind: "decision";
	paneId: string;
	group: string;
	/** The model whose opinion became the decision — the escalator's, when it took over. */
	model: string;
	op: Op;
	/** The model's own number, 0..1. Not an accuracy estimate; see docs/METRICS.md. */
	confidence: number;
	/** True when the model declined to commit to an op. */
	refused: boolean;
	/** True whenever the primary was found insufficient and the escalator was asked. */
	escalated: boolean;
	/** True when the escalation was attempted and the escalator threw. */
	escalationFailed: boolean;
	/** The deciding model's own round trip. */
	latencyMs: number;
	/** The deciding model's own price. The escalator's cost is on its own trail. */
	costUsd: number;
	/** The group's ask policy at decision time. Informational for `leave`/`flag`:
	 *  neither is ever gated, so the policy was not consulted. */
	policy: AskPolicy;
	/** True when the gate parked this decision's action instead of performing it. */
	held: boolean;
	/** Absent in every row today: no adapter reports token usage. */
	promptTokens?: number;
	completionTokens?: number;
	/** Ground truth from a bench join, when one supplies it. Absent otherwise,
	 *  which is what makes accuracy-by-decile null instead of invented. */
	labelOp?: Op;
	/** The legacy one-line summary (`describeDecision`), kept because it is what
	 *  a human reads in the log and it must not disappear from the row. */
	decision?: string;
}

/** One tick's summary. The denominator for every per-tick rate, and the only
 *  place the whole-tick cost (trails included) is recorded. */
export interface TickEvent extends Base {
	kind: "tick";
	agents: number;
	moved: number;
	decisions: number;
	escalated: number;
	escalationFailed: number;
	triggers: number;
	inspected: number;
	/** Prompts actually sent to panes, nudges and inspector nudges alike. */
	prompts: number;
	/** Actions parked for the operator. */
	held: number;
	costUsd: number;
	durationMs: number;
	/** Every model consulted this tick, including a failed escalator's target. */
	models: string[];
	dry: boolean;
	/** Legacy alias of `held`: the existing `tick` line calls it `asks`. */
	asks?: number;
}

/** One cross-agent trigger, as the scan found it. Log-only triggers (churn with
 *  the inspector off) are here too: the row says the condition fired, not that
 *  anything was spent on it. */
export interface TriggerEvent extends Base {
	kind: "trigger";
	/** The trigger's own kind. Named `triggerKind` because `kind` is the event
	 *  discriminator, and a row cannot be two things. */
	triggerKind: TriggerKind;
	group: string;
	paneIds: string[];
	detail: string;
}

/** One investigation of one trigger. `proposed` is the yield question: what
 *  fraction of triggered inspections produced something actionable. */
export interface InspectionEvent extends Base {
	kind: "inspection";
	triggerKind: TriggerKind;
	group: string;
	paneIds: string[];
	mode: InspectionMode;
	/** The model that answered, when one did. */
	model?: string;
	confidence: number;
	costUsd: number;
	latencyMs: number;
	/** True when the finding carried an action. */
	proposed: boolean;
	/** True when the requested path did not deliver: `deep` fell back to `cheap`,
	 *  or the model call failed and the finding says so. */
	degraded: boolean;
}

/** One would-be action and how far it got. The hold rate, the prompt cap and
 *  the cooldown are all measured here, and `gated` is what makes the hold rate's
 *  denominator honest: an action skipped for cooldown never reached the gate. */
export interface ActionEvent extends Base {
	kind: "action";
	paneId: string;
	group: string;
	op: Op;
	disposition: ActionDisposition;
	/** Short, stable reason: `ok`, `gate`, `cooldown`, `capped`, `dry`, `flag-reported`,
	 *  or the transport's own refusal reason. */
	reason: string;
	/** Time spent performing it — the prompt round trip where there was one. */
	latencyMs: number;
	/** True when the ask gate ran for this action. */
	gated: boolean;
	policy: AskPolicy;
	/** Which contests the gate saw, so hold rate can be read per fork kind. */
	forkKinds?: string[];
	forkSeverities?: string[];
}

/** One watchdog finding. `stalled` is present only when a scan re-sampled to
 *  tell slow from hung; the per-tick scan does not pay for that second sample. */
export interface WatchdogEvent extends Base {
	kind: "watchdog";
	rule: string;
	pid: number;
	ageMs: number;
	command: string;
	stalled?: boolean;
}

/** The worker-side read for a moved pane, recorded next to the decision it fed.
 *  This is the claim-versus-herdr disagreement in numbers, so divergence can be
 *  counted without re-deriving it from prose. */
export interface ClaimEvent extends Base {
	kind: "claim";
	paneId: string;
	group: string;
	phase: Phase;
	state: ClaimMetricState;
	/** Milliseconds since the claim file was last written. Absent when there is
	 *  no claim file — an unknown age is not an age of zero. */
	ageMs?: number;
	/** True when the worker claims `working` and herdr does not report working. */
	diverged: boolean;
}

/** What happened after a decision, as the next ticks observed it. This is the
 *  only row in the log that is a *judgment about a decision* rather than a record
 *  of what the supervisor did, and the only one a transcript could not have
 *  produced: the decisions worth judging are the ones nobody typed anything
 *  after. See ./outcome.ts for the rules, and for why only the silent-and-stalled
 *  direction is evidence.
 *
 *  It carries the pane's own fields — status, idleTicks, cwd, title — because the
 *  tick observed them for free with the snapshot it had already taken, and the
 *  exporter needs them to build a row shaped like a bench task. */
export interface OutcomeEvent extends Base {
	kind: "outcome";
	paneId: string;
	group: string;
	/** The op that was decided, and therefore what this is an outcome *of*. */
	op: Op;
	/** The verdict's kind. Named `outcomeKind` because `kind` is the event
	 *  discriminator, as `triggerKind` is on a trigger. */
	outcomeKind: OutcomeKind;
	/** Ticks between the decision and the judgement, this one included. A count,
	 *  never a duration: the tick interval is a setting. */
	ticksObserved: number;
	/** True when `completion_seq` advanced between the decision and the judgement. */
	movedSinceDecision: boolean;
	/** The decision's own text: a nudge's instruction, a leave's reason, a
	 *  declaration's summary. Log-only — it is what the operator reads when asking
	 *  why a pane was left alone. */
	argument: string;
	/** The pane's state at judgement. */
	status: AgentStatus;
	idleTicks: number;
	/** The pane's tree at judgement; a nudge may not redirect past it. */
	cwd: string;
	title: string;
}

export interface EventByKind {
	decision: DecisionEvent;
	tick: TickEvent;
	trigger: TriggerEvent;
	inspection: InspectionEvent;
	action: ActionEvent;
	watchdog: WatchdogEvent;
	claim: ClaimEvent;
	outcome: OutcomeEvent;
}

export type EventKind = keyof EventByKind;

export type SchemaEvent = EventByKind[EventKind];

// ------------------------------------------------------------- the validators

type FieldType = "string" | "number" | "boolean" | "strings" | "op" | "policy" | "triggerKind" | "mode" | "disposition" | "phase" | "claimState" | "outcomeKind" | "agentStatus";

interface FieldSpec {
	key: string;
	type: FieldType;
	/** False means the field may be absent; if it is present it must still typecheck. */
	required: boolean;
}

const DECISION_FIELDS: readonly FieldSpec[] = [
	{ key: "paneId", type: "string", required: true },
	{ key: "group", type: "string", required: true },
	{ key: "model", type: "string", required: true },
	{ key: "op", type: "op", required: true },
	{ key: "confidence", type: "number", required: true },
	{ key: "refused", type: "boolean", required: true },
	{ key: "escalated", type: "boolean", required: true },
	{ key: "escalationFailed", type: "boolean", required: true },
	{ key: "latencyMs", type: "number", required: true },
	{ key: "costUsd", type: "number", required: true },
	{ key: "policy", type: "policy", required: true },
	{ key: "held", type: "boolean", required: true },
	{ key: "promptTokens", type: "number", required: false },
	{ key: "completionTokens", type: "number", required: false },
	{ key: "labelOp", type: "op", required: false },
	{ key: "decision", type: "string", required: false },
];

const TICK_FIELDS: readonly FieldSpec[] = [
	{ key: "agents", type: "number", required: true },
	{ key: "moved", type: "number", required: true },
	{ key: "decisions", type: "number", required: true },
	{ key: "escalated", type: "number", required: true },
	{ key: "escalationFailed", type: "number", required: true },
	{ key: "triggers", type: "number", required: true },
	{ key: "inspected", type: "number", required: true },
	{ key: "prompts", type: "number", required: true },
	{ key: "held", type: "number", required: true },
	{ key: "costUsd", type: "number", required: true },
	{ key: "durationMs", type: "number", required: true },
	{ key: "models", type: "strings", required: true },
	{ key: "dry", type: "boolean", required: true },
	{ key: "asks", type: "number", required: false },
];

const TRIGGER_FIELDS: readonly FieldSpec[] = [
	{ key: "triggerKind", type: "triggerKind", required: true },
	{ key: "group", type: "string", required: true },
	{ key: "paneIds", type: "strings", required: true },
	{ key: "detail", type: "string", required: true },
];

const INSPECTION_FIELDS: readonly FieldSpec[] = [
	{ key: "triggerKind", type: "triggerKind", required: true },
	{ key: "group", type: "string", required: true },
	{ key: "paneIds", type: "strings", required: true },
	{ key: "mode", type: "mode", required: true },
	{ key: "model", type: "string", required: false },
	{ key: "confidence", type: "number", required: true },
	{ key: "costUsd", type: "number", required: true },
	{ key: "latencyMs", type: "number", required: true },
	{ key: "proposed", type: "boolean", required: true },
	{ key: "degraded", type: "boolean", required: true },
];

const ACTION_FIELDS: readonly FieldSpec[] = [
	{ key: "paneId", type: "string", required: true },
	{ key: "group", type: "string", required: true },
	{ key: "op", type: "op", required: true },
	{ key: "disposition", type: "disposition", required: true },
	{ key: "reason", type: "string", required: true },
	{ key: "latencyMs", type: "number", required: true },
	{ key: "gated", type: "boolean", required: true },
	{ key: "policy", type: "policy", required: true },
	{ key: "forkKinds", type: "strings", required: false },
	{ key: "forkSeverities", type: "strings", required: false },
];

const WATCHDOG_FIELDS: readonly FieldSpec[] = [
	{ key: "rule", type: "string", required: true },
	{ key: "pid", type: "number", required: true },
	{ key: "ageMs", type: "number", required: true },
	{ key: "command", type: "string", required: true },
	{ key: "stalled", type: "boolean", required: false },
];

const CLAIM_FIELDS: readonly FieldSpec[] = [
	{ key: "paneId", type: "string", required: true },
	{ key: "group", type: "string", required: true },
	{ key: "phase", type: "phase", required: true },
	{ key: "state", type: "claimState", required: true },
	{ key: "ageMs", type: "number", required: false },
	{ key: "diverged", type: "boolean", required: true },
];

const OUTCOME_FIELDS: readonly FieldSpec[] = [
	{ key: "paneId", type: "string", required: true },
	{ key: "group", type: "string", required: true },
	{ key: "op", type: "op", required: true },
	{ key: "outcomeKind", type: "outcomeKind", required: true },
	{ key: "ticksObserved", type: "number", required: true },
	{ key: "movedSinceDecision", type: "boolean", required: true },
	{ key: "argument", type: "string", required: true },
	{ key: "status", type: "agentStatus", required: true },
	{ key: "idleTicks", type: "number", required: true },
	{ key: "cwd", type: "string", required: true },
	{ key: "title", type: "string", required: true },
];

function fieldOk(value: unknown, type: FieldType): boolean {
	switch (type) {
		case "string":
			return typeof value === "string";
		case "number":
			return typeof value === "number" && Number.isFinite(value);
		case "boolean":
			return typeof value === "boolean";
		case "strings":
			return Array.isArray(value) && value.every((entry) => typeof entry === "string");
		case "op":
			return isOp(value);
		case "policy":
			return known(ASK_POLICIES, value);
		case "triggerKind":
			return known(TRIGGER_KINDS, value);
		case "mode":
			return known(MODES, value);
		case "disposition":
			return known(DISPOSITIONS, value);
		case "phase":
			return known(PHASES, value);
		case "claimState":
			return known(CLAIM_STATES, value);
		case "outcomeKind":
			return known(OUTCOME_KINDS, value);
		case "agentStatus":
			return known(AGENT_STATUSES, value);
	}
}

type Bag = Record<string, unknown>;

function isBag(value: unknown): value is Bag {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Every required field present and well typed, and no optional field of the
 *  wrong type. Extra keys are allowed: this taxonomy adds fields to rows that
 *  already have a human-readable life. */
function conforms(bag: Bag, fields: readonly FieldSpec[]): boolean {
	for (const field of fields) {
		const value = bag[field.key];
		if (value === undefined) {
			if (field.required) return false;
			continue;
		}
		if (!fieldOk(value, field.type)) return false;
	}
	return true;
}

function accept<T>(bag: Bag, fields: readonly FieldSpec[]): T | undefined {
	return conforms(bag, fields) ? (bag as unknown as T) : undefined;
}

/** The one place a line becomes an event.
 *
 *  Returns undefined for anything that is not a row of this schema version: a
 *  truncated write, a hand-edited line, a legacy row from before the taxonomy,
 *  or a kind this build does not know. Callers count those and skip them — a
 *  single bad row must never poison an aggregate, and rejecting is how the store
 *  can promise that. */
export function parseEvent(line: string): SchemaEvent | undefined {
	const text = line.trim();
	if (text === "") return undefined;
	let raw: unknown;
	try {
		raw = JSON.parse(text);
	} catch {
		return undefined;
	}
	if (!isBag(raw)) return undefined;
	if (raw.schema !== SCHEMA_VERSION) return undefined;
	if (typeof raw.ts !== "string" || Number.isNaN(Date.parse(raw.ts))) return undefined;

	switch (raw.kind) {
		case "decision":
			return accept<DecisionEvent>(raw, DECISION_FIELDS);
		case "tick":
			return accept<TickEvent>(raw, TICK_FIELDS);
		case "trigger":
			return accept<TriggerEvent>(raw, TRIGGER_FIELDS);
		case "inspection":
			return accept<InspectionEvent>(raw, INSPECTION_FIELDS);
		case "action":
			return accept<ActionEvent>(raw, ACTION_FIELDS);
		case "watchdog":
			return accept<WatchdogEvent>(raw, WATCHDOG_FIELDS);
		case "claim":
			return accept<ClaimEvent>(raw, CLAIM_FIELDS);
		case "outcome":
			return accept<OutcomeEvent>(raw, OUTCOME_FIELDS);
		default:
			return undefined;
	}
}

/** The JSON line for one event. The only serialiser in the project: a row that is
 *  not a SchemaEvent does not typecheck, so no stage can write an unvalidated
 *  shape even if it wanted to. */
export function eventLine(event: SchemaEvent): string {
	return JSON.stringify(event);
}

// -------------------------------------------------------------- constructors
//
// Each `make*` takes exactly the facts the stage owns and returns the row. The
// stages call these instead of building objects, which is what keeps the log
// consistent when a stage's own fields change.

function nowIso(): string {
	return new Date().toISOString();
}

function stamp(ts: string | undefined): string {
	return ts ?? nowIso();
}

export interface DecisionRecord {
	paneId: string;
	group: string;
	model: string;
	op: Op;
	confidence: number;
	refused: boolean;
	escalated: boolean;
	escalationFailed: boolean;
	latencyMs: number;
	costUsd: number;
	policy: AskPolicy;
	held: boolean;
	promptTokens?: number;
	completionTokens?: number;
	labelOp?: Op;
	decision?: string;
	ts?: string;
}

export function makeDecision(record: DecisionRecord): DecisionEvent {
	const { ts, ...rest } = record;
	return { schema: SCHEMA_VERSION, kind: "decision", ts: stamp(ts), ...rest };
}

export interface TickRecord {
	agents: number;
	moved: number;
	decisions: number;
	escalated: number;
	escalationFailed: number;
	triggers: number;
	inspected: number;
	prompts: number;
	held: number;
	costUsd: number;
	durationMs: number;
	models: string[];
	dry: boolean;
	ts?: string;
}

export function makeTick(record: TickRecord): TickEvent {
	const { ts, ...rest } = record;
	// `asks` is the legacy key on this row; it and `held` are the same number and
	// both are written so a consumer reading either keeps working.
	return { schema: SCHEMA_VERSION, kind: "tick", ts: stamp(ts), ...rest, asks: rest.held };
}

export interface TriggerRecord {
	triggerKind: TriggerKind;
	group: string;
	paneIds: string[];
	detail: string;
	ts?: string;
}

export function makeTrigger(record: TriggerRecord): TriggerEvent {
	const { ts, ...rest } = record;
	return { schema: SCHEMA_VERSION, kind: "trigger", ts: stamp(ts), ...rest };
}

export interface InspectionRecord {
	triggerKind: TriggerKind;
	group: string;
	paneIds: string[];
	mode: InspectionMode;
	model?: string;
	confidence: number;
	costUsd: number;
	latencyMs: number;
	proposed: boolean;
	degraded: boolean;
	ts?: string;
}

export function makeInspection(record: InspectionRecord): InspectionEvent {
	const { ts, ...rest } = record;
	return { schema: SCHEMA_VERSION, kind: "inspection", ts: stamp(ts), ...rest };
}

export interface ActionRecord {
	paneId: string;
	group: string;
	op: Op;
	disposition: ActionDisposition;
	reason: string;
	latencyMs: number;
	gated: boolean;
	policy: AskPolicy;
	forkKinds?: string[];
	forkSeverities?: string[];
	ts?: string;
}

export function makeAction(record: ActionRecord): ActionEvent {
	const { ts, ...rest } = record;
	return { schema: SCHEMA_VERSION, kind: "action", ts: stamp(ts), ...rest };
}

export interface WatchdogRecord {
	rule: string;
	pid: number;
	ageMs: number;
	command: string;
	stalled?: boolean;
	ts?: string;
}

export function makeWatchdog(record: WatchdogRecord): WatchdogEvent {
	const { ts, ...rest } = record;
	return { schema: SCHEMA_VERSION, kind: "watchdog", ts: stamp(ts), ...rest };
}

export interface ClaimRecord {
	paneId: string;
	group: string;
	phase: Phase;
	state: ClaimMetricState;
	ageMs?: number;
	diverged: boolean;
	ts?: string;
}

export function makeClaim(record: ClaimRecord): ClaimEvent {
	const { ts, ...rest } = record;
	return { schema: SCHEMA_VERSION, kind: "claim", ts: stamp(ts), ...rest };
}

export interface OutcomeRecord {
	paneId: string;
	group: string;
	op: Op;
	outcomeKind: OutcomeKind;
	ticksObserved: number;
	movedSinceDecision: boolean;
	argument: string;
	status: AgentStatus;
	idleTicks: number;
	cwd: string;
	title: string;
	ts?: string;
}

/** One judgement. `outcomeKind`, `ticksObserved` and `movedSinceDecision` come
 *  from ./outcome.ts unchanged: this layer may not re-derive what the judge
 *  decided, or the log and the rule would be two opinions. */
export function makeOutcome(record: OutcomeRecord): OutcomeEvent {
	const { ts, ...rest } = record;
	return { schema: SCHEMA_VERSION, kind: "outcome", ts: stamp(ts), ...rest };
}

// ------------------------------------------------------------- fork taxonomy
//
// The ask gate reports *why* it stopped an action as a list of reasons with a
// severity. It carries no kind, and the `Fork` type lives in a module this file
// does not own, so the kind is read from the sentence the gate itself wrote
// (`src/manager/ask.ts`). A reason that matches none of them is "other" rather
// than a guess, and the mapping is here — one place, next to the field it fills —
// so a hold can be counted per reason without any stage re-deriving it.

export type ForkKind = "irreversible" | "cross-agent" | "scope-change" | "at-cap" | "other";

export function forkKindOf(reason: string): ForkKind {
	if (reason.startsWith("declare_done stops ")) return "irreversible";
	if (reason.startsWith("collision in ") || reason.startsWith("churn in ")) return "cross-agent";
	if (reason.startsWith("nudge is ") || reason.startsWith("nudge names ")) return "scope-change";
	if (reason.includes("prompts already sent this tick")) return "at-cap";
	return "other";
}
