/**
 * SessionOrchestrator — the composition glue between ws dispatch, domain
 * registry/state, backend runner, and the broadcaster. Owns: session lifecycle,
 * per-session ClaudeRunner map, pending approvals (canUseTool ↔ HITL frames),
 * the inbound message queue, and the RPC replies for control frames.
 * @module session/orchestrator
 */

import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AuthenticatedConnection } from "../ws/server.js";
import type { ValidatedFrame } from "../protocol/validation.js";
import { errorFrame } from "../protocol/frames.js";
import {
  directoriesFrame,
  hostFrame,
  modelsFrame,
  permissionFrame,
  permissionOptionsFrame,
  providersFrame,
  selectModelFrame,
  sentFrame,
  sessionArchivedFrame,
  sessionCancelledFrame,
  sessionCreatedFrame,
  sessionRenamedFrame,
  sessionsFrame,
  subscribedFrame,
  workspacesFrame,
  agentPresetsFrame,
  defaultModelFrame,
  defaultsFrame,
  saveDefaultModelFrame,
  setDefaultFrame,
  type OutboundFrame,
} from "../protocol/frames.js";
import { ERROR_CODES } from "../protocol/error-codes.js";
import { SessionRegistry } from "../domain/registry.js";
import type { SessionState } from "../domain/state.js";
import { EventBroadcaster } from "../stream/broadcaster.js";
import { ClaudeRunner, type PermissionOutcome, type SdkQueryFn } from "../backend/claude-runner.js";
import { pageHistory } from "../backend/history.js";
import { schemeAEvent } from "../protocol/wire-events.js";
import { TranscriptReader, transcriptPath } from "../backend/transcript.js";
import {
  currentHostModel,
  resolveSpawnModel,
  withHostModel,
  type Config,
  type ModelEntry,
  type PermissionPreset,
} from "../config.js";

interface PendingApproval {
  readonly rpcId: string;
  readonly sessionId: string;
  readonly approvalId: string;
  readonly resolve: (outcome: PermissionOutcome) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

interface QueueItem {
  readonly id: string;
  readonly text: string;
}

const APPROVAL_TIMEOUT_MS = 10 * 60 * 1000;
const HOME = process.env.HOME ?? "/home/ubuntu";

export class SessionOrchestrator {
  private runners = new Map<string, ClaudeRunner>();
  private queues = new Map<string, QueueItem[]>();
  private pendingApprovals = new Map<string, PendingApproval>();
  private workspaceIds = new Map<string, string>(); // workspaceId → path
  private settings: {
    defaultModel?: { provider: string; model: string; reasoningEffort?: string };
    defaultPermission: PermissionPreset;
  };
  private settingsPath: string;
  private transcript: TranscriptReader;
  /** Set by shutdown(): no new turns, no queue drains, queues dropped. */
  private shuttingDown = false;

  constructor(
    private readonly config: Config,
    private readonly registry: SessionRegistry,
    private readonly broadcaster: EventBroadcaster,
    queryFn: SdkQueryFn,
    transcript?: TranscriptReader,
  ) {
    this.settingsPath = join(config.dataDir, "settings.json");
    this.settings = this.loadSettings();
    this.transcript = transcript ?? new TranscriptReader({
      readFile: (p) => readFileSync(p, "utf8"),
      stat: (p) => statSync(p),
      exists: (p) => existsSync(p),
    });
    this.queryFn = queryFn;
    mkdirSync(config.dataDir, { recursive: true });
  }

  private queryFn: SdkQueryFn;

  // ---------------------------------------------------------------- lifecycle

  /**
   * F2: graceful shutdown. Every in-flight turn gets exactly one terminal
   * frame; queued messages are dropped rather than drained into a process that
   * is going away; pending approvals resolve as denied. Returns how many turns
   * were closed (the restart gate logs this so a silent kill is visible).
   */
  shutdown(): number {
    this.shuttingDown = true;
    let closed = 0;
    for (const runner of this.runners.values()) {
      if (runner.isRunning) {
        runner.terminateForShutdown();
        closed++;
      }
    }
    this.runners.clear();
    for (const state of this.registry.all()) {
      if (state.isRunning) state.setRunning(false);
    }
    this.queues.clear();
    for (const [rpcId, pending] of [...this.pendingApprovals]) {
      clearTimeout(pending.timer);
      pending.resolve({ behavior: "deny", message: "gateway shutting down" });
      this.pendingApprovals.delete(rpcId);
    }
    return closed;
  }

  /**
   * F4: bind a session id the phone still holds to a Claude Code transcript that
   * exists on disk, without a restart. Before the index existed (pre-F1) a
   * restart orphaned the client's id, and every request for it answered
   * session-not-found — the app showed a blank chat page forever.
   *
   * `seq` starts ABOVE the replayed history on purpose: history is renumbered
   * from 0, so a live event reusing a seq the client already saw would be
   * discarded as a duplicate.
   */
  adoptSession(input: { sessionId: string; ccSessionId: string; cwd?: string }): {
    readonly adopted: boolean;
    readonly replayedEvents: number;
    readonly seq: number;
  } {
    const cwd = input.cwd ?? this.config.sessionCwdRoot;
    const path = transcriptPath(HOME, cwd, input.ccSessionId);
    const replayed = this.transcript.read(path).length;
    const seq = replayed + 1;
    const now = Math.floor(Date.now() / 1000);
    const existing = this.registry.get(input.sessionId);
    if (existing === undefined) {
      this.registry.restore({
        sessionId: input.sessionId,
        cwd,
        createdAt: Date.now(), // 与 create 同单位（毫秒）
        updatedAt: now, // 秒，与事件时间同单位
        seq,
        preset: this.settings.defaultPermission,
        ccSessionId: input.ccSessionId,
        archived: false,
      });
      return { adopted: true, replayedEvents: replayed, seq };
    }
    // already known: just (re)point it at the transcript the phone remembers
    existing.attachCcSession(input.ccSessionId);
    return { adopted: false, replayedEvents: replayed, seq: existing.nextSeq };
  }

  /**
   * Boot-time title heal. Sessions persisted before the title rule have no
   * title at all, and the phone then falls back to the cwd basename — that is
   * the "标题怎么是工作目录" symptom. Derive from the first user message in the
   * Claude Code transcript; any read failure simply means "not healed" (R3).
   */
  deriveMissingTitles(): number {
    let healed = 0;
    for (const state of this.registry.all()) {
      if (state.metadata.title !== undefined) continue;
      const cc = state.metadata.ccSessionId;
      if (cc === undefined) continue;
      try {
        const items = this.transcript.read(transcriptPath(HOME, state.metadata.cwd, cc));
        const first = items.find((item) => item.type === "user/message");
        const text = (first as { data?: { text?: unknown } } | undefined)?.data?.text;
        if (typeof text === "string" && text.trim() !== "") {
          state.adoptTitle(text.replace(/\s+/g, " ").trim().slice(0, 28));
          healed++;
        }
      } catch {
        // R3: a broken transcript must never break the boot
      }
    }
    return healed;
  }

  /** Read-only view for the restart gate (F5): what is live on this process. */
  preflightSnapshot(): readonly Record<string, unknown>[] {
    return this.registry.all().map((state) => ({
      sessionId: state.sessionId,
      running: state.isRunning,
      updatedAt: state.metadata.updatedAt,
      cwd: state.metadata.cwd,
      queued: (this.queues.get(state.sessionId) ?? []).length,
    }));
  }

  onOpen(conn: AuthenticatedConnection): void {
    this.broadcaster.track(conn);
    // protocol: new connections receive the current archives set.
    // 官方 lib/index.mjs:2594 只在**非 conversation 通道**发这份 baseline（客户端按通道有
    // 期望：官方测试 gateway.test.mjs:328 断言 conversation 侧收不到 session-archives）。
    if (conn.lane !== "conversation") {
      conn.ws.send(JSON.stringify({ kind: "session-archives", archivedSessionIds: [...this.registry.archivedSet] }));
    }
  }

  onClose(conn: AuthenticatedConnection): void {
    this.broadcaster.untrack(conn);
  }

  /** Entry from GatewayServer: one validated frame per call. */
  onFrame(conn: AuthenticatedConnection, frame: ValidatedFrame): void {
    switch (frame.type) {
      case "ping":
        conn.ws.send(JSON.stringify({ kind: "pong", at: Date.now() }));
        return;
      case "subscribe":
        this.handleSubscribe(conn, frame.sessionId);
        return;
      case "unsubscribe":
        this.broadcaster.unsubscribe(conn);
        conn.ws.send(JSON.stringify({ kind: "subscribed" }));
        return;
      case "sessions":
        conn.ws.send(JSON.stringify(sessionsFrame(this.registry.list())));
        return;
      case "session-create":
        this.handleSessionCreate(conn, frame.requestId, frame.workspaceId, frame.cwd);
        return;
      case "message":
        this.handleMessage(conn, frame);
        return;
      case "history":
        this.handleHistory(conn, frame);
        return;
      case "session-cancel":
        this.handleCancel(conn, frame.sessionId);
        return;
      case "session-rename":
        this.handleRename(conn, frame.sessionId, frame.title);
        return;
      case "session-archive":
        this.handleArchive(conn, frame.sessionId);
        return;
      case "search":
        conn.ws.send(JSON.stringify({ kind: "search", query: frame.query, sessions: this.registry.search(frame.query) }));
        return;
      case "models":
        conn.ws.send(JSON.stringify(this.buildModels(frame.sessionId)));
        return;
      case "select-model":
        this.handleSelectModel(conn, frame);
        return;
      case "providers":
        conn.ws.send(JSON.stringify(providersFrame()));
        return;
      case "default-model":
        // 客户端读 frame.selection（送顶层 provider/model 等于没回）
        conn.ws.send(
          JSON.stringify(
            defaultModelFrame({
              provider: this.settings.defaultModel?.provider ?? "claude-code",
              model: this.settings.defaultModel?.model ?? this.hotModels()[0]?.id ?? "",
              ...(this.settings.defaultModel?.reasoningEffort !== undefined
                ? { reasoningEffort: this.settings.defaultModel.reasoningEffort }
                : {}),
            }),
          ),
        );
        return;
      case "save-default-model": {
        // 2026-09-10 线上事故：这里回的是 select-model 帧，客户端等的 save-default-model 永不到达
        // → App 提示"save-default-model 请求超时，请检查 Mobile Gateway"。回帧类型 + saved 必须都对。
        const saved: { provider: string; model: string; reasoningEffort?: string } = {
          provider: frame.provider,
          model: frame.model,
          ...(frame.reasoningEffort !== undefined ? { reasoningEffort: frame.reasoningEffort } : {}),
        };
        this.settings = { ...this.settings, defaultModel: saved };
        this.saveSettings();
        conn.ws.send(JSON.stringify(saveDefaultModelFrame(saved)));
        return;
      }
      case "permission-options":
        conn.ws.send(JSON.stringify(this.buildPermissionOptions(frame.sessionId)));
        return;
      case "permission":
        this.handlePermission(conn, frame.sessionId, frame.name as PermissionPreset);
        return;
      case "agent-presets":
        conn.ws.send(JSON.stringify(agentPresetsFrame()));
        return;
      case "defaults":
        conn.ws.send(JSON.stringify(defaultsFrame(this.settings.defaultPermission)));
        return;
      case "set-default":
        this.handleSetDefault(conn, frame.target, frame.value);
        return;
      case "host":
        conn.ws.send(JSON.stringify(this.buildHost()));
        return;
      case "workspaces":
        conn.ws.send(JSON.stringify(this.buildWorkspaces()));
        return;
      case "workspace-create":
        this.handleWorkspaceCreate(conn, frame.path);
        return;
      case "directories":
        this.handleDirectories(conn, frame.path);
        return;
      case "directory-create":
        this.handleDirectoryCreate(conn, frame.path, frame.name);
        return;
      case "approval-response":
        this.handleApprovalResponse(conn, frame);
        return;
      case "queue-update":
        this.handleQueueUpdate(conn, frame);
        return;
      case "context-usage":
      case "session-stats":
      case "tasks":
      case "goal":
        conn.ws.send(JSON.stringify(this.buildStatsOrEmpty(frame.type, frame.sessionId)));
        return;
      case "attachment":
        conn.ws.send(JSON.stringify(errorFrame(ERROR_CODES.BAD_REQUEST, "attachment storage lands with images in a later step", "attachment", frame.sessionId)));
        return;
      // protocol-defined but not wired in this build (honest error, never silent):
      case "commands":
      case "command-execute":
      case "command-options":
      case "command-select":
      case "fork":
      case "goal-edit":
      case "goal-pause":
      case "goal-resume":
      case "goal-clear":
      case "question-answer":
      case "question-cancel":
      case "file-list":
      case "file-download-open":
      case "file-download-read":
      case "file-download-cancel":
        conn.ws.send(JSON.stringify(errorFrame(ERROR_CODES.UNKNOWN_COMMAND, `frame ${frame.type} not implemented in this build`, frame.type, "sessionId" in frame ? frame.sessionId : undefined)));
        return;
    }
  }

  // ---------------------------------------------------------------- handlers

  private handleSubscribe(conn: AuthenticatedConnection, sessionId: string): void {
    this.broadcaster.subscribe(conn, sessionId);
    conn.ws.send(JSON.stringify({ kind: "subscribed", sessionId }));
    // protocol: replay still-pending approvals right after subscribed
    for (const frame of this.broadcaster.replayApprovals(sessionId)) {
      conn.ws.send(JSON.stringify(frame));
    }
  }

  private handleSessionCreate(conn: AuthenticatedConnection, requestId: string, workspaceId?: string, cwd?: string): void {
    const resolvedCwd = this.resolveCwd(workspaceId, cwd);
    if (resolvedCwd === null) {
      conn.ws.send(JSON.stringify(errorFrame(ERROR_CODES.WORKSPACE_INVALID_PATH, "workspace/cwd rejected", "session-create", requestId)));
      return;
    }
    const sessionId = randomUUID();
    this.registry.create(sessionId, resolvedCwd, Date.now());
    conn.ws.send(JSON.stringify(sessionCreatedFrame(requestId, sessionId)));
  }

  private handleMessage(conn: AuthenticatedConnection, frame: Extract<ValidatedFrame, { type: "message" }>): void {
    const f = frame.frame;
    let sessionId = f.sessionId;
    let state: SessionState | undefined = sessionId !== undefined ? this.registry.get(sessionId) : undefined;
    if (state === undefined) {
      const resolvedCwd = this.resolveCwd(f.workspaceId, f.cwd);
      if (resolvedCwd === null) {
        conn.ws.send(JSON.stringify(errorFrame(ERROR_CODES.WORKSPACE_INVALID_PATH, "workspace/cwd rejected", "message")));
        return;
      }
      sessionId = randomUUID();
      state = this.registry.create(sessionId, resolvedCwd, Date.now());
    }
    if (this.shuttingDown) {
      conn.ws.send(JSON.stringify(errorFrame(ERROR_CODES.INTERNAL, "gateway is shutting down", "message", f.sessionId ?? "")));
      return;
    }
    if (sessionId === undefined || state === undefined) return; // unreachable

    if (state.isRunning) {
      // CC is single-turn live: park the message; drain after turn/end (plan queue row)
      const item: QueueItem = { id: randomUUID(), text: f.text ?? "" };
      const queue = this.queues.get(sessionId) ?? [];
      queue.push(item);
      this.queues.set(sessionId, queue);
      conn.ws.send(JSON.stringify(sentFrame(sessionId, "queue")));
      this.broadcastQueueSnapshot(sessionId);
      return;
    }

    conn.ws.send(JSON.stringify(sentFrame(sessionId, f.mode ?? "queue")));
    this.startTurn(state, f.text ?? "", f.images);
  }

  private startTurn(state: SessionState, text: string, images?: readonly { mediaType: string; data: string; name?: string }[]): void {
    const userEvent = state.emit("user/message", Math.floor(Date.now() / 1000), { text, source: "user", images: images ?? [] });
    this.broadcaster.broadcastEvent(state.sessionId, userEvent, Date.now());

    let runner = this.runners.get(state.sessionId);
    if (runner === undefined) {
      runner = new ClaudeRunner(
        state,
        {
          query: this.queryFn,
          now: () => Date.now(),
          onIdle: () => this.drainQueue(state.sessionId),
        },
        {
          onEvents: (events) => {
            for (const event of events) this.broadcaster.broadcastEvent(state.sessionId, event, Date.now());
          },
        },
      );
      this.runners.set(state.sessionId, runner);
    }

    const preset = state.metadata.permission.preset;
    // A stale explicit default must never pin a model the current upstream
    // rejects — dropping it lets the host's ANTHROPIC_MODEL (pp's `sm`) win.
    const wanted = state.metadata.nextModel ?? this.settings.defaultModel?.model;
    const model = resolveSpawnModel(wanted, this.hotModels());
    if (wanted !== undefined && model === undefined) {
      console.warn(`[dsh-cc-mgw] ignoring model "${wanted}" (not in the current whitelist); inheriting the host default`);
    }
    const resume = state.metadata.ccSessionId;
    runner.start({
      text,
      ...(images !== undefined ? { images } : {}),
      ...(model !== undefined ? { model } : {}),
      ...(resume !== undefined ? { resume } : {}),
      preset,
      canUseTool: (toolName, input) => this.requestApproval(state.sessionId, toolName, input),
    });
  }

  /** Drain one queued message after a turn ends. */
  drainQueue(sessionId: string): void {
    if (this.shuttingDown) return; // never start a turn we cannot finish
    const queue = this.queues.get(sessionId);
    if (queue === undefined || queue.length === 0) return;
    const state = this.registry.get(sessionId);
    if (state === undefined || state.isRunning) return;
    const next = queue.shift();
    this.broadcastQueueSnapshot(sessionId);
    if (next !== undefined) this.startTurn(state, next.text);
  }

  private broadcastQueueSnapshot(sessionId: string): void {
    const queue = this.queues.get(sessionId) ?? [];
    const frame: OutboundFrame = {
      kind: "session-queue",
      sessionId,
      items: queue.map((item) => ({
        id: item.id,
        placement: "queued",
        message: { id: item.id, content: [{ type: "text", text: item.text }] },
      })),
    };
    this.broadcaster.broadcastControl(frame, Date.now());
  }

  private handleHistory(conn: AuthenticatedConnection, frame: Extract<ValidatedFrame, { type: "history" }>): void {
    const state = this.registry.get(frame.frame.sessionId);
    if (state === undefined) {
      conn.ws.send(JSON.stringify(errorFrame(ERROR_CODES.SESSION_NOT_FOUND, frame.frame.sessionId, "history", frame.frame.sessionId)));
      return;
    }
    let events = [...state.bufferedEvents];
    if (events.length === 0 && state.metadata.ccSessionId !== undefined) {
      // transcript fallback (plan D2): replay on disk with fresh seq numbers
      const path = transcriptPath(HOME, state.metadata.cwd, state.metadata.ccSessionId);
      events = this.transcript.read(path).map((item, index) => ({
        type: item.type,
        seq: index,
        time: item.time,
        data: item.data,
      }));
    }
    const page = pageHistory(events, {
      sessionId: frame.frame.sessionId,
      ...(frame.frame.beforeSeq !== undefined ? { beforeSeq: frame.frame.beforeSeq } : {}),
      ...(frame.frame.maxMessages !== undefined ? { maxMessages: frame.frame.maxMessages } : {}),
      ...(frame.frame.maxBytes !== undefined ? { maxBytes: frame.frame.maxBytes } : {}),
      ...(frame.frame.view !== undefined ? { view: frame.frame.view } : {}),
    });
    conn.ws.send(JSON.stringify({
      kind: "history",
      sessionId: frame.frame.sessionId,
      events: page.events.map((e) => schemeAEvent(e)),
      bytes: page.bytes,
      ...(frame.frame.view !== undefined ? { view: frame.frame.view } : {}),
      hasMore: page.hasMore,
      ...(page.nextBeforeSeq !== undefined ? { nextBeforeSeq: page.nextBeforeSeq } : {}),
      projections: { asOfSeq: page.asOfSeq, values: {} },
    }));
  }

  /**
   * protocol §4: `session-cancel` → `{kind:"session-cancelled", accepted}`.
   *
   * `accepted` answers "is this session stopped now?", not "was there something
   * to interrupt?". The client discards an unaccepted reply and keeps its
   * stop-button spinner up (GatewayRuntime: `if (!correlation.accepted) return
   * null`), which is what pp saw as 未被服务端接收 after my restart had already
   * killed the turn: nothing was left to cancel, yet stopping was still the
   * state the user asked for. Unknown sessions stay an explicit error.
   */
  private handleCancel(conn: AuthenticatedConnection, sessionId: string): void {
    if (this.registry.get(sessionId) === undefined) {
      conn.ws.send(JSON.stringify(errorFrame(ERROR_CODES.SESSION_NOT_FOUND, sessionId, "session-cancel", sessionId)));
      return;
    }
    const runner = this.runners.get(sessionId);
    runner?.abort();
    const accepted = true;
    // pending approvals resolve as denied (turn is over)
    for (const [rpcId, pending] of this.pendingApprovals) {
      if (pending.sessionId !== sessionId) continue;
      clearTimeout(pending.timer);
      pending.resolve({ behavior: "deny", message: "session cancelled" });
      this.pendingApprovals.delete(rpcId);
      this.broadcaster.resolveApproval(rpcId);
    }
    this.queues.delete(sessionId);
    this.broadcastQueueSnapshot(sessionId);
    conn.ws.send(JSON.stringify(sessionCancelledFrame(sessionId, accepted)));
  }

  private handleRename(conn: AuthenticatedConnection, sessionId: string, title: string): void {
    const state = this.registry.get(sessionId);
    if (state === undefined) {
      conn.ws.send(JSON.stringify(errorFrame(ERROR_CODES.SESSION_NOT_FOUND, sessionId, "session-rename", sessionId)));
      return;
    }
    state.setTitle(title);
    const seq = state.lastSeq;
    conn.ws.send(JSON.stringify(sessionRenamedFrame(sessionId, title, seq)));
    this.broadcaster.broadcastControl({ kind: "session-title-changed", sessionId, title, seq, source: { kind: "user" } }, Date.now());
  }

  private handleArchive(conn: AuthenticatedConnection, sessionId: string): void {
    const fullSet = this.registry.archive(sessionId);
    conn.ws.send(JSON.stringify(sessionArchivedFrame(sessionId, fullSet)));
    this.broadcaster.broadcastControl({ kind: "session-archives", archivedSessionIds: [...fullSet] }, Date.now());
  }

  private handleSelectModel(conn: AuthenticatedConnection, frame: Extract<ValidatedFrame, { type: "select-model" }>): void {
    if (!this.hotModels().some((m) => m.id === frame.frame.model)) {
      conn.ws.send(JSON.stringify(errorFrame(ERROR_CODES.MODEL_UNAVAILABLE, frame.frame.model, "select-model", frame.frame.sessionId)));
      return;
    }
    const state = this.registry.get(frame.frame.sessionId);
    if (state === undefined) {
      conn.ws.send(JSON.stringify(errorFrame(ERROR_CODES.SESSION_NOT_FOUND, frame.frame.sessionId, "select-model", frame.frame.sessionId)));
      return;
    }
    state.setNextModel(frame.frame.model);
    conn.ws.send(JSON.stringify(selectModelFrame({
      provider: frame.frame.provider,
      model: frame.frame.model,
      ...(frame.frame.reasoningEffort !== undefined ? { reasoningEffort: frame.frame.reasoningEffort } : {}),
    })));
  }

  private handlePermission(conn: AuthenticatedConnection, sessionId: string, name: PermissionPreset): void {
    const state = this.registry.get(sessionId);
    if (state === undefined) {
      conn.ws.send(JSON.stringify(errorFrame(ERROR_CODES.SESSION_NOT_FOUND, sessionId, "permission", sessionId)));
      return;
    }
    if (!["read-only", "workspace-write", "danger-full-access"].includes(name)) {
      conn.ws.send(JSON.stringify(errorFrame(ERROR_CODES.BAD_REQUEST, `unknown permission preset ${name}`, "permission", sessionId)));
      return;
    }
    state.setPermission(name);
    conn.ws.send(JSON.stringify(permissionFrame(sessionId, name)));
  }

  private handleSetDefault(conn: AuthenticatedConnection, target: string, value: string): void {
    if (target === "permission") {
      this.settings = { ...this.settings, defaultPermission: value as PermissionPreset };
    } else if (target !== "agent-preset") {
      // agent-preset target accepted with the single static preset
      conn.ws.send(JSON.stringify(errorFrame(ERROR_CODES.BAD_REQUEST, `unknown default target ${target}`, "set-default")));
      return;
    }
    this.saveSettings();
    conn.ws.send(JSON.stringify(setDefaultFrame(target, value)));
  }

  private handleApprovalResponse(conn: AuthenticatedConnection, frame: Extract<ValidatedFrame, { type: "approval-response" }>): void {
    const f = frame.frame;
    const pending = this.pendingApprovals.get(f.rpcId);
    if (pending === undefined || pending.sessionId !== f.sessionId || pending.approvalId !== f.approvalId) {
      conn.ws.send(JSON.stringify({ kind: "approval-response", rpcId: f.rpcId, sessionId: f.sessionId, approvalId: f.approvalId, outcome: f.outcome, accepted: false, reason: "not-pending" }));
      return;
    }
    clearTimeout(pending.timer);
    this.pendingApprovals.delete(f.rpcId);
    pending.resolve(f.outcome === "allowed-once" ? { behavior: "allow" } : { behavior: "deny", message: "用户拒绝" });
    conn.ws.send(JSON.stringify({ kind: "approval-response", rpcId: f.rpcId, sessionId: f.sessionId, approvalId: f.approvalId, outcome: f.outcome, accepted: true }));
    this.broadcaster.broadcastControl({ kind: "approval-resolved", rpcId: f.rpcId, sessionId: f.sessionId, approvalId: f.approvalId, outcome: f.outcome }, Date.now());
    this.broadcaster.resolveApproval(f.rpcId);
  }

  private handleQueueUpdate(conn: AuthenticatedConnection, frame: Extract<ValidatedFrame, { type: "queue-update" }>): void {
    const f = frame.frame;
    const queue = this.queues.get(f.sessionId) ?? [];
    const index = queue.findIndex((item) => item.id === f.itemId);
    if (index < 0) {
      conn.ws.send(JSON.stringify({ kind: "queue-item-updated", sessionId: f.sessionId, itemId: f.itemId, action: f.action, accepted: false }));
      return;
    }
    if (f.action === "edit" && f.text !== undefined) {
      queue[index] = { id: f.itemId, text: f.text };
    } else if (f.action === "remove") {
      queue.splice(index, 1);
    } else if (f.action === "steer") {
      const [item] = queue.splice(index, 1);
      this.runners.get(f.sessionId)?.abort();
      const state = this.registry.get(f.sessionId);
      if (state !== undefined && item !== undefined) {
        this.queues.set(f.sessionId, queue);
        conn.ws.send(JSON.stringify({ kind: "queue-item-updated", sessionId: f.sessionId, itemId: f.itemId, action: f.action, accepted: true }));
        this.broadcastQueueSnapshot(f.sessionId);
        this.startTurn(state, item.text);
        return;
      }
    }
    this.queues.set(f.sessionId, queue);
    conn.ws.send(JSON.stringify({ kind: "queue-item-updated", sessionId: f.sessionId, itemId: f.itemId, action: f.action, accepted: true }));
    this.broadcastQueueSnapshot(f.sessionId);
  }

  // ---------------------------------------------------------------- HITL

  /** canUseTool → approval-requested → wait for the mobile decision (D3). */
  private requestApproval(sessionId: string, toolName: string, input: Record<string, unknown>): Promise<PermissionOutcome> {
    const rpcId = randomUUID();
    const approvalId = randomUUID();
    const reason = summarizeToolInput(toolName, input);
    this.broadcaster.registerPendingApproval({
      rpcId,
      sessionId,
      approvalId,
      toolName,
      ...(reason !== undefined ? { reason } : {}),
    });
    this.broadcaster.broadcastControl({
      kind: "approval-requested",
      rpcId,
      sessionId,
      approvalId,
      toolName,
      ...(reason !== undefined ? { reason } : {}),
    }, Date.now());

    return new Promise<PermissionOutcome>((resolve) => {
      const timer = setTimeout(() => {
        this.pendingApprovals.delete(rpcId);
        this.broadcaster.resolveApproval(rpcId);
        this.broadcaster.broadcastControl({ kind: "approval-resolved", rpcId, sessionId, approvalId, outcome: "cancelled" }, Date.now());
        resolve({ behavior: "deny", message: "审批超时（10 分钟）" });
      }, APPROVAL_TIMEOUT_MS);
      this.pendingApprovals.set(rpcId, {
        rpcId,
        sessionId,
        approvalId,
        resolve,
        timer,
      });
    });
  }

  // ---------------------------------------------------------------- builders

  private resolveCwd(workspaceId?: string, cwd?: string): string | null {
    if (workspaceId !== undefined) {
      const path = this.workspaceIds.get(workspaceId);
      if (path !== undefined) return path;
    }
    if (cwd !== undefined) {
      // protocol: absolute path inside the workspace root only
      if (!cwd.startsWith(this.config.workspaceRoot + "/") && cwd !== this.config.workspaceRoot) return null;
      return cwd;
    }
    return this.config.sessionCwdRoot;
  }

  private buildModels(sessionId?: string): OutboundFrame {
    // hot, not the frozen boot list: pp switches providers with `sm`, which only
    // rewrites ~/.claude/settings.json — pm2 is never touched
    const groups = [
      {
        id: "claude-code",
        name: "Claude Code",
        models: this.hotModels().map((m) => ({ id: m.id, name: m.name })),
      },
    ];
    const state = sessionId !== undefined ? this.registry.get(sessionId) : undefined;
    if (state === undefined) {
      return modelsFrame({ groups, failures: [] });
    }
    const currentModel = state.metadata.nextModel ?? this.settings.defaultModel?.model ?? this.hotModels()[0]?.id;
    if (currentModel === undefined) return modelsFrame({ groups, failures: [] });
    return modelsFrame({
      current: { provider: "claude-code", model: currentModel },
      routable: true,
      groups,
      failures: [],
    });
  }

  /**
   * The model set as it stands right now: the host's current default (pp's `sm`)
   * leads, then the configured whitelist. Reading the settings file is cached by
   * path+mtime+size, so this is cheap enough to call per request and per frame.
   */
  private hotModels(): readonly ModelEntry[] {
    return withHostModel(this.config.models, currentHostModel(this.config.hostSettingsPath));
  }

  private buildPermissionOptions(sessionId?: string): OutboundFrame {
    const state = sessionId !== undefined ? this.registry.get(sessionId) : undefined;
    const currentValue = state?.metadata.permission.preset ?? this.settings.defaultPermission;
    return permissionOptionsFrame({
      ...(sessionId !== undefined ? { sessionId } : {}),
      options: [
        { value: "read-only", name: "只读" },
        { value: "workspace-write", name: "工作区写入" },
        { value: "danger-full-access", name: "完全访问" },
      ],
      currentValue,
    });
  }

  private buildHost(): OutboundFrame {
    return hostFrame({
      version: "dsh-cc-mgw 0.1.0 (claude-code)",
      cwd: this.config.workspaceRoot,
      provider: "claude-code",
      model: this.settings.defaultModel?.model ?? this.config.models[0]?.id ?? "",
      attachedSessions: this.registry.list().length,
      canOpenPath: true,
    });
  }

  private buildWorkspaces(): OutboundFrame {
    // 工作区表是内存态：重启走的是 registry.restore（不经 ensureWorkspace），凡是在自定义目录
    // 里跑过的会话都会失去归属 → 客户端按"不在任何工作区 sessionIds 里"把它们塞进「未分组」。
    // 每次构建按可见会话的 cwd 补齐归属（只读会话列表，绝不凭空造会话）。
    for (const session of this.registry.list()) this.ensureWorkspace(session.cwd);
    const entries: {
      workspaceId: string;
      path: string;
      title: string;
      sessionIds: string[];
      createdAt: string;
      updatedAt: string;
    }[] = [];
    // 官方条目带 createdAt/updatedAt（客户端 DTO 为非空字符串）；用该工作区最新会话时间戳派生。
    const stampFor = (sessionIds: readonly string[]): string => {
      const times = this.registry
        .all()
        .filter((s) => sessionIds.includes(s.sessionId))
        .map((s) => s.metadata.updatedAt);
      const newest = times.length > 0 ? Math.max(...times) : Math.floor(Date.now() / 1000);
      return new Date(newest * 1000).toISOString();
    };
    // root workspace always present
    //（__root__ 只是别名：必须与真实条目合并，否则同一 workspaceId 会下发两条）
    const rootPath = this.config.workspaceRoot;
    let rootId = this.workspaceIds.get("__root__");
    if (rootId === undefined) {
      rootId = this.ensureWorkspace(rootPath);
      this.workspaceIds.set("__root__", rootId);
    }
    for (const [wsId, path] of this.workspaceIds) {
      if (wsId === "__root__" || path === rootPath) continue; // 根工作区在下方单独入列
      const sessionIds = this.registry.list().filter((s) => s.cwd === path).map((s) => s.sessionId);
      const stamp = stampFor(sessionIds);
      entries.push({ workspaceId: wsId, path, title: path.split("/").pop() ?? path, sessionIds, createdAt: stamp, updatedAt: stamp });
    }
    const rootSessions = this.registry.list().filter((s) => s.cwd === this.config.workspaceRoot).map((s) => s.sessionId);
    const rootStamp = stampFor(rootSessions);
    entries.unshift({ workspaceId: rootId, path: this.config.workspaceRoot, title: this.config.workspaceRoot.split("/").pop() ?? "home", sessionIds: rootSessions, createdAt: rootStamp, updatedAt: rootStamp });
    return workspacesFrame(entries, this.registry.archivedSet);
  }

  private ensureWorkspace(path: string): string {
    for (const [id, p] of this.workspaceIds) if (p === path) return id;
    // id 由路径派生：同一目录在任何一次启动里都是同一个工作区。自增序号在重启后会重新分配，
    // 手机端记住的 selectedWorkspaceId 就会指向别的目录（分组选择漂移）。
    const id = `w-${createHash("sha256").update(path).digest("hex").slice(0, 8)}`;
    this.workspaceIds.set(id, path);
    return id;
  }

  private handleWorkspaceCreate(conn: AuthenticatedConnection, path: string): void {
    if (!path.startsWith(this.config.workspaceRoot)) {
      conn.ws.send(JSON.stringify(errorFrame(ERROR_CODES.WORKSPACE_INVALID_PATH, path, "workspace-create")));
      return;
    }
    let stat;
    try {
      stat = statSync(path);
    } catch {
      conn.ws.send(JSON.stringify(errorFrame(ERROR_CODES.WORKSPACE_INVALID_PATH, `not found: ${path}`, "workspace-create")));
      return;
    }
    if (!stat.isDirectory()) {
      conn.ws.send(JSON.stringify(errorFrame(ERROR_CODES.WORKSPACE_INVALID_PATH, `not a directory: ${path}`, "workspace-create")));
      return;
    }
    const existing = this.buildWorkspaces();
    const already = ((existing as Record<string, unknown>)["workspaces"] as { path: string; workspaceId: string; title: string; sessionIds: string[] }[]).find((w) => w.path === path);
    if (already !== undefined) {
      conn.ws.send(JSON.stringify({ kind: "workspace-create", workspace: already, created: false }));
      return;
    }
    const id = this.ensureWorkspace(path);
    conn.ws.send(JSON.stringify({ kind: "workspace-create", workspace: { workspaceId: id, path, title: path.split("/").pop() ?? path, sessionIds: [] }, created: true }));
  }

  private handleDirectories(conn: AuthenticatedConnection, path?: string): void {
    const target = path ?? this.config.workspaceRoot;
    if (!target.startsWith(this.config.workspaceRoot)) {
      conn.ws.send(JSON.stringify(errorFrame(ERROR_CODES.WORKSPACE_INVALID_PATH, target, "directories")));
      return;
    }
    try {
      const names = readdirSync(target, { withFileTypes: true });
      const entries = names
        .filter((d) => !d.isSymbolicLink())
        .map((d) => {
          const full = join(target, d.name);
          if (d.isDirectory()) return { name: d.name, path: full, kind: "directory" as const };
          const st = statSync(full);
          return { name: d.name, path: full, kind: "file" as const, bytes: st.size, modifiedAt: st.mtimeMs };
        });
      const crumbs = [{ name: "home", path: this.config.workspaceRoot }];
      conn.ws.send(JSON.stringify(directoriesFrame({ path: target, crumbs, entries })));
    } catch {
      conn.ws.send(JSON.stringify(errorFrame(ERROR_CODES.DIRECTORY_UNREADABLE, target, "directories")));
    }
  }

  private handleDirectoryCreate(conn: AuthenticatedConnection, path: string, name: string): void {
    const target = join(path, name);
    if (existsSync(target)) {
      conn.ws.send(JSON.stringify(errorFrame(ERROR_CODES.DIRECTORY_EXISTS, target, "directory-create")));
      return;
    }
    try {
      mkdirSync(target);
      conn.ws.send(JSON.stringify({ kind: "directory-create", path: target }));
    } catch {
      conn.ws.send(JSON.stringify(errorFrame(ERROR_CODES.BAD_REQUEST, `cannot create ${target}`, "directory-create")));
    }
  }

  private buildStatsOrEmpty(kind: string, sessionId: string): OutboundFrame {
    const state = this.registry.get(sessionId);
    if (state === undefined) return errorFrame(ERROR_CODES.SESSION_NOT_FOUND, sessionId, kind, sessionId);
    const runner = this.runners.get(sessionId);
    const stats = runner?.usageStats;
    if (kind === "context-usage") {
      return { kind: "context-usage", sessionId, tokenUsage: { totals: stats?.usage ?? {} }, contextPressure: { contextWindow: 1000000, pressureTokens: 0, surfaceTokens: 0 } };
    }
    if (kind === "session-stats") {
      return { kind: "session-stats", sessionId, asOfSeq: state.lastSeq, sessionStats: { turns: 0, steps: 0, llmMs: stats?.llmMs ?? 0, toolMs: 0, ttftMs: stats?.llmMs ?? 0, ttftSteps: 1, decodeMs: 0, decodeTokens: 0, lastTurn: 0, openStep: null, pendingCalls: {} }, tokenUsage: { totals: stats?.usage ?? {} } };
    }
    if (kind === "tasks") return { kind: "tasks", sessionId, asOfSeq: state.lastSeq, todos: null };
    return { kind: "goal", sessionId, asOfSeq: state.lastSeq, goal: null };
  }

  // ---------------------------------------------------------------- settings

  private loadSettings(): {
    defaultModel?: { provider: string; model: string; reasoningEffort?: string };
    defaultPermission: PermissionPreset;
  } {
    try {
      const raw = JSON.parse(readFileSync(this.settingsPath, "utf8")) as Record<string, unknown>;
      return {
        ...(typeof raw.defaultModel === "object" && raw.defaultModel !== null ? { defaultModel: raw.defaultModel as { provider: string; model: string; reasoningEffort?: string } } : {}),
        defaultPermission: (typeof raw.defaultPermission === "string" ? raw.defaultPermission : "workspace-write") as PermissionPreset,
      };
    } catch {
      return { defaultPermission: "workspace-write" };
    }
  }

  private saveSettings(): void {
    const tmp = this.settingsPath + ".tmp";
    writeFileSync(tmp, JSON.stringify(this.settings, null, 2), "utf8");
    renameSync(tmp, this.settingsPath);
  }
}

/** Human-readable reason for approval cards (protocol: no full args). */
function summarizeToolInput(toolName: string, input: Record<string, unknown>): string | undefined {
  if (toolName === "Bash" && typeof input.command === "string") {
    return `运行命令: ${input.command.slice(0, 200)}`;
  }
  if ((toolName === "Edit" || toolName === "Write" || toolName === "MultiEdit") && typeof input.file_path === "string") {
    return `修改文件: ${input.file_path}`;
  }
  return undefined;
}
