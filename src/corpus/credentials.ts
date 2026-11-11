// The credential shapes, defined once and used by both sides that need them.
//
// Two consumers, two different jobs, one list:
//   * `tools/check-corpus.mjs` fails a COMMIT when a tracked file carries one;
//   * `mine/time-sampled-points.ts` drops a SESSION at mine time when its text
//     carries one, because the corpus is session text and the policy is exclude
//     rather than sanitise (docs/CORPUS-POLICY.md).
//
// They were two lists for about an hour. A guard and a miner that disagree about
// what a secret looks like is a corpus that excludes what the guard would have
// passed, or worse, the reverse — so the list lives here and both import it.
//
// Nothing in this module ever returns the matched text. A function that echoes what
// it found is the leak it was meant to stop, and both callers only need a name and
// a line number.

export interface CredentialShape {
	readonly name: string;
	readonly re: RegExp;
}

export const CREDENTIALS: readonly CredentialShape[] = [
	{ name: "openai-key", re: /\bsk-[A-Za-z0-9_-]{20,}/ },
	{ name: "github-token", re: /\b(ghp|gho|ghu|ghs)_[A-Za-z0-9]{20,}/ },
	{ name: "aws-key", re: /\bAKIA[0-9A-Z]{16}\b/ },
	{ name: "private-key", re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
	{ name: "slack-token", re: /\bxox[baprs]-[A-Za-z0-9-]{10,}/ },
	{ name: "basic-auth-url", re: /\/\/[^\s/:@]+:[^\s/@]+@[^\s/]+/ },
	// A literal assignment. Prose that merely contains the word is fine.
	{ name: "assigned-secret", re: /\b(api[_-]?key|secret|password|passwd)\b\s*[:=]\s*["'][^"']{16,}["']/i },
];

/** A value that is obviously not a live secret. The guard exempts these so a test
 *  fixture is not a finding; the miner does NOT, because the corpus is session text
 *  and a session that merely looks like it holds a credential is excluded rather
 *  than argued with. A corpus is cheap to shrink and impossible to un-publish. */
export const PLACEHOLDER = /test|fake|dummy|example|placeholder|redacted|your[_-]?key|xxxx|\.\.\./i;

export interface CredentialHit {
	/** The shape's name. Never the matched text. */
	name: string;
	/** 0-based index of the text that matched, so a caller can report *where*
	 *  without reporting *what*. */
	index: number;
}

/** Every shape that matches `text`, matched globally and reported by name. */
export function credentialHits(text: string, options: { placeholderExempt?: boolean } = {}): CredentialHit[] {
	const hits: CredentialHit[] = [];
	for (const [index, { name, re }] of CREDENTIALS.entries()) {
		const global = new RegExp(re.source, re.flags.includes("g") ? re.flags : `${re.flags}g`);
		for (const match of text.matchAll(global)) {
			if (options.placeholderExempt === true && PLACEHOLDER.test(match[0])) continue;
			hits.push({ name, index });
			break;
		}
	}
	return hits;
}
