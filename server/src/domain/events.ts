/**
 * SessionEvent vocabulary shared between translator, history, and broadcaster.
 * Wire shape (PROTOCOL.md §13): {type, seq, time, data}.
 * @module domain/events
 */

/** A session-scoped ordered event with an assigned sequence number. */
export interface SessionEvent {
  readonly type: SessionEventType;
  /** Monotonic per-session sequence number starting at 0. */
  readonly seq: number;
  /** Wall-clock epoch seconds, as the protocol expects. */
  readonly time: number;
  readonly data: unknown;
}

export type SessionEventType =
  | "user/message"
  | "assistant/chunk"
  | "assistant/message"
  | "tool/call"
  | "tool/result"
  | "turn/start"
  | "turn/end"
  | "step/start"
  | "step/end"
  | "session/title";

/** Narrow helper for the widely used chunk payloads. */
export interface ChunkData {
  readonly turn: number;
  readonly step: number;
  readonly chunkType:
    | "text-delta"
    | "reasoning-delta"
    | "tool-call-delta"
    | "usage"
    | "finish";
  readonly text?: string;
  readonly tool?: {
    readonly index: number;
    readonly id?: string;
    readonly name?: string;
    readonly argumentsDelta?: string;
  };
  readonly usage?: Record<string, number>;
  readonly finish?: { readonly reason: string };
}

/** user/message payload. */
export interface UserMessageData {
  readonly text: string;
  readonly source: "user" | "queue" | "steer";
  readonly images?: readonly {
    readonly attachmentId: string;
    readonly mediaType: string;
    readonly bytes: number;
    readonly width?: number;
    readonly height?: number;
    readonly name?: string;
  }[];
}

/** assistant/message payload (canonical replacement of streamed chunks). */
export interface AssistantMessageData {
  readonly turn: number;
  readonly step: number;
  readonly text: string;
  readonly reasoning: string;
  readonly toolCalls: readonly {
    readonly callId: string;
    readonly name: string;
    readonly arguments: string;
  }[];
}

/** tool/call payload. */
export interface ToolCallData {
  readonly turn: number;
  readonly step: number;
  readonly callId: string;
  readonly name: string;
  readonly arguments: string;
}

/** tool/result payload. */
export interface ToolResultData {
  readonly turn: number;
  readonly step: number;
  readonly callId: string;
  readonly isError: boolean;
  /** Preview capped to 400 chars per protocol. */
  readonly preview: string;
}

/** turn/start|end and step/start|end payload. */
export interface TurnStepData {
  readonly turn: number;
  readonly step: number;
  readonly reason?: string;
}

/** session/title payload. */
export interface SessionTitleData {
  readonly title: string;
  readonly source?: "user" | "auto";
}
