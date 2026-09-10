/**
 * SessionIndexStore — the persistence edge for the session index (F1).
 *
 * Why this exists: the registry is in-memory, so before F1 every `pm2 restart`
 * erased the phone's whole session list. The user-visible failure was worse than
 * a missing list: the client kept a session id it could no longer resolve and
 * hung waiting for events (incident 2026-09-10).
 *
 * Design rules:
 * - registry stays I/O-free; this is the only module that touches sessions.json
 * - writes are atomic (tmp + rename): a torn index file would blank the list
 *   again at the next boot, i.e. the failure we are fixing
 * - reads degrade to an empty index on ANY problem (missing/corrupt/unknown
 *   shape) — the gateway must boot, matching the R3 rule used for transcripts
 * - `running` is never persisted as true, so a kill mid-turn cannot leave a
 *   session forever showing "running" after restart
 * @module domain/session-index
 */

import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { SessionRegistry } from "./registry.js";
import type { SessionRecord } from "./state.js";

export interface SessionIndexFile {
  readonly version: 1;
  readonly sessions: readonly SessionRecord[];
  /**
   * Archived ids the registry has no state for (the phone's orphan sessions).
   * Optional so older files still load; an unknown-shape read never fails.
   */
  readonly archivedOnly?: readonly string[];
}

/** Fields a record must carry to be trusted; everything else is optional. */
function isRecord(value: unknown): value is SessionRecord {
  if (typeof value !== "object" || value === null) return false;
  const r = value as Record<string, unknown>;
  if (typeof r["sessionId"] !== "string" || r["sessionId"] === "") return false;
  if (typeof r["cwd"] !== "string") return false;
  if (typeof r["seq"] !== "number" || !Number.isSafeInteger(r["seq"]) || r["seq"] < 0) return false;
  if (typeof r["createdAt"] !== "number" || typeof r["updatedAt"] !== "number") return false;
  const preset = r["preset"];
  return preset === "read-only" || preset === "workspace-write" || preset === "danger-full-access";
}

export class SessionIndexStore {
  private lastWritten = "";
  private timer: NodeJS.Timeout | undefined;
  /** Count of records dropped during the last load (diagnostics, never fatal). */
  private rejected = 0;

  constructor(
    private readonly registry: SessionRegistry,
    private readonly path: string,
  ) {}

  /**
   * Load the index into the registry. Returns the number of sessions restored;
   * 0 either means no file yet or the file was unusable (see loadErrors).
   */
  load(): number {
    let raw: string;
    try {
      if (!existsSync(this.path)) return 0;
      raw = readFileSync(this.path, "utf8");
    } catch {
      return 0;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      this.rejected = -1; // whole file unreadable
      return 0;
    }
    const records = (parsed as Partial<SessionIndexFile> | null)?.sessions;
    if (!Array.isArray(records)) {
      this.rejected = -1;
      return 0;
    }
    let restored = 0;
    let dropped = 0;
    for (const record of records) {
      if (!isRecord(record)) {
        dropped++;
        continue;
      }
      this.registry.restore(record);
      restored++;
    }
    const archivedOnly = (parsed as Partial<SessionIndexFile> | null)?.archivedOnly;
    if (Array.isArray(archivedOnly)) {
      this.registry.rememberArchivedOnly(
        archivedOnly.filter((id): id is string => typeof id === "string" && id !== ""),
      );
    }
    this.rejected = dropped;
    // a successful load becomes the write baseline, so an unchanged boot
    // rewrites nothing
    this.lastWritten = JSON.stringify(this.envelope());
    return restored;
  }

  /** Records dropped by the last load (-1 = whole file unusable). */
  get loadRejections(): number {
    return this.rejected;
  }

  /**
   * Serialize and write when — and only when — the content changed. Best-effort:
   * a failed write leaves sessions fully usable in memory and is retried on the
   * next flush tick.
   */
  flush(): boolean {
    const body = JSON.stringify(this.envelope());
    if (body === this.lastWritten) return false;
    const tmp = `${this.path}.tmp`;
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      writeFileSync(tmp, body, "utf8");
      renameSync(tmp, this.path);
      this.lastWritten = body;
      return true;
    } catch {
      try {
        unlinkSync(tmp); // never leave a stale tmp next to the index
      } catch {
        // nothing to clean
      }
      return false;
    }
  }

  /** Checkpoint on a timer; unref'd so it can never keep the process alive. */
  start(intervalMs = 2000): void {
    if (this.timer !== undefined) return;
    this.timer = setInterval(() => {
      this.flush();
    }, intervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  private envelope(): SessionIndexFile {
    return {
      version: 1,
      sessions: this.registry.snapshot(),
      archivedOnly: this.registry.archivedUnknownIds(),
    };
  }
}
