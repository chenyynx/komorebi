/**
 * Translator tests — fixtures from REAL forms:
 * - assistant blocks: thinking{signature,thinking} / tool_use{id,name,input} / text{text}
 *   (extracted from /home/ubuntu/.claude/projects/-home-ubuntu/*.jsonl, 2026-09-10)
 * - stream_event: SDK 0.3.267 sdk.d.ts:4852 SDKPartialAssistantMessage = raw Messages API events
 * - result: SDKResultSuccess duration/usage fields (sdk.d.ts:5032)
 * - user tool_result: {content, tool_use_id, type} from transcript
 */
import { describe, expect, it } from "vitest";
import { EventTranslator, type SdkMessageLike } from "../../src/backend/translator";

function translateAll(messages: SdkMessageLike[]): { events: { type: string; data: Record<string, unknown> }[]; stats: { unknownTypes: number; skippedBlocks: number } } {
  const translator = new EventTranslator();
  const events = messages.flatMap((m) =>
    translator.translate(m).map((d) => ({ type: d.type, data: d.data })),
  );
  return { events, stats: { ...translator.stats } };
}

describe("stream_event translation (SDK 0.3.267 raw Messages API forms)", () => {
  it("text_delta → assistant/chunk text-delta", () => {
    const { events } = translateAll([
      { type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "正在" } } },
    ]);
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({
      type: "assistant/chunk",
      data: { turn: 0, step: 0, chunkType: "text-delta", text: "正在" },
    });
  });

  it("thinking_delta → assistant/chunk reasoning-delta", () => {
    const { events } = translateAll([
      { type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", text: "用户只发了1" } } },
    ]);
    expect(events[0]?.data).toMatchObject({ chunkType: "reasoning-delta", text: "用户只发了1" });
  });

  it("input_json_delta → tool-call-delta with bound callId from content_block_start", () => {
    const { events } = translateAll([
      { type: "stream_event", event: { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "toolu_abc", name: "Read" } } },
      { type: "stream_event", event: { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: "{\"file_path" } } },
    ]);
    expect(events).toHaveLength(3); // step/start + tool/call + delta
    expect(events[1]).toEqual({
      type: "tool/call",
      data: { turn: 0, step: 1, callId: "toolu_abc", name: "Read", arguments: "" },
    });
    expect(events[2]).toEqual({
      type: "assistant/chunk",
      data: { turn: 0, step: 1, chunkType: "tool-call-delta", tool: { index: 1, id: "toolu_abc", argumentsDelta: "{\"file_path" } },
    });
  });

  it("message_delta with stop_reason → finish chunk", () => {
    const { events } = translateAll([
      { type: "stream_event", event: { type: "message_delta", delta: { stop_reason: "end_turn" } } },
    ]);
    expect(events[0]?.data).toMatchObject({ chunkType: "finish", finish: { reason: "end_turn" } });
  });

  it("message_start/message_stop/content_block_stop emit nothing", () => {
    const { events } = translateAll([
      { type: "stream_event", event: { type: "message_start" } },
      { type: "stream_event", event: { type: "content_block_stop", index: 0 } },
      { type: "stream_event", event: { type: "message_stop" } },
    ]);
    expect(events).toHaveLength(0);
  });
});

describe("assistant canonical message (real transcript block forms)", () => {
  it("mixed text+thinking+tool_use → single assistant/message (canonical)", () => {
    const { events } = translateAll([
      {
        type: "assistant",
        message: {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "用户只发了1——测试通道", signature: "sigX" },
            { type: "text", text: "通道通了。" },
            { type: "tool_use", id: "call_1", name: "Read", input: { file_path: "/tmp/a" } },
          ],
        },
      },
    ]);
    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe("assistant/message");
    expect(events[0]?.data).toEqual({
      turn: 0,
      step: 0,
      text: "通道通了。",
      reasoning: "用户只发了1——测试通道",
      toolCalls: [{ callId: "call_1", name: "Read", arguments: "{\"file_path\":\"/tmp/a\"}" }],
    });
  });

  it("unknown block types are counted, never thrown", () => {
    const { events, stats } = translateAll([
      { type: "assistant", message: { role: "assistant", content: [{ type: "future_block" } as never] } },
    ]);
    expect(events).toHaveLength(1); // assistant/message with empty fields
    expect(stats.skippedBlocks).toBe(1);
  });
});

describe("user tool_result (real transcript form)", () => {
  it("tool_result → tool/result with 400-char preview cap", () => {
    const longOutput = "x".repeat(1000);
    const { events } = translateAll([
      {
        type: "user",
        parent_tool_use_id: null,
        message: {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "call_1", content: longOutput }],
        },
      },
    ]);
    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe("tool/result");
    expect((events[0]?.data["preview"] as string).length).toBe(400);
    expect(events[0]?.data["isError"]).toBe(false);
  });

  it("tool_result with is_error propagates", () => {
    const { events } = translateAll([
      {
        type: "user",
        message: { role: "user", content: [{ type: "tool_result", tool_use_id: "call_2", content: "boom", is_error: true }] },
      },
    ]);
    expect(events[0]?.data["isError"]).toBe(true);
  });

  it("tool_result with block-array content joins texts", () => {
    const { events } = translateAll([
      {
        type: "user",
        message: { role: "user", content: [{ type: "tool_result", tool_use_id: "c", content: [{ type: "text", text: "a" }, { type: "text", text: "b" }] }] },
      },
    ]);
    expect(events[0]?.data["preview"]).toBe("ab");
  });
});

describe("result → usage + turn end + lifecycle", () => {
  it("success result emits usage chunk then turn/end with reason end_turn", () => {
    const { events } = translateAll([
      {
        type: "result",
        subtype: "success",
        duration_ms: 228000,
        usage: { input_tokens: 15601, cached_input_tokens: 14464, output_tokens: 121, cache_read_input_tokens: 14464, cache_creation_input_tokens: 0 },
      },
    ]);
    expect(events).toHaveLength(2);
    expect(events[0]).toEqual({
      type: "assistant/chunk",
      data: { turn: 0, step: 0, chunkType: "usage", usage: { inputTokens: 15601, outputTokens: 121, cacheReadTokens: 14464, cacheWriteTokens: 0 } },
    });
    expect(events[1]?.type).toBe("turn/end");
    expect(events[1]?.data).toMatchObject({ reason: "end_turn" });
  });

  it("next prompt cycle opens turn 1 (turn lifecycle = prompt cycles)", () => {
    const { events } = translateAll([
      { type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "t1" }] } },
      { type: "result", subtype: "success", usage: {} },
      { type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "t2" }] } },
    ]);
    // [0]=assistant t1 (turn0) [1]=usage (turn0) [2]=turn/end (turn0) [3]=assistant t2 (turn1)
    expect(events[0]?.data["turn"]).toBe(0);
    expect(events[3]?.data["turn"]).toBe(1); // advanced after result
  });

  it("error result reason carries subtype", () => {
    const { events } = translateAll([{ type: "result", subtype: "error_during_execution", usage: {} }]);
    expect(events[1]?.data["reason"]).toBe("error_during_execution");
  });
});

describe("unknown / malformed SDK messages (R2 contract)", () => {
  it("unknown message types counted and skipped (log-and-skip)", () => {
    const { events, stats } = translateAll([
      { type: "rate_limit_event" },
      { type: "something_new_in_sdk_v999" },
    ]);
    expect(events).toHaveLength(0);
    expect(stats.unknownTypes).toBe(2);
  });

  it("stream_event without event payload is counted", () => {
    const { stats } = translateAll([{ type: "stream_event" }]);
    expect(stats.unknownTypes).toBe(1);
  });

  it("assistant without content array is counted as skipped", () => {
    const { events, stats } = translateAll([{ type: "assistant", message: { role: "assistant" } }]);
    expect(events).toHaveLength(0);
    expect(stats.skippedBlocks).toBe(1);
  });
});

describe("system init", () => {
  it("init emits turn/start (session bootstrap marker)", () => {
    const { events } = translateAll([{ type: "system", subtype: "init", session_id: "cc-uuid" }]);
    expect(events).toEqual([{ type: "turn/start", data: { turn: 0, step: 0 } }]);
  });
});
