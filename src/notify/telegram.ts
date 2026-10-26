// Outbox. Telegram is the only channel that reaches a phone, so it is the one
// that matters; the console notifier is what dry runs and tests use.

export type Level = "info" | "action" | "alert";

export interface Notifier {
	send(text: string, level?: Level): Promise<void>;
}

export const silentNotifier: Notifier = {
	async send(): Promise<void> {
		/* deliberately empty: used by tests and dry runs */
	},
};

export function consoleNotifier(prefix = "fleet"): Notifier {
	return {
		async send(text: string, level: Level = "info"): Promise<void> {
			console.error(`[${prefix}:${level}] ${text}`);
		},
	};
}

export interface TelegramOptions {
	token?: string;
	chatId?: string;
	/** Telegram rejects messages over 4096 chars; this leaves headroom. */
	maxChars?: number;
}

export function telegramNotifier(options: TelegramOptions = {}): Notifier | undefined {
	const token = (options.token ?? process.env.TELEGRAM_BOT_TOKEN ?? "").trim();
	const chatId = (options.chatId ?? process.env.TELEGRAM_CHAT_ID ?? "").trim();
	if (!token || !chatId) return undefined;
	const maxChars = options.maxChars ?? 3500;

	return {
		async send(text: string, level: Level = "info"): Promise<void> {
			const marker = level === "alert" ? "!! " : level === "action" ? ">> " : "";
			const body = `${marker}${text}`.slice(0, maxChars);
			const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ chat_id: chatId, text: body, disable_web_page_preview: true }),
			});
			if (!res.ok) {
				const detail = await res.text();
				throw new Error(`telegram ${res.status}: ${detail.slice(0, 200)}`);
			}
		},
	};
}

/** Best available channel: Telegram when configured, console otherwise. */
export function defaultNotifier(): Notifier {
	return telegramNotifier() ?? consoleNotifier();
}
