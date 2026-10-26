export type AgentStatus = "idle" | "working" | "blocked" | "done" | "unknown";

/** One live agent pane, normalised from herdr's snake_case payload. */
export interface HerdrAgent {
	paneId: string;
	agent: string;
	status: AgentStatus;
	cwd: string;
	foregroundCwd: string;
	workspaceId: string;
	tabId: string;
	title: string;
	/** Bumped when a turn completes. The cheap change detector. */
	completionSeq: number;
	/** Bumped on any lifecycle transition, including working→idle. */
	stateChangeSeq: number;
	focused: boolean;
}

export type PromptDisposition = "accepted" | "rejected";

/** Outcome of `agent prompt`. herdr rejects before sending any input when the
 *  agent is already blocked, so this is a real signal, not an error path. */
export interface PromptResult {
	disposition: PromptDisposition;
	reason?: string;
	/** State observed after submission, when --wait was requested. */
	observed?: AgentStatus;
}

export interface HerdrPort {
	list(): Promise<HerdrAgent[]>;
	get(paneId: string): Promise<HerdrAgent | undefined>;
	/** Last `lines` lines of terminal output, trailing column padding stripped. */
	read(paneId: string, lines: number): Promise<string>;
	prompt(paneId: string, text: string, timeoutMs?: number): Promise<PromptResult>;
}
