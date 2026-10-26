// OpenRouter adapter. One POST per decision, temperature 0, JSON-object response
// format, tokens→dollars from a table so the benchmark can report real cost.

import { renderInput, SYSTEM } from "./prompt.ts";
import { parseDecision, type Decision, type DecisionInput, type DecisionModel } from "./types.ts";

interface Price {
	/** USD per million input tokens. */
	in: number;
	/** USD per million output tokens. */
	out: number;
}

/** From openrouter.ai/api/v1/models, checked 2026-10-26. */
export const PRICES: Record<string, Price> = {
	"z-ai/glm-5.3-flash": { in: 0.15, out: 0.5 },
	"z-ai/glm-5.3-flash:batch": { in: 0.05, out: 0.18 },
	"z-ai/glm-5.3-flashx": { in: 0.37, out: 1.25 },
	"z-ai/glm-5.3-prime": { in: 2.8, out: 8.8 },
	"z-ai/glm-flash-latest": { in: 0.0413, out: 0.0758 },
};

interface Choice {
	message?: { content?: unknown };
}

interface Usage {
	prompt_tokens?: unknown;
	completion_tokens?: unknown;
}

interface Response {
	choices?: unknown;
	usage?: unknown;
	error?: unknown;
}

function costOf(model: string, promptTokens: number, completionTokens: number): number {
	const price = PRICES[model];
	if (!price) return 0;
	return (promptTokens * price.in + completionTokens * price.out) / 1_000_000;
}

export interface OpenRouterOptions {
	model: string;
	apiKey?: string;
	baseUrl?: string;
	timeoutMs?: number;
}

export function openRouterModel(options: OpenRouterOptions): DecisionModel {
	const apiKey = options.apiKey ?? process.env.OPENROUTER_API_KEY;
	const baseUrl = options.baseUrl ?? "https://openrouter.ai/api/v1";
	const timeoutMs = options.timeoutMs ?? 60_000;
	const price = PRICES[options.model];
	// Worst case for one call: full context in, one sentence out.
	const costPerCallUsd = price ? (800 * price.in + 80 * price.out) / 1_000_000 : 0;

	return {
		name: `openrouter:${options.model}`,
		costPerCallUsd,

		async decide(input: DecisionInput): Promise<Decision> {
			if (!apiKey) throw new Error("OPENROUTER_API_KEY is not set");
			const started = Date.now();
			const body = JSON.stringify({
				model: options.model,
				messages: [
					{ role: "system", content: SYSTEM },
					{ role: "user", content: renderInput(input) },
				],
				temperature: 0,
				response_format: { type: "json_object" },
			});

			const controller = new AbortController();
			const timer = setTimeout(() => controller.abort(), timeoutMs);
			let res: Response;
			try {
				const http = await fetch(`${baseUrl}/chat/completions`, {
					method: "POST",
					headers: {
						Authorization: `Bearer ${apiKey.trim()}`,
						"Content-Type": "application/json",
					},
					body,
					signal: controller.signal,
				});
				const text = await http.text();
				if (!http.ok) throw new Error(`openrouter ${http.status}: ${text.slice(0, 300)}`);
				res = JSON.parse(text) as Response;
			} finally {
				clearTimeout(timer);
			}

			const latencyMs = Date.now() - started;
			const choice = Array.isArray(res.choices) ? (res.choices[0] as Choice | undefined) : undefined;
			const content = choice?.message?.content;
			const usage = (typeof res.usage === "object" && res.usage !== null ? res.usage : {}) as Usage;
			const promptTokens = typeof usage.prompt_tokens === "number" ? usage.prompt_tokens : 0;
			const completionTokens = typeof usage.completion_tokens === "number" ? usage.completion_tokens : 0;
			const raw = typeof content === "string" ? content : JSON.stringify(content ?? "");

			return parseDecision(raw, {
				model: options.model,
				costUsd: costOf(options.model, promptTokens, completionTokens),
				latencyMs,
			});
		},
	};
}
