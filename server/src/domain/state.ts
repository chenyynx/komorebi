/**
 * Per-session state: seq allocation, event buffer, metadata, CC id mapping.
 * Single authority for one session's ordered event history (plan §4 domain/state.ts).
 * @module domain/state
 */

import type { SessionEvent, SessionEventType } from "./events.js";

export interface SessionMetadata {
  readonly sessionId: string;
  title: string | undefined;
  updatedAt: number;
  readonly cwd: string;
  /** Our sequence of the Claude Code session this maps to (resume id). */
  ccSessionId: string | undefined;
  archived: boolean;
  /** Model selection that takes effect on next turn. */
  nextModel: string | undefined;
  /** Effective permission preset (pp decision: three modes, default workspace-write). */
  permission: PermissionState;
}

/** What the index store writes to disk for one session. */
export interface SessionRecord {
  readonly sessionId: string;
  readonly cwd: string;
  readonly createdAt: number;
  /** Next seq to allocate (not a high-water mark of buffered events). */
  readonly seq: number;
  readonly updatedAt: number;
  readonly preset: PermissionState["preset"];
  readonly title?: string;
  readonly ccSessionId?: string;
  readonly nextModel?: string;
  readonly archived?: boolean;
}

export interface PermissionState {
  readonly preset: "read-only" | "workspace-write" | "danger-full-access";
}

/** Bounded ring buffer of session events (plan: drop oldest, never crash). */
const MAX_BUFFERED_EVENTS = 5000;

export class SessionState {
  private seqCounter = 0;
  /**
   * Next turn number (session-scoped: one user prompt = one turn). Must NOT be
   * a fresh-translator-zero: the client keys streamed chunks by `turn-step`,
   * so a reused turn number makes the trajectory projection merge unrelated
   * chunks and fail closed ("replacement node wire value 无效", 2026-09-11).
   */
  private turnCounter = 0;
  private turnSeededFlag = false;
  private buffer: SessionEvent[] = [];
  private running = false;
  createdAt: number;

  constructor(readonly sessionId: string, readonly cwd: string, createdAt: number) {
    this.createdAt = createdAt;
    // updatedAt 与事件时间同单位（秒）。这里必须初始化：否则"建了但还没说话"的空白会话
    // updatedAt=0 → 客户端按时间排序把它沉到 1970（表现为"会话藏在分组里/找不到"）。
    this.updatedAt = createdAt > 1e12 ? Math.floor(createdAt / 1000) : createdAt;
  }

  get metadata(): SessionMetadata {
    return {
      sessionId: this.sessionId,
      title: this.title,
      updatedAt: this.updatedAt,
      cwd: this.cwd,
      ccSessionId: this.ccSessionId,
      archived: this.archived,
      nextModel: this.nextModel,
      permission: { preset: this.preset },
    };
  }

  // -- metadata (kept as fields; metadata getter copies) --
  private title: string | undefined;
  private updatedAt = 0;
  private ccSessionId: string | undefined;
  private archived = false;
  private nextModel: string | undefined;
  private preset: SessionMetadata["permission"]["preset"] = "workspace-write";

  get isRunning(): boolean {
    return this.running;
  }

  /** Blank = no events and nothing in flight (§5 sessions.blank). */
  get isBlank(): boolean {
    return this.buffer.length === 0 && !this.running;
  }

  get lastSeq(): number {
    return this.seqCounter - 1;
  }

  get bufferedEvents(): readonly SessionEvent[] {
    return this.buffer;
  }

  /** Allocate the next strictly monotonic seq (starts at 0). */
  allocateSeq(): number {
    return this.seqCounter++;
  }

  /** Next seq to be allocated — persisted so the client's seq space survives a restart. */
  get nextSeq(): number {
    return this.seqCounter;
  }

  /**
   * Restore persisted fields. The event buffer is deliberately NOT rebuilt here:
   * history comes from Claude Code's own transcript on disk (plan D2). What IS
   * restored is the seq counter — the client tracks `lastSequence`, so live
   * frames reusing a seq it already saw would be discarded after a restart.
   * `running` is never resurrected: a persisted running flag is a corpse.
   */
  hydrate(input: {
    readonly title?: string;
    readonly updatedAt?: number;
    readonly ccSessionId?: string;
    readonly archived?: boolean;
    readonly nextModel?: string;
    readonly preset?: SessionMetadata["permission"]["preset"];
    readonly seq?: number;
    readonly createdAt?: number;
  }): void {
    if (input.title !== undefined) this.title = input.title;
    if (input.updatedAt !== undefined) this.updatedAt = input.updatedAt;
    if (input.ccSessionId !== undefined) this.ccSessionId = input.ccSessionId;
    if (input.nextModel !== undefined) this.nextModel = input.nextModel;
    if (input.preset !== undefined) this.preset = input.preset;
    if (input.archived === true) this.archived = true;
    if (input.createdAt !== undefined) this.createdAt = input.createdAt;
    if (input.seq !== undefined && input.seq > this.seqCounter) this.seqCounter = input.seq;
    this.running = false;
  }

  /** Next turn number to allocate (consumed once per started turn). */
  nextTurn(): number {
    return this.turnCounter++;
  }

  /** Raise the counter so replayed/legacy turns never collide with new ones. */
  seedTurnCounter(next: number): void {
    if (next > this.turnCounter) this.turnCounter = next;
  }

  get turnSeeded(): boolean {
    return this.turnSeededFlag;
  }

  markTurnSeeded(): void {
    this.turnSeededFlag = true;
  }

  /** Persistable projection of this session (used by the index store). */
  record(): SessionRecord {
    const meta = this.metadata;
    return {
      sessionId: this.sessionId,
      cwd: this.cwd,
      createdAt: this.createdAt,
      seq: this.seqCounter,
      ...(meta.title !== undefined ? { title: meta.title } : {}),
      ...(meta.ccSessionId !== undefined ? { ccSessionId: meta.ccSessionId } : {}),
      ...(meta.nextModel !== undefined ? { nextModel: meta.nextModel } : {}),
      ...(meta.archived ? { archived: true } : {}),
      preset: meta.permission.preset,
      updatedAt: meta.updatedAt,
    };
  }

  /**
   * Host 侧标题规则：首条 user/message 的正文前 28 字（与客户端本地生成标题的规则一致，
   * SessionListReducer.applyEvent: user/message -> event.text.take(28)）。用户重命名优先，
   * 一旦有 title 不再改写。为什么在 append 里做：这是所有事件进入会话的唯一漏斗，
   * 且 title 会随 record() 落盘 —— 否则重启后标题退回「目录名」。
   */
  private maybeDeriveTitle(event: SessionEvent): void {
    if (this.title !== undefined || event.type !== "user/message") return;
    const data = event.data as { text?: unknown; content?: { type?: unknown; text?: unknown }[] };
    const fromContent = Array.isArray(data?.content)
      ? data.content
          .filter((block): block is { type: string; text: string } => block?.type === "text" && typeof block.text === "string")
          .map((block) => block.text)
          .join(" ")
      : "";
    const raw = (typeof data?.text === "string" ? data.text : "") || fromContent;
    this.adoptTitle(raw.replace(/\s+/g, " ").trim().slice(0, 28));
  }

  /** Append an already-seq'd event; seq must equal the next allocation exactly. */
  append(event: SessionEvent): void {
    this.maybeDeriveTitle(event);
    if (event.seq !== this.seqCounter) {
      throw new Error(`non-monotonic seq ${event.seq}, expected ${this.seqCounter}`);
    }
    this.seqCounter++;
    this.buffer.push(event);
    if (this.buffer.length > MAX_BUFFERED_EVENTS) {
      this.buffer = this.buffer.slice(this.buffer.length - MAX_BUFFERED_EVENTS);
    }
    this.updatedAt = event.time;
  }

  /** Convenience: build the next event and append it atomically. */
  emit(type: SessionEventType, time: number, data: unknown): SessionEvent {
    const event: SessionEvent = { type, seq: this.seqCounter, time, data };
    this.append(event);
    return event;
  }

  /** Latest TodoWrite projection (client task card); undefined = never written. */
  private todosInternal: readonly { content: string; status: "pending" | "in_progress" | "completed" }[] | undefined;
  get todos(): readonly { content: string; status: "pending" | "in_progress" | "completed" }[] | undefined {
    return this.todosInternal;
  }
  setTodos(todos: readonly { content: string; status: "pending" | "in_progress" | "completed" }[] | undefined): void {
    this.todosInternal = todos;
  }

  /** Replace the buffered event at a seq (used by canonical assistant/message replacing chunks). */
  replaceAt(seq: number, type: SessionEventType, time: number, data: unknown): SessionEvent {
    const index = this.buffer.findIndex((e) => e.seq === seq);
    const event: SessionEvent = { type, seq, time, data };
    if (index >= 0) this.buffer[index] = event;
    else this.buffer.push(event);
    return event;
  }

  /** Events with seq < beforeSeq, newest first, capped by maxMessages. */
  pageEvents(beforeSeq: number | undefined, maxMessages: number): readonly SessionEvent[] {
    const all = beforeSeq === undefined ? this.buffer : this.buffer.filter((e) => e.seq < beforeSeq);
    // protocol pages newest→older; caller reverses as needed
    const slice = all.slice(Math.max(0, all.length - maxMessages));
    return slice;
  }

  /**
   * 采用一个派生标题：只在还没有标题时生效，且**不动 updatedAt**
   * （启动补齐若走 setTitle，会把所有会话刷成"刚刚活跃"，排序全乱）。
   */
  adoptTitle(title: string): void {
    if (this.title === undefined && title !== "") this.title = title;
  }

  setTitle(title: string): void {
    this.title = title;
    this.updatedAt = Math.floor(Date.now() / 1000);
  }

  attachCcSession(ccSessionId: string): void {
    this.ccSessionId = ccSessionId;
  }

  markArchived(): void {
    this.archived = true;
  }

  setNextModel(model: string): void {
    this.nextModel = model;
  }

  setPermission(preset: SessionMetadata["permission"]["preset"]): void {
    this.preset = preset;
  }

  setRunning(running: boolean): void {
    this.running = running;
  }

  /** Event lookup for tests and history by seq range. */
  eventsBetween(minSeq: number, maxSeq: number): readonly SessionEvent[] {
    return this.buffer.filter((e) => e.seq >= minSeq && e.seq <= maxSeq);
  }
}
