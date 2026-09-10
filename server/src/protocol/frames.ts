/**
 * Outbound frame constructors — every field asserted in unit tests.
 * Wire shape follows PROTOCOL.md v0.7.2 (kind frames, server → client).
 * @module protocol/frames
 */

/** All server→client frames carry `kind` as the discriminator. */
export interface OutboundFrame {
  readonly kind: string;
  [field: string]: unknown;
}

/** Capabilities advertised in hello; must match the protocol set we implement. */
export const CAPABILITIES: readonly string[] = [
  "split-channels",
  "images",
  "commands",
  "tasks",
  "goals",
  "session-cancel",
  "queue-control",
  "session-archive",
  "session-rename",
  "file-downloads",
  "session-create",
];

export function pairedFrame(token: string, device: { id: string; name: string; createdAt: number }): OutboundFrame {
  return { kind: "paired", token, device };
}

export function helloFrame(port: number, clients: number): OutboundFrame {
  return {
    kind: "hello",
    protocol: 3,
    capabilities: [...CAPABILITIES],
    authenticated: true,
    port,
    clients,
  };
}

export function pongFrame(atMs: number): OutboundFrame {
  return { kind: "pong", at: atMs };
}

export function subscribedFrame(sessionId: string): OutboundFrame {
  return { kind: "subscribed", sessionId };
}

export function errorFrame(
  code: string,
  message: string,
  requestType?: string,
  sessionId?: string,
): OutboundFrame {
  const frame: OutboundFrame = { kind: "error", code, message };
  if (requestType !== undefined) frame.requestType = requestType;
  if (sessionId !== undefined) frame.sessionId = sessionId;
  return frame;
}

export function sentFrame(sessionId: string, mode: string): OutboundFrame {
  return { kind: "sent", sessionId, mode };
}

export function eventFrame(
  sessionId: string,
  seq: number,
  time: number,
  event: Record<string, unknown>,
): OutboundFrame {
  return { kind: "event", sessionId, seq, time, event };
}

export function historyFrame(payload: {
  sessionId: string;
  events: readonly unknown[];
  bytes: number;
  view?: string;
  hasMore: boolean;
  nextBeforeSeq?: number;
  projections: Record<string, unknown>;
}): OutboundFrame {
  const frame: OutboundFrame = {
    kind: "history",
    sessionId: payload.sessionId,
    events: [...payload.events],
    bytes: payload.bytes,
    hasMore: payload.hasMore,
    projections: payload.projections,
  };
  if (payload.view !== undefined) frame.view = payload.view;
  if (payload.nextBeforeSeq !== undefined) frame.nextBeforeSeq = payload.nextBeforeSeq;
  return frame;
}

export function sessionsFrame(
  sessions: readonly {
    sessionId: string;
    title?: string;
    updatedAt: number;
    running: boolean;
    blank: boolean;
    cwd?: string;
  }[],
): OutboundFrame {
  return {
    kind: "sessions",
    items: sessions.map((s) => ({
      sessionId: s.sessionId,
      // 客户端读的是 item.projections.values.title（Swift GatewayModels.swift:473 /
      // KMP GatewayDtos.kt:349 的 projectedTitle）—— 顶层 title 它根本不读。
      // 没有 projections 时回退链是 cwd 目录名，这就是"标题显示工作目录"的来源。
      ...(s.title !== undefined
        ? { title: s.title, projections: { values: { title: s.title } } }
        : {}),
      updatedAt: s.updatedAt,
      running: s.running,
      blank: s.blank,
      ...(s.cwd !== undefined ? { cwd: s.cwd } : {}),
    })),
  };
}

export function workspacesFrame(
  workspaces: readonly {
    workspaceId: string;
    path: string;
    title: string;
    sessionIds: readonly string[];
    createdAt?: string;
    updatedAt?: string;
  }[],
  archivedSessionIds: readonly string[] = [],
): OutboundFrame {
  const stamp = new Date().toISOString();
  return {
    kind: "workspaces",
    items: workspaces.map((w) => ({
      workspaceId: w.workspaceId,
      path: w.path,
      title: w.title,
      sessionIds: [...w.sessionIds],
      createdAt: w.createdAt ?? stamp,
      updatedAt: w.updatedAt ?? stamp,
    })),
    archivedSessionIds: [...archivedSessionIds],
  };
}

export function modelsFrame(payload: {
  current?: { provider: string; model: string; reasoningEffort?: string };
  routable?: boolean;
  groups: readonly {
    id: string;
    name: string;
    models: readonly {
      id: string;
      name: string;
      reasoning?: { efforts: readonly { id: string; name: string }[] };
    }[];
  }[];
  failures: readonly unknown[];
}): OutboundFrame {
  const frame: OutboundFrame = {
    kind: "models",
    groups: payload.groups.map((g) => ({
      id: g.id,
      name: g.name,
      models: g.models.map((m) => ({
        id: m.id,
        name: m.name,
        ...(m.reasoning !== undefined ? { reasoning: m.reasoning } : {}),
      })),
    })),
    failures: [...payload.failures],
  };
  if (payload.current !== undefined) frame.current = payload.current;
  if (payload.routable !== undefined) frame.routable = payload.routable;
  return frame;
}

export function selectModelFrame(selected: {
  provider: string;
  model: string;
  reasoningEffort?: string;
}): OutboundFrame {
  const frame: OutboundFrame = {
    kind: "select-model",
    selected: { provider: selected.provider, model: selected.model },
  };
  if (selected.reasoningEffort !== undefined) {
    (frame.selected as Record<string, unknown>).reasoningEffort = selected.reasoningEffort;
  }
  return frame;
}

/**
 * `default-model` 响应：客户端读 frame.selection
 *（fixtures: {"kind":"default-model","selection":{"provider":"openai","model":"gpt-5"}}）。
 */
export function defaultModelFrame(selection: {
  provider: string;
  model: string;
  reasoningEffort?: string;
}): OutboundFrame {
  const frame: OutboundFrame = {
    kind: "default-model",
    selection: { provider: selection.provider, model: selection.model },
  };
  if (selection.reasoningEffort !== undefined) {
    (frame.selection as Record<string, unknown>).reasoningEffort = selection.reasoningEffort;
  }
  return frame;
}

/**
 * `save-default-model` 响应：客户端读 frame.saved，并逐字比对请求里的
 * provider/model/reasoningEffort（SharedSessionControlStore.defaultModelSaved）。
 * 帧类型必须是 save-default-model —— 回成别的种类，这个请求就永远不完成。
 */
export function saveDefaultModelFrame(saved: {
  provider: string;
  model: string;
  reasoningEffort?: string;
}): OutboundFrame {
  const frame: OutboundFrame = {
    kind: "save-default-model",
    saved: { provider: saved.provider, model: saved.model },
  };
  if (saved.reasoningEffort !== undefined) {
    (frame.saved as Record<string, unknown>).reasoningEffort = saved.reasoningEffort;
  }
  return frame;
}

export function permissionOptionsFrame(payload: {
  sessionId?: string;
  options: readonly { value: string; name: string }[];
  currentValue: string;
}): OutboundFrame {
  const frame: OutboundFrame = {
    kind: "permission-options",
    options: payload.options.map((o) => ({ value: o.value, name: o.name })),
    sessionPermissions: { options: payload.options.map((o) => ({ value: o.value, name: o.name })), currentValue: payload.currentValue, preset: payload.currentValue },
  };
  if (payload.sessionId !== undefined) frame.sessionId = payload.sessionId;
  return frame;
}

export function permissionFrame(sessionId: string, set: string): OutboundFrame {
  return {
    kind: "permission",
    sessionId,
    set,
    commandId: `perm-${Date.now()}`,
    result: { kind: "success", text: `permission set to ${set}` },
  };
}

export function approvalRequestedFrame(payload: {
  rpcId: string;
  sessionId: string;
  approvalId: string;
  toolName: string;
  callId?: string;
  reason?: string;
  replay?: boolean;
}): OutboundFrame {
  const frame: OutboundFrame = {
    kind: "approval-requested",
    rpcId: payload.rpcId,
    sessionId: payload.sessionId,
    approvalId: payload.approvalId,
    toolName: payload.toolName,
  };
  if (payload.callId !== undefined) frame.callId = payload.callId;
  if (payload.reason !== undefined) frame.reason = payload.reason;
  if (payload.replay === true) frame.replay = true;
  return frame;
}

export function approvalResolvedFrame(payload: {
  rpcId: string;
  sessionId: string;
  approvalId: string;
  outcome: "allowed-once" | "rejected" | "cancelled" | "unavailable";
}): OutboundFrame {
  return {
    kind: "approval-resolved",
    rpcId: payload.rpcId,
    sessionId: payload.sessionId,
    approvalId: payload.approvalId,
    outcome: payload.outcome,
  };
}

export function sessionCancelledFrame(sessionId: string, accepted: boolean): OutboundFrame {
  return { kind: "session-cancelled", sessionId, accepted };
}

export function sessionRenamedFrame(sessionId: string, title: string, seq: number): OutboundFrame {
  return { kind: "session-renamed", sessionId, title, seq };
}

export function sessionArchivedFrame(sessionId: string, archivedSessionIds: readonly string[]): OutboundFrame {
  return {
    kind: "session-archived",
    sessionId,
    archivedSessionIds: [...archivedSessionIds],
  };
}

export function attachmentFrame(payload: {
  sessionId: string;
  attachmentId: string;
  attachment: Record<string, unknown>;
  data: string;
}): OutboundFrame {
  return {
    kind: "attachment",
    sessionId: payload.sessionId,
    attachmentId: payload.attachmentId,
    attachment: payload.attachment,
    data: payload.data,
  };
}

export function hostFrame(payload: {
  version: string;
  cwd: string;
  provider?: string;
  model?: string;
  attachedSessions: number;
  canOpenPath: boolean;
}): OutboundFrame {
  const frame: OutboundFrame = {
    kind: "host",
    version: payload.version,
    cwd: payload.cwd,
    attachedSessions: payload.attachedSessions,
    canOpenPath: payload.canOpenPath,
  };
  if (payload.provider !== undefined) frame.provider = payload.provider;
  if (payload.model !== undefined) frame.model = payload.model;
  return frame;
}

export function directoriesFrame(payload: {
  path: string;
  crumbs: readonly { name: string; path: string }[];
  entries: readonly {
    name: string;
    path: string;
    kind: "directory" | "file";
    bytes?: number;
    modifiedAt?: number;
  }[];
}): OutboundFrame {
  return {
    kind: "directories",
    path: payload.path,
    crumbs: payload.crumbs.map((c) => ({ name: c.name, path: c.path })),
    entries: payload.entries.map((e) => {
      const out: Record<string, unknown> = { name: e.name, path: e.path, kind: e.kind };
      if (e.bytes !== undefined) out.bytes = e.bytes;
      if (e.modifiedAt !== undefined) out.modifiedAt = e.modifiedAt;
      return out;
    }),
  };
}

export function workspaceCreateFrame(workspace: {
  workspaceId: string;
  path: string;
  title: string;
  sessionIds: readonly string[];
}, created: boolean): OutboundFrame {
  return {
    kind: "workspace-create",
    workspace: {
      workspaceId: workspace.workspaceId,
      path: workspace.path,
      title: workspace.title,
      sessionIds: [...workspace.sessionIds],
    },
    created,
  };
}

export function tasksFrame(sessionId: string, asOfSeq: number, todos: readonly { content: string; status: string }[] | null): OutboundFrame {
  return { kind: "tasks", sessionId, asOfSeq, todos: todos === null ? null : todos.map((t) => ({ ...t })) };
}

export function tasksUpdatedFrame(sessionId: string, asOfSeq: number, todos: readonly { content: string; status: string }[] | null): OutboundFrame {
  return { kind: "tasks-updated", sessionId, asOfSeq, todos: todos === null ? null : todos.map((t) => ({ ...t })) };
}

export function goalFrame(sessionId: string, asOfSeq: number, goal: Record<string, unknown> | null): OutboundFrame {
  return { kind: "goal", sessionId, asOfSeq, goal };
}

export function goalUpdatedFrame(sessionId: string, asOfSeq: number, goal: Record<string, unknown> | null): OutboundFrame {
  return { kind: "goal-updated", sessionId, asOfSeq, goal };
}

export function contextUsageFrame(sessionId: string, payload: Record<string, unknown>): OutboundFrame {
  return { kind: "context-usage", sessionId, ...payload };
}

export function sessionStatsFrame(sessionId: string, asOfSeq: number, payload: Record<string, unknown>): OutboundFrame {
  return { kind: "session-stats", sessionId, asOfSeq, ...payload };
}

export function providersFrame(): OutboundFrame {
  return {
    kind: "providers",
    providers: [{ provider: "claude-code", displayName: "Claude Code", declared: true }],
  };
}

export function sessionCreatedFrame(requestId: string, sessionId: string): OutboundFrame {
  return { kind: "session-created", requestId, sessionId };
}

export function agentPresetsFrame(): OutboundFrame {
  return {
    kind: "agent-presets",
    presets: [{ id: "claude-code", isDefault: true, authorable: false, hasDocument: false }],
    authorable: false,
    hasDocument: false,
    agentPresetDefault: "claude-code",
  };
}

export function defaultsFrame(permissionDefault: string): OutboundFrame {
  return { kind: "defaults", agentPresetDefault: "claude-code", permissionDefault };
}

export function setDefaultFrame(target: string, value: string): OutboundFrame {
  return { kind: "set-default", target, value, applied: true };
}
