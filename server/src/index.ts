/**
 * dsh-cc-mgw entrypoint — composition root.
 * Wires config, device store, registry, broadcaster, orchestrator and the
 * real Claude Agent SDK adapter, then serves. The SDK adapter is the single
 * escape hatch where our structural SdkQueryFn meets the SDK's own types.
 * @module index
 */

import { join } from "node:path";
import { loadConfig } from "./config.js";
import { DeviceStore } from "./auth/device-store.js";
import { SessionRegistry } from "./domain/registry.js";
import { SessionIndexStore } from "./domain/session-index.js";
import { EventBroadcaster } from "./stream/broadcaster.js";
import { SessionOrchestrator } from "./session/orchestrator.js";
import { GatewayServer } from "./ws/server.js";
import type { ValidatedFrame } from "./protocol/validation.js";
import type { SdkQueryFn, SdkSpawnOptions } from "./backend/claude-runner.js";
import { query } from "@anthropic-ai/claude-agent-sdk";

/** Adapts our structural spawn options to the real SDK query(). */
export function createSdkQuery(): SdkQueryFn {
  return (options: SdkSpawnOptions) => {
    const prompt =
      typeof options.prompt === "string"
        ? options.prompt
        : (async function* () {
            yield {
              type: "user" as const,
              message: { role: "user" as const, content: options.prompt as never },
              parent_tool_use_id: null,
            };
          })();

    // canUseTool bridge: our Promise<PermissionOutcome> ↔ SDK PermissionResult
    const sdkHandle = query({
      prompt: prompt as never,
      options: {
        cwd: options.cwd,
        ...(options.model !== undefined ? { model: options.model } : {}),
        ...(options.resume !== undefined ? { resume: options.resume } : {}),
        permissionMode: options.permissionMode,
        includePartialMessages: options.includePartialMessages,
        abortController: options.abortController,
        canUseTool: async (
          toolName: string,
          input: Record<string, unknown>,
        ): Promise<{ behavior: "allow"; updatedInput: Record<string, unknown> } | { behavior: "deny"; message: string }> => {
          const outcome = await options.canUseTool(toolName, input);
          if (outcome.behavior === "allow") {
            return { behavior: "allow", updatedInput: input };
          }
          return { behavior: "deny", message: outcome.message ?? "用户在手机上拒绝了该操作" };
        },
      } as never,
    });

    return {
      async *[Symbol.asyncIterator]() {
        for await (const message of sdkHandle as AsyncIterable<never>) {
          yield message as never;
        }
      },
      abort() {
        options.abortController.abort();
      },
    };
  };
}

export function main(): void {
  const config = loadConfig();
  const devices = new DeviceStore({
    dataDir: config.dataDir,
    pairingTtlMs: config.pairingTtlMs,
    maxFailures: config.authMaxFailures,
    failureWindowMs: config.authWindowMs,
  });
  const registry = new SessionRegistry();
  // F1: the session index lives on disk. Before this, every restart blanked the
  // phone's session list and orphaned whatever session it was holding.
  const sessionIndex = new SessionIndexStore(registry, join(config.dataDir, "sessions.json"));
  const restored = sessionIndex.load();
  sessionIndex.start();
  const broadcaster = new EventBroadcaster();
  const orchestrator = new SessionOrchestrator(config, registry, broadcaster, createSdkQuery());
  const server = new GatewayServer(config, devices, {
    onFrame: (conn, frame) => orchestrator.onFrame(conn, frame as ValidatedFrame),
    onOpen: (conn) => orchestrator.onOpen(conn),
    onClose: (conn) => orchestrator.onClose(conn),
  });
  server.preflightProvider = () => orchestrator.preflightSnapshot();

  void server.listen().then((port) => {
    console.log(`[dsh-cc-mgw] listening on 127.0.0.1:${port}${config.wsPath}`);
    console.log(`[dsh-cc-mgw] sessions restored: ${restored}` +
      (sessionIndex.loadRejections > 0 ? ` (rejected ${sessionIndex.loadRejections} record(s))` : "") +
      (sessionIndex.loadRejections < 0 ? " (index unreadable, starting empty)" : ""));
  });

  // F2: pm2 sends SIGINT on restart. Close in-flight turns first so phones stop
  // waiting, flush the index, then let go. Hard deadline below pm2's kill window.
  let closing = false;
  const shutdown = (signal: string): void => {
    if (closing) return;
    closing = true;
    const closed = orchestrator.shutdown();
    sessionIndex.stop();
    sessionIndex.flush();
    console.log(`[dsh-cc-mgw] ${signal}: closed ${closed} in-flight turn(s), index flushed`);
    void server.close().then(() => process.exit(0));
    setTimeout(() => process.exit(0), 900).unref();
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

main();
