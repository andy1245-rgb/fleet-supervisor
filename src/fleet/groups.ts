// Grouping decides what an inspector can be scoped to. Two agents in the same
// repo can collide over the same files; two agents in $HOME have nothing in
// common. So cwd is the default bucket, a declared label overrides it, and the
// home directory is explicitly *not* a group — over half a real fleet lives
// there and would otherwise collapse into one meaningless bucket.

import { homedir } from "node:os";
import { basename, resolve } from "node:path";
import type { HerdrAgent } from "../herdr/types.ts";
import type { Claim } from "./registry.ts";

export interface Grouped {
	/** Group key, "home" for ungrouped sessions in a home directory, or
	 *  "unknown" when the agent reported no path at all. */
	group: string;
	agents: HerdrAgent[];
}

function isHome(path: string, home: string): boolean {
	const r = resolve(path);
	return r === resolve(home) || r === "/";
}

/** The bucket key for one agent: declared label, else repo basename, else "home".
 *  A path we were never given is not "home" either — resolve("") yields the
 *  *manager's* cwd, which would silently file the agent under whatever tree the
 *  supervisor happens to sit in and corrupt collision detection. */
export function groupOf(agent: HerdrAgent, claim: Claim | undefined, home = homedir()): string {
	if (claim?.group) return claim.group;
	const path = agent.foregroundCwd || agent.cwd;
	if (path.trim() === "") return "unknown";
	if (isHome(path, home)) return "home";
	const base = basename(resolve(path));
	return base || "home";
}

export function groupAll(agents: HerdrAgent[], claims: Map<string, Claim>, home = homedir()): Grouped[] {
	const buckets = new Map<string, HerdrAgent[]>();
	for (const agent of agents) {
		const key = groupOf(agent, claims.get(agent.paneId), home);
		const list = buckets.get(key);
		if (list) list.push(agent);
		else buckets.set(key, [agent]);
	}
	return [...buckets.entries()]
		.map(([group, members]) => ({ group, agents: members }))
		.sort((a, b) => b.agents.length - a.agents.length || a.group.localeCompare(b.group));
}

/** Agents that are actively writing to the same tree. This is the collision
 *  signal: cwd equality is the cheapest proxy for "about to stomp each other". */
export function collisions(agents: HerdrAgent[]): Map<string, HerdrAgent[]> {
	const byTree = new Map<string, HerdrAgent[]>();
	for (const agent of agents) {
		if (agent.status !== "working") continue;
		const tree = resolve(agent.foregroundCwd || agent.cwd);
		const list = byTree.get(tree);
		if (list) list.push(agent);
		else byTree.set(tree, [agent]);
	}
	for (const [tree, members] of byTree) {
		if (members.length < 2) byTree.delete(tree);
	}
	return byTree;
}
