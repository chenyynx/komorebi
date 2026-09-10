import { describe, expect, it } from "vitest";
import { bridgeCanUseTool } from "../../src/backend/sdk-bridge.js";

describe("canUseTool bridge — the P0-3 regression line (updatedInput forwarding)", () => {
  it("FORWARDS outcome.updatedInput (AskUserQuestion answers ride it)", async () => {
    const input = { questions: [{ question: "都修吗？" }] };
    const outcome = {
      behavior: "allow" as const,
      updatedInput: { ...input, answers: { "都修吗？": "都修" } },
    };
    const bridged = await bridgeCanUseTool(async () => outcome, "AskUserQuestion", input);
    expect(bridged).toEqual({
      behavior: "allow",
      updatedInput: { questions: [{ question: "都修吗？" }], answers: { "都修吗？": "都修" } },
    });
  });

  it("allow WITHOUT updatedInput falls back to the original input (plain approvals)", async () => {
    const input = { command: "ls" };
    const bridged = await bridgeCanUseTool(async () => ({ behavior: "allow" as const }), "Bash", input);
    expect(bridged).toEqual({ behavior: "allow", updatedInput: input });
  });

  it("deny passes message through; empty message gets the mobile fallback", async () => {
    const bridged = await bridgeCanUseTool(
      async () => ({ behavior: "deny" as const, message: "用户拒绝" }),
      "Bash",
      {},
    );
    expect(bridged).toEqual({ behavior: "deny", message: "用户拒绝" });
    const noMsg = await bridgeCanUseTool(async () => ({ behavior: "deny" as const, message: "" }), "Bash", {});
    expect(noMsg).toEqual({ behavior: "deny", message: "用户在手机上拒绝了该操作" });
  });
});
