// Plain object literals typed against the real interfaces. `node --test
// test/*.test.ts` never picks this file up; it is imported by the test files so
// each one only states the fields its behaviour depends on.

import { homedir } from "node:os";
import { join } from "node:path";
import type { HerdrAgent } from "../src/herdr/types.ts";
import type { Claim } from "../src/fleet/registry.ts";

export const HOME = homedir();
export const REPO = join(HOME, "work", "fleet-supervisor");

export function agent(paneId: string, overrides: Partial<Omit<HerdrAgent, "paneId">> = {}): HerdrAgent {
	return {
		paneId,
		agent: "pi",
		status: "idle",
		cwd: REPO,
		foregroundCwd: REPO,
		workspaceId: "w2C",
		tabId: "w2C:t1",
		title: "pi",
		completionSeq: 0,
		stateChangeSeq: 0,
		focused: false,
		...overrides,
	};
}

export function claim(paneId: string, overrides: Partial<Omit<Claim, "paneId">> = {}): Claim {
	return {
		paneId,
		cwd: REPO,
		intent: "pin the pure modules",
		phase: "implement",
		state: "working",
		last: "wrote test/detect.test.ts",
		updated: "2024-05-01T00:00:00.000Z",
		...overrides,
	};
}
