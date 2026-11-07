// Which decision path the supervisor is on, as one persisted word.
//
// Two paths exist and both work. `adapter` is the hosted `responses` call plus the
// rule-based escalator; `pi` is one `pi -p` invocation on the same model with
// reasoning off (see ./pi.ts). The choice is operator-facing, so it lives in a file
// the GUI can write and the supervisor reads on the next tick — not in an env var,
// which a running supervisor would never see and a GUI could never change.
//
// Three rules, and each exists because the alternative is a supervisor that
// silently changes what it does:
//
//   * the default is `adapter`, the mode that existed before this file did, so an
//     upgrade changes nothing until somebody asks for the other one;
//   * a file that is absent means "never set" and is not an error — but a file that
//     is present and unreadable, unparseable, or names a mode this build does not
//     have falls back to `adapter` **with a reason**, because a supervisor that
//     quietly ignores a broken toggle is worse than one that says so;
//   * the write is atomic (write a sibling temp file, rename over), because the
//     reader is a tick that may run at any moment and a half-written file must never
//     be the thing that decides how the fleet is supervised.

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { writeJsonAtomic } from "../fleet/settings.ts";

export type DecisionMode = "pi" | "adapter";

/** Order matters only for display: the default first, so a UI that renders this
 *  list renders the fallback as the first option. */
export const DECISION_MODES: readonly DecisionMode[] = ["adapter", "pi"];

/** What a supervisor does before anyone sets the file: exactly what it did before
 *  the other mode existed. */
export const DEFAULT_DECISION_MODE: DecisionMode = "adapter";

export const MODE_FILE = "decision-mode.json";

/** The one file both sides agree on. Beside `policy.json`, in the state dir the
 *  supervisor already writes its other mutable settings to. */
export function decisionModePath(stateDir: string): string {
	return join(stateDir, MODE_FILE);
}

export function isDecisionMode(value: unknown): value is DecisionMode {
	return typeof value === "string" && (DECISION_MODES as readonly string[]).includes(value);
}

export interface ModeReading {
	mode: DecisionMode;
	/** `file` when the setting decided; `default` when it did not, including the
	 *  ordinary case of a file that has never been written. */
	source: "file" | "default";
	/** Why the file did not decide. Absent when it did, and absent when the file
	 *  is simply not there — that is not a fault, it is a fresh install. */
	note?: string;
}

/** The value, or the default and the reason it was not the value.
 *
 *  Never throws: this runs at the top of a tick, and a supervisor that cannot read
 *  its own settings must still supervise. The caller records `note` — an operator
 *  who set the toggle and sees the old mode in the log needs the reason on the row,
 *  not in a stack trace. */
export function readDecisionMode(path: string): ModeReading {
	let text: string;
	try {
		text = readFileSync(path, "utf8");
	} catch (e) {
		const code = (e as NodeJS.ErrnoException).code;
		if (code === "ENOENT") return { mode: DEFAULT_DECISION_MODE, source: "default" };
		return { mode: DEFAULT_DECISION_MODE, source: "default", note: `could not read ${path}: ${(e as Error).message}` };
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		return { mode: DEFAULT_DECISION_MODE, source: "default", note: `${path} is not JSON; using ${DEFAULT_DECISION_MODE}` };
	}
	// A bare string is accepted too, so `echo '"pi"' > decision-mode.json` works for an
	// operator at a shell and not only for the object the GUI writes.
	if (isDecisionMode(parsed)) return { mode: parsed, source: "file" };
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		return { mode: DEFAULT_DECISION_MODE, source: "default", note: `${path} is not a JSON object; using ${DEFAULT_DECISION_MODE}` };
	}
	// A bare string is accepted as well, so `echo '"pi"' > decision-mode.json` works
	// and so does the object the GUI writes. Anything else is a rejection with a name.
	// `parseDecision` keeps the model's own sentence when it supplied one, which is what
	// makes a refusal readable in the log: the op is refused, the text survives.
	const bag = parsed as Record<string, unknown>;
	const named = bag.mode;
	if (isDecisionMode(named)) return { mode: named, source: "file" };
	return {
		mode: DEFAULT_DECISION_MODE,
		source: "default",
		note: `${path} names no known mode (${JSON.stringify(named)}); using ${DEFAULT_DECISION_MODE}`,
	};
}

/** Write the setting, atomically.
 *
 *  One writer for the whole tree: `src/fleet/settings.ts`'s `writeJsonAtomic` (sibling temp
 *  file, rename over the target). The reader is a tick that may run at any moment, so a
 *  half-written file must never be the thing that decides how the fleet is supervised —
 *  and that rule belongs in one place, not in four near-copies. */
export function writeDecisionMode(path: string, mode: DecisionMode): void {
	writeJsonAtomic(path, { mode, updatedAt: new Date().toISOString() });
}
