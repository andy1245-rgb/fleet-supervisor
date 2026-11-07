// Worker claim files. Each live agent session writes its own file; the manager
// only ever reads them. One file per pane is what makes concurrent writers safe —
// no two sessions ever touch the same inode.

import { mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type Phase = "research" | "experiment" | "implement" | "verify" | "idle" | "unknown";

export interface Claim {
	paneId: string;
	cwd: string;
	/** Declared group; overrides the cwd-derived bucket when present. */
	group?: string;
	/** One line: what this session was asked to do. */
	intent: string;
	phase: Phase;
	/** How this session knows it is finished. Free text, quoted from the human. */
	acceptance?: string;
	state: "working" | "waiting" | "done";
	/** Last completed action, for divergence detection. */
	last: string;
	budget?: { runs?: number; tokens?: number };
	/** ISO timestamp of the last write. */
	updated: string;
}

const PHASES: ReadonlySet<string> = new Set(["research", "experiment", "implement", "verify", "idle", "unknown"]);
const STATES: ReadonlySet<string> = new Set(["working", "waiting", "done"]);

export function registryDir(env: NodeJS.ProcessEnv = process.env): string {
	return env.AGENTFLEET_REGISTRY || join(homedir(), ".pi", "agent", "fleet");
}

/** pane ids look like `w2C:p1`; colons are legal in filenames but noisy in shells. */
function fileName(paneId: string): string {
	return `${paneId.replace(/[^A-Za-z0-9._-]/g, "_")}.json`;
}

function phase(value: unknown): Phase {
	return typeof value === "string" && PHASES.has(value) ? (value as Phase) : "unknown";
}

function str(value: unknown, fallback = ""): string {
	return typeof value === "string" ? value : fallback;
}

export function toClaim(raw: unknown): Claim | undefined {
	if (typeof raw !== "object" || raw === null) return undefined;
	const r = raw as Record<string, unknown>;
	const paneId = str(r.paneId);
	if (!paneId) return undefined;
	const state = typeof r.state === "string" && STATES.has(r.state) ? (r.state as Claim["state"]) : "working";
	const claim: Claim = {
		paneId,
		cwd: str(r.cwd),
		intent: str(r.intent),
		phase: phase(r.phase),
		state,
		last: str(r.last),
		updated: str(r.updated),
	};
	if (typeof r.group === "string" && r.group) claim.group = r.group;
	if (typeof r.acceptance === "string" && r.acceptance) claim.acceptance = r.acceptance;
	if (typeof r.budget === "object" && r.budget !== null) claim.budget = r.budget as Claim["budget"];
	return claim;
}

export function readClaim(paneId: string, dir = registryDir()): Claim | undefined {
	try {
		return toClaim(JSON.parse(readFileSync(join(dir, fileName(paneId)), "utf8")));
	} catch {
		return undefined;
	}
}

export function readClaims(dir = registryDir()): Map<string, Claim> {
	const out = new Map<string, Claim>();
	let names: string[];
	try {
		names = readdirSync(dir).filter((n) => n.endsWith(".json"));
	} catch {
		return out;
	}
	for (const name of names) {
		try {
			const claim = toClaim(JSON.parse(readFileSync(join(dir, name), "utf8")));
			if (claim) out.set(claim.paneId, claim);
		} catch {
			/* a half-written file is normal; the next turn rewrites it */
		}
	}
	return out;
}

export function writeClaim(claim: Claim, dir = registryDir()): void {
	mkdirSync(dir, { recursive: true });
	const target = join(dir, fileName(claim.paneId));
	const tmp = `${target}.${process.pid}.tmp`;
	writeFileSync(tmp, `${JSON.stringify({ ...claim, updated: new Date().toISOString() }, null, "\t")}\n`);
	renameSync(tmp, target);
}
