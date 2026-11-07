// The admit step: a decode's call is admitted or it is not, and admission is a pure
// function of the reply, the catalogue the answering process actually holds, and the
// state it was shown. `runtime-scaffold.md` §3.2 step 2 and RG §13.
//
// Why this is separate from the gate: the gate mutates, and this must be testable
// without a board, a ledger or a clock. Every check here is one the grammar cannot
// express in 1024 tokens (`role-grammars.md` §13, "why the grammar cannot").
//
// The provenance check is the whole-state substring rule, which is also the rule the
// engine's grounding gate applies. The stricter per-field form §13 asks for — "using
// the renderer's recorded field ranges" — needs ranges the renderers do not emit yet;
// the honest version of that check runs in `profiles.render()`'s owner, not here, and
// enlarging this file's rule to pretend otherwise would be a lie the gate cannot
// verify.

import type { ToolSpec } from "./profiles.ts";
import type { ProfileReply } from "./types.ts";

export interface Call {
	op: string;
	args: Record<string, string>;
}

export type VerifyOutcome =
	| { ok: true; call: Call }
	| { ok: false; cause: "unparseable"; detail: string };

export interface VerifyInput {
	/** The catalogue of the process that answered. A leaf has no `spawn`, so a
	 *  `spawn` from one fails here before any ceiling is consulted. */
	catalogue: readonly ToolSpec[];
	/** The rendered state the profile was shown. */
	stateText: string;
	/** The previous call on this node, for the loop check: the sidecar is stateless,
	 *  so an identical call twice in a row is a loop, not a decision. */
	last?: Call | undefined;
}

export function verifyCall(reply: ProfileReply, input: VerifyInput): VerifyOutcome {
	const op = reply.op;
	if (op === null) {
		return { ok: false, cause: "unparseable", detail: "the reply carried no call" };
	}
	const tool = input.catalogue.find((entry) => entry.name === op);
	if (!tool) {
		return {
			ok: false,
			cause: "unparseable",
			detail: `op ${op} is not in the answering catalogue (${input.catalogue.map((t) => t.name).join("|")})`,
		};
	}

	const declared = new Set(tool.args.map((arg) => arg.name));
	for (const name of Object.keys(reply.args)) {
		if (!declared.has(name)) {
			return { ok: false, cause: "unparseable", detail: `${op} has no argument ${name}` };
		}
	}

	const args: Record<string, string> = {};
	for (const arg of tool.args) {
		const value = reply.args[arg.name];
		if (value === undefined || value === "") {
			return { ok: false, cause: "unparseable", detail: `${op}.${arg.name} is missing` };
		}
		if (arg.enum.length > 0) {
			// An enum member is legal by construction; anything else is out of licence.
			if (!arg.enum.includes(value)) {
				return {
					ok: false,
					cause: "unparseable",
					detail: `${op}.${arg.name}=${value} is not one of ${arg.enum.join("|")}`,
				};
			}
		} else if (!input.stateText.includes(value)) {
			// The span rule. An argument the state never said was not decided on; it was
			// invented, and a fabricated id is the failure mode that looks like success.
			return { ok: false, cause: "unparseable", detail: `${op}.${arg.name}=${value} is not a span of the state` };
		}
		args[arg.name] = value;
	}

	if (input.last && input.last.op === op && sameArgs(input.last.args, args)) {
		return { ok: false, cause: "unparseable", detail: `repeat of the previous ${op} call` };
	}

	return { ok: true, call: { op, args } };
}

function sameArgs(a: Readonly<Record<string, string>>, b: Readonly<Record<string, string>>): boolean {
	const keys = Object.keys(a);
	if (keys.length !== Object.keys(b).length) return false;
	return keys.every((key) => a[key] === b[key]);
}
