// The incremental JSONL reader both spend rollups sit on.
//
// `events.jsonl` grows by one row per tick and `usage.jsonl` by one row per model
// call, and both are read on a cadence, so neither can afford to re-read itself:
// the state is a byte offset per named reader and only the bytes appended since the
// last call are parsed. A rotated or replaced file (different `dev:ino`) — or one
// shorter than the offset, which is how an in-place rewrite looks — drops the state
// and starts again from zero.
//
// The status is returned rather than swallowed, because one of the two callers must
// be able to tell "this file records no spend" from "this file could not be read".
// A spend cap that confuses those two reports $0.00 for a fleet it cannot see, which
// is the one error that makes the cap worse than no cap at all. `missing` and
// `unreadable` are separate for the same reason: a log that has not been created yet
// is a young installation, and a log that cannot be opened is a problem.
//
// A trailing partial line is left for the next call: a supervisor writing right now
// must not be counted as half a row.

import { closeSync, openSync, readSync, statSync } from "node:fs";

/** What happened to the file. Only `ok` means the lines handed to `onLine` are all
 *  of the lines that were there. */
export type TailStatus = "ok" | "missing" | "unreadable";

interface TailState {
	/** `dev:ino`, so a rotated or replaced log is rebuilt rather than trusted. */
	identity: string;
	/** Byte offset already counted. Only ever moves forward. */
	offset: number;
}

interface FileStat {
	size: number;
	identity: string;
}

const CHUNK = 4 * 1024 * 1024;
const NEWLINE = 0x0a;

const states = new Map<string, TailState>();

function statusOf(error: unknown): TailStatus {
	return (error as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : "unreadable";
}

function statOf(logPath: string): FileStat | TailStatus {
	try {
		const stat = statSync(logPath);
		return { size: stat.size, identity: `${stat.dev}:${stat.ino}` };
	} catch (e) {
		return statusOf(e);
	}
}

function isStatus(value: FileStat | TailStatus): value is TailStatus {
	return typeof value === "string";
}

/** Feeds every complete line appended since the last call under the same `key`.
 *
 *  `key` names the reader, not the file: two readers over one log (the local-day cap
 *  and the UTC-day global cap both read `events.jsonl`) each keep their own offset
 *  and their own fold, and a reader that has never been called starts at byte zero.
 *
 *  `onRestart` runs before any line when the reader starts over — the first call, or a
 *  file that was replaced or rewritten underneath it. The caller folds its totals into a
 *  map of its own, and that map was built from the *old* file, so a caller that ignored
 *  this would add the new file's rows to a total that already counted them. It is a
 *  no-op for a caller that keeps no state between calls. */
export function tailLines(args: {
	key: string;
	logPath: string;
	onLine: (line: string) => void;
	onRestart?: () => void;
}): TailStatus {
	const { key, logPath, onLine, onRestart } = args;
	const stat = statOf(logPath);
	if (isStatus(stat)) return stat;

	let state = states.get(key);
	if (state === undefined || state.identity !== stat.identity || state.offset > stat.size) {
		state = { identity: stat.identity, offset: 0 };
		states.set(key, state);
		onRestart?.();
	} else if (stat.size === state.offset) {
		return "ok";
	}

	let fd: number;
	try {
		fd = openSync(logPath, "r");
	} catch (e) {
		return statusOf(e);
	}
	try {
		// Sized to what is actually left to read: a 4 MB buffer per tick to count one
		// appended line is an allocation the tick should not pay for. The cold read of a
		// large log still goes in CHUNK-sized pieces.
		const buffer = Buffer.alloc(Math.max(1, Math.min(CHUNK, stat.size - state.offset)));
		let carry: Buffer = Buffer.alloc(0);
		for (let pos = state.offset; pos < stat.size; ) {
			let n: number;
			try {
				n = readSync(fd, buffer, 0, buffer.length, pos);
			} catch (e) {
				return statusOf(e);
			}
			if (n <= 0) break;
			pos += n;

			const piece = buffer.subarray(0, n);
			const data = carry.length === 0 ? piece : Buffer.concat([carry, piece]);
			const cut = data.lastIndexOf(NEWLINE);
			if (cut === -1) {
				carry = Buffer.from(data);
				continue;
			}
			const complete = data.subarray(0, cut + 1);
			carry = Buffer.from(data.subarray(cut + 1));

			let start = 0;
			for (;;) {
				const end = complete.indexOf(NEWLINE, start);
				if (end === -1) break;
				onLine(complete.toString("utf8", start, end));
				start = end + 1;
			}
			state.offset += complete.length;
		}
	} finally {
		closeSync(fd);
	}
	return "ok";
}
