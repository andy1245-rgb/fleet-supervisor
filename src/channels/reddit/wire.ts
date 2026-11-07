// Readers for untrusted wire text.
//
// Every parser in this directory sits on bytes this layer did not produce, and a parser
// that throws turns a shape change into a query failure instead of a `parse` envelope.
// So nothing here throws: a missing field is `null`, a wrong type is `null`, and the
// caller decides what `null` means for that field. The one exception is JSON.parse,
// whose failure is caught at the call site and reported as `error/parse`.
//
// The XML side is deliberately not a parser. `rss` needs four things out of an Atom feed
// — entry boundaries, four child elements, one attribute and the escaped body — and the
// feed comes from one producer with one shape. A general XML parser would be a dependency
// and an attack surface for four selectors.

export type Json = Record<string, unknown>;

export function asRecord(value: unknown): Json | null {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
	return value as Json;
}

export function asArray(value: unknown): readonly unknown[] {
	return Array.isArray(value) ? value : [];
}

export function str(value: unknown): string | null {
	return typeof value === "string" ? value : null;
}

export function num(value: unknown): number | null {
	return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function bool(value: unknown): boolean {
	return value === true;
}

/** A parse either produced a value or produced the reason it did not. No parser in this
 *  directory throws: a shape change must arrive as an envelope the router can classify,
 *  not as an exception that skips the failure→next-channel rule. */
export type Parsed<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly code: "parse" | "http"; readonly detail: string };

export function jsonParse(text: string): { readonly ok: true; readonly value: unknown } | { readonly ok: false; readonly detail: string } {
	try {
		return { ok: true, value: JSON.parse(text) as unknown };
	} catch (error) {
		const detail = error instanceof Error ? error.message : String(error);
		return { ok: false, detail: `body is not JSON: ${detail}` };
	}
}

const NAMED_ENTITIES: Readonly<Record<string, string>> = {
	amp: "&",
	lt: "<",
	gt: ">",
	quot: '"',
	apos: "'",
	nbsp: " ",
	hellip: "…",
	mdash: "—",
	ndash: "–",
	rsquo: "’",
	lsquo: "‘",
	rdquo: "”",
	ldquo: "“",
};

/** Decode the named and numeric entities that appear in Atom bodies and in HTML inside
 *  them. Unknown entities are left alone rather than dropped: a visible `&foo;` in a
 *  comment is a fact about the source, while a silently deleted one is a body that
 *  differs from what the author wrote. */
export function decodeEntities(text: string): string {
	return text.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g, (whole, body: string) => {
		if (body.startsWith("#x") || body.startsWith("#X")) {
			const code = Number.parseInt(body.slice(2), 16);
			return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
		}
		if (body.startsWith("#")) {
			const code = Number.parseInt(body.slice(1), 10);
			return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
		}
		return NAMED_ENTITIES[body] ?? whole;
	});
}

/** Atom/HTML → the text a comment actually says.
 *
 *  The feed's `<content>` is HTML-escaped markdown rendered into `<div class="md"><p>…`,
 *  wrapped in `<!-- SC_OFF -->` markers. What the projection needs is the prose with the
 *  paragraph structure intact, so paragraph boundaries become blank lines and every
 *  other tag is dropped. Entities are decoded twice on purpose: once for the Atom layer,
 *  once for the HTML inside it, and `&#39;` inside a `<p>` is only visible after both. */
export function stripHtml(html: string): string {
	const withoutComments = html.replace(/<!--[\s\S]*?-->/g, "");
	const withBreaks = withoutComments
		.replace(/<br\s*\/?>/gi, "\n")
		.replace(/<\/(p|div|li|blockquote|h[1-6])>/gi, "\n\n")
		.replace(/<li[^>]*>/gi, "- ");
	const withoutTags = withBreaks.replace(/<[^>]*>?/g, "");
	return decodeEntities(decodeEntities(withoutTags))
		.replace(/\r\n?/g, "\n")
		.split("\n")
		.map((line) => line.replace(/[ \t]+/g, " ").trim())
		.join("\n")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
}

export interface XmlElement {
	readonly raw: string;
}

/** Every `<tag …>…</tag>` block, non-greedy and dot-all. `<entry>` and `</entry>` do not
 *  nest in Atom, so a non-greedy scan is exact rather than approximate for these tags. */
export function xmlBlocks(xml: string, tag: string): readonly string[] {
	const pattern = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, "g");
	const out: string[] = [];
	for (const match of xml.matchAll(pattern)) {
		const body = match[1];
		if (body !== undefined) out.push(body);
	}
	return out;
}

/** The first `<tag>` body, decoded, or `null`. */
export function xmlText(xml: string, tag: string): string | null {
	const blocks = xmlBlocks(xml, tag);
	const first = blocks[0];
	return first === undefined ? null : decodeEntities(first).trim();
}

/** An attribute of the first `<tag …>` opener. */
export function xmlAttr(xml: string, tag: string, attribute: string): string | null {
	const opener = new RegExp(`<${tag}\\b([^>]*)>`).exec(xml);
	const attrs = opener?.[1];
	if (attrs === undefined) return null;
	const found = new RegExp(`\\b${attribute}\\s*=\\s*"([^"]*)"`).exec(attrs) ?? new RegExp(`\\b${attribute}\\s*=\\s*'([^']*)'`).exec(attrs);
	const value = found?.[1];
	return value === undefined ? null : decodeEntities(value);
}

/** A `<content>` body with CDATA unwrapped if the producer used it. */
export function xmlContentBody(entry: string): string | null {
	const body = xmlBlocks(entry, "content")[0];
	if (body === undefined) return null;
	const cdata = /^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/.exec(body);
	if (cdata) return cdata[1] ?? null;
	return decodeEntities(body);
}
