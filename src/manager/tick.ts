// One supervisor tick: observe, decide who moved, ask or act, record.
//
// Cost discipline lives in the escalation rules: a decision call happens only for an
// agent whose sequence numbers advanced, and the escalator only for an answer the
// primary could not stand behind (see ../decision/escalation.ts). Everything else is
// one `agent list` call. Above both of those sits the daily cap (../metrics/daily.ts):
// once the day's recorded spend reaches `AGENTFLEET_DAILY_COST_CAP_USD` the tick makes
// no model call at all, writes one row that says so, and leaves the moved panes for a
// tick that can afford them.
//
// Ask discipline lives in ./ask.ts and ./config.ts: whether an action is taken
// now or parked for the operator is a per-group policy, and a parked action is
// written to asks.jsonl instead of performed. See ./answer.ts for the channel.

import { appendFileSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname } from "node:path";
import { herdrPort } from "../herdr/cli.ts";
import type { HerdrAgent, HerdrPort } from "../herdr/types.ts";
import { detect, loadMarks, saveMarks, type Marks } from "../fleet/detect.ts";
import { groupOf } from "../fleet/groups.ts";
import { readClaims, writeClaim, type Claim } from "../fleet/registry.ts";
import { commandcodeModel, type ReasoningEffort } from "../decision/adapters/commandcode.ts";
import { decideWithEscalation } from "../decision/escalation.ts";
import { needleModel } from "../decision/needle.ts";
import { openRouterModel } from "../decision/openrouter.ts";
import type { Decision, DecisionInput, DecisionModel } from "../decision/types.ts";
import { defaultNotifier, type Notifier } from "../notify/telegram.ts";
import { scanTriggers, type ClaimHistory, type Trigger } from "./triggers.ts";
import { scan as watchdogScan, formatAge, findingFields } from "../watchdog/rules.ts";
import { appendAsk, pendingAsks, pendingKey, readAskLog } from "./answer.ts";
import { askId, shouldAsk, type AskPolicy, type AskRecord, type Fork } from "./ask.ts";
import { askPolicyFor, loadConfig, type Config } from "./config.ts";
import { dailySpend } from "../metrics/daily.ts";
import { inspect, type Finding } from "./inspector.ts";
import { eventLine, forkKindOf, makeAction, makeClaim, makeDecision, makeInspection, makeOutcome, makeTick, makeTrigger, makeWatchdog, type ActionDisposition, type SchemaEvent } from "../metrics/schema.ts";
import { DEFAULT_WINDOW_TICKS, decidedAt, isSilent, judge, observedTicks, parsePending, pendingJson, pendingPath, recordPending, type Observation, type PendingDecision } from "../metrics/outcome.ts";

export interface TickReport {
	agents: number;
	moved: number;
	decisions: Decision[];
	triggers: Trigger[];
	/** Cross-agent triggers the inspector actually investigated this tick. */
	inspected: number;
	promptsSent: number;
	/** Actions parked for the operator instead of performed. */
	asks: number;
	escalated: number;
	/** Escalations attempted where the escalator itself failed. The primary was
	 *  still found insufficient, so these are a subset of `escalated`, counted
	 *  separately because an escalator outage is a fact about the supervisor. */
	escalationFailed: number;
	costUsd: number;
	dry: boolean;
	/** True when the daily cap skipped this tick's model calls: nothing was
	 *  consulted, no `decision` row was written, and the panes that moved are still
	 *  waiting for the next tick that can afford them. */
	capped: boolean;
	/** Today's spend, this tick's own cost included, and the cap in force in dollars
	 *  (`0` when the cap is disabled). */
	dailyCostUsd: number;
	dailyCostCapUsd: number;
}

export interface Deps {
	port: HerdrPort;
	notifier: Notifier;
	config: Config;
	now?: () => number;
	/** Injected ladder pair: dry runs and tests decide without a network call. */
	models?: { primary: DecisionModel; escalator: DecisionModel };
}

function readJson<T>(path: string, fallback: T): T {
	try {
		return JSON.parse(readFileSync(path, "utf8")) as T;
	} catch {
		return fallback;
	}
}

function writeJson(path: string, value: unknown): void {
	mkdirSync(dirname(path), { recursive: true });
	const tmp = `${path}.${process.pid}.tmp`;
	writeFileSync(tmp, `${JSON.stringify(value, null, "\t")}\n`);
	renameSync(tmp, path);
}

function appendEvent(config: Config, event: Record<string, unknown>): void {
	mkdirSync(dirname(config.eventsPath), { recursive: true });
	appendFileSync(config.eventsPath, `${JSON.stringify({ ts: new Date().toISOString(), ...event })}\n`);
}

/** One typed measurement. Every stage's numbers reach the log through
 *  ./metrics/schema.ts, so the report can read the file without knowing which
 *  stage wrote which row, and a stage cannot invent a shape of its own. */
function appendMetric(config: Config, event: SchemaEvent): void {
	mkdirSync(dirname(config.eventsPath), { recursive: true });
	appendFileSync(config.eventsPath, `${eventLine(event)}\n`);
}

/** Wall-clock milliseconds for a measurement. Deliberately not the injected clock:
 *  `nowMs` exists so a test can decide *policy* deterministically, and a latency
 *  measured on a frozen clock would always be zero. */
function elapsed(startedAt: number): number {
	return Math.max(0, Date.now() - startedAt);
}

/** The open decisions, from the file beside the log they explain. A malformed or
 *  absent file is empty, not fatal: this is bookkeeping, and one hand-edited line
 *  must not stop a tick. */
function readPending(path: string): Map<string, PendingDecision> {
	try {
		return parsePending(readFileSync(path, "utf8"));
	} catch {
		return new Map();
	}
}

/** Judges every open decision against the snapshot this tick already took, and
 *  appends one `outcome` row per verdict. A judged decision leaves the map; one
 *  still open carries its incremented tick count, because `judge` counts the
 *  current tick when it is called and the two must not disagree about that.
 *
 *  The trimmed map is written here, not at the end of the tick: a judgement is
 *  appended to the log and removed from the file in the same breath, so the
 *  window in which a crash could leave a judged decision behind to be judged
 *  twice is a rewrite rather than the rest of a tick's network work.
 *
 *  No herdr call: the snapshot in hand is the observation, which is what makes
 *  this free. A pane that is no longer listed is reported `present: false` rather
 *  than as a pane that sat still. */
function judgeOpen(config: Config, agents: readonly HerdrAgent[], idleTicks: ReadonlyMap<string, number>): { open: Map<string, PendingDecision>; judged: number } {
	const open = readPending(pendingPath(config.eventsPath));
	if (open.size === 0) return { open, judged: 0 };

	const byPane = new Map(agents.map((agent) => [agent.paneId, agent]));
	const still: Map<string, PendingDecision> = new Map();
	let judged = 0;

	for (const [paneId, pending] of open) {
		const agent = byPane.get(paneId);
		const observation: Observation = agent === undefined ? { completionSeq: pending.decidedAtSeq, status: "unknown", present: false } : { completionSeq: agent.completionSeq, status: agent.status };
		const outcome = judge(pending, observation, DEFAULT_WINDOW_TICKS);
		if (outcome === undefined) {
			still.set(paneId, { ...pending, ticksObserved: observedTicks(pending) });
			continue;
		}
		judged += 1;
		appendMetric(
			config,
			makeOutcome({
				paneId,
				group: pending.group,
				op: pending.op,
				outcomeKind: outcome.kind,
				ticksObserved: outcome.ticksObserved,
				movedSinceDecision: outcome.movedSinceDecision,
				argument: pending.argument,
				status: agent?.status ?? "unknown",
				idleTicks: agent === undefined ? 0 : (idleTicks.get(paneId) ?? 0),
				cwd: agent?.foregroundCwd || agent?.cwd || "",
				title: agent?.title ?? "",
			}),
		);
	}

	// Nothing open and nothing judged is nothing to say: the file is untouched.
	if (still.size > 0 || judged > 0) writeJson(pendingPath(config.eventsPath), pendingJson(still));
	return { open: still, judged };
}

function forkKinds(forks: readonly Fork[]): string[] | undefined {
	if (forks.length === 0) return undefined;
	return [...new Set(forks.map((fork) => forkKindOf(fork.reason)))];
}

function forkSeverities(forks: readonly Fork[]): string[] | undefined {
	if (forks.length === 0) return undefined;
	return [...new Set(forks.map((fork) => fork.severity))];
}

/** The worker-side read for one pane, recorded beside the decision it fed.
 *  `diverged` is the claim-versus-herdr disagreement the divergence trigger is
 *  grounded in, so that disagreement is a count instead of a re-derivation. */
function recordClaim(config: Config, agent: HerdrAgent, claim: Claim | undefined, group: string): void {
	if (!claim) {
		appendMetric(config, makeClaim({ paneId: agent.paneId, group, phase: "unknown", state: "none", diverged: false }));
		return;
	}
	const updated = Date.parse(claim.updated);
	appendMetric(
		config,
		makeClaim({
			paneId: agent.paneId,
			group,
			phase: claim.phase,
			state: claim.state,
			ageMs: Number.isFinite(updated) ? Math.max(0, Date.now() - updated) : undefined,
			diverged: claim.state === "working" && agent.status !== "working",
		}),
	);
}

/** What the config hands a decision adapter. `effort` is a parameter of the hosted wire
 *  only, so an adapter that has no such field ignores it. */
export interface ModelOptions {
	effort?: ReasoningEffort;
	timeoutMs?: number;
}

/** Maps a config model name to an adapter. A `commandcode/` prefix names the responses
 *  wire; everything else keeps the chat-completions path it had. `needle3` stays
 *  buildable on purpose — it is retired from the default, not removed. */
export function buildModel(name: string, options: ModelOptions = {}): DecisionModel {
	const trimmed = name.trim();
	// The local engine keeps its own 30 s deadline: the 90 s figure was measured on the
	// hosted wire, and the engine is retired rather than re-tuned (phase 8 removes it).
	if (trimmed === "needle3" || trimmed === "needle") return needleModel();
	if (trimmed.startsWith("commandcode/")) return commandcodeModel({ model: trimmed.slice("commandcode/".length), ...options });
	const model = trimmed.startsWith("openrouter:") ? trimmed.slice("openrouter:".length) : trimmed;
	return openRouterModel({ model, ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }) });
}

/** Builds the pair escalation needs, degrading to the escalator alone when the
 *  local engine is unavailable — a missing venv must not stop the supervisor.
 *
 *  `escalator` is the model the tier-2 inspector borrows; `falsifier` is the same model
 *  in the role escalation needs. They diverge only in the degraded case: the model still
 *  exists and can inspect, but it is the primary itself, so there is nothing to falsify
 *  with and escalation is off. */
export function buildLadderModels(config: Config): { primary: DecisionModel; escalator: DecisionModel; falsifier: DecisionModel | undefined; degraded?: string } {
	// The two settings the measurements moved, applied to both decision calls: the
	// effort default and the per-call deadline are properties of the decision step, not
	// of one adapter. A name the adapter cannot honour ignores it.
	const options: ModelOptions = { effort: config.effort, timeoutMs: config.decisionTimeoutMs };
	const escalator = buildModel(config.escalator, options);
	// A pair the operator configured as one model is handed over whole: escalation.ts
	// refuses a same-family pair loudly, and that refusal must not be papered over here.
	if (config.primary === config.escalator) return { primary: escalator, escalator, falsifier: escalator };
	try {
		return { primary: buildModel(config.primary, options), escalator, falsifier: escalator };
	} catch (e) {
		return {
			primary: escalator,
			escalator,
			falsifier: undefined,
			degraded: `primary ${config.primary} unavailable: ${(e as Error).message}; no falsifier, so escalation is off`,
		};
	}
}

function toInput(agent: HerdrAgent, claim: Claim | undefined, tail: string, idleTicks: number): DecisionInput {
	const input: DecisionInput = {
		paneId: agent.paneId,
		cwd: agent.foregroundCwd || agent.cwd,
		status: agent.status,
		title: agent.title,
		intent: claim?.intent ?? "",
		phase: claim?.phase ?? "unknown",
		claimState: claim?.state ?? "unknown",
		last: claim?.last ?? "",
		idleTicks,
		tail,
	};
	if (claim?.acceptance) input.acceptance = claim.acceptance;
	return input;
}

async function pool<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
	const out: R[] = new Array(items.length);
	let cursor = 0;
	const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
		for (;;) {
			const index = cursor++;
			if (index >= items.length) return;
			out[index] = await fn(items[index] as T);
		}
	});
	await Promise.all(workers);
	return out;
}

export function describeDecision(decision: Decision): string {
	const tag = decision.refused ? "refused" : decision.op;
	return `${tag}(${decision.argument.slice(0, 120)}) via ${decision.model} conf ${decision.confidence.toFixed(2)}`;
}

export interface GateArgs {
	config: Config;
	notifier: Notifier;
	decision: Decision;
	/** The ladder trail: the escalator's opinion when there is one. */
	trail: readonly Decision[];
	triggers: readonly Trigger[];
	paneId: string;
	group: string;
	/** The pane's own tree, which a nudge may not redirect past. */
	cwd: string;
	/** Prompts already sent this tick. */
	promptsSent: number;
	/** Asks still pending, from earlier ticks and earlier in this one. */
	pending: ReadonlySet<string>;
	/** One clock read for the id seed and the record timestamp. */
	nowMs: number;
}

export interface GateOutcome {
	/** True when the action must not be performed now. */
	held: boolean;
	policy: AskPolicy;
	why: string;
	/** Every contest the gate saw. Undefined severity is not a thing: a fork is
	 *  hard or soft. Carried out of the gate so the action row can say which kind
	 *  of contest held it, without the report re-reading prose. */
	forks: readonly Fork[];
	/** The record written, or undefined when an identical ask is already pending. */
	record?: AskRecord;
}

function askMessage(record: AskRecord): string {
	return [
		`[ask ${record.id}] ${record.paneId} (${record.group}) wants to ${record.op}`,
		record.why,
		`held: ${record.argument.slice(0, 240)}`,
		"answer from a shell — Telegram replies are not read yet:",
		`node src/manager/answer.ts ${record.id} yes|no`,
	].join("\n");
}

/** The human-in-the-loop gate. Every would-be action passes through it: the
 *  policy decides whether this tick acts or parks the action, and a parked action
 *  is written to asks.jsonl instead of performed — never performed and mentioned.
 *
 *  A duplicate ask is not written again: the pane's next turn usually produces
 *  the same nudge, and re-notifying an unanswered id every tick is how a channel
 *  gets ignored. */
export async function askGate(args: GateArgs): Promise<GateOutcome> {
	const { config } = args;
	const policy = askPolicyFor(config, args.group);
	const gate = shouldAsk(policy, {
		op: args.decision.op,
		argument: args.decision.argument,
		paneId: args.paneId,
		cwd: args.cwd,
		home: homedir(),
		trail: args.trail,
		triggers: args.triggers,
		promptsSent: args.promptsSent,
		maxPromptsPerTick: config.maxPromptsPerTick,
	});
	if (!gate.ask) return { held: false, policy, why: gate.why, forks: gate.forks };

	if (args.pending.has(pendingKey(args.paneId, args.decision.op, args.decision.argument))) {
		appendEvent(config, {
			kind: "ask_pending",
			paneId: args.paneId,
			group: args.group,
			op: args.decision.op,
			policy,
			why: gate.why,
		});
		return { held: true, policy, why: gate.why, forks: gate.forks };
	}

	const at = new Date(args.nowMs);
	const record: AskRecord = {
		id: askId(`${at.toISOString()}\u0000${args.paneId}\u0000${args.decision.op}\u0000${args.decision.argument}`),
		ts: at.toISOString(),
		paneId: args.paneId,
		group: args.group,
		op: args.decision.op,
		argument: args.decision.argument,
		why: gate.why,
		forks: gate.forks,
		cwd: args.cwd,
		status: "pending",
	};
	appendAsk(config.asksPath, record);
	appendEvent(config, {
		kind: "ask",
		id: record.id,
		paneId: record.paneId,
		group: record.group,
		op: record.op,
		policy,
		why: record.why,
		forks: record.forks,
	});
	await args.notifier.send(askMessage(record), "action").catch(() => undefined);
	return { held: true, policy, why: gate.why, forks: gate.forks, record };
}

/** Worst first: a collision is two agents about to stomp the same files, a blocked
 *  agent cannot free itself, divergence is a claim herdr contradicts, and churn is
 *  the step repetition that burns the most turns. Stable within a kind, so the
 *  scan's own order decides ties. */
const SEVERITY: Record<Trigger["kind"], number> = { collision: 0, blocked: 1, divergence: 2, churn: 3 };

function rankTriggers(triggers: readonly Trigger[]): Trigger[] {
	return triggers
		.map((trigger, index) => ({ trigger, index }))
		.sort((a, b) => SEVERITY[a.trigger.kind] - SEVERITY[b.trigger.kind] || a.index - b.index)
		.map((entry) => entry.trigger);
}

/** Panes one inspection may read: the trigger's own first, then the rest of the
 *  group. A brief that grows with the fleet would cost a terminal read per pane
 *  for evidence nobody asked for. */
const MAX_INSPECTED_PANES = 6;

function triggerScope(trigger: Trigger, agents: readonly HerdrAgent[], claims: ReadonlyMap<string, Claim>): HerdrAgent[] {
	const named: HerdrAgent[] = [];
	for (const paneId of trigger.paneIds) {
		const agent = agents.find((candidate) => candidate.paneId === paneId);
		if (agent) named.push(agent);
	}
	// Every pane the trigger named is always in scope; the cap only limits how many
	// of the group's other panes are read on speculation.
	const room = Math.max(0, MAX_INSPECTED_PANES - named.length);
	const peers = agents
		.filter((agent) => !trigger.paneIds.includes(agent.paneId) && groupOf(agent, claims.get(agent.paneId)) === trigger.group)
		.slice(0, room);
	return [...named, ...peers];
}

async function readTails(scope: readonly HerdrAgent[], port: HerdrPort, config: Config): Promise<Map<string, string>> {
	const tails = new Map<string, string>();
	await pool([...scope], config.concurrency, async (agent) => {
		try {
			tails.set(agent.paneId, await port.read(agent.paneId, config.readLines));
		} catch (e) {
			tails.set(agent.paneId, `(terminal read failed: ${(e as Error).message})`);
		}
	});
	return tails;
}

/** One notification per finding: what the inspector sees and what it suggests,
 *  not a restatement of the trigger that sent it looking. */
function formatFinding(finding: Finding): string {
	const lines = [
		`[inspector] ${finding.trigger.kind} in ${finding.trigger.group} — ${finding.trigger.paneIds.join(", ")}`,
		`what I see: ${finding.diagnosis.slice(0, 400)}`,
		`recommendation: ${finding.recommendation.slice(0, 240)}`,
		`confidence ${finding.confidence.toFixed(2)} · $${finding.costUsd.toFixed(6)} · ${finding.model}`,
	];
	if (finding.proposed) {
		lines.push(`proposed: ${finding.proposed.op}(${finding.proposed.paneId}) ${finding.proposed.argument.slice(0, 200)}`);
	}
	return lines.join("\n");
}

export interface ApplyArgs {
	config: Config;
	notifier: Notifier;
	port: HerdrPort;
	finding: Finding;
	/** The pane's own group: the ask policy is keyed on how grouping named it. */
	group: string;
	/** The pane's own tree, which a nudge may not redirect past. */
	cwd: string;
	/** Every trigger this tick, so the gate sees the forks a decision would see. */
	triggers: readonly Trigger[];
	pending: Set<string>;
	cooldowns: Record<string, number>;
	/** Prompts already sent this tick. */
	promptsSent: number;
	/** The claim on file for the pane, so a done claim keeps its intent. */
	claim: Claim | undefined;
	nowMs: number;
}

export interface ApplyOutcome {
	/** True when the action was parked in asks.jsonl instead of performed. */
	held: boolean;
	prompted: boolean;
	askRecorded: boolean;
}

const NOTHING_APPLIED: ApplyOutcome = { held: false, prompted: false, askRecorded: false };

/** Applies a finding's proposal — and only ever through the gate. A finding is a
 *  decision the inspector happened to make, so it is gated exactly like one: a
 *  held action is written to asks.jsonl and never touches the pane. */
export async function applyFinding(args: ApplyArgs): Promise<ApplyOutcome> {
	const { config, finding } = args;
	const proposed = finding.proposed;
	if (!proposed) return NOTHING_APPLIED;

	const decision: Decision = {
		op: proposed.op,
		argument: proposed.argument,
		confidence: finding.confidence,
		model: finding.model,
		costUsd: finding.costUsd,
		latencyMs: 0,
		refused: false,
		raw: JSON.stringify({ source: "inspector", ...proposed }),
	};

	const policy = askPolicyFor(config, args.group);
	let forks: readonly Fork[] = [];
	// One action row per outcome, from the same forks the gate reported, so "what
	// the inspector proposed" and "what became of it" can never disagree.
	const note = (disposition: ActionDisposition, reason: string, gated: boolean, latencyMs = 0): void => {
		appendMetric(
			config,
			makeAction({
				paneId: proposed.paneId,
				group: args.group,
				op: decision.op,
				disposition,
				reason,
				latencyMs,
				gated,
				policy,
				forkKinds: forkKinds(forks),
				forkSeverities: forkSeverities(forks),
			}),
		);
	};

	// flag is already a request for a human, so it is reported rather than gated:
	// holding it would mean holding a notification, and the finding's own
	// notification has already carried the text.
	if (decision.op === "flag") {
		appendEvent(config, {
			kind: "inspector_flag",
			paneId: proposed.paneId,
			group: args.group,
			text: decision.argument,
			decision: describeDecision(decision),
		});
		// A flag changes nothing in the pane, so it is not a gated action either.
		note("skipped", "flag-reported", false);
		return NOTHING_APPLIED;
	}

	const gate = await askGate({
		config,
		notifier: args.notifier,
		decision,
		trail: [decision],
		triggers: args.triggers,
		paneId: proposed.paneId,
		group: args.group,
		cwd: args.cwd,
		promptsSent: args.promptsSent,
		pending: args.pending,
		nowMs: args.nowMs,
	});
	const askRecorded = gate.record !== undefined;
	forks = gate.forks;
	if (gate.record) args.pending.add(pendingKey(proposed.paneId, decision.op, decision.argument));
	if (gate.held) {
		note("held", "gate", true);
		return { held: true, prompted: false, askRecorded };
	}

	if (decision.op === "declare_done") {
		if (!config.dry) {
			const base = args.claim;
			const claim: Claim = {
				paneId: proposed.paneId,
				cwd: args.cwd,
				intent: base?.intent ?? "",
				phase: "idle",
				state: "done",
				last: decision.argument,
				updated: new Date().toISOString(),
			};
			if (base?.group) claim.group = base.group;
			if (base?.acceptance) claim.acceptance = base.acceptance;
			if (base?.budget) claim.budget = base.budget;
			writeClaim(claim);
		}
		appendEvent(config, { kind: "inspector_done", paneId: proposed.paneId, group: args.group, text: decision.argument, policy: gate.policy, why: gate.why, dry: config.dry });
		note(config.dry ? "dry" : "sent", config.dry ? "dry" : "ok", true);
		return { held: false, prompted: false, askRecorded };
	}

	// nudge
	if (args.nowMs - (args.cooldowns[proposed.paneId] ?? 0) < config.nudgeCooldownMin * 60_000) {
		appendEvent(config, { kind: "inspector_skipped", paneId: proposed.paneId, reason: "cooldown" });
		note("skipped", "cooldown", false);
		return { held: false, prompted: false, askRecorded };
	}
	if (args.promptsSent >= config.maxPromptsPerTick) {
		appendEvent(config, { kind: "inspector_nudge_capped", paneId: proposed.paneId, text: decision.argument, policy: gate.policy, why: gate.why });
		note("skipped", "capped", true);
		return { held: false, prompted: false, askRecorded };
	}
	if (config.dry) {
		appendEvent(config, {
			kind: "inspector_dry",
			paneId: proposed.paneId,
			text: decision.argument,
			decision: describeDecision(decision),
			policy: gate.policy,
			why: gate.why,
		});
		note("dry", "dry", true);
		return { held: false, prompted: false, askRecorded };
	}
	const promptStarted = Date.now();
	const sent = await args.port.prompt(proposed.paneId, decision.argument);
	if (sent.disposition === "rejected") {
		appendEvent(config, { kind: "inspector_rejected", paneId: proposed.paneId, reason: sent.reason ?? "unknown" });
		note("rejected", sent.reason ?? "unknown", true, elapsed(promptStarted));
		return { held: false, prompted: false, askRecorded };
	}
	args.cooldowns[proposed.paneId] = args.nowMs;
	appendEvent(config, {
		kind: "inspector_nudge",
		paneId: proposed.paneId,
		group: args.group,
		text: decision.argument,
		decision: describeDecision(decision),
		policy: gate.policy,
		why: gate.why,
	});
	note("sent", "ok", true, elapsed(promptStarted));
	return { held: false, prompted: true, askRecorded };
}

export async function tick(deps: Deps): Promise<TickReport> {
	const { port, notifier, config } = deps;
	const nowMs = deps.now ?? Date.now;
	// One clock read for the tick's own duration, which is what "is a pass getting
	// slower" is measured from.
	const tickStartedAt = Date.now();

	const agents = await port.list();

	// The daily cap, checked before the first model call and before the bookkeeping
	// that would otherwise record a decision nobody paid for. A capped tick is one
	// `agent list` call, one row, and at most one notification.
	//
	// `models: []` on the row is how a reader tells that nothing was consulted, and no
	// `decision` row is written for this tick, because a decision row for a call that
	// was not made is the lie the quota case already rules out (SPEC §4.9b).
	//
	// The marks are deliberately left alone: the panes that moved are still undecided,
	// and saving their movement here would spend the decision on a tick that could not
	// make it, so the next tick with money left would find nothing to decide.
	const spend = dailySpend(config.eventsPath, nowMs());
	if (config.dailyCostCapUsd > 0 && spend.spentUsd >= config.dailyCostCapUsd) {
		const capReason = `daily spend cap reached: $${spend.spentUsd.toFixed(6)} spent today against a $${config.dailyCostCapUsd.toFixed(2)} cap (AGENTFLEET_DAILY_COST_CAP_USD)`;
		// Once a day, not once a tick: at a 60 s interval the letter of "notify once per
		// tick" is 1,440 messages saying the same thing by midnight, which is a channel
		// the operator stops reading exactly when it matters. The first capped row is
		// the marker, and every later tick of the day is silent.
		if (!spend.notified) {
			await notifier.send(`fleet: ${capReason}. No model calls until tomorrow; raise the cap to resume sooner.`, "alert").catch(() => undefined);
		}
		appendMetric(
			config,
			makeTick({
				agents: agents.length,
				moved: 0,
				decisions: 0,
				escalated: 0,
				escalationFailed: 0,
				triggers: 0,
				inspected: 0,
				prompts: 0,
				held: 0,
				costUsd: 0,
				durationMs: elapsed(tickStartedAt),
				models: [],
				dry: config.dry,
				capped: true,
				capReason,
				dailyCostUsd: spend.spentUsd,
				dailyCostCapUsd: config.dailyCostCapUsd,
			}),
		);
		return {
			agents: agents.length,
			moved: 0,
			decisions: [],
			triggers: [],
			inspected: 0,
			promptsSent: 0,
			asks: 0,
			escalated: 0,
			escalationFailed: 0,
			costUsd: 0,
			dry: config.dry,
			capped: true,
			dailyCostUsd: spend.spentUsd,
			dailyCostCapUsd: config.dailyCostCapUsd,
		};
	}
	const claims = readClaims();
	const marks: Marks = loadMarks();
	const { moves, marks: nextMarks } = detect(agents, marks);

	const idleTicks = new Map(Object.entries(nextMarks).map(([pane, mark]) => [pane, mark.idleTicks]));

	// Outcome judging, before this tick's own decisions are recorded. The order is
	// the point: a decision taken further down carries the pane's current sequence
	// as its baseline, so the movement that prompted it can never be read as its
	// answer. Dry is a rehearsal — its snapshot is real, its decisions are not — so
	// it neither judges nor records, and leaves none of its own state behind.
	const outcomeState = config.dry ? { open: new Map<string, PendingDecision>(), judged: 0 } : judgeOpen(config, agents, idleTicks);
	let pendingOutcomes = outcomeState.open;
	// Only a decision recorded below has to be written at the end of the tick: the
	// judged set was already persisted by `judgeOpen`.
	let pendingDirty = false;
	const history = readJson<Record<string, ClaimHistory>>(config.triggerHistoryPath, {});
	const historyMap = new Map(Object.entries(history));
	const { triggers, history: nextHistory } = scanTriggers(agents, claims, idleTicks, historyMap);

	const cooldowns = readJson<Record<string, number>>(config.cooldownsPath, {});
	const built = deps.models ? { ...deps.models, falsifier: deps.models.escalator, degraded: undefined } : buildLadderModels(config);
	const { primary, escalator, falsifier, degraded } = built;
	const report: TickReport = { agents: agents.length, moved: moves.length, decisions: [], triggers, inspected: 0, promptsSent: 0, asks: 0, escalated: 0, escalationFailed: 0, costUsd: 0, dry: config.dry, capped: false, dailyCostUsd: spend.spentUsd, dailyCostCapUsd: config.dailyCostCapUsd };
	const pending = pendingAsks(readAskLog(config.asksPath));

	if (degraded) await notifier.send(degraded, "alert").catch(() => undefined);

	// Per-agent decisions only for panes that moved this tick.
	const decided = await pool(moves, config.concurrency, async (move) => {
		const claim = claims.get(move.paneId);
		let tail = "";
		try {
			tail = await port.read(move.paneId, config.readLines);
		} catch (e) {
			tail = `(terminal read failed: ${(e as Error).message})`;
		}
		const input = toInput(move.agent, claim, tail, move.idleTicks);
		const result = await decideWithEscalation(input, { primary, escalator: falsifier, triggers });
		return { move, claim, input, result };
	});

	const models = new Set<string>();

	for (const entry of decided) {
		report.decisions.push(entry.result.decision);
		report.costUsd += entry.result.trail.reduce((sum, d) => sum + d.costUsd, 0);
		if (entry.result.escalated) report.escalated += 1;
		if (entry.result.escalationFailed === true) report.escalationFailed += 1;

		const decision = entry.result.decision;
		const group = groupOf(entry.move.agent, entry.claim);
		const cwd = entry.move.agent.foregroundCwd || entry.move.agent.cwd;
		// Read once and written on both rows, so a decision and its action can never
		// record different policies.
		const policy = askPolicyFor(config, group);
		for (const consulted of entry.result.trail) models.add(consulted.model);
		recordClaim(config, entry.move.agent, entry.claim, group);

		/** How far this decision's action got. Undefined for `leave`, which is not one. */
		let action: { disposition: ActionDisposition; reason: string; latencyMs: number; gated: boolean } | undefined;
		let forks: readonly Fork[] = [];

		// Every would-be action goes through the gate first. `held` means the action
		// is parked in asks.jsonl and the operator has to release it — it is never
		// performed and then mentioned.
		const gated = async (): Promise<GateOutcome> => {
			const outcome = await askGate({
				config,
				notifier,
				decision,
				trail: entry.result.trail,
				triggers,
				paneId: entry.move.paneId,
				group,
				cwd,
				promptsSent: report.promptsSent,
				pending,
				nowMs: nowMs(),
			});
			if (outcome.record) {
				report.asks += 1;
				pending.add(pendingKey(entry.move.paneId, decision.op, decision.argument));
			}
			return outcome;
		};

		if (decision.op === "leave") {
			appendEvent(config, { kind: "decision", paneId: entry.move.paneId, group, decision: describeDecision(decision), escalated: entry.result.escalated, escalationFailed: entry.result.escalationFailed === true });
		} else if (decision.op === "flag") {
			// flag is already a request for a human, so it is reported rather than
			// gated: holding it would mean holding a notification.
			appendEvent(config, { kind: "flag", paneId: entry.move.paneId, group, text: decision.argument, decision: describeDecision(decision) });
			await notifier.send(`${entry.move.paneId} (${group}) needs a decision\n${decision.argument}`, "alert").catch(() => undefined);
			action = { disposition: "skipped", reason: "flag-reported", latencyMs: 0, gated: false };
		} else if (decision.op === "declare_done") {
			const gate = await gated();
			forks = gate.forks;
			if (gate.held) {
				action = { disposition: "held", reason: "gate", latencyMs: 0, gated: true };
			} else {
				if (!config.dry) {
					const base = entry.claim;
					const claim: Claim = {
						paneId: entry.move.paneId,
						cwd,
						intent: base?.intent ?? entry.move.agent.title,
						phase: "idle",
						state: "done",
						last: decision.argument,
						updated: new Date().toISOString(),
					};
					if (base?.group) claim.group = base.group;
					if (base?.acceptance) claim.acceptance = base.acceptance;
					if (base?.budget) claim.budget = base.budget;
					writeClaim(claim);
				}
				appendEvent(config, { kind: "done", paneId: entry.move.paneId, group, text: decision.argument, policy: gate.policy, why: gate.why });
				await notifier.send(`${entry.move.paneId} (${group}) finished\n${decision.argument}`, "info").catch(() => undefined);
				action = { disposition: config.dry ? "dry" : "sent", reason: config.dry ? "dry" : "ok", latencyMs: 0, gated: true };
			}
		} else {
			// nudge
			const lastPrompt = cooldowns[entry.move.paneId] ?? 0;
			const cooling = nowMs() - lastPrompt < config.nudgeCooldownMin * 60_000;
			if (cooling) {
				appendEvent(config, { kind: "nudge_skipped", paneId: entry.move.paneId, reason: "cooldown" });
				action = { disposition: "skipped", reason: "cooldown", latencyMs: 0, gated: false };
			} else {
				const gate = await gated();
				forks = gate.forks;
				if (gate.held) {
					action = { disposition: "held", reason: "gate", latencyMs: 0, gated: true };
				} else if (report.promptsSent >= config.maxPromptsPerTick) {
					appendEvent(config, { kind: "nudge_capped", paneId: entry.move.paneId, text: decision.argument, policy: gate.policy, why: gate.why });
					action = { disposition: "skipped", reason: "capped", latencyMs: 0, gated: true };
				} else if (config.dry) {
					appendEvent(config, { kind: "nudge_dry", paneId: entry.move.paneId, text: decision.argument, decision: describeDecision(decision), policy: gate.policy, why: gate.why });
					action = { disposition: "dry", reason: "dry", latencyMs: 0, gated: true };
				} else {
					const promptStarted = Date.now();
					const sent = await port.prompt(entry.move.paneId, decision.argument);
					const latencyMs = elapsed(promptStarted);
					report.promptsSent += 1;
					if (sent.disposition === "rejected") {
						appendEvent(config, { kind: "nudge_rejected", paneId: entry.move.paneId, reason: sent.reason ?? "unknown" });
						await notifier.send(`${entry.move.paneId} refused the prompt (${sent.reason ?? "unknown"}) — it needs you`, "alert").catch(() => undefined);
						action = { disposition: "rejected", reason: sent.reason ?? "unknown", latencyMs, gated: true };
					} else {
						cooldowns[entry.move.paneId] = nowMs();
						appendEvent(config, { kind: "nudge", paneId: entry.move.paneId, group, text: decision.argument, decision: describeDecision(decision), policy: gate.policy, why: gate.why });
						action = { disposition: "sent", reason: "ok", latencyMs, gated: true };
					}
				}
			}
		}

		appendMetric(
			config,
			makeDecision({
				paneId: entry.move.paneId,
				group,
				model: decision.model,
				op: decision.op,
				confidence: decision.confidence,
				refused: decision.refused,
				escalated: entry.result.escalated,
				escalationFailed: entry.result.escalationFailed === true,
				latencyMs: decision.latencyMs,
				costUsd: decision.costUsd,
				policy,
				held: action?.disposition === "held",
				decision: describeDecision(decision),
			}),
		);
		if (action) {
			appendMetric(
				config,
				makeAction({
					paneId: entry.move.paneId,
					group,
					op: decision.op,
					disposition: action.disposition,
					reason: action.reason,
					latencyMs: action.latencyMs,
					gated: action.gated,
					policy,
					forkKinds: forkKinds(forks),
					forkSeverities: forkSeverities(forks),
				}),
			);
		}

		// Only a decision that reached the pane is worth judging. A held action
		// waited for the operator, a skipped one never happened and a rejected one
		// was refused by herdr before any input: judging any of them would read the
		// operator's delay or the transport's refusal as the agent's answer. The
		// silent ops asked for nothing, so their absence of an action is the point —
		// and `flag` writes a `skipped` row precisely because a human notification is
		// not an instruction to the pane.
		if (!config.dry && (isSilent(decision.op) || action?.disposition === "sent")) {
			pendingOutcomes = recordPending(pendingOutcomes, decidedAt({ paneId: entry.move.paneId, group, op: decision.op, argument: decision.argument }, entry.move.agent.completionSeq));
			pendingDirty = true;
		}
	}

	for (const trigger of triggers) {
		appendEvent(config, { kind: `trigger:${trigger.kind}`, group: trigger.group, paneIds: trigger.paneIds, detail: trigger.detail });
		appendMetric(config, makeTrigger({ triggerKind: trigger.kind, group: trigger.group, paneIds: trigger.paneIds, detail: trigger.detail }));
	}

	// Tier 2. A trigger is a question, not an announcement: the worst
	// `maxInspectionsPerTick` of them are investigated and the rest are named in the
	// log, so a fleet-wide flap cannot become a fleet-wide spend. The inspector
	// itself never acts — anything it proposes goes through the gate below.
	if (config.inspector === "off") {
		for (const trigger of triggers) {
			// Churn was log-only before Tier 2 and stays log-only with the inspector off.
			if (trigger.kind === "churn") continue;
			await notifier.send(`[${trigger.kind}] ${trigger.group}: ${trigger.detail}`, "action").catch(() => undefined);
		}
	} else {
		const ranked = rankTriggers(triggers);
		const inspecting = ranked.slice(0, Math.max(0, config.maxInspectionsPerTick));
		if (inspecting.length < ranked.length) {
			appendEvent(config, {
				kind: "inspections_capped",
				triggers: ranked.length,
				inspected: inspecting.length,
				skipped: ranked.slice(inspecting.length).map((trigger) => `${trigger.kind}:${trigger.group}`),
			});
			await notifier
				.send(
					`${ranked.length} triggers fired, ${inspecting.length} inspected (cap ${config.maxInspectionsPerTick}): ${ranked
						.slice(inspecting.length)
						.map((trigger) => `${trigger.kind} ${trigger.group}`)
						.join(", ")}`,
					"info",
				)
				.catch(() => undefined);
		}

		for (const trigger of inspecting) {
			const scope = triggerScope(trigger, agents, claims);
			// Tails are read before the clock starts: the inspection's latency is the
			// model's, and a terminal read is not the thing being measured.
			const tails = await readTails(scope, port, config);
			const inspectionStarted = Date.now();
			const finding = await inspect(trigger, {
				agents: scope,
				claims,
				tails,
				model: escalator,
				deep: config.inspector === "deep",
			});

			report.inspected += 1;
			report.costUsd += finding.costUsd;
			models.add(finding.model);
			appendEvent(config, {
				kind: "inspector",
				trigger: finding.trigger.kind,
				group: finding.trigger.group,
				paneIds: finding.trigger.paneIds,
				diagnosis: finding.diagnosis,
				recommendation: finding.recommendation,
				confidence: Number(finding.confidence.toFixed(2)),
				costUsd: Number(finding.costUsd.toFixed(6)),
				model: finding.model,
				evidence: finding.evidence,
				proposed: finding.proposed ?? null,
			});
			appendMetric(
				config,
				makeInspection({
					triggerKind: finding.trigger.kind,
					group: finding.trigger.group,
					paneIds: finding.trigger.paneIds,
					mode: finding.mode,
					model: finding.model,
					confidence: finding.confidence,
					costUsd: finding.costUsd,
					latencyMs: elapsed(inspectionStarted),
					proposed: finding.proposed !== undefined,
					degraded: finding.degraded,
				}),
			);
			await notifier.send(formatFinding(finding), "action").catch(() => undefined);

			const proposed = finding.proposed;
			if (!proposed) continue;
			const target = agents.find((agent) => agent.paneId === proposed.paneId);
			const outcome = await applyFinding({
				config,
				notifier,
				port,
				finding,
				group: target ? groupOf(target, claims.get(target.paneId)) : trigger.group,
				cwd: target ? target.foregroundCwd || target.cwd : "",
				triggers,
				pending,
				cooldowns,
				promptsSent: report.promptsSent,
				claim: claims.get(proposed.paneId),
				nowMs: nowMs(),
			});
			if (outcome.prompted) report.promptsSent += 1;
			if (outcome.askRecorded) report.asks += 1;
		}
	}

	if (config.watchdog) {
		try {
			const findings = await watchdogScan();
			for (const { sample, verdict } of findings) {
				// One row, not two: the watchdog's fields are the same fields the metric
				// schema names, so the legacy line gains `schema` and `stalled` rather
				// than being duplicated beside a structured copy of itself.
				appendMetric(config, makeWatchdog(findingFields(sample, verdict)));
				await notifier.send(`[${verdict.rule}] pid ${sample.pid} running ${formatAge(sample.elapsedMs)}\n${verdict.why}\n${sample.command.slice(0, 160)}`, "action").catch(() => undefined);
			}
		} catch (e) {
			appendEvent(config, { kind: "watchdog_error", error: (e as Error).message });
		}
	}

	if (!config.dry) saveMarks(nextMarks);
	writeJson(config.triggerHistoryPath, Object.fromEntries(nextHistory));
	writeJson(config.cooldownsPath, cooldowns);
	// Written only when it changed: a rewrite with nothing to say is a file whose
	// mtime lies about when the fleet last moved.
	if (pendingDirty) writeJson(pendingPath(config.eventsPath), pendingJson(pendingOutcomes));
	// This row is the tick's own denominator: the same numbers as before, plus how
	// long the pass took, which models it actually consulted, and where the day's
	// spend stands — with the cap that produced it — so "is a tick getting slower or
	// more expensive" is a question about this row and not about the sum of everything
	// else.
	report.dailyCostUsd = spend.spentUsd + report.costUsd;
	appendMetric(
		config,
		makeTick({
			agents: report.agents,
			moved: report.moved,
			decisions: report.decisions.length,
			escalated: report.escalated,
			escalationFailed: report.escalationFailed,
			triggers: report.triggers.length,
			inspected: report.inspected,
			prompts: report.promptsSent,
			held: report.asks,
			costUsd: Number(report.costUsd.toFixed(6)),
			durationMs: elapsed(tickStartedAt),
			models: [...models].sort(),
			dry: config.dry,
			dailyCostUsd: Number(report.dailyCostUsd.toFixed(6)),
			...(config.dailyCostCapUsd > 0 ? { dailyCostCapUsd: config.dailyCostCapUsd } : {}),
		}),
	);
	return report;
}

async function main(): Promise<void> {
	const config = loadConfig();
	const notifier = defaultNotifier();
	const port = herdrPort();

	do {
		try {
			const report = await tick({ port, notifier, config });
			console.error(
				`fleet tick: ${report.agents} agents, ${report.moved} moved, ${report.decisions.length} decisions, ${report.triggers.length} triggers, ${report.inspected} inspected, ${report.escalated} escalated, ${report.escalationFailed} escalations failed, ${report.promptsSent} prompts, ${report.asks} held, $${report.costUsd.toFixed(6)}${report.dailyCostCapUsd > 0 ? ` · cap $${report.dailyCostCapUsd.toFixed(2)}/day · spent $${report.dailyCostUsd.toFixed(6)}` : ""}${report.capped ? " · capped" : ""}${report.dry ? " (dry)" : ""}`,
			);
		} catch (e) {
			const message = `fleet tick failed: ${(e as Error).message}`;
			console.error(message);
			await notifier.send(message, "alert").catch(() => undefined);
		}
		if (config.once) return;
		await new Promise((r) => setTimeout(r, config.intervalMs));
	} while (true);
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
	void main();
}
