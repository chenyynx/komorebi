/**
 * HistoryService tests — plan §7.1 backend/history.ts row:
 * conversation trimming, maxBytes paging, beforeSeq direction, asOfSeq,
 * empty session. 100-event sequence per plan.
 */
import { describe, expect, it } from "vitest";
import { SessionState } from "../../src/domain/state";
import { pageHistory, type HistoryRequest } from "../../src/backend/history";
import type { SessionEvent } from "../../src/domain/events";

function buildBuffer(count: number): SessionState {
  const state = new SessionState("s", "/w", 1);
  for (let i = 0; i < count; i++) {
    const type = i % 10 === 0 ? "user/message" : i % 5 === 0 ? "tool/result" : "assistant/chunk";
    state.emit(type as SessionEvent["type"], i, {
      text: `chunk-${i}`,
      ...(type === "user/message" ? { userText: `u${i}` } : {}),
      ...(type === "tool/result" ? { preview: `r${i}` } : {}),
    });
  }
  return state;
}

const req = (over: Partial<HistoryRequest> = {}): HistoryRequest => ({ sessionId: "s", ...over });

describe("conversation view trimming (§5)", () => {
  it("assistant/chunk events are dropped entirely", () => {
    const state = buildBuffer(10);
    const page = pageHistory(state.bufferedEvents, req({ view: "conversation" }));
    expect(page.events.some((e) => e.type === "assistant/chunk")).toBe(false);
  });

  it("user/message and tool/result survive", () => {
    const state = buildBuffer(20);
    const page = pageHistory(state.bufferedEvents, req({ view: "conversation" }));
    expect(page.events.some((e) => e.type === "user/message")).toBe(true);
    expect(page.events.some((e) => e.type === "tool/result")).toBe(true);
  });

  it("tool/result preview truncated to 2000 chars in conversation view", () => {
    const state = new SessionState("s", "/w", 1);
    state.emit("tool/result", 1, { preview: "y".repeat(3000) });
    const page = pageHistory(state.bufferedEvents, req({ view: "conversation" }));
    expect((page.events[0]?.data as { preview: string }).preview.length).toBe(2000);
  });

  it("without view, chunks are preserved (raw mode)", () => {
    const state = buildBuffer(10);
    const page = pageHistory(state.bufferedEvents, req());
    expect(page.events.some((e) => e.type === "assistant/chunk")).toBe(true);
  });
});

describe("maxMessages (100-event sequence)", () => {
  it("returns the newest N events", () => {
    const state = buildBuffer(100);
    const page = pageHistory(state.bufferedEvents, req({ maxMessages: 20 }));
    expect(page.events).toHaveLength(20);
    expect(page.events[0]?.seq).toBe(80);
    expect(page.events[19]?.seq).toBe(99);
  });
});

describe("maxBytes budget (protocol: newest preserved, nextBeforeSeq continues)", () => {
  it("shrinks the page to fit the byte budget and reports continuation", () => {
    const state = buildBuffer(100);
    const full = pageHistory(state.bufferedEvents, req({ maxMessages: 100 }));
    // request a tiny budget that fits only a few events
    const page = pageHistory(state.bufferedEvents, req({ maxMessages: 100, maxBytes: 500 }));
    expect(page.bytes).toBeLessThanOrEqual(500);
    expect(page.events.length).toBeLessThan(full.events.length);
    expect(page.hasMore).toBe(true);
    // continuation points at the oldest included event
    expect(page.nextBeforeSeq).toBe(page.events[0]?.seq);
    // newest content preserved: last seq of the page == last seq of buffer
    expect(page.events[page.events.length - 1]?.seq).toBe(99);
  });

  it("continuation walks strictly older pages until exhausted", () => {
    const state = buildBuffer(100);
    const all: number[] = [];
    let before: number | undefined;
    for (let guard = 0; guard < 20; guard++) {
      const page = pageHistory(state.bufferedEvents, req({ maxMessages: 30, beforeSeq: before }));
      all.push(...page.events.map((e) => e.seq));
      if (!page.hasMore) break;
      before = page.nextBeforeSeq;
    }
    expect(all).toHaveLength(100);
    // pages arrive newest→older, each page ascending: assert completeness+uniqueness
    expect([...all].sort((a, b) => a - b)).toEqual(Array.from({ length: 100 }, (_, i) => i));
  });
});

describe("beforeSeq direction", () => {
  it("only includes events strictly older than beforeSeq", () => {
    const state = buildBuffer(20);
    const page = pageHistory(state.bufferedEvents, req({ beforeSeq: 10, maxMessages: 50 }));
    expect(page.events.every((e) => e.seq < 10)).toBe(true);
  });
});

describe("projections", () => {
  it("asOfSeq equals the newest buffered seq", () => {
    const state = buildBuffer(7);
    const page = pageHistory(state.bufferedEvents, req());
    expect(page.asOfSeq).toBe(6);
  });

  it("empty session → empty page, hasMore false, no nextBeforeSeq", () => {
    const state = new SessionState("s", "/w", 1);
    const page = pageHistory(state.bufferedEvents, req());
    expect(page.events).toEqual([]);
    expect(page.hasMore).toBe(false);
    expect(page.nextBeforeSeq).toBeUndefined();
    expect(page.asOfSeq).toBe(0);
  });
});
