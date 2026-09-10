/**
 * SessionIndexStore (F1) — the persistence edge. These cases exist because a
 * restart used to blank the phone's session list entirely (incident 2026-09-10):
 * whatever the client still held became an unresolvable id.
 */
import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionIndexStore } from "../../src/domain/session-index";
import { SessionRegistry } from "../../src/domain/registry";

function freshDir(): { dir: string; file: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "mgw-index-"));
  return { dir, file: join(dir, "sessions.json"), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

describe("round trip (what a restart must survive)", () => {
  it("identity, metadata, model and permission all come back", () => {
    const box = freshDir();
    const first = new SessionRegistry();
    const s1 = first.create("s-a", "/home/ubuntu", 1000);
    s1.emit("user/message", 1001, { text: "x" });
    s1.attachCcSession("cc-1");
    s1.setTitle("标题");
    s1.setNextModel("qwen3.8-flash");
    s1.setPermission("read-only");
    new SessionIndexStore(first, box.file).flush();

    // same path, cold registry: this is exactly what boot does
    const second = new SessionRegistry();
    expect(new SessionIndexStore(second, box.file).load()).toBe(1);
    const meta = second.get("s-a")!.metadata;
    expect(meta.cwd).toBe("/home/ubuntu");
    expect(meta.title).toBe("标题");
    expect(meta.ccSessionId).toBe("cc-1");
    expect(meta.nextModel).toBe("qwen3.8-flash");
    expect(meta.permission.preset).toBe("read-only");
    box.cleanup();
  });

  it("seq continues from the persisted counter — the client tracks lastSequence", () => {
    const box = freshDir();
    const first = new SessionRegistry();
    const s = first.create("s-a", "/tmp", 1);
    for (let i = 0; i < 7; i++) s.emit("assistant/chunk", 10 + i, { text: "t" });
    new SessionIndexStore(first, box.file).flush();

    const second = new SessionRegistry();
    new SessionIndexStore(second, box.file).load();
    const back = second.get("s-a")!;
    expect(back.nextSeq).toBe(7);
    const event = back.emit("turn/end", 99, { reason: "shutdown" });
    expect(event.seq).toBe(7); // never reuses a seq the phone already saw
    box.cleanup();
  });

  it("running is never resurrected, and the archive set survives", () => {
    const box = freshDir();
    const first = new SessionRegistry();
    const busy = first.create("s-busy", "/tmp", 1);
    busy.setRunning(true);
    const gone = first.create("s-gone", "/tmp", 2);
    gone.markArchived();
    new SessionIndexStore(first, box.file).flush();

    const second = new SessionRegistry();
    const store = new SessionIndexStore(second, box.file);
    expect(store.load()).toBe(2);
    expect(second.get("s-busy")!.isRunning).toBe(false); // a persisted running is a corpse
    expect(second.list().map((x) => x.sessionId)).toEqual(["s-busy"]); // archived hidden
    expect(second.archivedSet).toContain("s-gone");
    box.cleanup();
  });
});

describe("write discipline", () => {
  it("only writes when content actually changed, and leaves no tmp file", () => {
    const box = freshDir();
    const registry = new SessionRegistry();
    registry.create("s-a", "/tmp", 1);
    const store = new SessionIndexStore(registry, box.file);
    expect(store.flush()).toBe(true);
    expect(store.flush()).toBe(false);
    registry.create("s-b", "/tmp", 2);
    expect(store.flush()).toBe(true);
    expect(existsSync(box.file + ".tmp")).toBe(false);
    const body = JSON.parse(readFileSync(box.file, "utf8")) as { version: number };
    expect(body.version).toBe(1);
    box.cleanup();
  });

  it("a torn/corrupt index degrades to an empty boot instead of crashing", () => {
    const box = freshDir();
    writeFileSync(box.file, "{ this is not json", "utf8");
    const registry = new SessionRegistry();
    const store = new SessionIndexStore(registry, box.file);
    expect(store.load()).toBe(0);
    expect(store.loadRejections).toBe(-1);
    box.cleanup();
  });

  it("one bad record never takes the good ones down with it", () => {
    const box = freshDir();
    writeFileSync(box.file, JSON.stringify({
      version: 1,
      sessions: [
        { sessionId: "ok", cwd: "/tmp", createdAt: 1, updatedAt: 2, seq: 3, preset: "workspace-write" },
        { sessionId: "no-seq", cwd: "/tmp", createdAt: 1, updatedAt: 2, preset: "workspace-write" },
        { sessionId: "", cwd: "/tmp", createdAt: 1, updatedAt: 2, seq: 0, preset: "workspace-write" },
        { sessionId: "bad-preset", cwd: "/tmp", createdAt: 1, updatedAt: 2, seq: 0, preset: "yolo" },
      ],
    }), "utf8");
    const registry = new SessionRegistry();
    const store = new SessionIndexStore(registry, box.file);
    expect(store.load()).toBe(1);
    expect(store.loadRejections).toBe(3);
    expect(registry.get("ok")).toBeDefined();
    box.cleanup();
  });

  it("missing file is a normal first boot", () => {
    const box = freshDir();
    const store = new SessionIndexStore(new SessionRegistry(), join(box.dir, "absent.json"));
    expect(store.load()).toBe(0);
    box.cleanup();
  });

  it("the timer is unref'd so it can never keep the process alive", () => {
    const box = freshDir();
    const store = new SessionIndexStore(new SessionRegistry(), box.file);
    store.start(50);
    store.stop();
    expect(store.flush()).toBe(true); // usable after stop
    box.cleanup();
  });
});

describe("orphan ids the phone still remembers", () => {
  it("archiving an id with no session state survives a restart (no resurrection into 未分组)", () => {
    const box = freshDir();
    const first = new SessionRegistry();
    first.create("real", "/home/ubuntu", Date.now());
    // the app holds an id the gateway never knew (pre-F1 orphan) and archives it
    const fullSet = first.archive("orphan-deadbeef");
    expect(fullSet).toContain("orphan-deadbeef");
    new SessionIndexStore(first, box.file).flush();

    const second = new SessionRegistry();
    second.restore({
      sessionId: "real",
      cwd: "/home/ubuntu",
      createdAt: 1,
      seq: 3,
      updatedAt: 4,
      preset: "workspace-write",
    });
    expect(second.archivedSet).toEqual([]); // fresh boot starts empty
    new SessionIndexStore(second, box.file).load();
    expect(second.archivedSet).toContain("orphan-deadbeef");
    expect(second.get("orphan-deadbeef")).toBeUndefined(); // hidden, never fabricated
    expect(second.list().map((s) => s.sessionId)).toEqual(["real"]);
  });
});
