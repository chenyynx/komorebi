/**
 * SessionRegistry tests — plan §7.1 domain/registry.ts row:
 * updatedAt ordering, running/blank judgement, archive whole-set replacement,
 * concurrent creation without id collision.
 */
import { describe, expect, it } from "vitest";
import { SessionRegistry } from "../../src/domain/registry";

describe("list", () => {
  it("sorts by updatedAt descending", () => {
    const registry = new SessionRegistry();
    const a = registry.create("a", "/w", 1);
    a.emit("user/message", 100, { text: "first" });
    const b = registry.create("b", "/w", 2);
    b.emit("user/message", 200, { text: "second" });
    const list = registry.list();
    expect(list.map((s) => s.sessionId)).toEqual(["b", "a"]);
  });

  it("running and blank flags come from state", () => {
    const registry = new SessionRegistry();
    const running = registry.create("r", "/w", 1);
    running.setRunning(true);
    running.emit("user/message", 1, { text: "x" });
    const blank = registry.create("blank", "/w", 2);
    const list = registry.list().sort((x, y) => x.sessionId.localeCompare(y.sessionId));
    expect(list.find((s) => s.sessionId === "r")).toMatchObject({ running: true, blank: false });
    expect(list.find((s) => s.sessionId === "blank")).toMatchObject({ running: false, blank: true });
  });
});

describe("archive semantics (protocol §5: whole-set replacement)", () => {
  it("archive adds one and returns the full confirmed set", () => {
    const registry = new SessionRegistry();
    registry.create("a", "/w", 1);
    registry.create("b", "/w", 2);
    const set = registry.archive("a");
    expect(set).toEqual(["a"]);
    const set2 = registry.archive("b");
    expect(set2).toEqual(["a", "b"]); // full set, not append-only
  });

  it("replaceArchiveSet swaps wholesale (WebUI-side sync)", () => {
    const registry = new SessionRegistry();
    registry.replaceArchiveSet(["x", "y"]);
    registry.replaceArchiveSet(["z"]);
    expect(registry.archivedSet).toEqual(["z"]);
  });

  it("archived sessions disappear from list", () => {
    const registry = new SessionRegistry();
    const a = registry.create("a", "/w", 1);
    a.emit("user/message", 10, { text: "hi" });
    registry.archive("a");
    expect(registry.list().find((s) => s.sessionId === "a")).toBeUndefined();
  });
});

describe("creation", () => {
  it("rejects duplicate session ids", () => {
    const registry = new SessionRegistry();
    registry.create("dup", "/w", 1);
    expect(() => registry.create("dup", "/w", 2)).toThrow(/duplicate session id/);
  });

  it("distinct ids never collide (concurrent creation)", () => {
    const registry = new SessionRegistry();
    for (let i = 0; i < 100; i++) {
      registry.create(`s-${i}`, "/w", i);
    }
    expect(registry.list()).toHaveLength(100);
  });
});

describe("search (§5)", () => {
  it("matches title case-insensitively", () => {
    const registry = new SessionRegistry();
    const a = registry.create("a", "/w", 1);
    a.emit("user/message", 10, { text: "hello world" });
    a.setTitle("Claude Code 接入");
    const hits = registry.search("claude");
    expect(hits.map((s) => s.sessionId)).toEqual(["a"]);
  });

  it("matches first user message text", () => {
    const registry = new SessionRegistry();
    const b = registry.create("b", "/w", 1);
    b.emit("user/message", 10, { text: "帮我查一下 deepseek" });
    const hits = registry.search("deepseek");
    expect(hits.map((s) => s.sessionId)).toEqual(["b"]);
  });

  it("empty query returns full list", () => {
    const registry = new SessionRegistry();
    registry.create("a", "/w", 1);
    registry.create("b", "/w", 2);
    expect(registry.search("")).toHaveLength(2);
  });
});

describe("timestamps (§5 sessions.updatedAt)", () => {
  it("a freshly created blank session already has a sane updatedAt (never 1970)", () => {
    const registry = new SessionRegistry();
    const nowMs = Date.now();
    registry.create("fresh", "/w", nowMs);
    const item = registry.list()[0];
    // 客户端按 updatedAt 排序：0 会把会话沉到 1970（线上表现 = "会话藏进分组/找不到"）
    expect(item.updatedAt).toBeGreaterThan(1_600_000_000);
    expect(item.updatedAt).toBe(Math.floor(nowMs / 1000));
  });

  it("restore heals a stored updatedAt=0 and normalizes a seconds-based createdAt to ms", () => {
    const registry = new SessionRegistry();
    const seconds = Math.floor(Date.now() / 1000);
    registry.restore({
      sessionId: "old",
      cwd: "/w",
      createdAt: seconds, // 历史数据：adopt 路径曾写秒
      seq: 0,
      updatedAt: 0, // 历史数据：空白会话
      preset: "workspace-write",
    });
    const item = registry.list()[0];
    expect(item.updatedAt).toBe(seconds);
    expect(registry.get("old")?.record().createdAt).toBe(seconds * 1000);
  });
});
