/** Re-anchor transcript-fallback events onto the live sequence tail. */
export function renumberFallback<T extends { seq: number }>(items: readonly T[], nextSeq: number): T[] {
  const base = Math.max(0, nextSeq - items.length);
  return items.map((item, index) => ({ ...item, seq: base + index }));
}

/**
 * HistoryService — build `history` frames from session event buffers
 * (plan §4 backend/history.ts, protocol §5 history semantics):
 * - view "conversation": drop assistant/chunk token replay, truncate nested
 *   tool/result text to 2000 chars
 * - maxBytes byte budget (default 4 MiB), newest kept, hasMore + nextBeforeSeq
 * - projections {asOfSeq, values} attached from live stats
 * @module backend/history
 */

import type { SessionEvent } from "../domain/events.js";

export interface HistoryRequest {
  readonly sessionId: string;
  readonly beforeSeq?: number | undefined;
  readonly maxMessages?: number | undefined;
  readonly maxBytes?: number | undefined;
  readonly view?: string | undefined;
}

export interface HistoryPage {
  readonly events: readonly SessionEvent[];
  readonly bytes: number;
  readonly hasMore: boolean;
  readonly nextBeforeSeq?: number;
  readonly asOfSeq: number;
}

const DEFAULT_MAX_MESSAGES = 50;
const DEFAULT_MAX_BYTES = 256 * 1024;
/**
 * Hard cap on how far back a single history backfill may walk. The official
 * client loops `hasMore` pages until completion and projects every event on
 * the main thread — a session with tens of thousands of events (live tool
 * streams) freezes it. 800 events (~16 pages) keeps recent context while the
 * older tail simply reports hasMore:false.
 */
const HISTORY_MAX_TOTAL_EVENTS = 800;
const TOOL_RESULT_PREVIEW_CAP = 2000;
const EVENT_TEXT_CAP = 32 * 1024;

/** Shrink oversized text blocks in one event (history-view guard). */
function shrinkEventText(event: SessionEvent): SessionEvent {
  const data = event.data as {
    text?: unknown;
    content?: unknown;
    message?: { content?: unknown };
  };
  const TRUNCATED = "\n…[超长内容已截断，完整记录在服务器 transcript]";
  const cut = (t: string) => (t.length > EVENT_TEXT_CAP ? t.slice(0, EVENT_TEXT_CAP) + TRUNCATED : t);
  let changed = false;
  const shrinkBlocks = (blocks: unknown[]): unknown[] =>
    blocks.map((b) => {
      if (b && typeof b === "object") {
        const blk = b as { type?: unknown; text?: unknown };
        if (blk.type === "text" && typeof blk.text === "string" && blk.text.length > EVENT_TEXT_CAP) {
          changed = true;
          return { ...blk, text: cut(blk.text) };
        }
      }
      return b;
    });
  let nextData = data as Record<string, unknown>;
  if (typeof data.text === "string" && data.text.length > EVENT_TEXT_CAP) {
    changed = true;
    nextData = { ...nextData, text: cut(data.text) };
  }
  if (Array.isArray(data.content)) {
    const blocks = shrinkBlocks(data.content);
    if (changed) nextData = { ...nextData, content: blocks };
  }
  if (data.message && Array.isArray((data.message as { content?: unknown }).content)) {
    const msgChanged = changed;
    const blocks = shrinkBlocks((data.message as { content: unknown[] }).content);
    if (msgChanged) {
      nextData = { ...nextData, message: { ...(data.message as object), content: blocks } };
    }
  }
  return changed ? { ...event, data: nextData as SessionEvent["data"] } : event;
}

/** Apply view=conversation trimming to one event (returns null to drop). */
function trimEvent(event: SessionEvent): SessionEvent | null {
  if (event.type === "assistant/chunk") return null; // token replay dropped in conversation view
  if (event.type === "tool/result") {
    const data = event.data as { preview?: unknown };
    if (typeof data.preview === "string" && data.preview.length > TOOL_RESULT_PREVIEW_CAP) {
      return { ...event, data: { ...data, preview: data.preview.slice(0, TOOL_RESULT_PREVIEW_CAP) } };
    }
  }
  return event;
}

function eventBytes(event: SessionEvent): number {
  // JSON length in UTF-8 bytes (protocol: byte budget on the serialized page)
  return Buffer.byteLength(JSON.stringify(event), "utf8");
}

/**
 * Page the newest events fitting the budget. Pagination walks older via
 * nextBeforeSeq = smallest seq included in the returned page.
 */
export function pageHistory(
  buffer: readonly SessionEvent[],
  request: HistoryRequest,
): HistoryPage {
  const maxMessages = request.maxMessages ?? DEFAULT_MAX_MESSAGES;
  const maxBytes = request.maxBytes ?? DEFAULT_MAX_BYTES;
  const view = request.view;

  let pool: readonly SessionEvent[] = buffer;
  const beforeSeq = request.beforeSeq;
  if (beforeSeq !== undefined) {
    pool = pool.filter((e) => e.seq < beforeSeq);
  }
  // Cap the lookback window: events older than the newest N are invisible to
  // pagination, so the client's loop terminates with a normal completed
  // outcome instead of walking the entire buffer.
  const capped = buffer.length > HISTORY_MAX_TOTAL_EVENTS;
  const capFloorSeq = capped
    ? buffer[buffer.length - HISTORY_MAX_TOTAL_EVENTS]?.seq ?? Number.NEGATIVE_INFINITY
    : Number.NEGATIVE_INFINITY;
  if (capped) {
    pool = pool.filter((e) => e.seq >= capFloorSeq);
  }
  // Shrink oversized payloads before byte accounting so pages stay honest.
  pool = pool.map(shrinkEventText);
  if (view === "conversation") {
    pool = pool
      .map(trimEvent)
      .filter((e): e is SessionEvent => e !== null);
  }

  // take the newest maxMessages, then shrink further under the byte budget
  let slice = pool.slice(Math.max(0, pool.length - maxMessages));
  let bytes = 0;
  let start = slice.length;
  for (let i = slice.length - 1; i >= 0; i--) {
    const item = slice[i];
    if (item === undefined) continue;
    const size = eventBytes(item);
    if (bytes + size > maxBytes && start < slice.length) {
      // keep at least one event (protocol: newest part preserved)
      if (start - 1 === i && start === slice.length) {
        start = slice.length; // single oversized event still included
        bytes += size;
        continue;
      }
      break;
    }
    bytes += size;
    start = i;
  }
  slice = slice.slice(start);

  // older events exist iff the pool held more than the final page (covers
  // both maxMessages slicing, byte-budget trimming and the total-events cap).
  // At the cap floor we report hasMore=false so the client finishes normally.
  let hasMore = pool.length > slice.length;
  if (hasMore && capped && capFloorSeq !== Number.NEGATIVE_INFINITY) {
    const oldestInPage = slice.length > 0 ? slice[0]?.seq : undefined;
    if (oldestInPage !== undefined && oldestInPage <= capFloorSeq) {
      hasMore = false;
    }
  }
  const oldest = slice.length > 0 ? slice[0] : undefined;
  const nextBeforeSeq = hasMore && oldest !== undefined ? oldest.seq : undefined;
  const asOfSeq = buffer.length > 0 ? buffer[buffer.length - 1]?.seq ?? 0 : 0;

  return {
    events: slice,
    bytes,
    hasMore,
    ...(nextBeforeSeq !== undefined ? { nextBeforeSeq } : {}),
    asOfSeq,
  };
}
