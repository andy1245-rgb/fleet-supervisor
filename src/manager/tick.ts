// One supervisor tick: observe, decide who moved, ask or act, record.
//
// Cost discipline lives in the ladder: a decision call happens only for an agent
// whose sequence numbers advanced, and the escalator only for cases the primary
// refused or scored low. Everything else is one `agent list` call.
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
import { decideWithEscalation } from "../decision/ladder.ts";
import { needleModel } from "../decision/needle.ts";
import { openRouterModel } from "../decision/openrouter.ts";
import type { Decision, DecisionInput, DecisionModel } from "../decision/types.ts";
import { defaultNotifier, type Notifier } from "../notify/telegram.ts";
import { scanTriggers, type ClaimHistory, type Trigger } from "./triggers.ts";
import { scan as watchdogScan, formatAge } from "../watchdog/rules.ts";
import { appendAsk, pendingAsks, pendingKey, readAskLog } from "./answer.ts";
import { askId, shouldAsk, type AskPolicy, type AskRecord } from "./ask.ts";
import { askPolicyFor, loadConfig, type Config } from "./config.ts";
import { inspect, type Finding } from "./inspector.ts";

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

/** Maps a config model name to an adapter. */
export function buildModel(name: string): DecisionModel {
	const trimmed = name.trim();
	if (trimmed === "needle3" || trimmed === "needle") return needleModel();
	const model = trimmed.startsWith("openrouter:") ? trimmed.slice("openrouter:".length) : trimmed;
	return openRouterModel({ model });
}

/** Builds the pair the ladder needs, degrading to the escalator alone when the
 *  local engine is unavailable — a missing venv must not stop the supervisor. */
export function buildLadderModels(config: Config): { primary: DecisionModel; escalator: DecisionModel; degraded?: string } {
	const escalator = buildModel(config.escalator);
	if (config.primary === config.escalator) return { primary: escalator, escalator };
	try {
		return { primary: buildModel(config.primary), escalator };
	} catch (e) {
		return { primary: escalator, escalator, degraded: `primary ${config.primary} unavailable: ${(e as Error).message}` };
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
	if (!gate.ask) return { held: false, policy, why: gate.why };

	if (args.pending.has(pendingKey(args.paneId, args.decision.op, args.decision.argument))) {
		appendEvent(config, {
			kind: "ask_pending",
			paneId: args.paneId,
			group: args.group,
			op: args.decision.op,
			policy,
			why: gate.why,
		});
		return { held: true, policy, why: gate.why };
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
	await args.notifier.send(askMessage(record), "action");
	return { held: true, policy, why: gate.why, record };
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
	if (gate.record) args.pending.add(pendingKey(proposed.paneId, decision.op, decision.argument));
	if (gate.held) return { held: true, prompted: false, askRecorded };

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
		return { held: false, prompted: false, askRecorded };
	}

	// nudge
	if (args.nowMs - (args.cooldowns[proposed.paneId] ?? 0) < config.nudgeCooldownMin * 60_000) {
		appendEvent(config, { kind: "inspector_skipped", paneId: proposed.paneId, reason: "cooldown" });
		return { held: false, prompted: false, askRecorded };
	}
	if (args.promptsSent >= config.maxPromptsPerTick) {
		appendEvent(config, { kind: "inspector_nudge_capped", paneId: proposed.paneId, text: decision.argument, policy: gate.policy, why: gate.why });
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
		return { held: false, prompted: false, askRecorded };
	}
	const sent = await args.port.prompt(proposed.paneId, decision.argument);
	if (sent.disposition === "rejected") {
		appendEvent(config, { kind: "inspector_rejected", paneId: proposed.paneId, reason: sent.reason ?? "unknown" });
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
	return { held: false, prompted: true, askRecorded };
}

export async function tick(deps: Deps): Promise<TickReport> {
	const { port, notifier, config } = deps;
	const nowMs = deps.now ?? Date.now;

	const agents = await port.list();
	const claims = readClaims();
	const marks: Marks = loadMarks();
	const { moves, marks: nextMarks } = detect(agents, marks);

	const idleTicks = new Map(Object.entries(nextMarks).map(([pane, mark]) => [pane, mark.idleTicks]));
	const history = readJson<Record<string, ClaimHistory>>(config.triggerHistoryPath, {});
	const historyMap = new Map(Object.entries(history));
	const { triggers, history: nextHistory } = scanTriggers(agents, claims, idleTicks, historyMap);

	const cooldowns = readJson<Record<string, number>>(config.cooldownsPath, {});
	const built = deps.models ? { ...deps.models, degraded: undefined } : buildLadderModels(config);
	const { primary, escalator, degraded } = built;
	const report: TickReport = { agents: agents.length, moved: moves.length, decisions: [], triggers, inspected: 0, promptsSent: 0, asks: 0, escalated: 0, escalationFailed: 0, costUsd: 0, dry: config.dry };
	const pending = pendingAsks(readAskLog(config.asksPath));

	if (degraded) await notifier.send(degraded, "alert");

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
		const result = await decideWithEscalation(input, { primary, escalator, threshold: config.threshold });
		return { move, claim, input, result };
	});

	for (const entry of decided) {
		report.decisions.push(entry.result.decision);
		report.costUsd += entry.result.trail.reduce((sum, d) => sum + d.costUsd, 0);
		if (entry.result.escalated) report.escalated += 1;
		if (entry.result.escalationFailed === true) report.escalationFailed += 1;

		const decision = entry.result.decision;
		const group = groupOf(entry.move.agent, entry.claim);
		const cwd = entry.move.agent.foregroundCwd || entry.move.agent.cwd;

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
			continue;
		}

		// flag is already a request for a human, so it is reported rather than gated:
		// holding it would mean holding a notification.
		if (decision.op === "flag") {
			appendEvent(config, { kind: "flag", paneId: entry.move.paneId, group, text: decision.argument, decision: describeDecision(decision) });
			await notifier.send(`${entry.move.paneId} (${group}) needs a decision\n${decision.argument}`, "alert");
			continue;
		}

		if (decision.op === "declare_done") {
			const gate = await gated();
			if (gate.held) continue;
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
			await notifier.send(`${entry.move.paneId} (${group}) finished\n${decision.argument}`, "info");
			continue;
		}

		// nudge
		const lastPrompt = cooldowns[entry.move.paneId] ?? 0;
		const cooling = nowMs() - lastPrompt < config.nudgeCooldownMin * 60_000;
		if (cooling) {
			appendEvent(config, { kind: "nudge_skipped", paneId: entry.move.paneId, reason: "cooldown" });
			continue;
		}
		const gate = await gated();
		if (gate.held) continue;
		if (report.promptsSent >= config.maxPromptsPerTick) {
			appendEvent(config, { kind: "nudge_capped", paneId: entry.move.paneId, text: decision.argument, policy: gate.policy, why: gate.why });
			continue;
		}
		if (config.dry) {
			appendEvent(config, { kind: "nudge_dry", paneId: entry.move.paneId, text: decision.argument, decision: describeDecision(decision), policy: gate.policy, why: gate.why });
			continue;
		}
		const sent = await port.prompt(entry.move.paneId, decision.argument);
		report.promptsSent += 1;
		if (sent.disposition === "rejected") {
			appendEvent(config, { kind: "nudge_rejected", paneId: entry.move.paneId, reason: sent.reason ?? "unknown" });
			await notifier.send(`${entry.move.paneId} refused the prompt (${sent.reason ?? "unknown"}) — it needs you`, "alert");
			continue;
		}
		cooldowns[entry.move.paneId] = nowMs();
		appendEvent(config, { kind: "nudge", paneId: entry.move.paneId, group, text: decision.argument, decision: describeDecision(decision), policy: gate.policy, why: gate.why });
	}

	for (const trigger of triggers) {
		appendEvent(config, { kind: `trigger:${trigger.kind}`, group: trigger.group, paneIds: trigger.paneIds, detail: trigger.detail });
	}

	// Tier 2. A trigger is a question, not an announcement: the worst
	// `maxInspectionsPerTick` of them are investigated and the rest are named in the
	// log, so a fleet-wide flap cannot become a fleet-wide spend. The inspector
	// itself never acts — anything it proposes goes through the gate below.
	if (config.inspector === "off") {
		for (const trigger of triggers) {
			// Churn was log-only before Tier 2 and stays log-only with the inspector off.
			if (trigger.kind === "churn") continue;
			await notifier.send(`[${trigger.kind}] ${trigger.group}: ${trigger.detail}`, "action");
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
			await notifier.send(
				`${ranked.length} triggers fired, ${inspecting.length} inspected (cap ${config.maxInspectionsPerTick}): ${ranked
					.slice(inspecting.length)
					.map((trigger) => `${trigger.kind} ${trigger.group}`)
					.join(", ")}`,
				"info",
			);
		}

		for (const trigger of inspecting) {
			const scope = triggerScope(trigger, agents, claims);
			const finding = await inspect(trigger, {
				agents: scope,
				claims,
				tails: await readTails(scope, port, config),
				model: escalator,
				deep: config.inspector === "deep",
			});

			report.inspected += 1;
			report.costUsd += finding.costUsd;
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
			await notifier.send(formatFinding(finding), "action");

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
				appendEvent(config, { kind: "watchdog", pid: sample.pid, rule: verdict.rule, command: sample.command.slice(0, 200), ageMs: sample.elapsedMs });
				await notifier.send(`[${verdict.rule}] pid ${sample.pid} running ${formatAge(sample.elapsedMs)}\n${verdict.why}\n${sample.command.slice(0, 160)}`, "action");
			}
		} catch (e) {
			appendEvent(config, { kind: "watchdog_error", error: (e as Error).message });
		}
	}

	if (!config.dry) saveMarks(nextMarks);
	writeJson(config.triggerHistoryPath, Object.fromEntries(nextHistory));
	writeJson(config.cooldownsPath, cooldowns);
	appendEvent(config, {
		kind: "tick",
		agents: report.agents,
		moved: report.moved,
		decisions: report.decisions.length,
		escalated: report.escalated,
		escalationFailed: report.escalationFailed,
		prompts: report.promptsSent,
		asks: report.asks,
		costUsd: Number(report.costUsd.toFixed(6)),
		triggers: report.triggers.length,
		inspected: report.inspected,
	});
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
				`fleet tick: ${report.agents} agents, ${report.moved} moved, ${report.decisions.length} decisions, ${report.triggers.length} triggers, ${report.inspected} inspected, ${report.escalated} escalated, ${report.escalationFailed} escalations failed, ${report.promptsSent} prompts, ${report.asks} held, $${report.costUsd.toFixed(6)}${report.dry ? " (dry)" : ""}`,
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
