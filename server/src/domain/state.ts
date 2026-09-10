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

export interface PermissionState {
  readonly preset: "read-only" | "workspace-write" | "danger-full-access";
}

/** Bounded ring buffer of session events (plan: drop oldest, never crash). */
const MAX_BUFFERED_EVENTS = 5000;

export class SessionState {
  private seqCounter = 0;
  private buffer: SessionEvent[] = [];
  private running = false;
  readonly createdAt: number;

  constructor(readonly sessionId: string, readonly cwd: string, createdAt: number) {
    this.createdAt = createdAt;
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

  /** Append an already-seq'd event; seq must equal the next allocation exactly. */
  append(event: SessionEvent): void {
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
