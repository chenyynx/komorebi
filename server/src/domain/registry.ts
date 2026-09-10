/**
 * Session registry: sessionId → SessionState map, list ordering, archive set.
 * Owns no I/O — persistence lives in domain/session-index.ts, which reads and
 * writes this module's snapshot()/restore() surface.
 * @module domain/registry
 */

import { SessionState, type SessionRecord } from "./state.js";

export interface SessionListItem {
  readonly sessionId: string;
  readonly title?: string;
  readonly updatedAt: number;
  readonly running: boolean;
  readonly blank: boolean;
  readonly cwd: string;
}

/** Client contract: GatewaySearchItem {sessionId, snippet} (GatewayDtos.kt:352); snippet is required or the whole entry is dropped on decode. */
export interface SessionSearchItem {
  readonly sessionId: string;
  readonly snippet: string;
}

export class SessionRegistry {
  private sessions = new Map<string, SessionState>();
  private archivedIds = new Set<string>();

  create(sessionId: string, cwd: string, now: number): SessionState {
    if (this.sessions.has(sessionId)) {
      throw new Error(`duplicate session id: ${sessionId}`);
    }
    const state = new SessionState(sessionId, cwd, now);
    this.sessions.set(sessionId, state);
    return state;
  }

  get(sessionId: string): SessionState | undefined {
    return this.sessions.get(sessionId);
  }

  /** Every live session, insertion order (shutdown sweep needs the whole set). */
  all(): readonly SessionState[] {
    return [...this.sessions.values()];
  }

  /** Persistable snapshot of the index — the store layer's only input. */
  snapshot(): readonly SessionRecord[] {
    return [...this.sessions.values()].map((state) => state.record());
  }

  /**
   * Rebuild one session from disk. Idempotent by sessionId; `running` is never
   * restored (SessionState.hydrate forces it false).
   */
  restore(record: SessionRecord): SessionState {
    const existing = this.sessions.get(record.sessionId);
    if (existing !== undefined) return existing;
    // 索引里的 createdAt 历史上混过两种单位（毫秒 / 秒），updatedAt 也出现过 0（空白会话）。
    // 载入时统一：createdAt → 毫秒，updatedAt → 有效秒（缺失/0 时由 createdAt 派生）。
    const createdMs = record.createdAt > 1e12 ? record.createdAt : record.createdAt * 1000;
    const updatedSeconds = record.updatedAt > 0 ? record.updatedAt : Math.floor(createdMs / 1000);
    const state = new SessionState(record.sessionId, record.cwd, createdMs);
    state.hydrate({
      ...(record.title !== undefined ? { title: record.title } : {}),
      updatedAt: updatedSeconds,
      ...(record.ccSessionId !== undefined ? { ccSessionId: record.ccSessionId } : {}),
      archived: record.archived === true,
      ...(record.nextModel !== undefined ? { nextModel: record.nextModel } : {}),
      preset: record.preset,
      seq: record.seq,
      createdAt: createdMs,
    });
    if (record.archived === true) this.archivedIds.add(record.sessionId);
    this.sessions.set(record.sessionId, state);
    return state;
  }

  /** Protocol §5: archived sessions hidden, list sorted by updatedAt desc. */
  list(): readonly SessionListItem[] {
    const items: SessionListItem[] = [];
    for (const state of this.sessions.values()) {
      const meta = state.metadata;
      if (meta.archived || this.archivedIds.has(meta.sessionId)) continue;
      items.push({
        sessionId: meta.sessionId,
        ...(meta.title !== undefined ? { title: meta.title } : {}),
        updatedAt: meta.updatedAt,
        running: state.isRunning,
        blank: state.isBlank,
        cwd: meta.cwd,
      });
    }
    items.sort((a, b) => b.updatedAt - a.updatedAt);
    return items;
  }

  /** Protocol §5: archive is a whole-set replacement, not append. */
  replaceArchiveSet(sessionIds: readonly string[]): void {
    this.archivedIds = new Set(sessionIds);
  }

  /** Protocol §5: session-archive returns the full set after adding one. */
  archive(sessionId: string): readonly string[] {
    this.archivedIds.add(sessionId);
    const state = this.sessions.get(sessionId);
    if (state) state.markArchived();
    return [...this.archivedIds];
  }

  get archivedSet(): readonly string[] {
    return [...this.archivedIds];
  }

  /**
   * Archived ids with no session state behind them. These are the phone's
   * orphans: ids minted before the index existed (pre-F1 restarts wiped them),
   * which the app still lists — under "未分组" — and can never open.
   * Archiving one must stick, or every restart resurrects the dead rows.
   */
  archivedUnknownIds(): readonly string[] {
    return [...this.archivedIds].filter((id) => !this.sessions.has(id));
  }

  /** Re-arm those ids after a boot (no state created, just the hidden set). */
  rememberArchivedOnly(ids: readonly string[]): void {
    for (const id of ids) {
      if (id !== "") this.archivedIds.add(id);
    }
  }

  /** Full-text search over titles and first user message (§5 search).
   * Returns {sessionId, snippet} entries — the client's GatewaySearchItem
   * shape. `sessions`-keyed entries without snippet decode to nothing on the
   * phone ("0 results" bug, audit 2026-09-11 §二-2). */
  search(query: string): readonly SessionSearchItem[] {
    const needle = query.trim().toLowerCase();
    const trim = (text: string): string => text.trim().slice(0, 80);
    const results: SessionSearchItem[] = [];
    if (needle === "") return results; // empty query -> no items, client keeps local filter
    for (const state of this.sessions.values()) {
      const meta = state.metadata;
      if (meta.archived || this.archivedIds.has(meta.sessionId)) continue;
      const firstUserText = this.firstUserText(state);
      let snippet: string | undefined = undefined;
      if (meta.title !== undefined && meta.title.toLowerCase().includes(needle)) {
        snippet = meta.title;
      } else if (firstUserText.toLowerCase().includes(needle)) {
        snippet = firstUserText;
      }
      if (snippet !== undefined) {
        results.push({ sessionId: meta.sessionId, snippet: trim(snippet) });
      }
    }
    return results;
  }

  private firstUserText(state: SessionState): string {
    for (const event of state.bufferedEvents) {
      if (event.type === "user/message") {
        const data = event.data as { text?: unknown };
        return typeof data.text === "string" ? data.text : "";
      }
    }
    return "";
  }
}
