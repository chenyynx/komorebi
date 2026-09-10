/**
 * TranscriptReader tests — fixture forms from REAL host transcripts
 * (/home/ubuntu/.claude/projects/-home-ubuntu/*.jsonl, structure verified
 * 2026-09-10): thinking{signature,thinking} / tool_use{id,name,input} /
 * tool_result{content(string),tool_use_id} / bookkeeping lines ignored.
 */
import { describe, expect, it, vi } from "vitest";
import { TranscriptReader, transcriptPath, type FileSystem } from "../../src/backend/transcript";
import { EventTranslator, type SdkMessageLike } from "../../src/backend/translator";

/** In-memory FS with call counters (proves zero-IO cache hits). */
function fakeFs(files: Record<string, string>): { fs: FileSystem; reads: () => number } {
  let readCount = 0;
  const fs: FileSystem = {
    readFile: (path) => {
      readCount++;
      const text = files[path];
      if (text === undefined) throw new Error(`ENOENT ${path}`);
      return text;
    },
    stat: (path) => {
      const text = files[path];
      if (text === undefined) throw new Error(`ENOENT ${path}`);
      return { mtimeMs: 1000, size: text.length };
    },
    exists: (path) => path in files,
  };
  return { fs, reads: () => readCount };
}

const line = (obj: Record<string, unknown>) => JSON.stringify(obj);

const userTurn = (text: string) =>
  line({ type: "user", timestamp: "2026-09-09T20:35:32.314Z", message: { role: "user", content: [{ type: "text", text }] } });

const assistantThinking = (thinking: string) =>
  line({ type: "assistant", timestamp: "2026-09-09T20:35:35.100Z", message: { role: "assistant", content: [{ type: "thinking", thinking, signature: "sigX" }] } });

const assistantToolUse = (id: string, name: string, input: unknown) =>
  line({ type: "assistant", timestamp: "2026-09-09T20:35:36.000Z", message: { role: "assistant", content: [{ type: "tool_use", id, name, input }] } });

const toolResult = (toolUseId: string, content: string, isError = false) =>
  line({ type: "user", timestamp: "2026-09-09T20:35:37.000Z", message: { role: "user", content: [{ type: "tool_result", tool_use_id: toolUseId, content, ...(isError ? { is_error: true } : {}) }] } });

const BOOKKEEPING = line({ type: "queue-operation", operation: "enqueue", timestamp: "2026-09-09T20:35:32.314Z", sessionId: "x" });

describe("path resolution", () => {
  it("maps cwd + cc session id to the projects slug path (Happy claudeRemote:291 same scheme)", () => {
    expect(transcriptPath("/home/ubuntu", "/home/ubuntu/claudio", "abc-123")).toBe(
      "/home/ubuntu/.claude/projects/-home-ubuntu-claudio/abc-123.jsonl",
    );
  });
});

describe("line parsing (real shapes)", () => {
  it("two prompt cycles become turns 0 and 1; tool_use bumps step", () => {
    const path = "/t/one.jsonl";
    const { fs } = fakeFs({
      [path]: [
        BOOKKEEPING, // ignored
        userTurn("第一条"),
        assistantThinking("想一下"),
        assistantToolUse("call_1", "Read", { file_path: "/tmp/a" }),
        toolResult("call_1", "内容"),
        userTurn("第二条"),
        line({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "回了" }] } }),
      ].join("\n"),
    });
    const items = new TranscriptReader(fs).read(path);
    const users = items.filter((i) => i.type === "user/message");
    expect(users).toHaveLength(2);
    expect(users[0]?.data["turn"]).toBe(0);
    expect(users[1]?.data["turn"]).toBe(1);
    const assistants = items.filter((i) => i.type === "assistant/message");
    const firstCycle = assistants.filter((a) => a.data["turn"] === 0);
    expect(firstCycle.some((a) => a.data["reasoning"] === "想一下")).toBe(true);
    expect(firstCycle.some((a) => (a.data["toolCalls"] as { callId: string }[])[0]?.callId === "call_1")).toBe(true);
    // step advanced for the tool call
    const toolEvents = items.filter((i) => i.type === "tool/result");
    expect(toolEvents[0]?.data["preview"]).toBe("内容");
    expect(toolEvents[0]?.data["isError"]).toBe(false);
  });

  it("is_error propagates through replay", () => {
    const path = "/t/err.jsonl";
    const { fs } = fakeFs({ [path]: [toolResult("c1", "boom", true)].join("\n") });
    const items = new TranscriptReader(fs).read(path);
    expect(items[0]?.data["isError"]).toBe(true);
  });

  it("malformed lines (torn writes) are skipped without crashing", () => {
    const path = "/t/broken.jsonl";
    const { fs } = fakeFs({ [path]: [line({ type: "user", message: { content: [{ type: "text", text: "ok" }] } }), '{"type": "assistant", "message": {trunca'].join("\n") });
    const items = new TranscriptReader(fs).read(path);
    expect(items.filter((i) => i.type === "user/message")).toHaveLength(1);
  });

  it("string-form message.content is normalized to a text block", () => {
    const path = "/t/str.jsonl";
    const { fs } = fakeFs({ [path]: line({ type: "user", message: { role: "user", content: "纯字符串" } }) });
    const items = new TranscriptReader(fs).read(path);
    expect(items[0]?.data["text"]).toBe("纯字符串");
  });

  it("sidechain (subagent) lines are not replayed", () => {
    const path = "/t/side.jsonl";
    const { fs } = fakeFs({
      [path]: [
        line({ type: "assistant", isSidechain: true, message: { content: [{ type: "text", text: "内部" }] } }),
        userTurn("正常"),
      ].join("\n"),
    });
    const items = new TranscriptReader(fs).read(path);
    expect(items.filter((i) => i.type === "assistant/message")).toHaveLength(0);
  });
});

describe("cache (R3 large-file guard)", () => {
  it("second read of an unchanged file performs zero readFile calls", () => {
    const path = "/t/cached.jsonl";
    const { fs, reads } = fakeFs({ [path]: userTurn("x") });
    const reader = new TranscriptReader(fs);
    const first = reader.read(path);
    const readsAfterFirst = reads();
    const second = reader.read(path);
    expect(reads()).toBe(readsAfterFirst); // zero additional IO
    expect(second).toEqual(first);
  });

  it("missing file degrades to empty history (R3 contract)", () => {
    const { fs } = fakeFs({});
    expect(new TranscriptReader(fs).read("/nope.jsonl")).toEqual([]);
  });

  it("catastrophic parse failure never throws — returns empty", () => {
    const reader = new TranscriptReader({
      exists: () => true,
      stat: () => {
        throw new Error("EIO");
      },
      readFile: () => "",
    });
    expect(reader.read("/any")).toEqual([]);
  });
});


/* ------------------------------------------------------------------ *
 * D-3 (2026-09-10): replay must hand the client the SAME canonical
 * structure the live stream does — one per API message, on that
 * message's own step. Fixture ids mirror real transcripts
 * (chatcmpl-*, present on 620/620 assistant lines on this host).
 * ------------------------------------------------------------------ */

const asst = (msgId: string | undefined, blocks: unknown[], ts = "2026-09-09T20:35:36.000Z") =>
  line({
    type: "assistant",
    timestamp: ts,
    message: { role: "assistant", ...(msgId === undefined ? {} : { id: msgId }), content: blocks },
  });

function readReplay(jsonl: string) {
  const path = "/t/parity.jsonl";
  const { fs } = fakeFs({ [path]: jsonl });
  return new TranscriptReader(fs).read(path);
}

describe("per-API-message canonical (replay mirrors live)", () => {
  it("split blocks sharing one id merge into a single canonical", () => {
    const items = readReplay([
      userTurn("\u4f60\u597d"),
      asst("chatcmpl-A", [{ type: "thinking", thinking: "\u5148\u60f3", signature: "s" }]),
      asst("chatcmpl-A", [{ type: "text", text: "\u4f60\u597d\uff0c\u6211\u662f" }]),
      asst("chatcmpl-A", [{ type: "text", text: "Claude\u3002" }]),
    ].join("\n"));
    const canon = items.filter((i) => i.type === "assistant/message");
    expect(canon).toHaveLength(1);
    expect(canon[0]?.data).toEqual({
      turn: 0, step: 0, text: "\u4f60\u597d\uff0c\u6211\u662fClaude\u3002", reasoning: "\u5148\u60f3", toolCalls: [],
    });
  });

  it("canonical keeps its own step while tool_use bumps the step for later events", () => {
    const items = readReplay([
      userTurn("\u5217\u76ee\u5f55"),
      asst("chatcmpl-B", [{ type: "thinking", thinking: "\u8981\u8c03\u5de5\u5177" }]),
      asst("chatcmpl-B", [{ type: "tool_use", id: "call_1", name: "Bash", input: { command: "ls" } }]),
      toolResult("call_1", "a.txt"),
      asst("chatcmpl-C", [{ type: "text", text: "\u6709 a.txt" }]),
    ].join("\n"));
    const canon = items.filter((i) => i.type === "assistant/message");
    expect(canon).toHaveLength(2);
    expect(canon[0]?.data["step"]).toBe(0); // the requesting message's own step
    expect((canon[0]?.data["toolCalls"] as { callId: string }[])[0]?.callId).toBe("call_1");
    expect(items.find((i) => i.type === "tool/result")?.data["step"]).toBe(1);
    expect(canon[1]?.data["step"]).toBe(1); // the follow-up message inherits it
    // canonical of the requesting message precedes its tool/result (live wire order)
    const types = items.map((i) => i.type);
    expect(types.indexOf("assistant/message")).toBeLessThan(types.indexOf("tool/result"));
  });

  it("distinct ids stay separate; id-less lines never merge", () => {
    const items = readReplay([
      userTurn("q"),
      asst("chatcmpl-X", [{ type: "text", text: "\u7b2c\u4e00\u6761" }]),
      asst("chatcmpl-Y", [{ type: "text", text: "\u7b2c\u4e8c\u6761" }]),
      asst(undefined, [{ type: "text", text: "\u65e0 id \u4e00" }]),
      asst(undefined, [{ type: "text", text: "\u65e0 id \u4e8c" }]),
    ].join("\n"));
    const canon = items.filter((i) => i.type === "assistant/message");
    expect(canon).toHaveLength(4);
    expect(canon.map((c) => c.data["text"])).toEqual([
      "\u7b2c\u4e00\u6761", "\u7b2c\u4e8c\u6761", "\u65e0 id \u4e00", "\u65e0 id \u4e8c",
    ]);
  });

  it("a content-free assistant line produces no canonical (no key freeze for nothing)", () => {
    const items = readReplay([
      userTurn("q"),
      asst("chatcmpl-E", [{ type: "thinking", thinking: "" }]),
      asst("chatcmpl-F", [{ type: "text", text: "\u53ea\u6709\u8fd9\u6761" }]),
    ].join("\n"));
    const canon = items.filter((i) => i.type === "assistant/message");
    expect(canon).toHaveLength(1);
    expect(canon[0]?.data["text"]).toBe("\u53ea\u6709\u8fd9\u6761");
  });

  it("PARITY: replay canonicals equal live translator canonicals for the same round trip", () => {
    // live side: the SDK sequence measured on this host (per-block assistant
    // messages sharing one API message id, wrapped by message_start/stop)
    const translator = new EventTranslator();
    const liveScript: SdkMessageLike[] = [
      { type: "system", subtype: "init", session_id: "cc-1" },
      { type: "stream_event", event: { type: "message_start", message: { id: "m1" } } },
      { type: "assistant", message: { role: "assistant", id: "m1", content: [{ type: "thinking", thinking: "\u60f3" }] } },
      { type: "stream_event", event: { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "call_9", name: "Bash" } } },
      { type: "assistant", message: { role: "assistant", id: "m1", content: [{ type: "tool_use", id: "call_9", name: "Bash", input: { command: "ls" } }] } },
      { type: "stream_event", event: { type: "message_stop" } },
      { type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "call_9", content: "a.txt" }] } },
      { type: "stream_event", event: { type: "message_start", message: { id: "m2" } } },
      { type: "assistant", message: { role: "assistant", id: "m2", content: [{ type: "text", text: "\u7b54\u6848" }] } },
      { type: "stream_event", event: { type: "message_stop" } },
    ];
    const live = liveScript
      .flatMap((m) => [...translator.translate(m)])
      .filter((d) => d.type === "assistant/message")
      .map((d) => ({ turn: d.data["turn"], step: d.data["step"], text: d.data["text"], reasoning: d.data["reasoning"], toolCalls: d.data["toolCalls"] }));

    // replay side: the same round trip as CC would have written it to disk
    const replay = readReplay([
      userTurn("\u5217\u76ee\u5f55"),
      asst("m1", [{ type: "thinking", thinking: "\u60f3" }]),
      asst("m1", [{ type: "tool_use", id: "call_9", name: "Bash", input: { command: "ls" } }]),
      toolResult("call_9", "a.txt"),
      asst("m2", [{ type: "text", text: "\u7b54\u6848" }]),
    ].join("\n"))
      .filter((i) => i.type === "assistant/message")
      .map((i) => ({ turn: i.data["turn"], step: i.data["step"], text: i.data["text"], reasoning: i.data["reasoning"], toolCalls: i.data["toolCalls"] }));

    expect(replay).toEqual(live);
    expect(live).toHaveLength(2); // guards against both sides collapsing to zero
  });

  it("cache: an unchanged file still costs zero extra reads after the merge pass", () => {
    const path = "/t/cached.jsonl";
    const { fs, reads } = fakeFs({ [path]: [userTurn("q"), asst("m", [{ type: "text", text: "a" }])].join("\n") });
    const reader = new TranscriptReader(fs);
    const first = reader.read(path);
    const second = reader.read(path);
    expect(second).toEqual(first);
    expect(reads()).toBe(1);
  });
});
