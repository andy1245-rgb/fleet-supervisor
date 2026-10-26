// Pure derivations for one claim's fields: what a tool call means for `phase`
// and `last`, and whether a final assistant line reads as "done". No I/O, no
// clock — everything here is a function of the event payload.

import type { Phase } from "../../../src/fleet/registry.ts";

const INTENT_MAX = 160;
const LAST_MAX = 160;

const RESEARCH_TOOLS: ReadonlySet<string> = new Set([
	"read",
	"read_file",
	"grep",
	"glob",
	"find",
	"ls",
	"look_at",
	"webfetch",
	"web_fetch",
	"websearch",
	"web_search",
]);
const RESEARCH_NAME = /(?:search|fetch)|^web[-_]/;
const IMPLEMENT_NAME = /^(?:write|edit)\d*(?:[-_].*)?$/;
const SHELL_TOOLS: ReadonlySet<string> = new Set(["bash", "powershell", "shell", "exec"]);

/** A shell command that tests or builds, as opposed to one that looks around. */
const VERIFY_COMMAND = new RegExp(
	[
		String.raw`\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:test|tests|build|lint|check|typecheck)\b`,
		String.raw`\b(?:npx|bunx)\s+(?:tsc|vitest|jest|eslint|prettier)\b`,
		String.raw`\btsc\b`,
		String.raw`\b(?:vitest|jest|pytest|mocha|phpunit|rspec)\b`,
		String.raw`\bcargo\s+(?:test|build|check|clippy)\b`,
		String.raw`\bgo\s+(?:test|build|vet)\b`,
		String.raw`\bnode\s+--test\b`,
		String.raw`\b(?:make|cmake)\b`,
	].join("|"),
	"i",
);

/**
 * Patterns matched against the *last* line of an assistant message. Anchored at
 * the start of the line so "I have not done that yet" cannot read as completion,
 * while "Done — updated the config." still does.
 */
const COMPLETION_LINES: readonly RegExp[] = [
	/^(?:all\s+)?done\b/i,
	/^(?:it(?:'|’)?s\s+)?(?:complete|completed|finished)\b/i,
	/^(?:i(?:'|’)?m\s+)?(?:done|finished)\b/i,
	/^all\s+set\b/i,
	/^that(?:'|’)?s\s+(?:it|all|everything)\b/i,
	/^wrapped\s+up\b/i,
	/^shipped\b/i,
	/^ready\s+to\s+ship\b/i,
	/^(?:the\s+)?(?:task|work|job)\s+is\s+(?:done|complete|finished)\b/i,
];

/** Argument keys in the order that makes the most useful one-line summary. */
const ARG_KEYS: readonly string[] = [
	"path",
	"file_path",
	"filePath",
	"notebook_path",
	"command",
	"cmd",
	"url",
	"query",
	"pattern",
	"prompt",
	"task",
	"name",
];

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : undefined;
}

function stringField(source: Record<string, unknown>, key: string): string {
	const value = source[key];
	return typeof value === "string" ? value : "";
}

/** Collapses to one line, strips terminal control characters, cuts to `max`. */
export function oneLine(text: string, max: number): string {
	const clean = text
		.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
		.replace(/\s+/g, " ")
		.trim();
	const chars = [...clean];
	if (chars.length <= max) return clean;
	return `${chars.slice(0, max - 1).join("").trimEnd()}…`;
}

/** The first non-empty line of `text`, flattened and truncated. */
export function firstLine(text: string, max = INTENT_MAX): string {
	for (const line of text.split("\n")) {
		const trimmed = line.trim();
		if (trimmed) return oneLine(trimmed, max);
	}
	return "";
}

function lastNonEmptyLine(text: string): string {
	const lines = text.split("\n");
	for (let index = lines.length - 1; index >= 0; index--) {
		const line = (lines[index] ?? "").trim();
		if (line) return line;
	}
	return "";
}

/** The argument worth quoting for a tool call: its path, its command, or its first string. */
export function summarizeArgs(args: unknown): string {
	const record = asRecord(args);
	if (!record) return "";
	for (const key of ARG_KEYS) {
		const value = stringField(record, key).trim();
		if (value) return value;
	}
	for (const value of Object.values(record)) {
		if (typeof value === "string" && value.trim()) return value;
	}
	return "";
}

/** `last` for a claim: the tool, then the argument that says what it touched. */
export function describeTool(toolName: string, args: unknown): string {
	return oneLine(`${toolName} ${summarizeArgs(args)}`.trim(), LAST_MAX);
}

/**
 * The phase a tool call puts the session in. A shell command that neither tests
 * nor builds changes nothing: `ls` is not progress in a phase, it is looking.
 */
export function phaseForTool(toolName: string, args: unknown, previous: Phase): Phase {
	const name = toolName.toLowerCase();
	if (RESEARCH_TOOLS.has(name) || RESEARCH_NAME.test(name)) return "research";
	if (IMPLEMENT_NAME.test(name)) return "implement";
	if (SHELL_TOOLS.has(name)) {
		const record = asRecord(args);
		const command = record ? stringField(record, "command") || stringField(record, "cmd") : "";
		return VERIFY_COMMAND.test(command) ? "verify" : previous;
	}
	return previous;
}

/** The text parts of a message payload, joined. */
export function messageText(message: unknown): string {
	const record = asRecord(message);
	if (!record) return "";
	const content = record["content"];
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	const parts: string[] = [];
	for (const part of content) {
		const entry = asRecord(part);
		if (entry && entry["type"] === "text" && typeof entry["text"] === "string") parts.push(entry["text"]);
	}
	return parts.join("\n");
}

/** Whether the message still carries tool calls the agent is waiting on. */
export function hasToolCall(message: unknown): boolean {
	const content = asRecord(message)?.["content"];
	if (!Array.isArray(content)) return false;
	return content.some((part) => asRecord(part)?.["type"] === "toolCall");
}

/** True when the closing line of `text` is a completion phrase. */
export function isCompletionText(text: string): boolean {
	const line = lastNonEmptyLine(text).replace(/^[\s>*_#`~–—-]+/, "");
	if (!line) return false;
	return COMPLETION_LINES.some((pattern) => pattern.test(line));
}

/**
 * Tokens one assistant response spent, per the provider's own report. Zero for
 * every other message kind, so the caller can sum without branching.
 */
export function messageTokens(message: unknown): number {
	const record = asRecord(message);
	if (!record || record["role"] !== "assistant") return 0;
	const usage = asRecord(record["usage"]);
	if (!usage) return 0;
	const total = usage["totalTokens"];
	if (typeof total === "number" && Number.isFinite(total) && total > 0) return total;
	const input = usage["input"];
	const output = usage["output"];
	const prompt = typeof input === "number" && Number.isFinite(input) ? input : 0;
	const completion = typeof output === "number" && Number.isFinite(output) ? output : 0;
	return prompt + completion;
}
