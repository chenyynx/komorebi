/**
 * 跨端协议保真护栏 —— 期望形状全部来自**客户端**与官方参考实现，不来自我方实现：
 *  - shared/src/commonTest/kotlin/com/clarklevis/dsh/shared/GatewayProtocolFixtures.kt（KMP 固定样例）
 *  - DeepSeekHarnessMobile/Core/GatewayFrameRouter.swift（Swift 解码路径）
 *  - DeepSeekHarnessMobileTests/GatewayProtocolTests.swift
 *  - 官方参考实现 ~/refs/dsh/dsh-plugin-mobile-gateway-main（PROTOCOL.md:80/606 + lib/index.mjs:628）
 *
 * 为什么存在：2026-09-10 线上事故 —— `sessions` 帧我方发 `sessions:[...]`，客户端读
 * `items:[...]`（GatewayFrameRouter.swift:188 -> decodeItems(frame.items) /
 * SharedMobileStore.kt:209 -> frame.items.orEmpty()），于是 App 每次都合并到**空列表**：
 * 远端会话的 running 标记永不更新，用户重进会话永远看到"停止/暂停"按钮（无法再发消息）。
 * 这类"字段名漂移"不报错、不崩溃，只静默失效 —— 所以逐帧钉死键名。
 */
import { describe, expect, it } from "vitest";
import {
  agentPresetsFrame,
  helloFrame,
  sessionsFrame,
  workspacesFrame,
} from "../../src/protocol/frames.js";

const OFFICIAL = {
  hello: '{"kind":"hello","protocol":3,"capabilities":["images"],"authenticated":true,"clients":2}',
  sessions: '{"kind":"sessions","items":[]}',
  workspaces: '{"kind":"workspaces","items":[],"archivedSessionIds":[]}',
  agentPresets: '{"kind":"agent-presets","presets":[],"authorable":false,"hasDocument":false}',
} as const;

function typeClass(value: unknown): string {
  if (Array.isArray(value)) return "array";
  if (value === null) return "null";
  return typeof value;
}

/** 官方样例里出现的每个键，我方帧必须存在且类型类别一致（多余键允许；改名/缺失不允许）。 */
function expectParity(frame: unknown, fixtureJson: string, label: string): void {
  const actual = frame as Record<string, unknown>;
  const fixture = JSON.parse(fixtureJson) as Record<string, unknown>;
  for (const [key, expected] of Object.entries(fixture)) {
    expect(actual, `${label}: 缺键 ${key}`).toHaveProperty(key);
    expect(typeClass(actual[key]), `${label}: 键 ${key} 类型不符`).toBe(typeClass(expected));
  }
}

describe("wire parity with the client contract", () => {
  it("hello carries protocol/capabilities/authenticated/clients", () => {
    expectParity(helloFrame(3090, 2), OFFICIAL.hello, "hello");
  });

  it("sessions list key is `items` (regression: 2026-09-10 stuck stop-button)", () => {
    const frame = sessionsFrame([{ sessionId: "s1", updatedAt: 1, running: true, blank: false }]);
    expectParity(frame, OFFICIAL.sessions, "sessions");
    expect(Object.keys(frame as Record<string, unknown>)).not.toContain("sessions");
  });

  it("workspaces carry items + archivedSessionIds, never `workspaces`", () => {
    const frame = workspacesFrame(
      [{ workspaceId: "w1", path: "/home/ubuntu", title: "home", sessionIds: ["s1"] }],
      ["s1"],
    ) as Record<string, unknown>;
    expectParity(frame, OFFICIAL.workspaces, "workspaces");
    expect(Object.keys(frame)).not.toContain("workspaces");
    expect(frame["archivedSessionIds"]).toEqual(["s1"]);
  });

  it("agent-presets exposes authorable/hasDocument at the top level (Swift reads frame.authorable)", () => {
    expectParity(agentPresetsFrame(), OFFICIAL.agentPresets, "agent-presets");
  });
});
