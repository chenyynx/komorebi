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
const DEFAULT_MAX_BYTES = 4 * 1024 * 1024;
const TOOL_RESULT_PREVIEW_CAP = 2000;

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
  // both maxMessages slicing and byte-budget trimming)
  const hasMore = pool.length > slice.length;
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
