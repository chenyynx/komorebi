/**
 * ClaudeRunner tests — fake SDK drives the full pipeline offline:
 * spawn params correctness, delta coalescing into state, canonical messages,
 * usage aggregation, error path, abort, preset↔mode mapping.
 */
import { describe, expect, it, vi } from "vitest";
import { SessionState } from "../../src/domain/state";
import { ClaudeRunner, presetToMode, type SdkMessageLike, type SdkSpawnOptions } from "../../src/backend/claude-runner";

const NOW = 1787111700000;

interface CapturedSpawn {
  options: SdkSpawnOptions;
  controller: AbortController;
}

/** Scripted fake SDK: yields queued messages, records spawn options + abort. */
function fakeSdk(script: SdkMessageLike[], onSpawn?: (c: CapturedSpawn) => void) {
  return (options: SdkSpawnOptions) => {
    const captured: CapturedSpawn = { options, controller: options.abortController };
    onSpawn?.(captured);
    return {
      async *[Symbol.asyncIterator]() {
        for (const message of script) {
          if (options.abortController.signal.aborted) return;
          yield message;
        }
      },
      abort() {
        options.abortController.abort();
      },
    };
  };
}

function makeRunner(script: SdkMessageLike[], spawnLog?: (c: CapturedSpawn) => void): { runner: ClaudeRunner; state: SessionState } {
  const state = new SessionState("sess-x", "/home/ubuntu/work", NOW);
  const runner = new ClaudeRunner(state, { query: fakeSdk(script, spawnLog), now: () => NOW });
  return { runner, state };
}

function eventsOf(state: SessionState): { type: string; data: Record<string, unknown> }[] {
  return state.bufferedEvents.map((e) => ({ type: e.type, data: e.data as Record<string, unknown> }));
}

describe("preset ↔ permissionMode mapping (pp decision: three modes)", () => {
  it("maps read-only→default / workspace-write→acceptEdits / danger-full-access→bypassPermissions", () => {
    expect(presetToMode("read-only")).toBe("default");
    expect(presetToMode("workspace-write")).toBe("acceptEdits");
    expect(presetToMode("danger-full-access")).toBe("bypassPermissions");
  });
});

describe("spawn options", () => {
  it("always requests includePartialMessages (streaming pipeline, plan D1)", () => {
    let captured: CapturedSpawn | undefined;
    const { runner } = makeRunner([{ type: "result", subtype: "success", usage: {} }], (c) => (captured = c));
    runner.start({ preset: "workspace-write", canUseTool: async () => ({ behavior: "allow" }) });
    expect(captured?.options.includePartialMessages).toBe(true);
    expect(captured?.options.cwd).toBe("/home/ubuntu/work");
  });

  it("passes model and resume when provided (select-model / reconnect semantics)", () => {
    let captured: CapturedSpawn | undefined;
    const { runner } = makeRunner([{ type: "result", subtype: "success", usage: {} }], (c) => (captured = c));
    runner.start({ model: "glm-5.3-flash[1m]", resume: "cc-uuid-1", preset: "workspace-write", canUseTool: async () => ({ behavior: "allow" }) });
    expect(captured?.options.model).toBe("glm-5.3-flash[1m]");
    expect(captured?.options.resume).toBe("cc-uuid-1");
    expect(captured?.options.permissionMode).toBe("acceptEdits");
  });

  it("permission preset is forwarded per the three-mode mapping", () => {
    let captured: CapturedSpawn | undefined;
    const { runner } = makeRunner([{ type: "result", subtype: "success", usage: {} }], (c) => (captured = c));
    runner.start({ preset: "danger-full-access", canUseTool: async () => ({ behavior: "allow" }) });
    expect(captured?.options.permissionMode).toBe("bypassPermissions");
  });
});

describe("full pipeline (fake SDK scripted turn)", () => {
  it("deltas coalesce; canonical assistant/message lands; tool call/result pair; usage aggregates; running flag cycles", async () => {
    const script: SdkMessageLike[] = [
      { type: "system", subtype: "init", session_id: "cc-uuid-1" },
      { type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", text: "思考一" } } },
      { type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", text: "思考二" } } },
      { type: "stream_event", event: { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "call_9", name: "Bash" } } },
      { type: "stream_event", event: { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: "{\"command\":\"ls\"}" } } },
      { type: "assistant", message: { role: "assistant", content: [{ type: "thinking", thinking: "思考一思考二", signature: "s" }, { type: "tool_use", id: "call_9", name: "Bash", input: { command: "ls" } }] } },
      { type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "call_9", content: "file1\nfile2" }] } },
      { type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "结果" } } },
      { type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "结果出来了" }] } },
      { type: "result", subtype: "success", usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 50, cache_creation_input_tokens: 0 } },
    ];
    const { runner, state } = makeRunner(script);
    runner.start({ preset: "workspace-write", canUseTool: async () => ({ behavior: "allow" }) });
    await vi.waitFor(() => expect(runner.isRunning).toBe(false));

    const events = eventsOf(state);
    const types = events.map((e) => e.type);
    // structural assertions
    expect(types[0]).toBe("turn/start"); // init
    expect(types).toContain("tool/call");
    expect(types).toContain("tool/result");
    expect(types.filter((t) => t === "assistant/message")).toHaveLength(2); // canonical, not per-chunk spam
    expect(types[types.length - 1]).toBe("turn/end");
    expect(state.isRunning).toBe(false);

    // coalesced reasoning: two deltas merged into one chunk event
    const reasoningChunks = events.filter((e) => e.data["chunkType"] === "reasoning-delta");
    expect(reasoningChunks).toHaveLength(1);
    expect(reasoningChunks[0]?.data["text"]).toBe("思考一思考二");

    // usage aggregation from the result message
    expect(runner.usageStats.usage).toEqual({ inputTokens: 100, outputTokens: 20, cacheReadTokens: 50, cacheWriteTokens: 0 });

    // seq strictly monotonic across the whole session
    const seqs = state.bufferedEvents.map((e) => e.seq);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
  });

  it("user tool_result echo does NOT emit a user/message (gateway owns prompt echo)", async () => {
    const script: SdkMessageLike[] = [
      { type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "c1", content: "out" }] } },
      { type: "result", subtype: "success", usage: {} },
    ];
    const { runner, state } = makeRunner(script);
    runner.start({ preset: "workspace-write", canUseTool: async () => ({ behavior: "allow" }) });
    await vi.waitFor(() => expect(runner.isRunning).toBe(false));
    expect(eventsOf(state).some((e) => e.type === "user/message")).toBe(false);
  });
});

describe("error path (R2 fail-open)", () => {
  it("SDK iterator throw → turn/end with error reason, running cleared", async () => {
    const state = new SessionState("sess-err", "/w", NOW);
    const runner = new ClaudeRunner(state, {
      query: () => ({
        async *[Symbol.asyncIterator]() {
          yield { type: "system", subtype: "init" } as SdkMessageLike;
          throw new Error("ECONNRESET");
        },
        abort() {},
      }),
      now: () => NOW,
    });
    runner.start({ preset: "workspace-write", canUseTool: async () => ({ behavior: "allow" }) });
    await vi.waitFor(() => expect(runner.isRunning).toBe(false));
    const events = eventsOf(state);
    const last = events[events.length - 1];
    expect(last?.type).toBe("turn/end");
    expect(last?.data["reason"]).toBe("error: ECONNRESET");
    expect(state.isRunning).toBe(false);
  });
});

describe("abort (session-cancel semantics)", () => {
  it("abort() signals the SDK and reports true when a turn was active", async () => {
    let aborted = false;
    const state = new SessionState("sess-abort", "/w", NOW);
    const runner = new ClaudeRunner(state, {
      query: () => ({
        async *[Symbol.asyncIterator]() {
          yield { type: "system", subtype: "init" } as SdkMessageLike;
          // simulate a long-running turn that observes the abort signal
          await new Promise<void>((resolve) => setTimeout(resolve, 50));
          if (aborted) return;
          yield { type: "result", subtype: "success", usage: {} } as SdkMessageLike;
        },
        abort() {
          aborted = true;
        },
      }),
      now: () => NOW,
    });
    runner.start({ preset: "workspace-write", canUseTool: async () => ({ behavior: "allow" }) });
    expect(runner.abort()).toBe(true);
    await vi.waitFor(() => expect(runner.isRunning).toBe(false));
    expect(aborted).toBe(true);
  });

  it("abort() with no active turn returns false", () => {
    const { runner } = makeRunner([]);
    expect(runner.abort()).toBe(false);
  });
});

describe("canUseTool wiring", () => {
  it("spawn carries the canUseTool callback through (approval pipeline hook)", () => {
    let captured: CapturedSpawn | undefined;
    const { runner } = makeRunner([{ type: "result", subtype: "success", usage: {} }], (c) => (captured = c));
    const callback = async () => ({ behavior: "allow" as const });
    runner.start({ preset: "workspace-write", canUseTool: callback });
    expect(captured?.options.canUseTool).toBe(callback);
  });
});

