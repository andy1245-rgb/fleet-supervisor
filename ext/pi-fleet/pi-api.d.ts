// The slice of pi's extension API this plugin touches, declared locally so this
// repository typechecks without installing pi as a dependency (agentFleet has
// none, and a copy of the host's types would be a second source of truth).
//
// Copied from the installed host declarations, which remain authoritative:
//   ~/.pi/agent/install/releases/1.2.0/node_modules/@earendil-works/pi-coding-agent
//     dist/core/extensions/types.d.ts   ExtensionAPI @1186, ExtensionContext @213,
//                                       SessionStart @575, SessionShutdown @637,
//                                       BeforeAgentStart @728-742, AgentSettled @801,
//                                       TurnStart @822, TurnEnd @828, MessageEnd @848,
//                                       ToolExecutionStart @853
// Every event below is the subset this extension reads; pi passes the full event
// object at runtime, so narrowing here can only lose type information, never
// behavior. `message` stays `unknown` on purpose: only the structural probe in
// src/derive.ts reads it.

declare module "@earendil-works/pi-coding-agent" {
	export type ExtensionMode = "tui" | "rpc" | "json" | "print";

	export interface ExtensionContext {
		/** Current run mode. `rpc` is a nested runner started by another pi process. */
		mode: ExtensionMode;
		/** Current working directory. */
		cwd: string;
		/** Whether dialog-capable UI is available. */
		hasUI: boolean;
	}

	export type ExtensionHandler<E, R = undefined> = (event: E, ctx: ExtensionContext) => Promise<R | void> | R | void;

	export interface SessionStartEvent {
		type: "session_start";
		reason: "startup" | "reload" | "new" | "resume" | "fork";
		previousSessionFile?: string;
	}

	export interface SessionShutdownEvent {
		type: "session_shutdown";
		reason: "quit" | "reload" | "new" | "resume" | "fork";
		targetSessionFile?: string;
	}

	export interface BeforeAgentStartUserEvent {
		type: "before_agent_start";
		messageType: "user";
		prompt: string;
	}

	export interface BeforeAgentStartCustomEvent {
		type: "before_agent_start";
		messageType: "custom";
		message: unknown;
	}

	export type BeforeAgentStartEvent = BeforeAgentStartUserEvent | BeforeAgentStartCustomEvent;

	export interface TurnStartEvent {
		type: "turn_start";
		turnIndex: number;
		timestamp: number;
	}

	export interface TurnEndEvent {
		type: "turn_end";
		turnIndex: number;
		message: unknown;
		toolResults: unknown[];
		outcome: "completed" | "aborted" | "error";
	}

	export interface MessageEndEvent {
		type: "message_end";
		message: unknown;
	}

	export interface ToolExecutionStartEvent {
		type: "tool_execution_start";
		toolCallId: string;
		toolName: string;
		args: unknown;
		/** Set when another tool (for example a codemode script) made this call. */
		parentToolCallId?: string;
	}

	export interface AgentSettledEvent {
		type: "agent_settled";
		aborted: boolean;
	}

	export interface ExtensionAPI {
		on(event: "session_start", handler: ExtensionHandler<SessionStartEvent>): () => void;
		on(event: "session_shutdown", handler: ExtensionHandler<SessionShutdownEvent>): () => void;
		on(event: "before_agent_start", handler: ExtensionHandler<BeforeAgentStartEvent>): () => void;
		on(event: "turn_start", handler: ExtensionHandler<TurnStartEvent>): () => void;
		on(event: "turn_end", handler: ExtensionHandler<TurnEndEvent>): () => void;
		on(event: "message_end", handler: ExtensionHandler<MessageEndEvent>): () => void;
		on(event: "tool_execution_start", handler: ExtensionHandler<ToolExecutionStartEvent>): () => void;
		on(event: "agent_settled", handler: ExtensionHandler<AgentSettledEvent>): () => void;
	}

	export type ExtensionFactory = (pi: ExtensionAPI) => void | Promise<void>;
}
