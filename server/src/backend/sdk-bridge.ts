/**
 * canUseTool bridge: our PermissionOutcome -> SDK PermissionResult.
 * Zero side effects (unit-testable). MUST forward outcome.updatedInput —
 * AskUserQuestion answers ride it. 2026-09-11 P0-3 regression: this bridge
 * once returned the ORIGINAL input on allow, silently swallowing every
 * answer ("The user did not answer the questions." in the CC transcript while
 * all gateway-side question frames looked correct). Approvals masked the bug:
 * they only consume the boolean decision.
 * @module backend/sdk-bridge
 */
import type { PermissionOutcome } from "./claude-runner.js";

export type BridgedPermissionResult =
  | { behavior: "allow"; updatedInput: Record<string, unknown> }
  | { behavior: "deny"; message: string };

export async function bridgeCanUseTool(
  handler: (toolName: string, input: Record<string, unknown>) => Promise<PermissionOutcome>,
  toolName: string,
  input: Record<string, unknown>,
): Promise<BridgedPermissionResult> {
  const outcome = await handler(toolName, input);
  if (outcome.behavior === "allow") {
    return { behavior: "allow", updatedInput: outcome.updatedInput ?? input };
  }
  return { behavior: "deny", message: outcome.message || "用户在手机上拒绝了该操作" };
}
