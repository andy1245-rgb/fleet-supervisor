// Tier 2: the inspector. A trigger says a group needs a look; this module says
// what is actually wrong and what to do about it — without doing it.
//
// The inspector never touches a pane. It assembles a brief, asks one model, and
// returns a Finding. When a finding implies an action, that action is a normal
// proposed action handed to ./ask.ts exactly as a decision's would be, so the
// fleet still has exactly one place that prompts and exactly one policy that
// decides whether to ask first. Report-only plus the gate.
//
// Two modes, chosen by the caller:
//   cheap (default) — one call on the model interface the ladder already uses.
//   deep            — one bounded `pi -p` child that can run herdr itself.
// Deep is opt-in because it is the expensive one. A spawn failure or a prose
// answer is a fallback to cheap, never an error: the supervisor keeps running.

import { spawn } from "node:child_process";
import { isOp, type DecisionInput, type DecisionModel, type Decision, type Op } from "../decision/types.ts";
import { groupOf } from "../fleet/groups.ts";
import type { Claim } from "../fleet/registry.ts";
import type { HerdrAgent } from "../herdr/types.ts";
import type { Trigger } from "./triggers.ts";

/** Characters of brief one inspection may cost. The trigger's panes and their
 *  tails fit comfortably; a trigger storm cannot make one brief unbounded. */
export const BRIEF_BUDGET = 6000;

/** A deep inspection that outlives this is killed: a hung child must not stall
 *  the tick that is supposed to keep the fleet moving. */
export const DEEP_TIMEOUT_MS = 120_000;

/** Evidence quotes kept, and their width, so `evidence` stays readable in a
 *  message instead of turning into a second transcript. */
const MAX_EVIDENCE = 6;
const MAX_EVIDENCE_CHARS = 300;

/** Tail budget weight by distance from the trigger. A pane the trigger named
 *  keeps three times the tail of a pane that is only in the same group, so a
 *  crowded brief loses the edges first and the evidence last. */
const NEAR_WEIGHT = 3;
const FAR_WEIGHT = 1;

/** Keys that identify a JSON object as the inspector's answer rather than some
 *  unrelated object a deep child printed around it. */
const FINDING_KEYS: readonly string[] = ["diagnosis", "recommendation", "proposed", "op"];

export interface Finding {
	trigger: Trigger;
	diagnosis: string;
	recommendation: string;
	proposed?: { paneId: string; op: Op; argument: string };
	evidence: string[];
	confidence: number;
	model: string;
	costUsd: number;
}

/** The action a finding may carry. Nothing more than a decision the inspector
 *  happened to make: it goes through the gate like any other. */
export type Proposed = NonNullable<Finding["proposed"]>;

export interface SpawnResult {
	ok: boolean;
	stdout: string;
	stderr?: string;
}

/** Injection point for the one child deep mode may start. Tests replace it; no
 *  test is allowed to spawn a real `pi`. */
export type SpawnPi = (args: string[], timeoutMs: number) => Promise<SpawnResult>;

export interface InspectContext {
	/** The fleet snapshot the trigger came from. */
	agents: readonly HerdrAgent[];
	claims: ReadonlyMap<string, Claim>;
	/** Terminal tails already read, keyed by paneId. A pane with no entry is
	 *  shown as "not read" rather than as an empty terminal. */
	tails: ReadonlyMap<string, string>;
	/** The escalator: the same interface the ladder decides with, no new HTTP. */
	model: DecisionModel;
	/** Opt in to one bounded `pi -p` child. Default is cheap. */
	deep?: boolean;
	spawnPi?: SpawnPi;
	timeoutMs?: number;
}

// ------------------------------------------------------------------- briefing

interface BriefPane {
	paneId: string;
	/** True for a pane the trigger named. */
	near: boolean;
	/** The fixed one-line facts, without a trailing newline. */
	header: string;
	/** undefined when the tail was never read. */
	tail: string | undefined;
}

function claimLine(claim: Claim | undefined): string {
	if (!claim) return "claim: none (no claim file)";
	return `claim: phase ${claim.phase}, state ${claim.state}, last "${claim.last}"`;
}

function toBriefPane(agent: HerdrAgent, trigger: Trigger, claim: Claim | undefined, tail: string | undefined): BriefPane {
	const near = trigger.paneIds.includes(agent.paneId);
	const path = agent.foregroundCwd || agent.cwd;
	return {
		paneId: agent.paneId,
		near,
		header: [
			`--- pane ${agent.paneId} (${near ? "named by the trigger" : `same group as ${trigger.group}`}) ---`,
			`cwd: ${path.trim() === "" ? "(none reported)" : path}`,
			`herdr: ${agent.status}`,
			claimLine(claim),
		].join("\n"),
		tail,
	};
}

/** The panes one brief covers: everything the trigger named, then the rest of
 *  the group. Another group's panes are not this trigger's business. */
function briefPanes(
	trigger: Trigger,
	agents: readonly HerdrAgent[],
	claims: ReadonlyMap<string, Claim>,
	tails: ReadonlyMap<string, string>,
): BriefPane[] {
	const named: HerdrAgent[] = [];
	for (const paneId of trigger.paneIds) {
		const agent = agents.find((candidate) => candidate.paneId === paneId);
		if (agent) named.push(agent);
	}
	const peers = agents.filter(
		(agent) => !trigger.paneIds.includes(agent.paneId) && groupOf(agent, claims.get(agent.paneId)) === trigger.group,
	);
	return [...named, ...peers].map((agent) =>
		toBriefPane(agent, trigger, claims.get(agent.paneId), tails.get(agent.paneId)),
	);
}

/** Water-filling. The nearest panes get first claim on the tail budget, and what
 *  is left is spread by weight — so a crowded brief shortens every tail instead
 *  of dropping a pane. */
function allocate(sizes: readonly number[], weights: readonly number[], budget: number): number[] {
	const allowance = sizes.map(() => 0);
	let pool = Math.max(0, budget);
	let pending = sizes
		.map((size, index) => ({ size, index, weight: weights[index] ?? FAR_WEIGHT }))
		.filter((entry) => entry.size > 0);

	for (;;) {
		if (pending.length === 0) return allowance;
		const totalWeight = pending.reduce((sum, entry) => sum + entry.weight, 0);
		const stay: typeof pending = [];
		pending.forEach((entry) => {
			const share = Math.floor((pool * entry.weight) / totalWeight);
			if (entry.size <= share) {
				allowance[entry.index] = entry.size;
				pool -= entry.size;
				return;
			}
			stay.push(entry);
		});
		if (stay.length === pending.length) {
			// The budget is the binding constraint: nobody's tail fits whole, so
			// every remaining pane gets its weighted share and keeps its ending.
			for (const entry of stay) allowance[entry.index] = Math.floor((pool * entry.weight) / totalWeight);
			return allowance;
		}
		pending = stay;
	}
}

const MARKER_ROOM = 40;

/** Reserved width for the tail section of one pane, so a brief that runs out of
 *  budget says "cut" inside its allowance instead of overrunning it. */
const TAIL_MIN = 10;
const CUT = "(cut)";
const UNREAD = "(not read)";
const EMPTY = "(empty)";

function marker(chars: number): string {
	return `[...truncated ${chars} chars...]\n`;
}

/** Keeps the end of the tail — what the agent did last is the evidence, not how
 *  its first lines scrolled away — inside exactly `allowance` characters. */
function clipTail(tail: string, allowance: number): string {
	if (tail.length <= allowance) return tail;
	let keep = Math.max(0, allowance - MARKER_ROOM);
	// The marker reports a digit count, and the digit count feeds the marker's
	// width, so settle the fixpoint before cutting.
	for (let pass = 0; pass < 3; pass += 1) keep = Math.max(0, allowance - marker(tail.length - keep).length);
	if (keep === 0) {
		const bare = marker(tail.length);
		return bare.length <= allowance ? bare : "";
	}
	return marker(tail.length - keep) + tail.slice(tail.length - keep);
}

/** Never wider than the allowance, whatever the allowance is. */
function renderTail(tail: string, allowance: number): string {
	if (tail === "") return EMPTY;
	if (tail.length <= allowance) return tail;
	const cut = clipTail(tail, allowance);
	return cut === "" ? CUT : cut;
}

/** The three lines above the pane blocks. The count is what the brief actually
 *  carries, so a brief that had to stop reading peers says so. */
function briefHead(trigger: Trigger, included: readonly BriefPane[], total: number): string {
	const named = included.filter((pane) => pane.near).length;
	const left = total - included.length;
	const counts = `panes: ${included.length} (${named} named by the trigger, ${included.length - named} in the same group)${left > 0 ? `, ${left} more in the group not read` : ""}`;
	return [`trigger: ${trigger.kind} in ${trigger.group}`, `detail: ${trigger.detail}`, counts].join("\n");
}

/** Assembles exactly what the inspector is allowed to see, and nothing else.
 *
 *  Pure: no clock, no fs, no network. Every fact comes from the arguments, so a
 *  brief can be asserted in a test instead of inferred from a live fleet. */
export function buildBrief(
	trigger: Trigger,
	agents: readonly HerdrAgent[],
	claims: ReadonlyMap<string, Claim>,
	tails: ReadonlyMap<string, string>,
): string {
	const all = briefPanes(trigger, agents, claims, tails);

	// A group can be arbitrarily large and a brief cannot. Peers are what go when
	// the headers alone would overrun the budget: a pane the trigger named is never
	// dropped from its own brief, so the tails are what get cut instead. The pane
	// cost is its header plus "\ntail:\n" (7) plus the blank line before the next
	// block (2), plus the width reserved for the tail itself.
	const cost = (panes: readonly BriefPane[]): number =>
		panes.reduce((sum, pane) => sum + pane.header.length + 9 + TAIL_MIN, 0);
	let included = all;
	for (;;) {
		if (briefHead(trigger, included, all.length).length + cost(included) <= BRIEF_BUDGET) break;
		const last = included[included.length - 1];
		if (last === undefined || last.near) break;
		included = included.slice(0, -1);
	}

	const head = briefHead(trigger, included, all.length);
	const allowance = allocate(
		included.map((pane) => pane.tail?.length ?? 0),
		included.map((pane) => (pane.near ? NEAR_WEIGHT : FAR_WEIGHT)),
		Math.max(0, BRIEF_BUDGET - head.length - cost(included)),
	).map((share) => share + TAIL_MIN);

	const blocks = included.map((pane, index) => {
		const shown = pane.tail === undefined ? UNREAD : renderTail(pane.tail, allowance[index] ?? TAIL_MIN);
		return `${pane.header}\ntail:\n${shown}`;
	});

	return [head, ...blocks].join("\n\n");
}

// ------------------------------------------------------------------ the model

const CHEAP_TASK = `Diagnose what is actually wrong with this group of agents, then recommend one action.
Step repetition is the largest known multi-agent failure mode: several turns
reporting the same phase and the same last action means the agent is repeating a
step, not making progress. Say which step is repeating and what it is probably
stuck on.
Reply with a single JSON object and nothing else:
{"diagnosis": "<what is wrong, 1-2 sentences>", "recommendation": "<what to do, one sentence>", "evidence": ["<a fact or quote from the brief>"], "confidence": <0..1>, "proposed": {"paneId": "<a pane named by the trigger>", "op": "nudge" | "declare_done" | "flag", "argument": "<the exact text to use>"}}
Use "proposed": null when no action is warranted. Name only panes that appear in
the brief, and propose only an action the evidence supports.`;

function deepPrompt(trigger: Trigger, brief: string): string {
	return [
		`You are the fleet inspector for ${trigger.group}: ${trigger.detail}`,
		"",
		"You may look deeper before answering. Read-only commands, for example:",
		"  herdr agent list",
		"  herdr agent get <paneId>",
		"  herdr agent read <paneId> --source recent-unwrapped --lines 80",
		"Never prompt, focus, close or otherwise change a pane. You investigate; you do not act.",
		"",
		"Step repetition is the largest known multi-agent failure mode: several turns",
		"reporting the same phase and the same last action means the agent is repeating",
		"a step, not making progress. Say which step is repeating and what it is",
		"probably stuck on.",
		"",
		"=== brief ===",
		brief,
		"",
		"=== answer ===",
		"Finish with a single JSON object and nothing else:",
		'{"diagnosis": "<what is wrong>", "recommendation": "<what to do>", "evidence": ["<a fact from what you read>"], "confidence": <0..1>, "proposed": {"paneId": "<a pane named by the trigger>", "op": "nudge" | "declare_done" | "flag", "argument": "<the exact text to use>"}}',
		'Use "proposed": null when no action is warranted.',
	].join("\n");
}

/** The structured request for one cheap inspection. The brief rides in its own
 *  `brief` field, which prompt.ts renders as an unclipped `brief:` section — it is
 *  larger than MAX_TAIL_CHARS by design, and the tail is omitted for that call. */
function cheapInput(trigger: Trigger, brief: string, ctx: InspectContext): DecisionInput {
	const named = trigger.paneIds
		.map((paneId) => ctx.agents.find((agent) => agent.paneId === paneId))
		.find((agent) => agent !== undefined);
	const claim = named ? ctx.claims.get(named.paneId) : undefined;
	return {
		paneId: trigger.paneIds.join(","),
		cwd: named ? named.foregroundCwd || named.cwd : trigger.group,
		status: named?.status ?? "unknown",
		title: `fleet inspector: ${trigger.kind}`,
		intent: trigger.detail,
		phase: claim?.phase ?? "unknown",
		claimState: claim?.state ?? "unknown",
		last: claim?.last ?? "",
		idleTicks: 0,
		tail: "",
		brief: `${brief}\n\n${CHEAP_TASK}`,
	};
}

// -------------------------------------------------------------------- parsing

function parseObject(text: string): Record<string, unknown> | undefined {
	try {
		const parsed: unknown = JSON.parse(text);
		if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
		return parsed as Record<string, unknown>;
	} catch {
		return undefined;
	}
}

/** The finding object out of a model's text. The common case is one object with
 *  a sentence around it; a deep child may also print tool output, so the scan
 *  accepts the first balanced object that looks like an answer. */
function jsonObjectIn(text: string): Record<string, unknown> | undefined {
	const first = text.indexOf("{");
	const last = text.lastIndexOf("}");
	if (first === -1 || last === -1 || last <= first) return undefined;
	const whole = parseObject(text.slice(first, last + 1));
	if (whole) return whole;

	for (let start = first; start !== -1; start = text.indexOf("{", start + 1)) {
		for (let end = text.indexOf("}", start); end !== -1; end = text.indexOf("}", end + 1)) {
			const found = parseObject(text.slice(start, end + 1));
			if (found && FINDING_KEYS.some((key) => key in found)) return found;
		}
	}
	return undefined;
}

function str(value: unknown): string {
	return typeof value === "string" ? value.trim() : "";
}

function clip(text: string, max: number): string {
	return text.length <= max ? text : `${text.slice(0, max)}…`;
}

function toEvidence(raw: unknown): string[] {
	if (!Array.isArray(raw)) return [];
	const out: string[] = [];
	for (const entry of raw) {
		const text = str(entry);
		if (text === "") continue;
		out.push(clip(text, MAX_EVIDENCE_CHARS));
		if (out.length >= MAX_EVIDENCE) break;
	}
	return out;
}

/** A supervisor must never act on an unparsed recommendation, so a proposal is
 *  only kept when every field of it checks out: a real op, a pane the trigger
 *  named, and text worth sending. `leave` is not an action, so it is not a
 *  proposal either. */
function validateProposed(raw: unknown, trigger: Trigger): Proposed | undefined {
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return undefined;
	const record = raw as Record<string, unknown>;
	const op = record.op;
	const paneId = str(record.paneId);
	const argument = str(record.argument);
	if (!isOp(op) || op === "leave") return undefined;
	if (!trigger.paneIds.includes(paneId)) return undefined;
	if (argument === "") return undefined;
	return { paneId, op, argument };
}

/** A cheap model answering the decision prompt replies `{op, argument}`. With
 *  exactly one pane in the trigger that answer is unambiguous, so it is read as
 *  a proposal for that pane; with two or more, the inspector has to name the
 *  target itself — an invented target is not a recommendation. */
function proposalCandidate(trigger: Trigger, object: Record<string, unknown>): unknown {
	if (object.proposed !== undefined && object.proposed !== null) return object.proposed;
	const [only] = trigger.paneIds;
	if (trigger.paneIds.length === 1 && only !== undefined && object.op !== undefined) {
		return { paneId: only, op: object.op, argument: object.argument };
	}
	return undefined;
}

interface ModelAnswer {
	/** The parsed finding object, when the model produced one. */
	object?: Record<string, unknown>;
	/** The model's text, kept for the prose case. */
	text: string;
	model: string;
	costUsd: number;
}

/** Turns whatever the model said into a validated Finding. Anything unparsed is
 *  still reported — it is evidence about the group — but it carries no action. */
function assemble(trigger: Trigger, answer: ModelAnswer): Finding {
	if (!answer.object) {
		const text = answer.text.trim();
		return {
			trigger,
			diagnosis: text === "" ? "the inspector returned nothing" : clip(text, 400),
			recommendation: "no action proposed: the inspector named no structured finding",
			evidence: [],
			confidence: 0,
			model: answer.model,
			costUsd: answer.costUsd,
		};
	}

	const object = answer.object;
	const stated = object.confidence;
	// A confidence that is not a number in 0..1 is a self-report the model got
	// wrong, which is no reason to trust the rest of the answer: the finding is
	// kept for the operator, the proposal is not.
	const inRange = typeof stated === "number" ? Number.isFinite(stated) && stated >= 0 && stated <= 1 : stated === undefined;
	const confidence = typeof stated === "number" && Number.isFinite(stated) ? Math.min(1, Math.max(0, stated)) : 0;

	const diagnosis = str(object.diagnosis) || str(object.argument) || "the inspector returned no diagnosis";
	const finding: Finding = {
		trigger,
		diagnosis: clip(diagnosis, 1000),
		recommendation: clip(str(object.recommendation) || "no recommendation: read the pane before acting", 600),
		evidence: toEvidence(object.evidence),
		confidence,
		model: answer.model,
		costUsd: answer.costUsd,
	};
	const proposed = inRange ? validateProposed(proposalCandidate(trigger, object), trigger) : undefined;
	if (proposed) finding.proposed = proposed;
	return finding;
}

function unavailable(trigger: Trigger, reason: string, model: string): Finding {
	return {
		trigger,
		diagnosis: `the inspector could not run: ${reason}`,
		recommendation: "no action proposed: nothing was inspected",
		evidence: [],
		confidence: 0,
		model,
		costUsd: 0,
	};
}

// ----------------------------------------------------------------------- modes

function defaultSpawnPi(args: string[], timeoutMs: number): Promise<SpawnResult> {
	return new Promise((resolve) => {
		let timer: ReturnType<typeof setTimeout> | undefined;
		let settled = false;
		let stdout = "";
		let stderr = "";
		const finish = (result: SpawnResult): void => {
			if (settled) return;
			settled = true;
			if (timer !== undefined) clearTimeout(timer);
			resolve(result);
		};
		const child = spawn("pi", args, { stdio: ["ignore", "pipe", "pipe"] });
		timer = setTimeout(() => {
			child.kill("SIGKILL");
			finish({ ok: false, stdout, stderr: `${stderr}pi -p: timeout after ${timeoutMs}ms` });
		}, timeoutMs);
		child.stdout.on("data", (chunk: Buffer) => {
			stdout += chunk.toString();
		});
		child.stderr.on("data", (chunk: Buffer) => {
			stderr += chunk.toString();
		});
		child.on("error", (e) => finish({ ok: false, stdout, stderr: e.message }));
		child.on("close", (code) => finish({ ok: code === 0, stdout, stderr }));
	});
}

async function inspectDeep(trigger: Trigger, brief: string, ctx: InspectContext): Promise<Finding | undefined> {
	const spawnPi = ctx.spawnPi ?? defaultSpawnPi;
	const prompt = deepPrompt(trigger, brief);
	let out: SpawnResult;
	try {
		out = await spawnPi(["-p", "--no-session", "--tools", "bash", prompt], ctx.timeoutMs ?? DEEP_TIMEOUT_MS);
	} catch {
		return undefined;
	}
	if (!out.ok) return undefined;
	const object = jsonObjectIn(out.stdout);
	if (!object) return undefined;
	return assemble(trigger, { object, text: out.stdout, model: "pi:deep", costUsd: 0 });
}

async function inspectCheap(trigger: Trigger, brief: string, ctx: InspectContext): Promise<Finding> {
	let decision: Decision;
	try {
		decision = await ctx.model.decide(cheapInput(trigger, brief, ctx));
	} catch (e) {
		return unavailable(trigger, (e as Error).message, ctx.model.name);
	}
	return assemble(trigger, {
		object: jsonObjectIn(decision.raw),
		text: decision.raw,
		model: decision.model,
		costUsd: decision.costUsd,
	});
}

/** Investigates one trigger. Never mutates a pane, never prompts: what comes
 *  back is a finding, and acting on it is the caller's job through the gate. */
export async function inspect(trigger: Trigger, ctx: InspectContext): Promise<Finding> {
	const brief = buildBrief(trigger, ctx.agents, ctx.claims, ctx.tails);
	if (ctx.deep === true) {
		const deep = await inspectDeep(trigger, brief, ctx);
		if (deep) return deep;
		// pi is missing, timed out, or answered in prose: cheap is the floor, not an error.
	}
	return inspectCheap(trigger, brief, ctx);
}
