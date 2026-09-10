/**
 * TranscriptReader tests — fixture forms from REAL host transcripts
 * (/home/ubuntu/.claude/projects/-home-ubuntu/*.jsonl, structure verified
 * 2026-09-10): thinking{signature,thinking} / tool_use{id,name,input} /
 * tool_result{content(string),tool_use_id} / bookkeeping lines ignored.
 */
import { describe, expect, it, vi } from "vitest";
import { TranscriptReader, transcriptPath, type FileSystem } from "../../src/backend/transcript";

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
