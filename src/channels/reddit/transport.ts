// The one place a request leaves this layer.
//
// Every adapter takes a `Transport`, so the live HTTP path and a fixture path are the
// same code with different inputs and no test has to reach the network. That is not a
// testing convenience bolted on afterwards: the two routes whose transport is genuinely
// missing on this box (curl_cffi, the browser bridge) can only degrade *cleanly* if
// "what can I send" is a value rather than an import.
//
// Measured facts that shape it (spec §1.2): a real Chrome header set with `sec-ch-ua`,
// `sec-fetch-*` and HTTP/2 still gets the 189,908 B branded wall, so headers are not the
// gate and there is no point in this file assembling a fake browser's worth of them. The
// gate is below the header layer — TLS fingerprint and/or egress reputation — which is
// why TLS impersonation is the identified fix and why plain `curl`/`fetch` cannot be
// dressed up to substitute for it.

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import type { Availability } from "./channel.ts";

export interface HttpRequest {
	readonly url: string;
	readonly method?: "GET" | "POST";
	readonly headers?: Readonly<Record<string, string>>;
	readonly body?: string;
	readonly timeoutMs?: number;
}

export interface HttpResponse {
	readonly status: number;
	/** Lowercased header names. The RSS bucket is read out of these, so the casing a
	 *  server happens to use must not be load-bearing. */
	readonly headers: Readonly<Record<string, string>>;
	/** Body size as transferred, in bytes. This is the discriminator between the two 403
	 *  shapes (189,908 vs 1,522), so it must be a real byte count and not `text.length`. */
	readonly bytes: number;
	readonly text: string;
	readonly wallMs: number;
}

export type Transport = (request: HttpRequest) => Promise<HttpResponse>;

/** The UA measured to be served by both `arctic-shift` and `www.reddit.com` (§1.7).
 *  Arctic refuses `Python-urllib/3.x` and serves `curl/7.81.0`; the DOCUMENTED value is
 *  used verbatim instead of a fabricated one, and Reddit's `.rss` is UA-independent
 *  anyway (§1.4) so this costs nothing there. */
export const MEASURED_UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

export interface NodeTransportOptions {
	readonly userAgent?: string;
	readonly timeoutMs?: number;
	/** Injected so a test can drive the transport without a socket. */
	readonly fetchImpl?: typeof fetch;
	readonly now?: () => number;
}

/** Plain HTTP over Node's fetch. Refused for `.json` by construction — that route is
 *  `json.ts`'s problem and needs a different transport — but correct for Arctic and for
 *  `.rss`, both of which are measured to answer this egress (§1.2). */
export function nodeTransport(options: NodeTransportOptions = {}): Transport {
	const userAgent = options.userAgent ?? MEASURED_UA;
	const doFetch = options.fetchImpl ?? fetch;
	const now = options.now ?? Date.now;
	return async (request) => {
		const started = now();
		const response = await doFetch(request.url, {
			method: request.method ?? "GET",
			headers: { "user-agent": userAgent, ...request.headers },
			...(request.body === undefined ? {} : { body: request.body }),
			// Manual: a 302 to /login is a diagnosis (§4.3.5), and following it lands on a
			// wall while hiding the reason.
			redirect: "manual",
			signal: AbortSignal.timeout(request.timeoutMs ?? options.timeoutMs ?? 20_000),
		});
		const text = await response.text();
		const headers: Record<string, string> = {};
		response.headers.forEach((value, key) => {
			headers[key.toLowerCase()] = value;
		});
		return { status: response.status, headers, bytes: Buffer.byteLength(text, "utf8"), text, wallMs: now() - started };
	};
}

/** What the box can actually do. Injected everywhere so no test spawns a process. */
export interface DependencyProbe {
	hasPythonModule(module: string): boolean;
	hasFile(path: string): boolean;
}

export const realDependencyProbe: DependencyProbe = {
	hasPythonModule(module: string): boolean {
		// `import <module>` is the cheapest honest check: it answers "could this process
		// import it", which is the question, and it cannot be fooled by a stray directory
		// name the way a metadata lookup can.
		const result = spawnSync("python3", ["-c", `import ${module}`], { timeout: 5_000, encoding: "utf8" });
		return result.status === 0;
	},
	hasFile(path: string): boolean {
		return existsSync(path);
	},
};

/** Chrome for Testing 156, already on the box (§1.5). Named here so the browser probe
 *  fails with "the binary is missing" rather than with a mystery. */
export const CHROME_PATH = "/home/andrew/.cache/ms-playwright/chromium-1248/chrome-linux64/chrome";

/** TLS impersonation is the identified fix for the plain-HTTP wall and it is NOT
 *  installed here. Its absence must not be an error path that a query pays for: the
 *  `json` route reports `unavailable` once and the router stops offering it, so the
 *  pipeline runs in the no-session degraded mode (§2.3) with a diagnostic that says why.
 *  Installing it is out of scope for this layer. */
export function probeCurlCffi(probe: DependencyProbe = realDependencyProbe): Availability {
	if (probe.hasPythonModule("curl_cffi")) return { available: true, detail: "curl_cffi importable" };
	return {
		available: false,
		detail: "curl_cffi is not importable: the .json route needs TLS impersonation, because a full Chrome header set over HTTP/2 still returns the 189,908 B branded wall — the discriminator is below the header layer (spec §1.2). Supply a Transport to enable the route, or install curl_cffi where it will run; this layer does not install it.",
	};
}

/** The browser route. `nodriver` and the Chrome binary are both present, and that is
 *  still not enough: driving a profile is the `session-mint` sidecar's job (§4.3.4), a
 *  separate process this layer consumes as a file. So the standing condition is
 *  "no bridge wired", which is true and checkable, rather than "unavailable because of
 *  something vague". */
export function probeBrowser(probe: DependencyProbe = realDependencyProbe): Availability {
	const python = probe.hasPythonModule("nodriver");
	const chrome = probe.hasFile(CHROME_PATH);
	if (python && chrome) {
		return {
			available: false,
			detail: `nodriver and ${CHROME_PATH} are present, but driving a browser profile is the session-mint sidecar's job (spec §4.3.4) and no bridge is wired into this layer. Supply a BrowserBridge to enable the route.`,
		};
	}
	const missing = [python ? null : "nodriver", chrome ? null : CHROME_PATH].filter((x): x is string => x !== null);
	return { available: false, detail: `browser route needs ${missing.join(" and ")}, neither of which is present on this box` };
}
