import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { answer, appendAsk, parseAskLog, pendingAsks, readAskLog } from "../src/manager/answer.ts";
import {
	askId,
	detectFork,
	isAskPolicy,
	normalizePolicy,
	NUDGE_LENGTH_LIMIT,
	shouldAsk,
	type AskInput,
	type AskRecord,
	type AskPolicy,
	type Fork,
} from "../src/manager/ask.ts";
import { askPolicyFor, loadConfig, type Config } from "../src/manager/config.ts";
import type { Decision } from "../src/decision/types.ts";
import { readClaims } from "../src/fleet/registry.ts";
import type { HerdrAgent, HerdrPort, PromptResult } from "../src/herdr/types.ts";
import type { Trigger, TriggerKind } from "../src/manager/triggers.ts";

const CWD = "/w/repo";
const HOME = "/home/andrew";
const TREE = "/home/andrew/work/agentFleet";

const dirs: string[] = [];

after(() => {
	for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "fleet-ask-"));
	dirs.push(dir);
	return dir;
}

function env(values: Record<string, string>): NodeJS.ProcessEnv {
	return values;
}

function decision(overrides: Partial<Decision> = {}): Decision {
	return {
		op: "nudge",
		argument: "run the suite",
		confidence: 0.9,
		model: "primary",
		costUsd: 0,
		latencyMs: 1,
		refused: false,
		raw: '{"op":"nudge"}',
		...overrides,
	};
}

function triggersOf(...specs: Array<[TriggerKind, string[]]>): Trigger[] {
	return specs.map(([kind, paneIds]) => ({ kind, group: "repo", paneIds, detail: `${kind} detail` }));
}

const BASE: AskInput = {
	op: "nudge",
	argument: "run the suite",
	paneId: "w2C:p1",
	cwd: CWD,
	home: HOME,
	trail: [decision()],
	triggers: [],
	promptsSent: 0,
	maxPromptsPerTick: 3,
};

function input(overrides: Partial<AskInput> = {}): AskInput {
	return { ...BASE, ...overrides };
}

function reasons(forks: readonly Fork[]): string {
	return forks.map((fork) => fork.reason).join(" | ");
}

function severities(forks: readonly Fork[]): string[] {
	return forks.map((fork) => fork.severity);
}

// ------------------------------------------------------------------ the trail
//
// The ladder's trail is an input to the gate and no longer a fork. A refusal is
// reported as `flag`, so any comparison of the trail's ends would fire on every
// escalation behind the shipped `needle3` primary (22/22 refusals) and hold every
// actionable decision under the default `fork` policy.

const REFUSAL = decision({ op: "flag", model: "needle3", refused: true, confidence: 0.03, argument: "not enough evidence" });
const ANSWER = decision({ op: "nudge", model: "escalator", refused: false, argument: "run the failing file" });

function escalated(second: Decision, overrides: Partial<AskInput> = {}): AskInput {
	return input({ op: second.op, trail: [REFUSAL, second], ...overrides });
}

test("a single model in the trail is not a fork", () => {
	assert.deepEqual(detectFork(input()), []);
});

test("escalating to the same op is not a fork", () => {
	const forks = detectFork(input({ trail: [decision(), decision({ model: "escalator", op: "nudge" })] }));

	assert.deepEqual(forks, []);
});

test("escalating to a different op is not a fork either", () => {
	const forks = detectFork(input({ trail: [decision({ op: "nudge" }), decision({ model: "escalator", op: "flag" })] }));

	assert.deepEqual(forks, [], "two models disagreeing is a ladder fact, not a risk property of the action");
});

test("a refusing primary plus an actionable escalator is not a fork", () => {
	assert.deepEqual(detectFork(escalated(ANSWER)), []);
});

test("the trail is read from neither end: a three-entry trail is still not a fork", () => {
	const forks = detectFork(
		input({
			op: "declare_done",
			argument: "acceptance met",
			trail: [decision({ op: "leave" }), decision({ op: "nudge" }), decision({ op: "declare_done" })],
		}),
	);

	assert.deepEqual(
		forks.map((fork) => fork.reason),
		["declare_done stops a live agent and cannot be silently undone"],
	);
});

test("no fork reports a ladder disagreement, and a fork is only a reason and a severity", () => {
	const battery = [
		input(),
		escalated(ANSWER),
		input({ trail: [decision({ op: "nudge" }), decision({ model: "escalator", op: "leave" })] }),
		input({ op: "declare_done", argument: "acceptance met", trail: [REFUSAL, decision({ op: "declare_done" })] }),
		input({ argument: "edit /etc/passwd", trail: [REFUSAL, ANSWER] }),
		input({ triggers: triggersOf(["collision", ["w2C:p1", "w2C:p2"]]), trail: [REFUSAL, ANSWER] }),
	];

	for (const context of battery) {
		for (const fork of detectFork(context)) {
			assert.doesNotMatch(fork.reason, /disagree|primary chose|escalator chose/, fork.reason);
			assert.deepEqual(Object.keys(fork).sort(), ["reason", "severity"], "the exported Fork carries no ladder kind");
		}
	}
});

// ---------------------------------------------------------------- irreversible

test("declare_done is a hard fork", () => {
	const forks = detectFork(input({ op: "declare_done", argument: "acceptance met" }));

	assert.deepEqual(severities(forks), ["hard"]);
	assert.match(reasons(forks), /declare_done stops a live agent/);
});

test("declare_done is irreversible even when both models agreed", () => {
	const forks = detectFork(input({ op: "declare_done", trail: [decision({ op: "declare_done" })] }));

	assert.deepEqual(severities(forks), ["hard"]);
	assert.equal(forks.length, 1);
});

test("nudge, flag and leave are not irreversible", () => {
	for (const op of ["nudge", "flag", "leave"] as const) {
		assert.deepEqual(detectFork(input({ op })), [], `op ${op} must not be a fork on its own`);
	}
});

// ------------------------------------------------------------------ cross-agent

test("a collision that names this pane is a hard fork", () => {
	const forks = detectFork(input({ triggers: triggersOf(["collision", ["w2C:p1", "w2C:p2"]]) }));

	assert.deepEqual(severities(forks), ["hard"]);
	assert.match(reasons(forks), /collision in repo: collision detail/);
});

test("a churn that names this pane is a hard fork", () => {
	const forks = detectFork(input({ triggers: triggersOf(["churn", ["w2C:p1"]]) }));

	assert.deepEqual(severities(forks), ["hard"]);
	assert.match(reasons(forks), /churn in repo/);
});

test("a collision on other panes is not this pane's fork", () => {
	const forks = detectFork(input({ triggers: triggersOf(["collision", ["w2C:p7", "w2C:p8"]]) }));

	assert.deepEqual(forks, []);
});

test("divergence and blocked are local, not cross-agent forks", () => {
	const forks = detectFork(input({ triggers: triggersOf(["divergence", ["w2C:p1"]], ["blocked", ["w2C:p1"]]) }));

	assert.deepEqual(forks, []);
});

// ---------------------------------------------------------------- scope-change

test("a nudge that names a path outside the tree is a soft fork", () => {
	const forks = detectFork(input({ argument: "edit /etc/passwd and rerun" }));

	assert.deepEqual(severities(forks), ["soft"]);
	assert.match(reasons(forks), /\/etc\/passwd outside \/w\/repo/);
});

test("a nudge that names a path inside the tree is not a fork", () => {
	const forks = detectFork(input({ argument: `edit ${CWD}/src/manager/tick.ts` }));

	assert.deepEqual(forks, []);
});

test("exactly 300 characters is still a nudge; 301 is not", () => {
	assert.deepEqual(detectFork(input({ argument: "x".repeat(NUDGE_LENGTH_LIMIT) })), []);

	const over = detectFork(input({ argument: "x".repeat(NUDGE_LENGTH_LIMIT + 1) }));
	assert.deepEqual(severities(over), ["soft"]);
	assert.match(reasons(over), /301 chars \(limit 300\)/);
});

test("a relative path is judged against the agent's own cwd", () => {
	assert.deepEqual(detectFork(input({ argument: "check ./src/fleet/detect.ts" })), []);

	const escaping = detectFork(input({ argument: "check ../neighbour/secret.env" }));
	assert.deepEqual(severities(escaping), ["soft"]);
	assert.match(reasons(escaping), /\.\.\/neighbour\/secret\.env outside/);
});

test("a homedir path is expanded before judging it", () => {
	const inside = detectFork(input({ argument: "read ~/work/agentFleet/src/fleet/detect.ts", cwd: TREE }));
	assert.deepEqual(inside, []);

	const outside = detectFork(input({ argument: "read ~/notes.md" }));
	assert.deepEqual(severities(outside), ["soft"]);
});

test("a URL is not a filesystem path", () => {
	assert.deepEqual(detectFork(input({ argument: "read https://example.com/a/b and report" })), []);
});

test("a bare relative path is not a candidate, because it cannot leave the tree", () => {
	assert.deepEqual(detectFork(input({ argument: "look at src/manager/tick.ts" })), []);
});

test("with no cwd on record nothing can be shown to be inside it", () => {
	const forks = detectFork(input({ argument: "write /tmp/report.md", cwd: "  " }));

	assert.deepEqual(severities(forks), ["soft"]);
});

test("declare_done never gets a scope-change, however long the summary", () => {
	const forks = detectFork(input({ op: "declare_done", argument: `done: ${"/etc/x ".repeat(80)}` }));

	assert.deepEqual(severities(forks), ["hard"]);
});

// ---------------------------------------------------------------------- at-cap

test("one below the cap is not at-cap", () => {
	assert.deepEqual(detectFork(input({ promptsSent: 2, maxPromptsPerTick: 3 })), []);
});

test("at the cap is at-cap", () => {
	const forks = detectFork(input({ promptsSent: 3, maxPromptsPerTick: 3 }));

	assert.deepEqual(severities(forks), ["soft"]);
	assert.match(reasons(forks), /3 prompts already sent this tick \(cap 3\)/);
});

test("a zero cap makes every nudge a capped one", () => {
	assert.deepEqual(severities(detectFork(input({ promptsSent: 0, maxPromptsPerTick: 0 }))), ["soft"]);
});

test("declare_done does not spend the prompt cap", () => {
	const forks = detectFork(input({ op: "declare_done", promptsSent: 9, maxPromptsPerTick: 3 }));

	assert.deepEqual(severities(forks), ["hard"]);
});

// -------------------------------------------------------------------- policies

const HARD = input({ op: "declare_done", argument: "acceptance met" });
const SOFT = input({ argument: "edit /etc/hosts" });
const CLEAN = input();

test("never acts and reports even with a hard fork", () => {
	const gate = shouldAsk("never", HARD);

	assert.equal(gate.ask, false);
	assert.match(gate.why, /policy never/);
	assert.equal(gate.forks.length, 1, "the fork is still reported, it is just not acted on");
});

test("fork asks on a hard fork", () => {
	const gate = shouldAsk("fork", HARD);

	assert.equal(gate.ask, true);
	assert.match(gate.why, /^hard fork: declare_done stops a live agent/);
});

test("fork does not ask on a soft fork alone", () => {
	const gate = shouldAsk("fork", SOFT);

	assert.equal(gate.ask, false);
	assert.match(gate.why, /ignores soft fork/);
	assert.deepEqual(severities(gate.forks), ["soft"]);
});

test("fork does not ask when nothing is contested", () => {
	const gate = shouldAsk("fork", CLEAN);

	assert.equal(gate.ask, false);
	assert.equal(gate.why, "no fork");
	assert.deepEqual(gate.forks, []);
});

test("a refusing primary behind an actionable escalator still acts under fork", () => {
	const context = escalated(ANSWER);
	const gate = shouldAsk("fork", context);

	assert.equal(gate.ask, false, "the shipped defaults must not turn every escalation into a hold");
	assert.equal(gate.why, "no fork");
	assert.deepEqual(gate.forks, []);
});

test("fork still holds an irreversible action behind a refusing primary", () => {
	const gate = shouldAsk("fork", escalated(decision({ op: "declare_done", model: "escalator", argument: "acceptance met" })));

	assert.equal(gate.ask, true);
	assert.match(gate.why, /^hard fork: declare_done stops a live agent/);
});

test("fork still holds a cross-agent action behind a refusing primary", () => {
	const gate = shouldAsk("fork", escalated(ANSWER, { triggers: triggersOf(["collision", ["w2C:p1", "w2C:p2"]]) }));

	assert.equal(gate.ask, true);
	assert.match(gate.why, /^hard fork: collision in repo/);
});

test("never still never asks, even when the ladder disagreed and the action is irreversible", () => {
	const gate = shouldAsk("never", escalated(decision({ op: "declare_done", model: "escalator", argument: "acceptance met" })));

	assert.equal(gate.ask, false);
	assert.match(gate.why, /policy never/);
	assert.equal(gate.forks.length, 1);
});

test("often holds a soft fork and still ignores the trail", () => {
	const soft = shouldAsk("often", escalated(ANSWER, { argument: "edit /etc/hosts" }));

	assert.equal(soft.ask, true);
	assert.match(soft.why, /^soft fork: .*\/etc\/hosts/);
});

test("always is unchanged by a two-model trail", () => {
	const gate = shouldAsk("always", escalated(ANSWER));

	assert.equal(gate.ask, true);
	assert.match(gate.why, /every action/);
	assert.deepEqual(gate.forks, []);
});

test("often asks on a soft fork", () => {
	const gate = shouldAsk("often", SOFT);

	assert.equal(gate.ask, true);
	assert.match(gate.why, /^soft fork: .*\/etc\/hosts/);
});

test("often asks on a hard fork", () => {
	assert.equal(shouldAsk("often", HARD).ask, true);
});

test("often does not ask when nothing is contested", () => {
	assert.equal(shouldAsk("often", CLEAN).ask, false);
});

test("always asks on a clean nudge", () => {
	const gate = shouldAsk("always", CLEAN);

	assert.equal(gate.ask, true);
	assert.match(gate.why, /every action/);
	assert.deepEqual(gate.forks, []);
});

test("leave never asks, even under always", () => {
	const gate = shouldAsk("always", input({ op: "leave", argument: "on track" }));

	assert.equal(gate.ask, false);
	assert.match(gate.why, /leave is not an action/);
});

test("leave asks under no policy", () => {
	for (const policy of ["never", "fork", "often", "always"] as const) {
		assert.equal(shouldAsk(policy, input({ op: "leave" })).ask, false, `policy ${policy}`);
	}
});

test("always asks on a declare_done and on a flag", () => {
	assert.equal(shouldAsk("always", HARD).ask, true);
	assert.equal(shouldAsk("always", input({ op: "flag", argument: "needs a human" })).ask, true);
});

test("every policy reports the forks it found", () => {
	for (const policy of ["never", "fork", "often", "always"] as const) {
		assert.equal(shouldAsk(policy, HARD).forks.length, 1, `policy ${policy}`);
	}
});

test("an unknown policy falls back to fork", () => {
	const gate = shouldAsk("sometimes" as AskPolicy, HARD);

	assert.equal(gate.ask, true);
	assert.match(gate.why, /^hard fork/);
});

test("normalizePolicy accepts the four names and defaults the rest", () => {
	for (const policy of ["never", "fork", "often", "always"] as const) {
		assert.equal(normalizePolicy(policy), policy);
		assert.equal(isAskPolicy(policy), true);
	}
	for (const junk of [undefined, null, "", "FORK", "ask-often", 3, {}]) {
		assert.equal(normalizePolicy(junk), "fork");
		assert.equal(isAskPolicy(junk), false);
	}
});

// ------------------------------------------------------- per-group overrides

function configWith(overrides: Partial<Config> = {}): Config {
	return { ...loadConfig(env({ AGENTFLEET_STATE_DIR: tempDir() })), ...overrides };
}

test("a group override wins over the fleet default", () => {
	const config = configWith({ ask: "fork", askByGroup: { repo: "always" } });

	assert.equal(askPolicyFor(config, "repo"), "always");
	assert.equal(askPolicyFor(config, "other"), "fork");
});

test("the resolved policy is what the gate uses per group", () => {
	const config = configWith({ ask: "never", askByGroup: { repo: "always" } });

	assert.equal(shouldAsk(askPolicyFor(config, "repo"), HARD).ask, true);
	assert.equal(shouldAsk(askPolicyFor(config, "elsewhere"), HARD).ask, false);
});

test("ask defaults to fork and comes from AGENTFLEET_ASK", () => {
	assert.equal(loadConfig(env({ AGENTFLEET_STATE_DIR: tempDir() })).ask, "fork");
	assert.equal(loadConfig(env({ AGENTFLEET_STATE_DIR: tempDir(), AGENTFLEET_ASK: "never" })).ask, "never");
	assert.equal(loadConfig(env({ AGENTFLEET_STATE_DIR: tempDir(), AGENTFLEET_ASK: "always" })).ask, "always");
});

test("an invalid AGENTFLEET_ASK falls back to fork", () => {
	assert.equal(loadConfig(env({ AGENTFLEET_STATE_DIR: tempDir(), AGENTFLEET_ASK: "sometimes" })).ask, "fork");
});

test("policy.json supplies the per-group overrides", () => {
	const state = tempDir();
	writeFileSync(join(state, "policy.json"), JSON.stringify({ askByGroup: { agentFleet: "always", home: "never" } }));

	const config = loadConfig(env({ AGENTFLEET_STATE_DIR: state, AGENTFLEET_ASK: "fork" }));

	assert.deepEqual(config.askByGroup, { agentFleet: "always", home: "never" });
	assert.equal(askPolicyFor(config, "agentFleet"), "always");
	assert.equal(askPolicyFor(config, "repo"), "fork");
});

test("a bare map in policy.json is accepted and junk entries are ignored", () => {
	const state = tempDir();
	writeFileSync(join(state, "policy.json"), JSON.stringify({ agentFleet: "often", junk: "sometimes", count: 2 }));

	const config = loadConfig(env({ AGENTFLEET_STATE_DIR: state }));

	assert.deepEqual(config.askByGroup, { agentFleet: "often" });
	assert.equal(askPolicyFor(config, "junk"), "fork");
});

test("a missing or broken policy.json is not an error", () => {
	const missing = loadConfig(env({ AGENTFLEET_STATE_DIR: tempDir() }));
	assert.deepEqual(missing.askByGroup, {});

	const state = tempDir();
	writeFileSync(join(state, "policy.json"), "{not json");
	assert.deepEqual(loadConfig(env({ AGENTFLEET_STATE_DIR: state })).askByGroup, {});

	const list = tempDir();
	writeFileSync(join(list, "policy.json"), "[]");
	assert.deepEqual(loadConfig(env({ AGENTFLEET_STATE_DIR: list })).askByGroup, {});
});

// ----------------------------------------------------------------------- ids

test("an ask id is 8 characters and deterministic for a seed", () => {
	const id = askId("2024-05-01T00:00:00.000Z\u0000w2C:p1\u0000nudge\u0000run the suite");

	assert.equal(id.length, 8);
	assert.equal(askId("same seed"), askId("same seed"));
	assert.notEqual(askId("seed one"), askId("seed two"));
	assert.match(id, /^[0-9a-z]{8}$/);
});

// ------------------------------------------------------------ ledger + answer

function record(overrides: Partial<AskRecord> = {}): AskRecord {
	return {
		id: "aaaa1111",
		ts: "2024-05-01T00:00:00.000Z",
		paneId: "w2C:p1",
		group: "repo",
		op: "nudge",
		argument: "run the suite",
		why: "hard fork: declare_done stops a live agent",
		forks: [{ reason: "declare_done stops a live agent", severity: "hard" }],
		cwd: CWD,
		status: "pending",
		...overrides,
	};
}

interface FakePort {
	port: HerdrPort;
	prompts: Array<{ paneId: string; text: string }>;
}

function fakePort(reply: PromptResult = { disposition: "accepted" }): FakePort {
	const prompts: Array<{ paneId: string; text: string }> = [];
	return {
		prompts,
		port: {
			async list(): Promise<HerdrAgent[]> {
				return [];
			},
			async get(): Promise<HerdrAgent | undefined> {
				return undefined;
			},
			async read(): Promise<string> {
				return "";
			},
			async prompt(paneId: string, text: string): Promise<PromptResult> {
				prompts.push({ paneId, text });
				return reply;
			},
		},
	};
}

test("the log folds to the last line for an id", () => {
	const log = parseAskLog(
		[
			JSON.stringify(record()),
			JSON.stringify(record({ status: "answered", answer: "yes", answeredAt: "2024-05-01T00:01:00.000Z" })),
			"",
			"not json",
		].join("\n"),
	);

	assert.equal(log.size, 1);
	assert.equal(log.get("aaaa1111")?.status, "answered");
	assert.equal(log.get("aaaa1111")?.answer, "yes");
});

test("pendingAsks holds only unanswered records", () => {
	const log = parseAskLog(
		[
			JSON.stringify(record({ id: "one11111", argument: "first" })),
			JSON.stringify(record({ id: "two22222", argument: "second" })),
			JSON.stringify(record({ id: "two22222", argument: "second", status: "answered", answer: "no" })),
		].join("\n"),
	);

	const pending = pendingAsks(log);

	assert.equal(pending.size, 1);
	assert.equal(pending.has("w2C:p1\u0000nudge\u0000first"), true);
	assert.equal(pending.has("w2C:p1\u0000nudge\u0000second"), false);
});

test("answering yes sends the held nudge and marks it answered", async () => {
	const config = configWith();
	appendAsk(config.asksPath, record());
	const fake = fakePort();

	const result = await answer({ port: fake.port, config }, "aaaa1111", "yes");

	assert.equal(result.ok, true);
	assert.deepEqual(fake.prompts, [{ paneId: "w2C:p1", text: "run the suite" }]);
	assert.equal(readAskLog(config.asksPath).get("aaaa1111")?.status, "answered");
});

test("answering the same id twice is refused, and the prompt is sent once", async () => {
	const config = configWith();
	appendAsk(config.asksPath, record());
	const fake = fakePort();

	const first = await answer({ port: fake.port, config }, "aaaa1111", "yes");
	const second = await answer({ port: fake.port, config }, "aaaa1111", "yes");

	assert.equal(first.ok, true);
	assert.equal(second.ok, false);
	if (!second.ok) assert.match(second.reason, /already answered yes/);
	assert.equal(fake.prompts.length, 1);
});

test("answering yes with replacement text sends the replacement", async () => {
	const config = configWith();
	appendAsk(config.asksPath, record());
	const fake = fakePort();

	const result = await answer({ port: fake.port, config }, "aaaa1111", "yes", "just run the two failing files");

	assert.equal(result.ok, true);
	assert.deepEqual(fake.prompts, [{ paneId: "w2C:p1", text: "just run the two failing files" }]);
	assert.match(readAskLog(config.asksPath).get("aaaa1111")?.applied ?? "", /just run the two failing files/);
});

test("answering no discards the held action without touching the pane", async () => {
	const config = configWith();
	appendAsk(config.asksPath, record());
	const fake = fakePort();

	const result = await answer({ port: fake.port, config }, "aaaa1111", "no");

	assert.equal(result.ok, true);
	assert.deepEqual(fake.prompts, []);
	const stored = readAskLog(config.asksPath).get("aaaa1111");
	assert.equal(stored?.status, "answered");
	assert.equal(stored?.answer, "no");
});

test("answering yes on a held declare_done writes the done claim", async () => {
	const config = configWith();
	const registry = join(tempDir(), "claims");
	appendAsk(config.asksPath, record({ id: "done1234", op: "declare_done", argument: "acceptance met" }));
	const fake = fakePort();

	const result = await answer({ port: fake.port, config, registry }, "done1234", "yes");

	assert.equal(result.ok, true);
	assert.deepEqual(fake.prompts, [], "a done claim is not a prompt");
	assert.equal(readClaims(registry).get("w2C:p1")?.state, "done");
	assert.equal(readClaims(registry).get("w2C:p1")?.last, "acceptance met");
});

test("a refused prompt leaves the ask pending so it can be retried", async () => {
	const config = configWith();
	appendAsk(config.asksPath, record());
	const fake = fakePort({ disposition: "rejected", reason: "agent_blocked" });

	const result = await answer({ port: fake.port, config }, "aaaa1111", "yes");

	assert.equal(result.ok, false);
	if (!result.ok) assert.match(result.reason, /agent_blocked/);
	assert.equal(readAskLog(config.asksPath).get("aaaa1111")?.status, "pending");
});

test("an unknown id is refused and writes nothing", async () => {
	const config = configWith();
	const fake = fakePort();

	const result = await answer({ port: fake.port, config }, "nosuchid", "yes");

	assert.equal(result.ok, false);
	if (!result.ok) assert.match(result.reason, /no ask "nosuchid"/);
	assert.deepEqual(fake.prompts, []);
	assert.equal(readAskLog(config.asksPath).size, 0);
});
