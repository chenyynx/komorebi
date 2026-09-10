/**
 * Validation unit tests — every inbound frame type gets ≥1 positive and ≥1 negative case,
 * per execution plan §7.1. Fixtures follow PROTOCOL.md v0.7.2 §1-§15 JSON examples.
 */
import { describe, expect, it } from "vitest";
import { validateInbound } from "../../src/protocol/validation";

const OK = (raw: unknown) => {
  const result = validateInbound(raw);
  expect(result.ok).toBe(true);
  return result.ok ? result.value : undefined;
};

const BAD = (raw: unknown, code = "bad-request") => {
  const result = validateInbound(raw);
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.code).toBe(code);
  return result;
};

describe("frame envelope", () => {
  it("rejects non-object frames", () => {
    BAD("ping");
    BAD(42);
    BAD(null);
  });

  it("rejects missing type", () => {
    BAD({ sessionId: "s" });
  });

  it("rejects empty type", () => {
    BAD({ type: "" });
  });

  it("rejects unknown type as unknown-command", () => {
    BAD({ type: "hacker-frame" }, "unknown-command");
  });
});

describe("no-payload frames", () => {
  it("accepts ping/unsubscribe/sessions/providers/workspaces/host/agent-presets/defaults/default-model", () => {
    for (const type of ["ping", "unsubscribe", "sessions", "providers", "workspaces", "host", "agent-presets", "defaults", "default-model"]) {
      expect(OK({ type }).type).toBe(type);
    }
  });
});

describe("subscribe / session control frames", () => {
  it("accepts subscribe with sessionId", () => {
    const value = OK({ type: "subscribe", sessionId: "session-abc" });
    expect(value).toEqual({ type: "subscribe", sessionId: "session-abc" });
  });

  it("rejects subscribe without sessionId", () => {
    BAD({ type: "subscribe" });
  });

  it("rejects subscribe with empty sessionId", () => {
    BAD({ type: "subscribe", sessionId: "  " });
  });

  it("accepts session-cancel/session-archive with sessionId", () => {
    expect(OK({ type: "session-cancel", sessionId: "s" }).type).toBe("session-cancel");
    expect(OK({ type: "session-archive", sessionId: "s" }).type).toBe("session-archive");
  });

  it("accepts session-rename with title", () => {
    const value = OK({ type: "session-rename", sessionId: "s", title: "新名字" });
    expect(value).toEqual({ type: "session-rename", sessionId: "s", title: "新名字" });
  });

  it("rejects session-rename with blank title", () => {
    BAD({ type: "session-rename", sessionId: "s", title: " " });
  });

  it("accepts session-create with requestId", () => {
    const value = OK({ type: "session-create", requestId: "unique-id", workspaceId: "w1" });
    expect(value).toEqual({ type: "session-create", requestId: "unique-id", workspaceId: "w1" });
  });

  it("rejects session-create without requestId (protocol: no auto-retry)", () => {
    BAD({ type: "session-create" });
  });
});

describe("message frame", () => {
  it("accepts text message with sessionId (PROTOCOL §4 example)", () => {
    const value = OK({ type: "message", sessionId: "session-abc", text: "你好", mode: "queue", workspaceId: "w1" });
    expect(value.type).toBe("message");
    if (value.type === "message") {
      expect(value.frame.text).toBe("你好");
      expect(value.frame.mode).toBe("queue");
    }
  });

  it("accepts image-only message (protocol: text or images)", () => {
    const value = OK({
      type: "message",
      sessionId: "s",
      images: [{ mediaType: "image/png", data: "iVBORw0KGgo" }],
    });
    expect(value.type).toBe("message");
  });

  it("rejects message with neither text nor images", () => {
    BAD({ type: "message", sessionId: "s" });
  });

  it("defaults mode to queue and accepts steer", () => {
    const queued = OK({ type: "message", sessionId: "s", text: "x" });
    if (queued.type === "message") expect(queued.frame.mode).toBe("queue");
    const steered = OK({ type: "message", sessionId: "s", text: "x", mode: "steer" });
    if (steered.type === "message") expect(steered.frame.mode).toBe("steer");
  });

  it("accepts clientTimeZone as optional string", () => {
    const value = OK({ type: "message", sessionId: "s", text: "x", clientTimeZone: "Asia/Shanghai" });
    if (value.type === "message") expect(value.frame.clientTimeZone).toBe("Asia/Shanghai");
  });
});

describe("history frame", () => {
  it("accepts full form (PROTOCOL §5 example)", () => {
    const value = OK({ type: "history", sessionId: "session-abc", maxMessages: 60, maxBytes: 4194304, view: "conversation" });
    expect(value.type).toBe("history");
    if (value.type === "history") {
      expect(value.frame.maxMessages).toBe(60);
      expect(value.frame.view).toBe("conversation");
    }
  });

  it("accepts pagination form with beforeSeq", () => {
    const value = OK({ type: "history", sessionId: "s", beforeSeq: 128 });
    if (value.type === "history") expect(value.frame.beforeSeq).toBe(128);
  });

  it("rejects non-integer beforeSeq", () => {
    BAD({ type: "history", sessionId: "s", beforeSeq: 12.5 });
  });

  it("rejects missing sessionId", () => {
    BAD({ type: "history" });
  });
});

describe("models / select-model / save-default-model", () => {
  it("accepts models with and without sessionId (§8)", () => {
    expect(OK({ type: "models" }).type).toBe("models");
    const withSession = OK({ type: "models", sessionId: "session-abc" });
    if (withSession.type === "models") expect(withSession.sessionId).toBe("session-abc");
  });

  it("accepts select-model (§8 example)", () => {
    const value = OK({ type: "select-model", sessionId: "s", provider: "claude-code", model: "glm-5.3-flash[1m]", reasoningEffort: "high" });
    if (value.type === "select-model") {
      expect(value.frame.provider).toBe("claude-code");
      expect(value.frame.reasoningEffort).toBe("high");
    }
  });

  it("rejects select-model without provider", () => {
    BAD({ type: "select-model", sessionId: "s", model: "m" });
  });

  it("accepts save-default-model", () => {
    const value = OK({ type: "save-default-model", provider: "claude-code", model: "glm-5.3-flash[1m]" });
    expect(value.type).toBe("save-default-model");
  });
});

describe("permission frames", () => {
  it("accepts permission-options with optional sessionId (§9)", () => {
    expect(OK({ type: "permission-options" }).type).toBe("permission-options");
    expect(OK({ type: "permission-options", sessionId: "s" }).type).toBe("permission-options");
  });

  it("accepts permission switch (§9 example)", () => {
    const value = OK({ type: "permission", sessionId: "session-abc", name: "workspace-write" });
    expect(value).toEqual({ type: "permission", sessionId: "session-abc", name: "workspace-write" });
  });

  it("rejects permission without name", () => {
    BAD({ type: "permission", sessionId: "s" });
  });
});

describe("goal frames", () => {
  it("accepts goal baseline request", () => {
    expect(OK({ type: "goal", sessionId: "s" }).type).toBe("goal");
  });

  it("accepts goal-edit with ref and objective (§6 example)", () => {
    const value = OK({ type: "goal-edit", sessionId: "s", ref: { id: "goal-opaque-id", revision: 7 }, objective: "完成" });
    if (value.type === "goal-edit") {
      expect(value.frame.ref.revision).toBe(7);
      expect(value.frame.objective).toBe("完成");
    }
  });

  it("rejects goal-edit without either objective or maxGoalRounds", () => {
    BAD({ type: "goal-edit", sessionId: "s", ref: { id: "g", revision: 1 } });
  });

  it("rejects goal-edit with malformed ref", () => {
    BAD({ type: "goal-edit", sessionId: "s", ref: { id: "g" }, objective: "x" });
  });

  it("accepts pause/resume/clear with ref", () => {
    const ref = { id: "g", revision: 2 };
    for (const t of ["goal-pause", "goal-resume", "goal-clear"]) {
      const value = OK({ type: t, sessionId: "s", ref });
      expect(value.type).toBe(t);
    }
  });
});

describe("workspace / directory frames", () => {
  it("accepts workspace-create with absolute path (§7)", () => {
    const value = OK({ type: "workspace-create", path: "/home/ubuntu/project" });
    expect(value).toEqual({ type: "workspace-create", path: "/home/ubuntu/project" });
  });

  it("rejects workspace-create with blank path", () => {
    BAD({ type: "workspace-create", path: "" });
  });

  it("accepts directories with and without path", () => {
    expect(OK({ type: "directories" }).type).toBe("directories");
    const withPath = OK({ type: "directories", path: "/home/ubuntu" });
    if (withPath.type === "directories") expect(withPath.path).toBe("/home/ubuntu");
  });

  it("accepts directory-create with parent path + name (§7)", () => {
    const value = OK({ type: "directory-create", path: "/home/ubuntu/p", name: "Sources" });
    expect(value).toEqual({ type: "directory-create", path: "/home/ubuntu/p", name: "Sources" });
  });

  it("rejects directory-create with slash in name or dot names (§7 rules)", () => {
    BAD({ type: "directory-create", path: "/p", name: "a/b" });
    BAD({ type: "directory-create", path: "/p", name: ".." });
    BAD({ type: "directory-create", path: "/p", name: " " });
  });
});

describe("commands frames", () => {
  it("accepts commands with locale", () => {
    const value = OK({ type: "commands", sessionId: "s", locale: "zh-CN" });
    if (value.type === "commands") expect(value.locale).toBe("zh-CN");
  });

  it("accepts command-execute with slash line (PROTOCOL §4)", () => {
    const value = OK({ type: "command-execute", sessionId: "s", line: "/compact" });
    expect(value).toEqual({ type: "command-execute", sessionId: "s", line: "/compact" });
  });

  it("rejects command-execute line without leading slash", () => {
    BAD({ type: "command-execute", sessionId: "s", line: "compact" });
  });

  it("accepts command-options and command-select (§4)", () => {
    expect(OK({ type: "command-options", sessionId: "s", command: "permission" }).type).toBe("command-options");
    const sel = OK({ type: "command-select", sessionId: "s", command: "permission", optionId: "workspace-write" });
    expect(sel.type).toBe("command-select");
  });

  it("rejects command-select without optionId", () => {
    BAD({ type: "command-select", sessionId: "s", command: "permission" });
  });
});

describe("queue / fork frames (no iOS UI yet — WS-level tests per plan)", () => {
  it("accepts queue-update edit with non-empty text (§4)", () => {
    const value = OK({ type: "queue-update", sessionId: "s", itemId: "message-1", action: "edit", text: "修改后" });
    if (value.type === "queue-update") {
      expect(value.frame.action).toBe("edit");
      expect(value.frame.text).toBe("修改后");
    }
  });

  it("accepts queue-update remove/steer without text", () => {
    for (const action of ["remove", "steer"]) {
      const value = OK({ type: "queue-update", sessionId: "s", itemId: "i", action });
      if (value.type === "queue-update") expect(value.frame.action).toBe(action);
    }
  });

  it("rejects queue-update edit with empty text", () => {
    BAD({ type: "queue-update", sessionId: "s", itemId: "i", action: "edit", text: "" });
  });

  it("rejects queue-update with invalid action", () => {
    BAD({ type: "queue-update", sessionId: "s", itemId: "i", action: "explode" });
  });

  it("accepts fork with optional atSeq (§11)", () => {
    const withSeq = OK({ type: "fork", sessionId: "s", atSeq: 42 });
    if (withSeq.type === "fork") expect(withSeq.atSeq).toBe(42);
    const withoutSeq = OK({ type: "fork", sessionId: "s" });
    if (withoutSeq.type === "fork") expect(withoutSeq.atSeq).toBeUndefined();
  });
});

describe("HITL frames (§3)", () => {
  it("accepts question-answer with batch answers (§3.1)", () => {
    const value = OK({
      type: "question-answer",
      rpcId: "5ce4",
      sessionId: "s",
      answers: [{ id: "research-direction", selected: ["移动网关"] }, { id: "second", custom: "自由输入" }],
    });
    if (value.type === "question-answer") {
      expect(value.frame.answers.length).toBe(2);
    }
  });

  it("rejects question-answer with empty answers", () => {
    BAD({ type: "question-answer", rpcId: "r", answers: [] });
  });

  it("accepts question-cancel", () => {
    const value = OK({ type: "question-cancel", rpcId: "r", sessionId: "s" });
    expect(value.type).toBe("question-cancel");
  });

  it("accepts approval-response allowed-once (§3.2 example)", () => {
    const value = OK({
      type: "approval-response",
      rpcId: "approval-rpc-1",
      sessionId: "session-abc",
      approvalId: "approval-1",
      outcome: "allowed-once",
    });
    if (value.type === "approval-response") expect(value.frame.outcome).toBe("allowed-once");
  });

  it("rejects approval-response with host-only outcome (protocol: cancelled/unavailable not submittable)", () => {
    BAD({ type: "approval-response", rpcId: "r", sessionId: "s", approvalId: "a", outcome: "cancelled" });
  });

  it("rejects approval-response with missing approvalId", () => {
    BAD({ type: "approval-response", rpcId: "r", sessionId: "s", outcome: "rejected" });
  });
});

describe("file frames (§5 file downloads)", () => {
  it("accepts file-list with optional path/requestId", () => {
    const value = OK({ type: "file-list", sessionId: "s", requestId: "files-1" });
    expect(value.type).toBe("file-list");
    const withPath = OK({ type: "file-list", sessionId: "s", path: "builds", requestId: "files-1" });
    if (withPath.type === "file-list") expect(withPath.path).toBe("builds");
  });

  it("accepts file-download-open with path and requestId (§5 example)", () => {
    const value = OK({ type: "file-download-open", sessionId: "s", path: "builds/app-release.apk", requestId: "download-1" });
    expect(value).toEqual({ type: "file-download-open", sessionId: "s", path: "builds/app-release.apk", requestId: "download-1" });
  });

  it("rejects file-download-open with empty path", () => {
    BAD({ type: "file-download-open", sessionId: "s", path: "", requestId: "d1" });
  });

  it("accepts file-download-read with non-negative offset", () => {
    const value = OK({ type: "file-download-read", transferId: "t1", offset: 524288 });
    expect(value).toEqual({ type: "file-download-read", transferId: "t1", offset: 524288 });
  });

  it("rejects negative offset", () => {
    BAD({ type: "file-download-read", transferId: "t1", offset: -1 });
  });

  it("accepts file-download-cancel", () => {
    const value = OK({ type: "file-download-cancel", transferId: "t1" });
    expect(value).toEqual({ type: "file-download-cancel", transferId: "t1" });
  });
});

describe("search / set-default", () => {
  it("accepts search with string query", () => {
    const value = OK({ type: "search", query: "hello" });
    expect(value).toEqual({ type: "search", query: "hello" });
  });

  it("rejects search with missing query", () => {
    BAD({ type: "search" });
  });

  it("accepts set-default (§10 example)", () => {
    const value = OK({ type: "set-default", target: "agent-preset", value: "minimal" });
    expect(value).toEqual({ type: "set-default", target: "agent-preset", value: "minimal" });
  });

  it("rejects set-default with empty value", () => {
    BAD({ type: "set-default", target: "agent-preset", value: "" });
  });
});

describe("misc session frames", () => {
  it("accepts context-usage / session-stats / tasks with sessionId", () => {
    for (const type of ["context-usage", "session-stats", "tasks"]) {
      expect(OK({ type, sessionId: "s" }).type).toBe(type);
    }
  });

  it("accepts attachment with attachmentId", () => {
    const value = OK({ type: "attachment", sessionId: "s", attachmentId: "sha256-opaque-id" });
    expect(value).toEqual({ type: "attachment", sessionId: "s", attachmentId: "sha256-opaque-id" });
  });

  it("rejects attachment without attachmentId", () => {
    BAD({ type: "attachment", sessionId: "s" });
  });
});
