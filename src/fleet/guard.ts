// The loopback predicate. One file, six call sites deleted.
//
// It was in six places before this module existed: five byte-identical copies of the
// Host-header test (`lib/http.mjs`, `lib/answer-route.mjs`, `lib/chat-send.mjs`,
// `lib/chat-start.mjs`, `lib/fast-resume.mjs`) and one bind-address test in
// `lib/auth.mjs`. Five of the six gate a write. None of them ever disagreed, which is
// why nobody fixed one: they agreed by accident, and the seventh route would copy
// whichever file its author happened to open first.
//
// A parity harness cannot catch this class of duplication, because parity compares
// documents and a security predicate emits none. So the mechanism is a grep
// (`tools/drift.ts`): every definition of a loopback symbol, and every spelling of
// the four host names, outside this file is a finding, and `test/drift.test.mjs`
// fails on one. A seventh copy fails loudly or it does not exist.
//
// The three predicates are deliberately not one predicate:
//
//   * `isLoopbackHost` is a security test on a *Header*, so it is deliberately
//     narrow: an exact name, port stripped. `127.0.0.2` is loopback to the kernel and
//     is not accepted here, because a Host header that odd is a client to be curious
//     about rather than an operator.
//   * `isLoopbackBind` is a test on an *address the kernel gave us*, so it accepts the
//     whole 127/8 range and strips brackets: a bind is not forgeable.
//   * `clientIsLoopback` is the socket's remote address, for reporting only. It is
//     never a gate on its own; `requireLoopback` is the gate.
//
// Nothing in the CLI calls any of these: the CLI binds no socket. They live here
// because one of them is the gate every write on the other side passes through, and
// because "one surface can be asked this question" is a fact about the call sites, not
// about where the predicate is stored.

/** Loopback by name, not by DNS: the value checked is the Host header the client
 *  sent, so a request through a proxy that rewrote it is treated as remote. */
export function isLoopbackHost(hostHeader: string | null | undefined): boolean {
	if (typeof hostHeader !== "string" || hostHeader === "") return false;
	const name = hostHeader.replace(/:\d+$/, "").toLowerCase();
	return name === "127.0.0.1" || name === "localhost" || name === "[::1]" || name === "::1";
}

/** The bind address, which cannot be forged: `0.0.0.0`, `::` and a tailnet address
 *  are all non-loopback, and all of 127/8 is loopback. */
export function isLoopbackBind(host: string | null | undefined): boolean {
	if (typeof host !== "string" || host === "") return false;
	const name = host.replace(/^\[|\]$/g, "").toLowerCase();
	return name === "127.0.0.1" || name === "localhost" || name === "::1" || name.startsWith("127.");
}

/** The socket's own peer address, for the sentence a refusal prints. */
export function clientIsLoopback(remoteAddress: string | null | undefined): boolean {
	if (typeof remoteAddress !== "string" || remoteAddress === "") return false;
	const address = remoteAddress.replace(/^::ffff:/, "");
	return address === "127.0.0.1" || address === "::1" || address.startsWith("127.");
}

export interface LoopbackRefusal {
	ok: false;
	code: "not_loopback";
	status: 403;
	host: string | null;
	remoteAddress: string | null;
	message: string;
}

export interface LoopbackRequest {
	headers?: { host?: string | string[] | undefined };
	socket?: { remoteAddress?: string | null };
}

/**
 * The one call every write route makes, in its first three lines:
 *
 *     const refused = requireLoopback(req, opts);
 *     if (refused !== null) return sendJson(res, refused.status, refused);
 *
 * Returns `null` when the caller may proceed. `allowRemoteWrites` is an input to the
 * predicate rather than a second predicate, so `--allow-remote-writes` cannot grow a
 * copy of its own. The refusal code is `not_loopback` and not a per-route string: one
 * gate, one code, so a test can drive all seven writes with one assertion.
 */
export function requireLoopback(
	req: LoopbackRequest,
	opts: { allowRemoteWrites?: boolean; what?: string } = {},
): LoopbackRefusal | null {
	if (opts.allowRemoteWrites === true) return null;
	const raw = req.headers?.host;
	const host = typeof raw === "string" ? raw : Array.isArray(raw) ? (raw[0] ?? null) : null;
	if (isLoopbackHost(host)) return null;
	const what = opts.what ?? "This route";
	return {
		ok: false,
		code: "not_loopback",
		status: 403,
		host,
		remoteAddress: req.socket?.remoteAddress ?? null,
		message: `${what} accepts a loopback Host header only. A browser on another machine reaching a loopback bind is not the operator.`,
	};
}

/** Every host spelling this module owns, quoted so `tools/drift.ts` can find a copy
 *  without a second hand-written list. */
export const HOST_SPELLINGS = ["127.0.0.1", "localhost", "[::1]", "::1"] as const;

/** The identifier patterns a copy would be spelled with. `drift.ts` matches these
 *  against every file outside this one. */
export const SYMBOL_PATTERNS = ["hostIsLoopback", "hostLoopback", "isLoopbackHost", "isLoopbackBind", "clientIsLoopback"] as const;
