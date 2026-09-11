/**
 * Translator tests — fixtures from REAL forms:
 * - assistant blocks: thinking{signature,thinking} / tool_use{id,name,input} / text{text}
 *   (extracted from /home/ubuntu/.claude/projects/-home-ubuntu/*.jsonl, 2026-09-10)
 * - stream_event: SDK 0.3.267 sdk.d.ts:4852 SDKPartialAssistantMessage = raw Messages API events
 * - result: SDKResultSuccess duration/usage fields (sdk.d.ts:5032)
 * - user tool_result: {content, tool_use_id, type} from transcript
 */
import { describe, expect, it } from "vitest";
import { EventTranslator, type SdkMessageLike, type TranslatorStats } from "../../src/backend/translator";

function translateAll(messages: SdkMessageLike[]): { events: { type: string; data: Record<string, unknown> }[]; stats: TranslatorStats } {
  const translator = new EventTranslator();
  const events = messages.flatMap((m) =>
    translator.translate(m).map((d) => ({ type: d.type, data: d.data })),
  );
  return { events, stats: { ...translator.stats } };
}

describe("session-scoped turn numbering (P0-4)", () => {
  it("drafts carry the turn number handed in at construction", () => {
    const translator = new EventTranslator(7);
    const events = [
      { type: "system", subtype: "init", session_id: "cc-x" },
      { type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "hi" } } },
    ].flatMap((m) => translator.translate(m as SdkMessageLike).map((d) => d.data));
    expect(events.every((d) => d["turn"] === 7)).toBe(true);
    expect(translator.currentTurn).toBe(7);
  });

  it("defaults to turn 0 (back-compat for a single-prompt translator)", () => {
    const translator = new EventTranslator();
    const events = translator.translate({ type: "system", subtype: "init" } as SdkMessageLike);
    expect(events[0]?.data["turn"]).toBe(0);
  });
});

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

  it("thinking_delta carries its payload in `thinking` (measured SDK shape)", () => {
    const { events } = translateAll([
      { type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "用户只发了1" } } },
    ]);
    expect(events).toHaveLength(1);
    expect(events[0]?.data).toMatchObject({ chunkType: "reasoning-delta", text: "用户只发了1" });
  });

  it("thinking_delta with a legacy `text` field still streams (fallback)", () => {
    const { events } = translateAll([
      { type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", text: "思考" } } },
    ]);
    expect(events[0]?.data).toMatchObject({ chunkType: "reasoning-delta", text: "思考" });
  });

  it("signature_delta and other delta kinds produce no wire chunks", () => {
    const { events, stats } = translateAll([
      { type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "abc" } } },
    ]);
    expect(events).toHaveLength(0);
    expect(stats.unknownTypes).toBe(0);
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

  it("content_block_stop emits nothing; message_start/message_stop alone carry no payload", () => {
    const { events } = translateAll([
      { type: "stream_event", event: { type: "message_start", message: { id: "msg_a" } } },
      { type: "stream_event", event: { type: "content_block_stop", index: 0 } },
      { type: "stream_event", event: { type: "message_stop" } },
    ]);
    expect(events).toHaveLength(0);
  });

  it("message_start snapshots the step: a mid-message tool_use bump does not move the canonical key", () => {
    // client keys streams by turn-step: if the canonical carried the bumped
    // step, the streamed text of the same message would never be finalized.
    const { events } = translateAll([
      { type: "stream_event", event: { type: "message_start", message: { id: "msg_a" } } },
      { type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "答" } } },
      { type: "stream_event", event: { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "call_1", name: "Read" } } },
      { type: "assistant", message: { role: "assistant", id: "msg_a", content: [{ type: "text", text: "答案" }] } },
      { type: "stream_event", event: { type: "message_stop" } },
    ]);
    const textChunk = events.find((e) => e.data["chunkType"] === "text-delta");
    const canonical = events.find((e) => e.type === "assistant/message");
    expect(textChunk?.data["step"]).toBe(0);
    expect(canonical?.data["step"]).toBe(0);
    const toolCall = events.find((e) => e.type === "tool/call");
    expect(toolCall?.data["step"]).toBe(1); // tool calls still open their own step
  });
});

describe("assistant canonical message (real transcript block forms)", () => {
  it("mixed text+thinking+tool_use → single assistant/message (canonical)", () => {
    // canonical only after message_stop → exactly one, carrying the merged blocks
    const { events } = translateAll([
      { type: "stream_event", event: { type: "message_start", message: { id: "msg_a" } } },
      {
        type: "assistant",
        message: {
          role: "assistant",
          id: "msg_a",
          content: [
            { type: "thinking", thinking: "用户只发了1——测试通道", signature: "sigX" },
            { type: "text", text: "通道通了。" },
            { type: "tool_use", id: "call_1", name: "Read", input: { file_path: "/tmp/a" } },
          ],
        },
      },
      { type: "stream_event", event: { type: "message_stop" } },
    ]);
    expect(events.filter((e) => e.type === "assistant/message")).toHaveLength(1);
    expect(events[0]?.type).toBe("assistant/message");
    expect(events[0]?.data).toEqual({
      turn: 0,
      step: 0,
      text: "通道通了。",
      reasoning: "用户只发了1——测试通道",
      toolCalls: [{ callId: "call_1", name: "Read", arguments: "{\"file_path\":\"/tmp/a\"}" }],
    });
  });

  it("THE STREAMING REGRESSION (2026-09-10): CC splits one API message per block — one canonical, after every chunk", () => {
    // Measured real SDK order (model qwen3.8-flash, includePartialMessages):
    //   message_start(id) → thinking deltas → assistant[thinking] → text deltas
    //   → assistant[text] → message_stop
    // The old per-block canonical finalised the client's "0-0" stream key
    // before the body streamed, so all 31 text chunks were dropped and the
    // answer appeared in one shot.
    const mk = (id: string, kind: string, payload: Record<string, unknown>): SdkMessageLike =>
      ({ type: "assistant", message: { role: "assistant", id, content: [{ type: kind, ...payload } as never] } });
    const { events } = translateAll([
      { type: "system", subtype: "init", session_id: "cc-1" },
      { type: "stream_event", event: { type: "message_start", message: { id: "msg_split" } } },
      { type: "stream_event", event: { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } } },
      { type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "先想" } } },
      mk("msg_split", "thinking", { thinking: "先想一下", signature: "s" }),
      { type: "stream_event", event: { type: "content_block_stop", index: 0 } },
      { type: "stream_event", event: { type: "content_block_start", index: 1, content_block: { type: "text", text: "" } } },
      { type: "stream_event", event: { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "你好" } } },
      { type: "stream_event", event: { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "，我是 Claude" } } },
      mk("msg_split", "text", { text: "你好，我是 Claude。" }),
      { type: "stream_event", event: { type: "content_block_stop", index: 1 } },
      { type: "stream_event", event: { type: "message_stop" } },
    ]);
    const canonicals = events.filter((e) => e.type === "assistant/message");
    expect(canonicals).toHaveLength(1);
    expect(canonicals[0]?.data).toMatchObject({ turn: 0, step: 0, text: "你好，我是 Claude。", reasoning: "先想一下" });

    // every streamed chunk of that turn-step must precede the canonical
    const lastChunk = Math.max(...events.map((e, i) => (e.type === "assistant/chunk" ? i : -1)));
    const canonicalIdx = events.findIndex((e) => e.type === "assistant/message");
    expect(lastChunk).toBeLessThan(canonicalIdx);
    // thinking actually streamed (bug: `thinking` field was never read)
    expect(events.filter((e) => e.data["chunkType"] === "reasoning-delta")).toHaveLength(1);
    expect(events.filter((e) => e.data["chunkType"] === "text-delta")).toHaveLength(2);
  });

  it("truncated stream (no message_stop) still lands its canonical before result frames", () => {
    const { events } = translateAll([
      { type: "stream_event", event: { type: "message_start", message: { id: "msg_cut" } } },
      { type: "assistant", message: { role: "assistant", id: "msg_cut", content: [{ type: "text", text: "半截" } as never] } },
      { type: "result", subtype: "success", usage: {} },
    ]);
    expect(events[0]?.type).toBe("assistant/message");
    expect(events[0]?.data).toMatchObject({ text: "半截" });
    expect(events.map((e) => e.type)).toEqual(["assistant/message", "assistant/chunk", "turn/end"]);
  });

  it("tool_result flushes the requesting message's canonical first (wire order)", () => {
    const { events } = translateAll([
      { type: "assistant", message: { role: "assistant", id: "msg_t", content: [{ type: "tool_use", id: "call_1", name: "Bash", input: {} } as never] } },
      { type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "call_1", content: "ok" }] } },
    ]);
    expect(events.map((e) => e.type)).toEqual(["assistant/message", "tool/result"]);
  });

  it("unknown block types are counted; a content-free message emits NO canonical", () => {
    // an empty canonical would freeze the client's turn-step key and drop the
    // live chunks that follow it, so nothing renderable means nothing emitted.
    const { events, stats } = translateAll([
      { type: "assistant", message: { role: "assistant", id: "msg_u", content: [{ type: "future_block" } as never] } },
      { type: "stream_event", event: { type: "message_stop" } },
    ]);
    expect(events).toHaveLength(0);
    expect(stats.skippedBlocks).toBe(1); // the unknown block itself
    expect(stats.droppedEmptyCanonicals).toBe(1); // and the empty assembly it left behind
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
      { type: "assistant", message: { role: "assistant", id: "m1", content: [{ type: "text", text: "t1" }] } },
      { type: "stream_event", event: { type: "message_stop" } },
      { type: "result", subtype: "success", usage: {} },
      { type: "assistant", message: { role: "assistant", id: "m2", content: [{ type: "text", text: "t2" }] } },
      { type: "stream_event", event: { type: "message_stop" } },
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
