// Grouping decides what an inspector can be scoped to, and what counts as two
// agents working on the same thing. Two agents in the same repo can collide over
// the same files; two agents in $HOME have nothing in common. So cwd is the
// default bucket, a declared label overrides it, and the home directory is
// explicitly *not* a group — over half a real fleet lives there and would
// otherwise collapse into one meaningless bucket.
//
// Collisions use those same buckets rather than the raw path, for the same
// reason: a shared home directory is not shared work.

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

/** Agents that are actively working on the same thing, keyed by the bucket the
 *  supervisor already groups by.
 *
 *  The key is `groupOf`, not the resolved cwd. cwd equality was the old proxy for
 *  "about to stomp each other" and it was wrong in the one case that dominates a
 *  real fleet: agents sharing a home directory are in different repos under a
 *  parent directory, so keying on the path made "two agents are working and one
 *  of them is in $HOME" a collision. The `"home"` and `"unknown"` buckets are
 *  therefore never collisions — they are the buckets that exist *because* the
 *  path identified no group.
 *
 *  A declared `group` label is a collision even when the cwds differ: the label is
 *  the operator's own statement that these panes share a tree, and it outranks
 *  anything derived from a path. Both members must still be genuinely `working`. */
export function collisions(agents: HerdrAgent[], claims: Map<string, Claim> = new Map(), home = homedir()): Map<string, HerdrAgent[]> {
	const byGroup = new Map<string, HerdrAgent[]>();
	for (const agent of agents) {
		if (agent.status !== "working") continue;
		const group = groupOf(agent, claims.get(agent.paneId), home);
		if (group === "home" || group === "unknown") continue;
		const list = byGroup.get(group);
		if (list) list.push(agent);
		else byGroup.set(group, [agent]);
	}
	for (const [group, members] of byGroup) {
		if (members.length < 2) byGroup.delete(group);
	}
	return byGroup;
}
