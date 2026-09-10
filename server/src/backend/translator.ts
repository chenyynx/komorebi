/**
 * SDK message → SessionEvent draft translation table (pure, no side effects).
 * Fixture forms verified against: real CC transcript (assistant blocks
 * thinking{signature,thinking} / tool_use{id,name,input} / text{text}),
 * SDK 0.3.267 types (SDKPartialAssistantMessage.stream_event = raw Messages API
 * events; SDKResultSuccess usage; user tool_result{tool_use_id,content}), and
 * bridge sdk-process.ts consumption.
 *
 * Canonical assembly (live-streaming contract, 2026-09-10):
 * Claude Code emits ONE `assistant` message per COMPLETED CONTENT BLOCK, all
 * sharing a single API message id (verified: [thinking] then [text]). The
 * client's ConversationProjector keys streamed text by `turn-step` and, once an
 * `assistant/message` arrives for a key, drops every later chunk with that key
 * (finalizedKeys). So a per-block canonical would be stamped before the body
 * streams and silently kill streaming. We therefore accumulate blocks per API
 * message and emit exactly ONE canonical `assistant/message` at `message_stop`.
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
    /** thinking_delta carries its payload in `thinking`, NOT `text` (measured). */
    readonly thinking?: string;
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
  readonly message?: { readonly id?: string };
}

/** Loose SDK message shape (we only read documented fields; unknown = skip). */
export interface SdkMessageLike {
  readonly type: string;
  readonly subtype?: string;
  readonly event?: RawStreamEvent;
  readonly message?: {
    readonly role?: string;
    /** API message id — groups the per-block assistant messages of one call. */
    readonly id?: string;
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
  /** Canonicals dropped for lack of renderable content (streaming-key guard). */
  droppedEmptyCanonicals: number;
}

/** Tool call payload carried by an assembled canonical message. */
interface AssembledToolCall {
  readonly callId: string;
  readonly name: string;
  readonly arguments: string;
}

/** One API message's blocks, merged into a single canonical draft. */
interface PendingCanonical {
  readonly id: string;
  readonly turn: number;
  readonly step: number;
  text: string;
  reasoning: string;
  toolCalls: AssembledToolCall[];
}

/**
 * Turn lifecycle: CC emits everything for one prompt, ending with a `result`
 * message. The translator opens turn N on the first content of a prompt cycle
 * and closes it at result → next prompt opens turn N+1.
 */
export class EventTranslator {
  private turn = 0;
  private step = 0;
  /** Step owned by the API message currently streaming (snapshotted at message_start). */
  private messageStep = 0;
  /** Tool stream index → callId binding (content_block_start). */
  private toolCallIds = new Map<number, string>();
  /** True once this prompt cycle has opened its turn. */
  private turnOpen = false;
  /** Blocks of the API message whose canonical is still being assembled. */
  private pending: PendingCanonical | undefined;
  readonly stats: TranslatorStats = { unknownTypes: 0, skippedBlocks: 0, droppedEmptyCanonicals: 0 };

  get currentTurn(): number {
    return this.turn;
  }

  get currentStep(): number {
    return this.step;
  }

  /** True while a canonical message is waiting for its message_stop. */
  get hasPending(): boolean {
    return this.pending !== undefined;
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

  /**
   * Emit the assembled canonical for the API message whose stream just ended.
   * Content-free assemblies are dropped: a canonical that finalizes a
   * `turn-step` key must never be emitted for a message that carried nothing
   * the client can render (it would freeze the key and drop live chunks).
   */
  private flushPending(): readonly DraftEvent[] {
    const pending = this.pending;
    if (pending === undefined) return [];
    this.pending = undefined;
    if (pending.text === "" && pending.reasoning === "" && pending.toolCalls.length === 0) {
      this.stats.droppedEmptyCanonicals++;
      return [];
    }
    return [{
      type: "assistant/message",
      data: {
        turn: pending.turn,
        step: pending.step,
        text: pending.text,
        reasoning: pending.reasoning,
        toolCalls: pending.toolCalls,
      },
    }];
  }

  /** Open/lookup the assembly slot for one API message (id-keyed). */
  private slot(message: SdkMessageLike): PendingCanonical {
    const id = message.message?.id ?? `noid-${this.turn}-${this.messageStep}`;
    if (this.pending !== undefined && this.pending.id === id) return this.pending;
    // a different message id means the previous API message is over: settle it
    // first so wire order stays chunk → canonical → next message's chunks.
    // (normally message_stop already emptied it — this is the truncation guard)
    this.flushPending();
    this.pending = {
      id,
      turn: this.turn,
      step: this.messageStep,
      text: "",
      reasoning: "",
      toolCalls: [],
    };
    return this.pending;
  }

  private translateStreamEvent(event: RawStreamEvent | undefined): readonly DraftEvent[] {
    if (event === undefined) {
      this.stats.unknownTypes++;
      return [];
    }
    switch (event.type) {
      case "message_start": {
        // The step a message's chunks (and therefore its canonical) belong to is
        // fixed here; tool_use blocks bump `step` mid-message for their own events.
        this.messageStep = this.step;
        return this.flushPending();
      }
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
        if (delta?.type === "thinking_delta") {
          // measured shape: {"type":"thinking_delta","thinking":"The"} — `text`
          // stays undefined, so reading .text alone dropped every thought frame.
          const thinking = delta.thinking ?? delta.text ?? "";
          if (thinking === "") return [];
          return [this.draft("assistant/chunk", { chunkType: "reasoning-delta", text: thinking })];
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
      case "message_stop":
        // end of one API call: the merged canonical is the step's terminal state
        return this.flushPending();
      default:
        // content_block_stop: no wire event needed
        return [];
    }
  }

  private translateAssistant(message: SdkMessageLike): readonly DraftEvent[] {
    const content = message.message?.content;
    if (!Array.isArray(content)) {
      this.stats.skippedBlocks++;
      return [];
    }
    const slot = this.slot(message);
    for (const block of content) {
      switch (block.type) {
        case "text":
          slot.text += block.text ?? "";
          break;
        case "thinking":
          slot.reasoning += block.thinking ?? "";
          break;
        case "tool_use":
          slot.toolCalls.push({
            callId: block.id ?? `tool-${this.turn}-${this.step}`,
            name: block.name ?? "tool",
            arguments: JSON.stringify(block.input ?? {}),
          });
          break;
        default:
          this.stats.skippedBlocks++;
      }
    }
    // NOT emitted per block — a single canonical per API message closes the step
    return [];
  }

  private translateUser(message: SdkMessageLike): readonly DraftEvent[] {
    const content = message.message?.content;
    if (!Array.isArray(content)) return [];
    // the assistant message that asked for these tools is over: settle it first
    const drafts: DraftEvent[] = [...this.flushPending()];
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
      // a truncated stream (cancel/error before message_stop) must still land
      // its canonical ahead of the accounting frames
      ...this.flushPending(),
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
    this.messageStep = 0;
    this.turnOpen = false;
    this.toolCallIds.clear();
    return drafts;
  }
}
