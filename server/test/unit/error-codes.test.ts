/**
 * Error code table tests — every code and message must match PROTOCOL.md §1
 * and the usage sites documented in the plan.
 */
import { describe, expect, it } from "vitest";
import { ERROR_CODES, ERROR_MESSAGES, errorMessage } from "../../src/protocol/error-codes";

describe("ERROR_CODES coverage", () => {
  it("defines exactly the protocol error codes", () => {
    const codes = Object.values(ERROR_CODES);
    expect(codes).toEqual([
      "bad-request",
      "session-not-found",
      "agent-busy",
      "model-unavailable",
      "fork-unavailable",
      "unknown-command",
      "workspace-invalid-path",
      "directory-unreadable",
      "directory-exists",
      "wrong-channel",
      "internal",
    ]);
    expect(new Set(codes).size).toBe(codes.length); // no dupes
  });

  it("every code has a message template", () => {
    for (const code of Object.values(ERROR_CODES)) {
      expect(typeof ERROR_MESSAGES[code]).toBe("string");
      expect(ERROR_MESSAGES[code].length).toBeGreaterThan(0);
    }
  });
});

describe("errorMessage formatting", () => {
  it("substitutes %s placeholders in order", () => {
    expect(errorMessage(ERROR_CODES.SESSION_NOT_FOUND, "session-abc")).toBe("no such session: session-abc");
    expect(errorMessage(ERROR_CODES.WRONG_CHANNEL, "history", "control")).toBe("request history must be sent on the control channel");
    expect(errorMessage(ERROR_CODES.MODEL_UNAVAILABLE, "claude-code")).toContain("claude-code");
  });

  it("leaves template intact with no args", () => {
    expect(errorMessage(ERROR_CODES.INTERNAL)).toBe("internal error: %s");
  });

  it("handles numeric args", () => {
    expect(errorMessage(ERROR_CODES.AGENT_BUSY, 42)).toContain("42");
  });
});
