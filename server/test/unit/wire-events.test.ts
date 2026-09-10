/**
 * Guard tests for the two outbound wire shapes (protocol §13).
 *
 * Regression under test: the live channel must emit FLAT refined payloads and the
 * history channel must emit scheme-A records. Emitting the internal shape
 * (`{type, data}`) on the live channel made every refined field decode to null on
 * the client — assistant text and user messages vanished while tool cards survived.
 */
import { describe, expect, it } from "vitest";
import { schemeAEvent, wireEvent } from "../../src/protocol/wire-events.js";
import type { SessionEvent } from "../../src/domain/events.js";

function ev(type: string, data: Record<string, unknown>, seq = 7): SessionEvent {
  return { type, seq, time: 1_700_000_000, data } as unknown as SessionEvent;
}

describe("wireEvent (live channel: flat refined payload)", () => {
  it("user/message is flat, carries text + source, omits an empty images array", () => {
    const out = wireEvent(ev("user/message", { text: "看看目录", source: "user", images: [] }));
    expect(out["type"]).toBe("user/message");
    expect(out["text"]).toBe("看看目录");
    expect(out["source"]).toBe("user");
    expect(out["images"]).toBeUndefined();
    expect(out["data"]).toBeUndefined(); // the bug: never re-wrap in `data`
  });

  it("assistant/chunk text-delta keeps chunkType + text + position", () => {
    const out = wireEvent(ev("assistant/chunk", { turn: 1, step: 0, chunkType: "text-delta", text: "正在" }));
    expect(out["chunkType"]).toBe("text-delta");
    expect(out["text"]).toBe("正在");
    expect(out["turn"]).toBe(1);
    expect(out["step"]).toBe(0);
  });

  it("assistant/chunk finish renames reason -> kind (FinishInfo.kind is what the client reads)", () => {
    const out = wireEvent(ev("assistant/chunk", { turn: 1, step: 0, chunkType: "finish", finish: { reason: "end_turn" } }));
    expect(out["finish"]).toEqual({ kind: "end_turn" });
  });

  it("assistant/message renames toolCalls[].callId -> id (ToolCall.id is non-null on the client)", () => {
    const out = wireEvent(
      ev("assistant/message", {
        turn: 1,
        step: 1,
        text: "完成",
        reasoning: "让我想想",
        toolCalls: [{ callId: "call_1", name: "Bash", arguments: { command: "ls" } }],
      }),
    );
    expect(out["text"]).toBe("完成");
    expect(out["reasoning"]).toBe("让我想想");
    expect(out["toolCalls"]).toEqual([{ id: "call_1", name: "Bash", arguments: { command: "ls" } }]);
  });

  it("tool/result caps preview at 400 chars and keeps isError", () => {
    const out = wireEvent(ev("tool/result", { turn: 1, step: 1, callId: "call_1", isError: false, preview: "x".repeat(500) }));
    expect(out["callId"]).toBe("call_1");
    expect(out["isError"]).toBe(false);
    expect(String(out["preview"]).length).toBe(401); // 400 + ellipsis
  });

  it("turn/end carries its reason string", () => {
    const out = wireEvent(ev("turn/end", { turn: 1, step: 1, reason: "end_turn" }));
    expect(out["type"]).toBe("turn/end");
    expect(out["reason"]).toBe("end_turn");
    expect(out["data"]).toBeUndefined();
  });
});

describe("schemeAEvent (history channel: raw shapes for RawSessionEvent.normalized)", () => {
  it("user/message becomes a content block list plus a source object", () => {
    const out = schemeAEvent(ev("user/message", { text: "看看目录", source: "user", images: [] }));
    const data = out["data"] as Record<string, unknown>;
    expect(out["seq"]).toBe(7);
    expect(data["content"]).toEqual([{ type: "text", text: "看看目录" }]);
    expect(data["source"]).toEqual({ kind: "user" });
  });

  it("assistant/chunk nests the delta under `chunk` with the position on the outside", () => {
    const out = schemeAEvent(ev("assistant/chunk", { turn: 1, step: 0, chunkType: "text-delta", text: "正在" }));
    const data = out["data"] as Record<string, unknown>;
    expect(data["turn"]).toBe(1);
    expect(data["step"]).toBe(0);
    expect(data["chunk"]).toEqual({ type: "text-delta", text: "正在" });
  });

  it("assistant/message rebuilds message.content with text/reasoning/tool-call blocks", () => {
    const out = schemeAEvent(
      ev("assistant/message", {
        turn: 1,
        step: 1,
        text: "完成",
        reasoning: "让我想想",
        toolCalls: [{ callId: "call_1", name: "Bash", arguments: { command: "ls" } }],
      }),
    );
    const message = (out["data"] as Record<string, unknown>)["message"] as { content: { type: string }[] };
    expect(message.content.map((b) => b.type)).toEqual(["text", "reasoning", "tool-call"]);
    expect(message.content[2]).toEqual({ type: "tool-call", id: "call_1", name: "Bash", arguments: { command: "ls" } });
  });

  it("tool/result rebuilds message.source.callId and a nested text preview", () => {
    const out = schemeAEvent(ev("tool/result", { turn: 1, step: 1, callId: "call_1", isError: true, preview: "boom" }));
    const data = out["data"] as Record<string, unknown>;
    expect((data["message"] as { source: { callId: string } }).source.callId).toBe("call_1");
    expect(data["error"]).toBeTruthy();
  });

  it("turn/end exposes reason.kind (the shape normalized() reads)", () => {
    const out = schemeAEvent(ev("turn/end", { turn: 1, step: 1, reason: "end_turn" }));
    expect((out["data"] as Record<string, unknown>)["reason"]).toEqual({ kind: "end_turn" });
  });
});
