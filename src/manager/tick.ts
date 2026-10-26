// One supervisor tick: observe, decide who moved, act, record.
//
// Cost discipline lives in the ladder: a decision call happens only for an agent
// whose sequence numbers advanced, and the escalator only for cases the primary
// refused or scored low. Everything else is one `agent list` call.

import { appendFileSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
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
import { loadConfig, type Config } from "./config.ts";

export interface TickReport {
	agents: number;
	moved: number;
	decisions: Decision[];
	triggers: Trigger[];
	promptsSent: number;
	escalated: number;
	costUsd: number;
	dry: boolean;
}

export interface Deps {
	port: HerdrPort;
	notifier: Notifier;
	config: Config;
	now?: () => number;
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
	const { primary, escalator, degraded } = buildLadderModels(config);
	const report: TickReport = { agents: agents.length, moved: moves.length, decisions: [], triggers, promptsSent: 0, escalated: 0, costUsd: 0, dry: config.dry };

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

		const decision = entry.result.decision;
		const group = groupOf(entry.move.agent, entry.claim);

		if (decision.op === "leave") {
			appendEvent(config, { kind: "decision", paneId: entry.move.paneId, group, decision: describeDecision(decision), escalated: entry.result.escalated });
			continue;
		}

		if (decision.op === "flag") {
			appendEvent(config, { kind: "flag", paneId: entry.move.paneId, group, text: decision.argument, decision: describeDecision(decision) });
			await notifier.send(`${entry.move.paneId} (${group}) needs a decision\n${decision.argument}`, "alert");
			continue;
		}

		if (decision.op === "declare_done") {
			if (!config.dry) {
				const base = entry.claim;
				const claim: Claim = {
					paneId: entry.move.paneId,
					cwd: entry.move.agent.foregroundCwd || entry.move.agent.cwd,
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
			appendEvent(config, { kind: "done", paneId: entry.move.paneId, group, text: decision.argument });
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
		if (report.promptsSent >= config.maxPromptsPerTick) {
			appendEvent(config, { kind: "nudge_capped", paneId: entry.move.paneId, text: decision.argument });
			continue;
		}
		if (config.dry) {
			appendEvent(config, { kind: "nudge_dry", paneId: entry.move.paneId, text: decision.argument, decision: describeDecision(decision) });
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
		appendEvent(config, { kind: "nudge", paneId: entry.move.paneId, group, text: decision.argument, decision: describeDecision(decision) });
	}

	for (const trigger of triggers) {
		appendEvent(config, { kind: `trigger:${trigger.kind}`, group: trigger.group, paneIds: trigger.paneIds, detail: trigger.detail });
		if (trigger.kind === "collision" || trigger.kind === "divergence" || trigger.kind === "blocked") {
			await notifier.send(`[${trigger.kind}] ${trigger.group}: ${trigger.detail}`, "action");
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
		prompts: report.promptsSent,
		costUsd: Number(report.costUsd.toFixed(6)),
		triggers: report.triggers.length,
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
				`fleet tick: ${report.agents} agents, ${report.moved} moved, ${report.decisions.length} decisions, ${report.escalated} escalated, ${report.promptsSent} prompts, $${report.costUsd.toFixed(6)}${report.dry ? " (dry)" : ""}`,
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
