// Change detection. The whole economics of the supervisor rest on this: an
// agent that did not move costs one integer comparison, not a terminal read.
//
// `completion_seq` bumps when a turn completes; `state_change_seq` bumps on any
// lifecycle transition. idleTicks is counted here because it is the divergence
// signal — a session claiming `working` while herdr reports `idle` for several
// consecutive ticks has silently stopped.

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { AgentStatus, HerdrAgent } from "../herdr/types.ts";

export interface Mark {
	completionSeq: number;
	stateChangeSeq: number;
	status: AgentStatus;
	/** Consecutive ticks observed in a resting state (idle/done/blocked). */
	idleTicks: number;
	firstSeen: string;
	lastSeen: string;
}

export type Marks = Record<string, Mark>;

export type MoveReason = "new" | "turn_completed" | "state_change" | "status_change";

export interface Move {
	paneId: string;
	reason: MoveReason;
	agent: HerdrAgent;
	idleTicks: number;
}

export function statePath(env: NodeJS.ProcessEnv = process.env): string {
	return env.AGENTFLEET_STATE || join(homedir(), ".pi", "agent", "fleet-state", "marks.json");
}

export function loadMarks(path = statePath()): Marks {
	try {
		const raw = JSON.parse(readFileSync(path, "utf8")) as unknown;
		return typeof raw === "object" && raw !== null ? (raw as Marks) : {};
	} catch {
		return {};
	}
}

export function saveMarks(marks: Marks, path = statePath()): void {
	mkdirSync(dirname(path), { recursive: true });
	const tmp = `${path}.${process.pid}.tmp`;
	writeFileSync(tmp, `${JSON.stringify(marks, null, "\t")}\n`);
	renameSync(tmp, path);
}

function resting(status: AgentStatus): boolean {
	return status === "idle" || status === "done" || status === "blocked";
}

export interface Detection {
	moves: Move[];
	marks: Marks;
	/** Agents that did not move this tick, with their accumulated idleTicks. */
	still: Array<{ agent: HerdrAgent; idleTicks: number }>;
}

/** Pure: given a snapshot and the previous marks, report what changed. */
export function detect(agents: HerdrAgent[], previous: Marks, now = new Date().toISOString()): Detection {
	const marks: Marks = {};
	const moves: Move[] = [];
	const still: Detection["still"] = [];

	for (const agent of agents) {
		const prev = previous[agent.paneId];
		if (!prev) {
			marks[agent.paneId] = {
				completionSeq: agent.completionSeq,
				stateChangeSeq: agent.stateChangeSeq,
				status: agent.status,
				idleTicks: resting(agent.status) ? 1 : 0,
				firstSeen: now,
				lastSeen: now,
			};
			moves.push({ paneId: agent.paneId, reason: "new", agent, idleTicks: 0 });
			continue;
		}

		let reason: MoveReason | undefined;
		if (agent.completionSeq > prev.completionSeq) reason = "turn_completed";
		else if (agent.stateChangeSeq > prev.stateChangeSeq) reason = "state_change";
		else if (agent.status !== prev.status) reason = "status_change";

		const idleTicks = reason ? (resting(agent.status) ? 1 : 0) : resting(agent.status) ? prev.idleTicks + 1 : 0;

		marks[agent.paneId] = {
			completionSeq: agent.completionSeq,
			stateChangeSeq: agent.stateChangeSeq,
			status: agent.status,
			idleTicks,
			firstSeen: prev.firstSeen,
			lastSeen: now,
		};

		if (reason) moves.push({ paneId: agent.paneId, reason, agent, idleTicks });
		else still.push({ agent, idleTicks });
	}

	return { moves, marks, still };
}
