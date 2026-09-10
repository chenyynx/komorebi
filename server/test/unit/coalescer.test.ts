/**
 * Coalescer tests — plan §7.1 backend/coalescer.ts row (fake clock):
 * window merge, char threshold, turn-end flush zero loss, cache reset,
 * two-session isolation.
 */
import { describe, expect, it, vi, afterEach } from "vitest";
import { DeltaCoalescer, type CoalescedChunk } from "../../src/backend/coalescer";

afterEach(() => {
  vi.useRealTimers();
});

describe("window merging (fake timers)", () => {
  it("merges N deltas within the window into one chunk", () => {
    vi.useFakeTimers();
    const flushed: CoalescedChunk[][] = [];
    const c = new DeltaCoalescer((chunks) => flushed.push([...chunks]));
    c.push("s1", "text-delta", 0, 0, "你");
    c.push("s1", "text-delta", 0, 0, "好");
    c.push("s1", "text-delta", 0, 0, "世界");
    expect(flushed).toHaveLength(0); // nothing before the window elapses
    vi.advanceTimersByTime(31);
    expect(flushed).toHaveLength(1);
    expect(flushed[0]).toEqual([{ turn: 0, step: 0, chunkType: "text-delta", text: "你好世界" }]);
  });

  it("separate keys for text vs reasoning within one turn", () => {
    vi.useFakeTimers();
    const flushed: CoalescedChunk[][] = [];
    const c = new DeltaCoalescer((chunks) => flushed.push([...chunks]));
    c.push("s1", "text-delta", 0, 0, "答");
    c.push("s1", "reasoning-delta", 0, 0, "思");
    vi.advanceTimersByTime(31);
    expect(flushed).toHaveLength(1);
    expect(flushed[0]).toHaveLength(2);
    expect(flushed[0]?.map((k) => k.chunkType).sort()).toEqual(["reasoning-delta", "text-delta"]);
  });
});

describe("char threshold", () => {
  it("flushes immediately at ≥512 chars without waiting for the window", () => {
    vi.useFakeTimers();
    const flushed: CoalescedChunk[][] = [];
    const c = new DeltaCoalescer((chunks) => flushed.push([...chunks]));
    c.push("s1", "text-delta", 0, 0, "x".repeat(600));
    expect(flushed).toHaveLength(1); // synchronous, no timer involved
    expect(c.pendingCount).toBe(0);
  });

  it("crosses the threshold by accumulation across pushes", () => {
    vi.useFakeTimers();
    const flushed: CoalescedChunk[][] = [];
    const c = new DeltaCoalescer((chunks) => flushed.push([...chunks]));
    c.push("s1", "text-delta", 0, 0, "a".repeat(300));
    c.push("s1", "text-delta", 0, 0, "b".repeat(300));
    expect(flushed).toHaveLength(1);
    expect(flushed[0]?.[0]?.text.length).toBe(600);
  });
});

describe("flushAll (turn end / cancel)", () => {
  it("flushes everything with zero loss and clears the timer", () => {
    vi.useFakeTimers();
    const flushed: CoalescedChunk[][] = [];
    const c = new DeltaCoalescer((chunks) => flushed.push([...chunks]));
    c.push("s1", "text-delta", 0, 0, "one");
    c.push("s1", "reasoning-delta", 0, 0, "two");
    c.push("s2", "text-delta", 3, 1, "three");
    c.flushAll();
    const all = flushed.flat();
    expect(all).toHaveLength(3);
    expect(all.map((k) => k.text).sort()).toEqual(["one", "three", "two"]);
    expect(c.pendingCount).toBe(0);
    // advancing time after manual flush must NOT re-flush (timer cleared)
    vi.advanceTimersByTime(1000);
    expect(flushed).toHaveLength(1);
  });

  it("flushAll with nothing pending is a no-op (no empty flush calls)", () => {
    const flushed: CoalescedChunk[][] = [];
    const c = new DeltaCoalescer((chunks) => flushed.push([...chunks]));
    c.flushAll();
    expect(flushed).toHaveLength(0);
  });
});

describe("cache hygiene", () => {
  it("after a flush the next push starts a fresh chunk (no content carry-over)", () => {
    vi.useFakeTimers();
    const flushed: CoalescedChunk[][] = [];
    const c = new DeltaCoalescer((chunks) => flushed.push([...chunks]));
    c.push("s1", "text-delta", 0, 0, "first");
    vi.advanceTimersByTime(31);
    c.push("s1", "text-delta", 0, 0, "second");
    vi.advanceTimersByTime(31);
    expect(flushed).toHaveLength(2);
    expect(flushed[0]?.[0]?.text).toBe("first");
    expect(flushed[1]?.[0]?.text).toBe("second");
  });
});

describe("two-session isolation", () => {
  it("sessions never cross-contaminate even with same turn/step", () => {
    vi.useFakeTimers();
    const flushed: CoalescedChunk[][] = [];
    const c = new DeltaCoalescer((chunks) => flushed.push([...chunks]));
    c.push("session-a", "text-delta", 0, 0, "AAA");
    c.push("session-b", "text-delta", 0, 0, "BBB");
    vi.advanceTimersByTime(31);
    expect(flushed[0]).toHaveLength(2);
    const texts = flushed[0]?.map((k) => k.text).sort();
    expect(texts).toEqual(["AAA", "BBB"]);
  });
});
