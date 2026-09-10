/**
 * SessionState tests — plan §7.1 domain/state.ts row:
 * seq strict monotonicity, buffer bound (drop oldest), concurrent-safe metadata,
 * CC session id two-way mapping.
 */
import { describe, expect, it } from "vitest";
import { SessionState } from "../../src/domain/state";

function newState(): SessionState {
  return new SessionState("sess-1", "/home/ubuntu/work", 1787111700000);
}

describe("seq allocation", () => {
  it("allocates strictly monotonic seq starting at 0", () => {
    const state = newState();
    expect(state.allocateSeq()).toBe(0);
    expect(state.allocateSeq()).toBe(1);
    expect(state.allocateSeq()).toBe(2);
    expect(state.lastSeq).toBe(2);
  });

  it("append rejects out-of-order seq", () => {
    const state = newState();
    state.emit("user/message", 1, { text: "hi" });
    expect(() =>
      state.append({ type: "user/message", seq: 0, time: 2, data: {} }),
    ).toThrow(/non-monotonic/);
  });

  it("emit allocates + appends atomically", () => {
    const state = newState();
    const event = state.emit("user/message", 42, { text: "x" });
    expect(event.seq).toBe(0);
    expect(state.bufferedEvents).toHaveLength(1);
    expect(state.lastSeq).toBe(0);
  });
});

describe("event buffer bound", () => {
  it("drops the oldest beyond 5000 buffered events without crashing", () => {
    const state = newState();
    for (let i = 0; i < 5100; i++) {
      state.emit("assistant/chunk", i, { text: String(i) });
    }
    expect(state.bufferedEvents.length).toBe(5000);
    // the oldest retained is the newest 5000
    expect(state.bufferedEvents[0]?.data).toEqual({ text: "100" });
    expect(state.lastSeq).toBe(5099);
  });
});

describe("metadata", () => {
  it("title updates are visible through the metadata snapshot", () => {
    const state = newState();
    state.setTitle("第一会话");
    expect(state.metadata.title).toBe("第一会话");
  });

  it("ccSessionId maps both directions (attach + read)", () => {
    const state = newState();
    state.attachCcSession("cc-uuid-123");
    expect(state.metadata.ccSessionId).toBe("cc-uuid-123");
  });

  it("permission preset defaults to workspace-write (pp decision) and switches", () => {
    const state = newState();
    expect(state.metadata.permission.preset).toBe("workspace-write");
    state.setPermission("danger-full-access");
    expect(state.metadata.permission.preset).toBe("danger-full-access");
    state.setPermission("read-only");
    expect(state.metadata.permission.preset).toBe("read-only");
  });

  it("nextModel staged for next turn", () => {
    const state = newState();
    state.setNextModel("qwen3.8-flash[1m]");
    expect(state.metadata.nextModel).toBe("qwen3.8-flash[1m]");
  });

  it("running and blank flags track lifecycle", () => {
    const state = newState();
    expect(state.isBlank).toBe(true);
    state.setRunning(true);
    expect(state.isRunning).toBe(true);
    expect(state.isBlank).toBe(false);
    state.setRunning(false);
    expect(state.isRunning).toBe(false);
  });
});

describe("paging helpers", () => {
  it("pageEvents newest tail with beforeSeq and maxMessages", () => {
    const state = newState();
    for (let i = 0; i < 10; i++) state.emit("assistant/chunk", i, { i });
    const tail = state.pageEvents(undefined, 3);
    expect(tail.map((e) => e.seq)).toEqual([7, 8, 9]);
    const older = state.pageEvents(7, 3);
    expect(older.map((e) => e.seq)).toEqual([4, 5, 6]);
  });

  it("replaceAt swaps a buffered event in place (canonical replacement)", () => {
    const state = newState();
    state.emit("assistant/chunk", 1, { chunkType: "text-delta" });
    state.emit("assistant/chunk", 2, { chunkType: "text-delta" });
    state.replaceAt(1, "assistant/message", 3, { text: "final" });
    expect(state.bufferedEvents[0]?.type).toBe("assistant/chunk");
    expect(state.bufferedEvents[1]?.type).toBe("assistant/message");
    expect(state.bufferedEvents[1]?.seq).toBe(1);
    expect(state.bufferedEvents[1]?.data).toEqual({ text: "final" });
  });

  it("eventsBetween filters by inclusive seq range", () => {
    const state = newState();
    for (let i = 0; i < 10; i++) state.emit("assistant/chunk", i, {});
    expect(state.eventsBetween(2, 4).map((e) => e.seq)).toEqual([2, 3, 4]);
  });
});
