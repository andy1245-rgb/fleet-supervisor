// Watchdog rules: a command running longer than it should, but only after
// excluding what is *supposed* to run forever.
//
// A threshold on elapsed time alone is pure noise: on a real desktop it matches
// init, pipewire, idle login shells and browser helpers. So a "command" is
// defined structurally — a process with a shell or agent among its ancestors —
// and the rules table then decides, first match wins, how long each class may
// legitimately take. Every rule carries the reason it exists because the reason
// is what gets shown to the human.
//
// Run standalone: `node src/watchdog/rules.ts [--stalled]`.

import { readdirSync, readFileSync, readlinkSync } from "node:fs";

export interface CommandSample {
	pid: number;
	ppid: number;
	/** Cumulative CPU time in ms, from /proc/<pid>/stat. */
	cpuMs: number;
	elapsedMs: number;
	command: string;
	/** Command basenames of this process's ancestors, nearest first. */
	ancestors: string[];
	/** True when this process is the foreground job of a terminal. */
	foreground: boolean;
	/** Working directory, when /proc/<pid>/cwd could be read. The attribution key for
	 *  `needsAWord`: a pane is judged on the processes working where it works. Absent
	 *  rather than empty when unreadable — an unknown directory is not a match. */
	cwd?: string;
}

export interface Rule {
	id: string;
	/** Shown to the human, so it must be a sentence, not a tag. */
	why: string;
	/** Age past which the process is reported. Infinity = never. */
	maxAgeMs: number;
	match: (sample: CommandSample) => boolean;
}

const MINUTE = 60_000;

const SERVERS = /(llama-server|llama-cli|llama-bench|ollama|vllm|sglang|whisper|panns|torchrun|gunicorn|uvicorn)/;
const INFRASTRUCTURE =
	/\b(pi|herdr|sshfs|gnome-|gdm|systemd|dbus|Xorg|Xwayland|pipewire|pulseaudio|rtkit|podman|docker|tailscaled|chrome|chromium|thorium|code|electron|gvfs|cron|agetty|login|sshd)\b/;
const SHELLS = /^(bash|zsh|sh|dash|fish)$/;
const AGENTS = /^(pi|herdr|node|claude)$/;
const BUILD =
	/\b(tsc|npm|pnpm|yarn|bun|cargo|rustc|go|make|cmake|gcc|g\+\+|clang|javac|mvn|gradle|pytest|vitest|jest|playwright|webpack|vite|esbuild|uv|pip)\b/;

/** A bare shell with no arguments is an idle prompt, not a running command. */
function isBareShell(sample: CommandSample): boolean {
	const parts = sample.command.split(/\s+/);
	const base = (parts[0] ?? "").split("/").pop() ?? "";
	return SHELLS.test(base) && parts.length === 1;
}

/** Structural definition of "a command": an agent's descendant, or the
 *  foreground job of a terminal. Daemons have no tty and no agent above them, so
 *  they never reach the age rules at all — no name list required. */
function isCommand(sample: CommandSample): boolean {
	return sample.foreground || sample.ancestors.some((a) => AGENTS.test(a));
}

export const RULES: readonly Rule[] = [
	{
		id: "inference-server",
		why: "inference servers are long-lived by design — an idle one looks identical to a hung one",
		maxAgeMs: Number.POSITIVE_INFINITY,
		match: (s) => s.command.includes("llama.cpp/build/bin") || SERVERS.test(s.command),
	},
	{
		id: "idle-shell",
		why: "a bare shell is a prompt waiting for input, not a command that is running",
		maxAgeMs: Number.POSITIVE_INFINITY,
		match: (s) => isBareShell(s),
	},
	{
		id: "background-service",
		why: "no terminal and no agent above it: this is a background service, not a command someone is waiting on",
		maxAgeMs: Number.POSITIVE_INFINITY,
		match: (s) => !isCommand(s),
	},
	{
		id: "infrastructure",
		why: "agents, terminals and desktop services are the thing doing the watching, not work to be watched",
		maxAgeMs: Number.POSITIVE_INFINITY,
		match: (s) => INFRASTRUCTURE.test(s.command.split(/\s+/)[0] ?? "") || /\/pi\b|herdr server/.test(s.command),
	},
	{
		id: "agent-tui",
		why: "an agent retitled its own process, so there is no command line to judge — the turn, not the process, is what has a duration",
		maxAgeMs: Number.POSITIVE_INFINITY,
		match: (s) => !s.command.includes("/") && s.ancestors.some((a) => AGENTS.test(a)),
	},
	{
		id: "build",
		why: "builds and test suites are legitimately slow on this machine",
		maxAgeMs: 20 * MINUTE,
		match: (s) => BUILD.test(s.command),
	},
	{
		id: "command",
		why: "past five minutes and not a build — usually a lock wait, a prompt on a non-tty, or a dead mount",
		maxAgeMs: 5 * MINUTE,
		match: () => true,
	},
];

export interface Verdict {
	flagged: boolean;
	rule: string;
	why: string;
	/** True when a second sample showed no CPU progress — the hung case. */
	stalled?: boolean;
}

export function classify(sample: CommandSample, rules: readonly Rule[] = RULES, previousCpuMs?: number): Verdict {
	// A table that matches nothing (including an empty one) must not throw: this
	// runs inside a supervisor tick, and a classifier that dies takes the tick
	// with it. No rule means nothing is known, so nothing is claimed.
	const rule = rules.find((r) => r.match(sample));
	const flagged = rule !== undefined && Number.isFinite(rule.maxAgeMs) && sample.elapsedMs > rule.maxAgeMs;
	const verdict: Verdict = rule
		? { flagged, rule: rule.id, why: rule.why }
		: { flagged: false, rule: "no-rule", why: "no rule matched this process" };
	if (flagged && previousCpuMs !== undefined) verdict.stalled = sample.cpuMs - previousCpuMs < 100;
	return verdict;
}

/** What one finding contributes to the metric log.
 *
 *  The rule id and the stall verdict are the watchdog's own facts, so they are
 *  named here and not re-derived by whoever writes the row. That is what keeps
 *  "findings by rule" comparable across scans: every row names the rule the same
 *  way the classifier did, including `no-rule`. */
export interface FindingFields {
	rule: string;
	pid: number;
	ageMs: number;
	/** Clipped: a metric row is a measurement, not a place to keep a command line. */
	command: string;
	/** Present only when the scan re-sampled to tell slow from hung. */
	stalled?: boolean;
}

export function findingFields(sample: CommandSample, verdict: Verdict): FindingFields {
	const fields: FindingFields = {
		rule: verdict.rule,
		pid: sample.pid,
		ageMs: sample.elapsedMs,
		command: sample.command.slice(0, 200),
	};
	if (verdict.stalled !== undefined) fields.stalled = verdict.stalled;
	return fields;
}

const CLOCK_TICKS = 100; // Linux USER_HZ; only used to convert stat fields to ms.

interface RawStat {
	ppid: number;
	pgrp: number;
	tpgid: number;
	ttyNr: number;
	elapsedMs: number;
	cpuMs: number;
}

function uptimeSeconds(): number {
	try {
		return Number(readFileSync("/proc/uptime", "utf8").split(" ")[0]);
	} catch {
		return Number.NaN;
	}
}

function readStat(pid: number, uptime: number): RawStat | undefined {
	try {
		const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
		// Field 2 is the executable name in parens and may contain spaces, so
		// everything is split from the *last* ')' onwards.
		const close = stat.lastIndexOf(")");
		const fields = stat.slice(close + 2).split(" ");
		const ppid = Number(fields[1]);
		const pgrp = Number(fields[2]);
		const ttyNr = Number(fields[4]);
		const tpgid = Number(fields[5]);
		const utime = Number(fields[11]);
		const stime = Number(fields[12]);
		const starttime = Number(fields[19]);
		if (!Number.isFinite(ppid) || !Number.isFinite(utime) || !Number.isFinite(stime) || !Number.isFinite(starttime) || !Number.isFinite(uptime)) {
			return undefined;
		}
		return {
			ppid,
			pgrp,
			tpgid,
			ttyNr,
			elapsedMs: uptime * 1000 - (starttime / CLOCK_TICKS) * 1000,
			cpuMs: ((utime + stime) / CLOCK_TICKS) * 1000,
		};
	} catch {
		return undefined;
	}
}

function readCommand(pid: number): string | undefined {
	try {
		const raw = readFileSync(`/proc/${pid}/cmdline`, "utf8");
		const cmd = raw.replace(/\0+$/, "").split("\0").join(" ").trim();
		return cmd || undefined;
	} catch {
		return undefined;
	}
}

function basename(command: string): string {
	const first = command.split(/\s+/)[0] ?? "";
	return first.split("/").pop() ?? "";
}

function readCwd(pid: number): string | undefined {
	try {
		return readlinkSync(`/proc/${pid}/cwd`);
	} catch {
		// A process that exited between the listing and the read, or one this user may
		// not inspect, has no cwd to report. Not a zero-length directory.
		return undefined;
	}
}

export function sampleProcesses(): CommandSample[] {
	let pids: string[];
	try {
		pids = readdirSync("/proc").filter((n) => /^\d+$/.test(n));
	} catch {
		return [];
	}
	const uptime = uptimeSeconds();

	const raw = new Map<number, { stat: RawStat; command: string }>();
	for (const name of pids) {
		const pid = Number(name);
		const stat = readStat(pid, uptime);
		if (!stat) continue;
		const command = readCommand(pid);
		if (!command) continue;
		raw.set(pid, { stat, command });
	}

	const ancestorsOf = (pid: number): string[] => {
		const chain: string[] = [];
		let cursor = raw.get(pid)?.stat.ppid ?? 0;
		// Bounded so a corrupted table cannot spin.
		for (let i = 0; i < 64 && cursor > 1; i += 1) {
			const parent = raw.get(cursor);
			if (!parent) break;
			chain.push(basename(parent.command));
			cursor = parent.stat.ppid;
		}
		return chain;
	};

	const out: CommandSample[] = [];
	for (const [pid, entry] of raw) {
		const cwd = readCwd(pid);
		out.push({
			pid,
			ppid: entry.stat.ppid,
			elapsedMs: entry.stat.elapsedMs,
			cpuMs: entry.stat.cpuMs,
			command: entry.command,
			ancestors: ancestorsOf(pid),
			foreground: entry.stat.ttyNr > 0 && entry.stat.pgrp === entry.stat.tpgid,
			...(cwd === undefined ? {} : { cwd }),
		});
	}
	return out;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export function formatAge(ms: number): string {
	const total = Math.floor(ms / 1000);
	const h = Math.floor(total / 3600);
	const m = Math.floor((total % 3600) / 60);
	return h > 0 ? `${h}h${String(m).padStart(2, "0")}m` : `${m}m${String(total % 60).padStart(2, "0")}s`;
}

/** Samples once, optionally re-sampling so slow can be told from hung. */
export async function scan(options: { stalled?: boolean; sampleIntervalMs?: number } = {}): Promise<
	Array<{ sample: CommandSample; verdict: Verdict }>
> {
	const first = sampleProcesses();
	const flagged = first.map((sample) => ({ sample, verdict: classify(sample) })).filter((r) => r.verdict.flagged);
	if (!options.stalled || flagged.length === 0) return flagged;

	await sleep(options.sampleIntervalMs ?? 10_000);
	const second = new Map(sampleProcesses().map((s) => [s.pid, s]));
	for (const entry of flagged) {
		const again = second.get(entry.sample.pid);
		if (again) entry.verdict = classify(again, RULES, entry.sample.cpuMs);
	}
	return flagged.filter((r) => r.verdict.stalled !== false);
}

async function main(): Promise<void> {
	const stalled = process.argv.includes("--stalled");
	const findings = await scan({ stalled });
	if (findings.length === 0) {
		console.log("watchdog: nothing past its rule");
		return;
	}
	findings.sort((a, b) => b.sample.elapsedMs - a.sample.elapsedMs);
	for (const { sample, verdict } of findings) {
		const state = verdict.stalled === true ? "STALLED" : verdict.stalled === false ? "working" : "untested";
		console.log(
			`[${verdict.rule}] pid ${sample.pid} · ${formatAge(sample.elapsedMs)} · ${state}\n    ${verdict.why}\n    ${sample.command.slice(0, 180)}`,
		);
	}
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
	void main();
}
