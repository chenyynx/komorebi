/**
 * Outbound frame constructor tests — field-by-field assertions per plan §7.1.
 * Every expected shape mirrors PROTOCOL.md v0.7.2 examples.
 */
import { describe, expect, it } from "vitest";
import {
  CAPABILITIES,
  approvalRequestedFrame,
  approvalResolvedFrame,
  attachmentFrame,
  directoriesFrame,
  errorFrame,
  eventFrame,
  helloFrame,
  historyFrame,
  hostFrame,
  modelsFrame,
  pairedFrame,
  permissionFrame,
  permissionOptionsFrame,
  pongFrame,
  selectModelFrame,
  sessionArchivedFrame,
  sessionCancelledFrame,
  sessionRenamedFrame,
  sessionsFrame,
  sentFrame,
  subscribedFrame,
  tasksFrame,
  workspacesFrame,
} from "../../src/protocol/frames";

describe("paired / hello (protocol §1)", () => {
  it("paired carries token and device exactly once", () => {
    const frame = pairedFrame("tok", { id: "d1", name: "iPhone", createdAt: 1787111700000 });
    expect(frame).toEqual({
      kind: "paired",
      token: "tok",
      device: { id: "d1", name: "iPhone", createdAt: 1787111700000 },
    });
  });

  it("hello has protocol 3, full capability set, authenticated true (§1)", () => {
    const frame = helloFrame(3090, 1) as Record<string, unknown>;
    expect(frame["kind"]).toBe("hello");
    expect(frame["protocol"]).toBe(3);
    expect(frame["authenticated"]).toBe(true);
    expect(frame["port"]).toBe(3090);
    expect(frame["clients"]).toBe(1);
    const caps = frame["capabilities"] as string[];
    for (const cap of [
      "split-channels", "images", "commands", "tasks", "goals",
      "session-cancel", "queue-control", "session-archive", "session-rename",
      "file-downloads", "session-create",
    ]) {
      expect(caps).toContain(cap);
    }
  });

  it("CAPABILITIES constant covers the full protocol set (no amputation)", () => {
    expect(CAPABILITIES).toHaveLength(11);
  });
});

describe("pong / subscribed / sent / error", () => {
  it("pong echoes at in ms (§2)", () => {
    expect(pongFrame(1786937352316)).toEqual({ kind: "pong", at: 1786937352316 });
  });

  it("subscribed echoes sessionId (§2)", () => {
    expect(subscribedFrame("session-abc")).toEqual({ kind: "subscribed", sessionId: "session-abc" });
  });

  it("sent carries mode (§4)", () => {
    expect(sentFrame("session-abc", "queue")).toEqual({ kind: "sent", sessionId: "session-abc", mode: "queue" });
  });

  it("error carries all four fields when present (§1)", () => {
    const frame = errorFrame("session-not-found", "no such session", "history", "session-abc");
    expect(frame).toEqual({
      kind: "error",
      code: "session-not-found",
      message: "no such session",
      requestType: "history",
      sessionId: "session-abc",
    });
  });

  it("error omits optional fields cleanly", () => {
    const frame = errorFrame("bad-request", "x");
    expect(frame).toEqual({ kind: "error", code: "bad-request", message: "x" });
  });
});

describe("event frame (protocol §13)", () => {
  it("wraps seq/time/event triple", () => {
    const frame = eventFrame("session-abc", 42, 1786937352, {
      type: "assistant/chunk",
      data: { turn: 1, step: 0, chunkType: "text-delta", text: "正在" },
    });
    expect(frame).toEqual({
      kind: "event",
      sessionId: "session-abc",
      seq: 42,
      time: 1786937352,
      event: { type: "assistant/chunk", data: { turn: 1, step: 0, chunkType: "text-delta", text: "正在" } },
    });
  });
});

describe("history frame (§5)", () => {
  it("carries events, bytes, hasMore, projections, view, nextBeforeSeq", () => {
    const frame = historyFrame({
      sessionId: "session-abc",
      events: [{ type: "user/message", seq: 3, time: 1, data: {} }],
      bytes: 3521,
      view: "conversation",
      hasMore: true,
      nextBeforeSeq: 128,
      projections: { asOfSeq: 127, values: {} },
    }) as Record<string, unknown>;
    expect(frame["kind"]).toBe("history");
    expect(frame["bytes"]).toBe(3521);
    expect(frame["hasMore"]).toBe(true);
    expect(frame["nextBeforeSeq"]).toBe(128);
    expect(frame["view"]).toBe("conversation");
    expect((frame["events"] as unknown[]).length).toBe(1);
  });

  it("omits view and nextBeforeSeq when absent", () => {
    const frame = historyFrame({
      sessionId: "s", events: [], bytes: 0, hasMore: false,
      projections: { asOfSeq: 0, values: {} },
    }) as Record<string, unknown>;
    expect("view" in frame).toBe(false);
    expect("nextBeforeSeq" in frame).toBe(false);
  });
});

describe("sessions / workspaces (§5/§7)", () => {
  // 列表键以客户端为契约：sessions 与 workspaces 都是 `items`
  //（GatewayProtocolFixtures.kt: RouteFixture("""{"kind":"sessions","items":[]}""")；
  //  GatewayFrameRouter.swift:177/188 -> decodeItems(frame.items, ...)）。
  it("sessions list items carry the §5 fields under the `items` key", () => {
    const frame = sessionsFrame([{ sessionId: "s1", title: "t", updatedAt: 1786937352, running: false, blank: true, cwd: "/w" }]) as Record<string, unknown>;
    expect("sessions" in frame).toBe(false);
    const sessions = frame["items"] as Record<string, unknown>[];
    expect(sessions[0]).toEqual({
      sessionId: "s1",
      title: "t",
      updatedAt: 1786937352,
      running: false,
      blank: true,
      cwd: "/w",
      // 客户端读 item.projections.values.title（GatewayModels.swift:473）—— 没有这层就是目录名回退
      projections: { values: { title: "t" } },
    });
  });

  it("workspaces carry items/createdAt/updatedAt + archivedSessionIds (§7)", () => {
    const frame = workspacesFrame(
      [{ workspaceId: "w1", path: "/home/ubuntu", title: "home", sessionIds: ["s1"] }],
      ["archived-1"],
    ) as Record<string, unknown>;
    expect("workspaces" in frame).toBe(false);
    const workspaces = frame["items"] as Record<string, unknown>[];
    expect(workspaces[0]).toMatchObject({ workspaceId: "w1", path: "/home/ubuntu", title: "home", sessionIds: ["s1"] });
    expect(typeof workspaces[0]["createdAt"]).toBe("string");
    expect(typeof workspaces[0]["updatedAt"]).toBe("string");
    expect(frame["archivedSessionIds"]).toEqual(["archived-1"]);
  });
});

describe("models / select-model (§8)", () => {
  it("global catalog shape: groups + failures (§8)", () => {
    const frame = modelsFrame({
      groups: [{ id: "claude-code", name: "Claude Code", models: [{ id: "glm-5.3-flash[1m]", name: "GLM 5.3 Flash" }] }],
      failures: [],
    }) as Record<string, unknown>;
    expect(frame["kind"]).toBe("models");
    expect("current" in frame).toBe(false);
    expect("routable" in frame).toBe(false);
    const groups = frame["groups"] as Record<string, unknown>[];
    expect(groups[0]["id"]).toBe("claude-code");
  });

  it("session catalog adds current + routable (§8)", () => {
    const frame = modelsFrame({
      current: { provider: "claude-code", model: "glm-5.3-flash[1m]" },
      routable: true,
      groups: [],
      failures: [],
    }) as Record<string, unknown>;
    expect(frame["current"]).toEqual({ provider: "claude-code", model: "glm-5.3-flash[1m]" });
    expect(frame["routable"]).toBe(true);
  });

  it("select-model echoes selection incl. reasoningEffort (§8)", () => {
    const frame = selectModelFrame({ provider: "claude-code", model: "m", reasoningEffort: "high" });
    expect(frame).toEqual({
      kind: "select-model",
      selected: { provider: "claude-code", model: "m", reasoningEffort: "high" },
    });
  });
});

describe("permission frames (§9)", () => {
  it("permission-options carries sessionPermissions {options, currentValue, preset} matching client GatewaySessionPermissions", () => {
    const frame = permissionOptionsFrame({
      sessionId: "s",
      options: [
        { value: "read-only", name: "只读" },
        { value: "workspace-write", name: "工作区写入" },
        { value: "danger-full-access", name: "完全访问" },
      ],
      currentValue: "workspace-write",
    }) as Record<string, unknown>;
    const perms = frame["sessionPermissions"] as Record<string, unknown>;
    expect(perms["currentValue"]).toBe("workspace-write");
    expect(perms["preset"]).toBe("workspace-write");
    expect((perms["options"] as unknown[]).length).toBe(3);
  });

  it("permission echoes set with success result (§9)", () => {
    const frame = permissionFrame("session-abc", "workspace-write") as Record<string, unknown>;
    expect(frame["set"]).toBe("workspace-write");
    expect(frame["commandId"]).toMatch(/^perm-/);
    const result = frame["result"] as Record<string, unknown>;
    expect(result["kind"]).toBe("success");
  });
});

describe("HITL frames (§3)", () => {
  it("approval-requested carries rpcId/approvalId/toolName + optional fields (§3.2)", () => {
    const frame = approvalRequestedFrame({
      rpcId: "approval-rpc-1",
      sessionId: "session-abc",
      approvalId: "approval-1",
      toolName: "bash",
      callId: "call-42",
      reason: "escalate sandbox",
      replay: true,
    });
    expect(frame).toEqual({
      kind: "approval-requested",
      rpcId: "approval-rpc-1",
      sessionId: "session-abc",
      approvalId: "approval-1",
      toolName: "bash",
      callId: "call-42",
      reason: "escalate sandbox",
      replay: true,
    });
  });

  it("approval-requested omits optional fields when absent", () => {
    const frame = approvalRequestedFrame({
      rpcId: "r", sessionId: "s", approvalId: "a", toolName: "t",
    }) as Record<string, unknown>;
    expect("callId" in frame).toBe(false);
    expect("replay" in frame).toBe(false);
  });

  it("approval-resolved carries final outcome (§3.2)", () => {
    const frame = approvalResolvedFrame({ rpcId: "r", sessionId: "s", approvalId: "a", outcome: "rejected" });
    expect(frame).toEqual({ kind: "approval-resolved", rpcId: "r", sessionId: "s", approvalId: "a", outcome: "rejected" });
  });
});

describe("session control frames", () => {
  it("session-cancelled echoes accepted (§4 stop)", () => {
    expect(sessionCancelledFrame("s", true)).toEqual({ kind: "session-cancelled", sessionId: "s", accepted: true });
  });

  it("session-renamed carries title + seq (§5)", () => {
    expect(sessionRenamedFrame("s", "新名", 128)).toEqual({ kind: "session-renamed", sessionId: "s", title: "新名", seq: 128 });
  });

  it("session-archived carries full archived set (§5: whole-set replace)", () => {
    const frame = sessionArchivedFrame("s2", ["s1", "s2"]);
    expect(frame).toEqual({ kind: "session-archived", sessionId: "s2", archivedSessionIds: ["s1", "s2"] });
  });
});

describe("attachment / host / directories / tasks (§5/§7/§6)", () => {
  it("attachment echoes attachmentId + attachment meta + base64 data (§5)", () => {
    const frame = attachmentFrame({
      sessionId: "s",
      attachmentId: "sha256-opaque-id",
      attachment: { attachmentId: "sha256-opaque-id", mediaType: "image/jpeg", bytes: 184320, width: 1200, height: 900, name: "IMG.JPG" },
      data: "/9j/4AAQ",
    });
    expect(frame).toEqual({
      kind: "attachment",
      sessionId: "s",
      attachmentId: "sha256-opaque-id",
      attachment: { attachmentId: "sha256-opaque-id", mediaType: "image/jpeg", bytes: 184320, width: 1200, height: 900, name: "IMG.JPG" },
      data: "/9j/4AAQ",
    });
  });

  it("host carries version/cwd/provider/model/attachedSessions/canOpenPath (§12)", () => {
    const frame = hostFrame({ version: "0.1.0", cwd: "/home/ubuntu", provider: "claude-code", model: "glm-5.3-flash[1m]", attachedSessions: 3, canOpenPath: true });
    expect(frame).toEqual({
      kind: "host", version: "0.1.0", cwd: "/home/ubuntu",
      provider: "claude-code", model: "glm-5.3-flash[1m]",
      attachedSessions: 3, canOpenPath: true,
    });
  });

  it("directories carries crumbs + entries with optional bytes/modifiedAt (§7)", () => {
    const frame = directoriesFrame({
      path: "/home/ubuntu",
      crumbs: [{ name: "home", path: "/home/ubuntu" }],
      entries: [
        { name: "project", path: "/home/ubuntu/project", kind: "directory" },
        { name: "a.txt", path: "/home/ubuntu/a.txt", kind: "file", bytes: 12, modifiedAt: 1787111700000 },
      ],
    });
    const entries = (frame as Record<string, unknown>)["entries"] as Record<string, unknown>[];
    expect(entries[0]).toEqual({ name: "project", path: "/home/ubuntu/project", kind: "directory" });
    expect(entries[1]).toEqual({ name: "a.txt", path: "/home/ubuntu/a.txt", kind: "file", bytes: 12, modifiedAt: 1787111700000 });
  });

  it("tasks carries todos null when none written (§6)", () => {
    const frame = tasksFrame("s", 42, null);
    expect(frame).toEqual({ kind: "tasks", sessionId: "s", asOfSeq: 42, todos: null });
    const withTodos = tasksFrame("s", 42, [{ content: "检查", status: "completed" }]);
    expect((withTodos as Record<string, unknown>)["todos"]).toEqual([{ content: "检查", status: "completed" }]);
  });
});
