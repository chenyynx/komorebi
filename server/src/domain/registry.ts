/**
 * Session registry: sessionId → SessionState map, list ordering, archive set.
 * Owns no I/O — persistence of the index lives in the store layer (later stage).
 * @module domain/registry
 */

import { SessionState } from "./state.js";

export interface SessionListItem {
  readonly sessionId: string;
  readonly title?: string;
  readonly updatedAt: number;
  readonly running: boolean;
  readonly blank: boolean;
  readonly cwd: string;
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

  /** Full-text search over titles and first user message (§5 search). */
  search(query: string): readonly SessionListItem[] {
    const needle = query.trim().toLowerCase();
    if (needle === "") return this.list();
    const results: SessionListItem[] = [];
    for (const state of this.sessions.values()) {
      const meta = state.metadata;
      if (meta.archived || this.archivedIds.has(meta.sessionId)) continue;
      const titleHit = meta.title !== undefined && meta.title.toLowerCase().includes(needle);
      const firstUserHit = this.firstUserText(state).toLowerCase().includes(needle);
      if (titleHit || firstUserHit) {
        results.push({
          sessionId: meta.sessionId,
          ...(meta.title !== undefined ? { title: meta.title } : {}),
          updatedAt: meta.updatedAt,
          running: state.isRunning,
          blank: state.isBlank,
          cwd: meta.cwd,
        });
      }
    }
    results.sort((a, b) => b.updatedAt - a.updatedAt);
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
