/**
 * SDK message → SessionEvent draft translation table (pure, no side effects).
 * Fixture forms verified against: real CC transcript (assistant blocks
 * thinking{signature,thinking} / tool_use{id,name,input} / text{text}),
 * SDK 0.3.267 types (SDKPartialAssistantMessage.stream_event = raw Messages API
 * events; SDKResultSuccess usage; user tool_result{tool_use_id,content}), and
 * bridge sdk-process.ts consumption.
 * @module backend/translator
 */

import type { SessionEventType } from "../domain/events.js";

/** Anthropic raw stream event (subset we consume), per SDK PartialAssistantMessage. */
export interface RawStreamEvent {
  readonly type: string;
  readonly index?: number;
  readonly delta?: {
    readonly type?: string;
    readonly text?: string;
    readonly partial_json?: string;
    readonly stop_reason?: string | null;
  };
  readonly content_block?: {
    readonly type: string;
    readonly id?: string;
    readonly name?: string;
    readonly text?: string;
    readonly thinking?: string;
  };
}

/** Loose SDK message shape (we only read documented fields; unknown = skip). */
export interface SdkMessageLike {
  readonly type: string;
  readonly subtype?: string;
  readonly event?: RawStreamEvent;
  readonly message?: {
    readonly role?: string;
    readonly content?: readonly SdkBlockLike[];
    readonly usage?: Record<string, number>;
  };
  readonly session_id?: string;
  readonly parent_tool_use_id?: string | null;
  readonly usage?: Record<string, number>;
}

export interface SdkBlockLike {
  readonly type: string;
  readonly text?: string;
  readonly thinking?: string;
  readonly id?: string;
  readonly name?: string;
  readonly input?: unknown;
  readonly tool_use_id?: string;
  readonly content?: string | readonly { type: string; text?: string }[];
  readonly is_error?: boolean;
}

/** A translated event awaiting seq/time assignment by the runner. */
export interface DraftEvent {
  readonly type: SessionEventType;
  readonly data: Record<string, unknown>;
}

/** Per-session translation counters surfaced as diagnostics (R2 visibility). */
export interface TranslatorStats {
  unknownTypes: number;
  skippedBlocks: number;
}

/**
 * Turn lifecycle: CC emits everything for one prompt, ending with a `result`
 * message. The translator opens turn N on the first content of a prompt cycle
 * and closes it at result → next prompt opens turn N+1.
 */
export class EventTranslator {
  private turn = 0;
  private step = 0;
  /** Tool stream index → callId binding (content_block_start). */
  private toolCallIds = new Map<number, string>();
  /** True once this prompt cycle has opened its turn. */
  private turnOpen = false;
  readonly stats: TranslatorStats = { unknownTypes: 0, skippedBlocks: 0 };

  get currentTurn(): number {
    return this.turn;
  }

  get currentStep(): number {
    return this.step;
  }

  /** Translate one SDK message into zero or more event drafts. */
  translate(message: SdkMessageLike): readonly DraftEvent[] {
    switch (message.type) {
      case "system":
        if (message.subtype === "init") {
          return [this.draft("turn/start", {})];
        }
        return [];
      case "stream_event":
        return this.translateStreamEvent(message.event);
      case "assistant":
        return this.translateAssistant(message);
      case "user":
        return this.translateUser(message);
      case "result":
        return this.translateResult(message);
      default:
        // unknown SDK message kinds are counted, never thrown (R2)
        this.stats.unknownTypes++;
        return [];
    }
  }

  private draft(type: SessionEventType, extra: Record<string, unknown>): DraftEvent {
    this.turnOpen = true;
    return { type, data: { turn: this.turn, step: this.step, ...extra } };
  }

  private translateStreamEvent(event: RawStreamEvent | undefined): readonly DraftEvent[] {
    if (event === undefined) {
      this.stats.unknownTypes++;
      return [];
    }
    switch (event.type) {
      case "content_block_start": {
        const block = event.content_block;
        if (block?.type === "tool_use" && block.id !== undefined && event.index !== undefined) {
          this.toolCallIds.set(event.index, block.id);
          // a tool invocation opens the next step of this turn
          this.step++;
          return [
            this.draft("step/start", {}),
            this.draft("tool/call", {
              callId: block.id,
              name: block.name ?? "tool",
              arguments: "",
            }),
          ];
        }
        return [];
      }
      case "content_block_delta": {
        const delta = event.delta;
        if (delta?.type === "text_delta" && delta.text !== undefined) {
          return [this.draft("assistant/chunk", { chunkType: "text-delta", text: delta.text })];
        }
        if (delta?.type === "thinking_delta" && delta.text !== undefined) {
          return [this.draft("assistant/chunk", { chunkType: "reasoning-delta", text: delta.text })];
        }
        if (delta?.type === "input_json_delta" && delta.partial_json !== undefined) {
          const index = event.index ?? 0;
          return [this.draft("assistant/chunk", {
            chunkType: "tool-call-delta",
            tool: { index, id: this.toolCallIds.get(index), argumentsDelta: delta.partial_json },
          })];
        }
        return [];
      }
      case "message_delta":
        if (event.delta?.stop_reason !== undefined && event.delta.stop_reason !== null) {
          return [this.draft("assistant/chunk", { chunkType: "finish", finish: { reason: event.delta.stop_reason } })];
        }
        return [];
      default:
        // message_start / message_stop / content_block_stop: no wire events needed
        return [];
    }
  }

  private translateAssistant(message: SdkMessageLike): readonly DraftEvent[] {
    const content = message.message?.content;
    if (!Array.isArray(content)) {
      this.stats.skippedBlocks++;
      return [];
    }
    let text = "";
    let reasoning = "";
    const toolCalls: { callId: string; name: string; arguments: string }[] = [];
    for (const block of content) {
      switch (block.type) {
        case "text":
          text += block.text ?? "";
          break;
        case "thinking":
          reasoning += block.thinking ?? "";
          break;
        case "tool_use":
          toolCalls.push({
            callId: block.id ?? `tool-${this.turn}-${this.step}`,
            name: block.name ?? "tool",
            arguments: JSON.stringify(block.input ?? {}),
          });
          break;
        default:
          this.stats.skippedBlocks++;
      }
    }
    return [this.draft("assistant/message", { text, reasoning, toolCalls })];
  }

  private translateUser(message: SdkMessageLike): readonly DraftEvent[] {
    const content = message.message?.content;
    if (!Array.isArray(content)) return [];
    const drafts: DraftEvent[] = [];
    for (const block of content) {
      if (block.type === "tool_result") {
        const output = typeof block.content === "string"
          ? block.content
          : Array.isArray(block.content)
            ? block.content.map((c: { text?: string }) => c.text ?? "").join("")
            : "";
        drafts.push(this.draft("tool/result", {
          callId: block.tool_use_id ?? "unknown",
          isError: block.is_error === true,
          preview: output.slice(0, 400),
        }));
      }
      // The initial prompt echo is NOT re-emitted — the gateway emits
      // user/message itself when the mobile sends it.
    }
    return drafts;
  }

  private translateResult(message: SdkMessageLike): readonly DraftEvent[] {
    const usage = message.usage ?? {};
    const reason = message.subtype === "success" ? "end_turn" : (message.subtype ?? "error");
    const drafts: DraftEvent[] = [
      this.draft("assistant/chunk", {
        chunkType: "usage",
        usage: {
          inputTokens: usage["input_tokens"] ?? 0,
          outputTokens: usage["output_tokens"] ?? 0,
          cacheReadTokens: usage["cache_read_input_tokens"] ?? 0,
          cacheWriteTokens: usage["cache_creation_input_tokens"] ?? 0,
        },
      }),
      this.draft("turn/end", { reason }),
    ];
    // close the prompt cycle: next prompt opens the next turn
    if (this.turnOpen) this.turn++;
    this.step = 0;
    this.turnOpen = false;
    this.toolCallIds.clear();
    return drafts;
  }
}
