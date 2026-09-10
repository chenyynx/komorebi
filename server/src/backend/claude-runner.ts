/**
 * ClaudeRunner — SDK query lifecycle wrapper (plan §4 backend row / D2).
 * Owns: spawn params (resume/model/permissionMode/includePartialMessages/abort),
 * draft→state pipeline with coalescer, usage aggregation.
 * The SDK is injected (SdkQueryFn) so the runner is fully testable offline.
 * @module backend/claude-runner
 */

import type { SessionState } from "../domain/state.js";
import type { SessionEventType } from "../domain/events.js";
import { EventTranslator, type DraftEvent, type SdkMessageLike } from "./translator.js";
import { DeltaCoalescer, type CoalescedChunk } from "./coalescer.js";

/** Minimal structural SDK surface we use (the real SDK satisfies this shape). */
export interface SdkQueryHandle extends AsyncIterable<SdkMessageLike> {
  abort(): void;
}

export interface SdkSpawnOptions {
  readonly cwd: string;
  readonly model?: string | undefined;
  readonly resume?: string | undefined;
  readonly permissionMode: "default" | "acceptEdits" | "bypassPermissions" | "plan";
  readonly includePartialMessages: true;
  readonly abortController: AbortController;
  readonly canUseTool: (toolName: string, input: Record<string, unknown>) => Promise<PermissionOutcome>;
}

export type SdkQueryFn = (options: SdkSpawnOptions) => SdkQueryHandle;

export interface UsageSnapshot {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
}

export interface PermissionOutcome {
  readonly behavior: "allow" | "deny";
  readonly message?: string | undefined;
}

/** dsh three-preset ↔ CC permissionMode mapping (plan §10 permission row). */
export function presetToMode(preset: "read-only" | "workspace-write" | "danger-full-access"): SdkSpawnOptions["permissionMode"] {
  switch (preset) {
    case "read-only":
      return "default";
    case "workspace-write":
      return "acceptEdits";
    case "danger-full-access":
      return "bypassPermissions";
  }
}

export interface RunnerDeps {
  readonly query: SdkQueryFn;
  readonly now: () => number;
}

export class ClaudeRunner {
  private handle: SdkQueryHandle | undefined;
  private translator: EventTranslator | undefined;
  private coalescer: DeltaCoalescer | undefined;
  private aggregatedUsage: UsageSnapshot = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
  private ttftMs: number | undefined;

  constructor(
    private readonly state: SessionState,
    private readonly deps: RunnerDeps,
  ) {}

  get isRunning(): boolean {
    return this.handle !== undefined;
  }

  get usageStats(): {
    readonly llmMs: number | undefined;
    readonly usage: UsageSnapshot;
    readonly unknownTypes: number;
    readonly skippedBlocks: number;
  } {
    return {
      llmMs: this.ttftMs,
      usage: this.aggregatedUsage,
      unknownTypes: this.translator?.stats.unknownTypes ?? 0,
      skippedBlocks: this.translator?.stats.skippedBlocks ?? 0,
    };
  }

  /** Start one prompt turn; the event pipeline is wired into the session state. */
  start(options: {
    model?: string | undefined;
    resume?: string | undefined;
    preset: "read-only" | "workspace-write" | "danger-full-access";
    canUseTool: (toolName: string, input: Record<string, unknown>) => Promise<PermissionOutcome>;
  }): void {
    if (this.handle !== undefined) {
      throw new Error("runner already active");
    }
    const abortController = new AbortController();
    const translator = new EventTranslator();
    this.translator = translator;
    this.coalescer = new DeltaCoalescer((chunks) => this.flushChunks(chunks));
    this.state.setRunning(true);

    const handle = this.deps.query({
      cwd: this.state.metadata.cwd,
      ...(options.model !== undefined ? { model: options.model } : {}),
      ...(options.resume !== undefined ? { resume: options.resume } : {}),
      permissionMode: presetToMode(options.preset),
      includePartialMessages: true,
      abortController,
      canUseTool: options.canUseTool,
    });
    this.handle = handle;

    const startedAt = this.deps.now();
    void this.pump(handle, translator, startedAt);
  }

  private async pump(handle: SdkQueryHandle, translator: EventTranslator, startedAt: number): Promise<void> {
    try {
      for await (const message of handle) {
        if (this.ttftMs === undefined && (message.type === "stream_event" || message.type === "assistant")) {
          this.ttftMs = this.deps.now() - startedAt;
        }
        this.sinkDrafts(translator.translate(message));
      }
    } catch (error) {
      // terminal error frame; transcript of a half turn stays in the buffer
      this.state.emit("turn/end" as SessionEventType, this.epochSeconds(), {
        turn: translator.currentTurn,
        step: translator.currentStep,
        reason: `error: ${(error as Error).message}`,
      });
    } finally {
      this.coalescer?.flushAll();
      this.state.setRunning(false);
      this.handle = undefined;
    }
  }

  /** Route drafts: deltas to the coalescer, everything else straight to state. */
  private sinkDrafts(drafts: readonly DraftEvent[]): void {
    for (const draft of drafts) {
      // wire order: pending streamed chunks must precede turn/end (client
      // replaces the temp streaming message with the canonical one last)
      if (draft.type === "turn/end") this.coalescer?.flushAll();
      const chunkType = draft.data["chunkType"];
      if (draft.type === "assistant/chunk" && (chunkType === "text-delta" || chunkType === "reasoning-delta")) {
        this.coalescer?.push(
          this.state.sessionId,
          chunkType as "text-delta" | "reasoning-delta",
          draft.data["turn"] as number,
          draft.data["step"] as number,
          draft.data["text"] as string,
        );
        continue;
      }
      if (draft.type === "assistant/chunk" && chunkType === "usage") {
        const usage = draft.data["usage"] as Record<string, number>;
        this.aggregatedUsage = {
          inputTokens: this.aggregatedUsage.inputTokens + (usage["inputTokens"] ?? 0),
          outputTokens: this.aggregatedUsage.outputTokens + (usage["outputTokens"] ?? 0),
          cacheReadTokens: this.aggregatedUsage.cacheReadTokens + (usage["cacheReadTokens"] ?? 0),
          cacheWriteTokens: this.aggregatedUsage.cacheWriteTokens + (usage["cacheWriteTokens"] ?? 0),
        };
      }
      this.state.emit(draft.type, this.epochSeconds(), draft.data);
    }
  }

  private flushChunks(chunks: readonly CoalescedChunk[]): void {
    const nowSec = this.epochSeconds();
    for (const chunk of chunks) {
      this.state.emit("assistant/chunk", nowSec, {
        turn: chunk.turn,
        step: chunk.step,
        chunkType: chunk.chunkType,
        text: chunk.text,
      });
    }
  }

  /** session-cancel (protocol §4): stop the current turn. */
  abort(): boolean {
    if (this.handle === undefined) return false;
    this.handle.abort();
    return true;
  }

  private epochSeconds(): number {
    return Math.floor(this.deps.now() / 1000);
  }
}
