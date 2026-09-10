/**
 * Full-pipeline e2e — real WS + real orchestrator + scripted fake SDK.
 * Covers plan S7: handshake → session-create → streamed turn (thinking/tool/
 * result/canonical) → history (conversation view) → approval HITL → queue
 * park/edit/remove → cancel → archive/rename. OS-assigned ports (plan fix
 * for the earlier e2e port flake).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";
import { DeviceStore } from "../../src/auth/device-store";
import { loadConfig } from "../../src/config";
import { SessionRegistry } from "../../src/domain/registry";
import { EventBroadcaster } from "../../src/stream/broadcaster";
import { SessionOrchestrator } from "../../src/session/orchestrator";
import { GatewayServer } from "../../src/ws/server";
import type { SdkMessageLike, SdkQueryHandle, SdkSpawnOptions } from "../../src/backend/claude-runner";

const dataDir = mkdtempSync(join(tmpdir(), "mgw-e2e-"));
let port = 0;
let server: GatewayServer;
let devices: DeviceStore;
const spawnLog: SdkSpawnOptions[] = [];

/**
 * One realistic tool-using turn. The block split mirrors the MEASURED SDK
 * order (2026-09-10, model qwen3.8-flash, includePartialMessages): CC sends one
 * `assistant` message per completed content block, all sharing a single API
 * message id, wrapped in message_start/message_stop. A canonical stamped per
 * block freezes the client's turn-step stream key and kills streaming.
 */
const TURN_SCRIPT: SdkMessageLike[] = [
  { type: "system", subtype: "init", session_id: "cc-e2e-1" },
  { type: "stream_event", event: { type: "message_start", message: { id: "msg_e2e_1" } } },
  { type: "stream_event", event: { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } } },
  { type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "让我" } } },
  { type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "想想" } } },
  { type: "assistant", message: { role: "assistant", id: "msg_e2e_1", content: [{ type: "thinking", thinking: "让我想想", signature: "s" }] } },
  { type: "stream_event", event: { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "call_e2e", name: "Bash" } } },
  { type: "stream_event", event: { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: "{\"command\":\"ls\"}" } } },
  { type: "assistant", message: { role: "assistant", id: "msg_e2e_1", content: [{ type: "tool_use", id: "call_e2e", name: "Bash", input: { command: "ls" } }] } },
  { type: "stream_event", event: { type: "message_stop" } },
  { type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "call_e2e", content: "a.txt\nb.txt" }] } },
  { type: "stream_event", event: { type: "message_start", message: { id: "msg_e2e_2" } } },
  { type: "stream_event", event: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } } },
  { type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "有两个文件" } } },
  { type: "assistant", message: { role: "assistant", id: "msg_e2e_2", content: [{ type: "text", text: "有两个文件：a.txt 和 b.txt" }] } },
  { type: "stream_event", event: { type: "message_stop" } },
  { type: "result", subtype: "success", usage: { input_tokens: 500, output_tokens: 42, cache_read_input_tokens: 10, cache_creation_input_tokens: 0 } },
];

function scriptedQuery(options: SdkSpawnOptions): SdkQueryHandle {
  spawnLog.push(options);
  return {
    async *[Symbol.asyncIterator]() {
      for (const message of TURN_SCRIPT) {
        if (options.abortController.signal.aborted) return;
        yield message;
      }
    },
    abort() {
      options.abortController.abort();
    },
  };
}

/** Minimal frame-collecting client with dot-path matcher ("event.type"). */
interface Client {
  ws: WebSocket;
  /** Every frame ever received (next() consumes the queue; this log survives). */
  log: Record<string, unknown>[];
  next: <T = Record<string, unknown>>(match?: Record<string, unknown>) => Promise<T>;
}

function connectTo(targetPort: number, pairingCode: string, deviceId: string): Client {
  const ws = new WebSocket(`ws://127.0.0.1:${targetPort}/ws/mobile`, ["dsh-mobile-v1", `dsh-pair.${pairingCode}`], {
    headers: { "x-dsh-device-id": deviceId },
  });
  const queue: Record<string, unknown>[] = [];
  const log: Record<string, unknown>[] = [];
  const waiters: { predicate: (frame: Record<string, unknown>) => boolean; resolve: (f: Record<string, unknown>) => void }[] = [];
  ws.on("message", (data) => {
    const frame = JSON.parse(String(data)) as Record<string, unknown>;
    log.push(frame);
    const index = waiters.findIndex((w) => w.predicate(frame));
    if (index >= 0) {
      const [waiter] = waiters.splice(index, 1);
      waiter?.resolve(frame);
    } else {
      queue.push(frame);
    }
  });
  const predicate = (match?: Record<string, unknown>) => (frame: Record<string, unknown>): boolean => {
    if (match === undefined) return true;
    return Object.entries(match).every(([key, value]) => {
      let cursor: unknown = frame;
      for (const part of key.split(".")) {
        if (typeof cursor !== "object" || cursor === null) return false;
        cursor = (cursor as Record<string, unknown>)[part];
      }
      return cursor === value;
    });
  };
  return {
    ws,
    log,
    next: <T = Record<string, unknown>>(match?: Record<string, unknown>) =>
      new Promise<T>((resolve, reject) => {
        const pred = predicate(match);
        const queuedIndex = queue.findIndex(pred);
        if (queuedIndex >= 0) {
          const [frame] = queue.splice(queuedIndex, 1);
          resolve(frame as T);
          return;
        }
        const timer = setTimeout(() => reject(new Error(`timeout waiting ${JSON.stringify(match)}`)), 5000);
        waiters.push({
          predicate: pred,
          resolve: (frame) => {
            clearTimeout(timer);
            resolve(frame as T);
          },
        });
      }),
  };
}

async function openStack(query: (options: SdkSpawnOptions) => SdkQueryHandle): Promise<{ actualPort: number; stackServer: GatewayServer }> {
  const config = loadConfig({ port: 0, dataDir });
  const registry = new SessionRegistry();
  const broadcaster = new EventBroadcaster();
  const orch = new SessionOrchestrator(config, registry, broadcaster, query);
  const stackServer = new GatewayServer(config, devices, {
    onFrame: (conn, frame) => orch.onFrame(conn, frame as never),
    onOpen: (conn) => orch.onOpen(conn),
    onClose: (conn) => orch.onClose(conn),
  });
  const actualPort = await stackServer.listen();
  return { actualPort, stackServer };
}

/** Pair a client against any stack port, waiting through paired+hello. */
async function pairedOn(targetPort: number): Promise<Client> {
  const { code } = devices.issuePairingCode();
  const client = connectTo(targetPort, code, `e2e-${Math.random()}`);
  await client.next({ kind: "paired" });
  const hello = await client.next<{ kind: string; capabilities: string[] }>({ kind: "hello" });
  expect(hello.capabilities).toContain("split-channels");
  expect(hello.capabilities).toContain("session-create");
  return client;
}

beforeAll(async () => {
  devices = new DeviceStore({
    dataDir,
    pairingTtlMs: 5 * 60_000,
    maxFailures: 5,
    failureWindowMs: 15 * 60_000,
  });
  const stack = await openStack(scriptedQuery);
  port = stack.actualPort;
  server = stack.stackServer;
});

afterAll(async () => {
  await server.close();
  rmSync(dataDir, { recursive: true, force: true });
});

describe("full pipeline", () => {
  it("handshake → create → streamed turn → canonical → history → sessions", async () => {
    const client = await pairedOn(port);
    client.ws.send(JSON.stringify({ type: "session-create", requestId: "r1", cwd: "/home/ubuntu" }));
    const created = await client.next<{ requestId: string; sessionId: string }>({ kind: "session-created" });
    expect(created.requestId).toBe("r1");
    const sessionId = created.sessionId;

    client.ws.send(JSON.stringify({ type: "subscribe", sessionId }));
    await client.next({ kind: "subscribed" });
    client.ws.send(JSON.stringify({ type: "message", sessionId, text: "看看目录" }));
    const sent = await client.next({ kind: "sent" });
    expect(sent.sessionId).toBe(sessionId);

    // live frames are FLAT refined payloads: no `data` wrapper, field names match GatewayEvent
    const liveUser = await client.next<{ event: Record<string, unknown> }>({ kind: "event", "event.type": "user/message" });
    expect(liveUser.event["text"]).toBe("看看目录");
    expect(liveUser.event["data"]).toBeUndefined();
    await client.next({ kind: "event", "event.type": "tool/call" });
    // canonical #1: the thinking+tool_use message (empty visible text, toolCalls present)
    const canonical1 = await client.next<{ event: { text: string; reasoning: string; toolCalls: { id: string }[] } }>({ kind: "event", "event.type": "assistant/message" });
    expect(canonical1.event.text).toBe("");
    expect(canonical1.event.reasoning).toBe("让我想想");
    expect(canonical1.event.toolCalls[0]?.id).toBe("call_e2e");
    await client.next({ kind: "event", "event.type": "tool/result" });
    // canonical #2: the final text answer
    const canonical = await client.next<{ event: { text: string } }>({ kind: "event", "event.type": "assistant/message" });
    expect(canonical.event.text).toBe("有两个文件：a.txt 和 b.txt");
    const turnEnd = await client.next<{ event: { reason: string } }>({ kind: "event", "event.type": "turn/end" });
    expect(turnEnd.event.reason).toBe("end_turn");

    expect(spawnLog.length).toBeGreaterThan(0);
    const last = spawnLog[spawnLog.length - 1];
    expect(last?.prompt).toBe("看看目录");
    expect(last?.includePartialMessages).toBe(true);

    client.ws.send(JSON.stringify({ type: "history", sessionId, view: "conversation" }));
    const history = await client.next<{ events: { type: string; data?: Record<string, unknown> }[]; hasMore: boolean; projections: { asOfSeq: number } }>({ kind: "history" });
    expect(history.events.some((e) => e.type === "assistant/chunk")).toBe(false);
    expect(history.events.some((e) => e.type === "assistant/message")).toBe(true);
    expect(history.events.some((e) => e.type === "user/message")).toBe(true);
    expect(history.hasMore).toBe(false);
    // scheme A: history events must carry the raw block shapes the client's
    // RawSessionEvent.normalized() reads (data.content[], data.message.content[]).
    const histUser = history.events.find((e) => e.type === "user/message");
    const userContent = histUser?.data?.["content"] as { type: string; text?: string }[] | undefined;
    expect(userContent?.[0]?.type).toBe("text");
    expect(userContent?.[0]?.text).toBe("看看目录");
    const histAssistants = history.events.filter((e) => e.type === "assistant/message");
    const toolCallSeen = histAssistants.some((e) =>
      (((e.data?.["message"] as { content?: { type: string }[] } | undefined)?.content) ?? []).some(
        (b) => b.type === "tool-call",
      ),
    );
    // WIRE GUARD (2026-09-10 streaming regression): the client's
    // ConversationProjector drops every assistant/chunk whose `turn-step` key
    // was already finalized by an assistant/message. Assert nothing arrives
    // after its own canonical, and that the body really streamed.
    const evs = client.log
      .filter((f) => f["kind"] === "event" && f["sessionId"] === sessionId)
      .map((f) => (f as { event: Record<string, unknown> }).event);
    const streamKey = (e: Record<string, unknown>) => `${String(e["turn"])}-${String(e["step"])}`;
    const finalized = new Set<string>();
    let dropped = 0;
    let streamedTextFrames = 0;
    for (const e of evs) {
      const isDelta = e["type"] === "assistant/chunk"
        && (e["chunkType"] === "text-delta" || e["chunkType"] === "reasoning-delta");
      if (isDelta) {
        if (finalized.has(streamKey(e))) dropped++;
        if (e["chunkType"] === "text-delta") streamedTextFrames++;
      }
      if (e["type"] === "assistant/message") finalized.add(streamKey(e));
    }
    expect(dropped).toBe(0);
    // >=1 (not >1): the coalescer legitimately merges same-window deltas, so
    // frame count is timing dependent — what must never regress is `dropped`.
    expect(streamedTextFrames).toBeGreaterThanOrEqual(1);
    // thinking must actually reach the wire (measured SDK field is `thinking`,
    // not `text`; reading .text alone produced zero reasoning frames)
    expect(evs.filter((e) => e["chunkType"] === "reasoning-delta").length).toBeGreaterThanOrEqual(1);
    // exactly one canonical per API message (two calls in this script) — per-block
    // canonical spam is what froze the stream key
    expect(evs.filter((e) => e["type"] === "assistant/message")).toHaveLength(2);

    client.ws.send(JSON.stringify({ type: "sessions" }));
    const sessions = await client.next<{ sessions: { sessionId: string }[] }>({ kind: "sessions" });
    expect(sessions.sessions.some((s) => s.sessionId === sessionId)).toBe(true);
    client.ws.close();
  });

  it("approval HITL: canUseTool surfaces approval-requested, response resolves deny", async () => {
    const approvalQuery = (options: SdkSpawnOptions): SdkQueryHandle => ({
      async *[Symbol.asyncIterator]() {
        yield { type: "system", subtype: "init" } as SdkMessageLike;
        const outcome = await options.canUseTool("Bash", { command: "rm -rf /" });
        expect(outcome.behavior).toBe("deny");
        yield { type: "result", subtype: "success", usage: {} } as SdkMessageLike;
      },
      abort() {
        options.abortController.abort();
      },
    });
    const { actualPort, stackServer } = await openStack(approvalQuery);
    try {
      const client = await pairedOn(actualPort);
      client.ws.send(JSON.stringify({ type: "session-create", requestId: "r2", cwd: "/home/ubuntu" }));
      const created = await client.next<{ sessionId: string }>({ kind: "session-created" });
      client.ws.send(JSON.stringify({ type: "message", sessionId: created.sessionId, text: "rm 一下" }));

      const approval = await client.next<{ rpcId: string; sessionId: string; approvalId: string; toolName: string; reason?: string }>({ kind: "approval-requested" });
      expect(approval.toolName).toBe("Bash");
      expect(approval.reason).toBe("运行命令: rm -rf /");
      client.ws.send(JSON.stringify({
        type: "approval-response",
        rpcId: approval.rpcId,
        sessionId: approval.sessionId,
        approvalId: approval.approvalId,
        outcome: "rejected",
      }));
      const receipt = await client.next<{ accepted: boolean }>({ kind: "approval-response" });
      expect(receipt.accepted).toBe(true);
      const resolved = await client.next<{ outcome: string }>({ kind: "approval-resolved" });
      expect(resolved.outcome).toBe("rejected");
      await client.next({ kind: "event", "event.type": "turn/end" });
      client.ws.close();
    } finally {
      await stackServer.close();
    }
  });

  it("queue: second message parks while a turn runs; edit/remove/cancel work", async () => {
    const blockQuery = (options: SdkSpawnOptions): SdkQueryHandle => ({
      async *[Symbol.asyncIterator]() {
        yield { type: "system", subtype: "init" } as SdkMessageLike;
        await new Promise<void>((resolve) => {
          const check = () => {
            if (options.abortController.signal.aborted) resolve();
            else setTimeout(check, 50);
          };
          check();
        });
      },
      abort() {
        options.abortController.abort();
      },
    });
    const { actualPort, stackServer } = await openStack(blockQuery);
    try {
      const client = await pairedOn(actualPort);
      client.ws.send(JSON.stringify({ type: "session-create", requestId: "r4", cwd: "/home/ubuntu" }));
      const created = await client.next<{ sessionId: string }>({ kind: "session-created" });
      const sessionId = created.sessionId;
      client.ws.send(JSON.stringify({ type: "message", sessionId, text: "长任务" }));
      await client.next({ kind: "sent" });
      client.ws.send(JSON.stringify({ type: "message", sessionId, text: "排队的" }));
      const parked = await client.next<{ mode: string }>({ kind: "sent" });
      expect(parked.mode).toBe("queue");
      const queueSnap = await client.next<{ items: { id: string }[] }>({ kind: "session-queue" });
      expect(queueSnap.items).toHaveLength(1);
      const itemId = queueSnap.items[0]?.id as string;

      client.ws.send(JSON.stringify({ type: "queue-update", sessionId, itemId, action: "edit", text: "改过的" }));
      const updated = await client.next<{ accepted: boolean }>({ kind: "queue-item-updated" });
      expect(updated.accepted).toBe(true);
      const snap2 = await client.next<{ items: { message: { content: { text: string }[] } }[] }>({ kind: "session-queue" });
      expect(snap2.items[0]?.message.content[0]?.text).toBe("改过的");

      client.ws.send(JSON.stringify({ type: "queue-update", sessionId, itemId, action: "remove" }));
      await client.next({ kind: "queue-item-updated" });
      const snap3 = await client.next<{ items: unknown[] }>({ kind: "session-queue" });
      expect(snap3.items).toHaveLength(0);

      client.ws.send(JSON.stringify({ type: "session-cancel", sessionId }));
      const cancelled = await client.next<{ accepted: boolean }>({ kind: "session-cancelled" });
      expect(cancelled.accepted).toBe(true);
      client.ws.close();
    } finally {
      await stackServer.close();
    }
  });

  it("rename returns new title; archive returns the whole set (§5)", async () => {
    const client = await pairedOn(port);
    client.ws.send(JSON.stringify({ type: "session-create", requestId: "r5", cwd: "/home/ubuntu" }));
    const created = await client.next<{ sessionId: string }>({ kind: "session-created" });
    const sessionId = created.sessionId;

    client.ws.send(JSON.stringify({ type: "session-rename", sessionId, title: "改名会话" }));
    const renamed = await client.next<{ title: string }>({ kind: "session-renamed" });
    expect(renamed.title).toBe("改名会话");

    client.ws.send(JSON.stringify({ type: "session-archive", sessionId }));
    const archived = await client.next<{ archivedSessionIds: string[] }>({ kind: "session-archived" });
    expect(archived.archivedSessionIds).toContain(sessionId);

    client.ws.send(JSON.stringify({ type: "sessions" }));
    const sessions = await client.next<{ sessions: { sessionId: string }[] }>({ kind: "sessions" });
    expect(sessions.sessions.some((s) => s.sessionId === sessionId)).toBe(false); // hidden after archive
    client.ws.close();
  });
});
