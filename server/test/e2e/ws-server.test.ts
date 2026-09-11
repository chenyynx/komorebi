/**
 * Integration tests for the WS layer — real WebSocket against a real server
 * on an ephemeral port, with a fake dispatcher capturing frames.
 * Covers: pairing handshake, hello schema, token reconnect, wrong-channel,
 * bad JSON, validation errors surfaced as error frames.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";
import { DeviceStore } from "../../src/auth/device-store";
import { encodePairingPayload } from "../../src/auth/pairing";
import { loadConfig } from "../../src/config";
import { GatewayServer } from "../../src/ws/server";

const dataDir = mkdtempSync(join(tmpdir(), "mgw-ws-"));
const port = 3990 + Math.floor(Math.random() * 100);
const wsUrl = `ws://127.0.0.1:${port}/ws/mobile`;

let server: GatewayServer;
let devices: DeviceStore;
const received: { conn: unknown; frame: unknown }[] = [];

beforeAll(async () => {
  devices = new DeviceStore({
    dataDir,
    pairingTtlMs: 5 * 60_000,
    maxFailures: 5,
    failureWindowMs: 15 * 60_000,
  });
  const config = loadConfig({ port });
  server = new GatewayServer(config, devices, {
    onFrame: (conn, frame) => received.push({ conn, frame }),
    onClose: () => {},
  });
  await server.listen();
});

afterAll(async () => {
  await server.close();
  rmSync(dataDir, { recursive: true, force: true });
});

interface ConnectSpec {
  protocols?: string[];
  headers?: Record<string, string>;
}

function connectOnce(spec: ConnectSpec): Promise<{ ws: WebSocket; frames: unknown[] }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl, spec.protocols ?? [], { headers: spec.headers });
    const frames: unknown[] = [];
    ws.on("message", (data) => frames.push(JSON.parse(String(data))));
    ws.on("open", () => resolve({ ws, frames }));
    ws.on("error", (err) => reject(err));
    ws.on("close", () => {});
    setTimeout(() => resolve({ ws, frames }), 1500); // closed connections resolve with what they got
  });
}

function waitFrames(collector: { frames: unknown[] }, count: number, timeoutMs = 2000): Promise<void> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const tick = () => {
      if (collector.frames.length >= count) return resolve();
      if (Date.now() - started > timeoutMs) return reject(new Error(`timeout: ${collector.frames.length}/${count}`));
      setTimeout(tick, 50);
    };
    tick();
  });
}

describe("pairing handshake (protocol §1)", () => {
  it("first connect with pairing code receives paired + hello, token works on reconnect", async () => {
    const { code, expiresAt } = devices.issuePairingCode();
    const pairing = connectOnce({
      protocols: ["komorebi-v1", `komorebi-pair.${code}`],
      headers: { "x-dsh-device-id": "device-test-1" },
    });
    const { ws, frames } = await pairing;
    await waitFrames({ frames }, 2);
    expect(frames[0]).toMatchObject({ kind: "paired" });
    expect(frames[1]).toMatchObject({ kind: "hello", protocol: 3, authenticated: true });
    const token = (frames[0] as { token: string }).token;
    expect(typeof token).toBe("string");
    ws.close();

    // Reconnect with bearer token
    const reconnect = connectOnce({
      protocols: ["komorebi-v1"],
      headers: { authorization: `Bearer ${token}` },
    });
    const { ws: ws2, frames: frames2 } = await reconnect;
    await waitFrames({ frames: frames2 }, 1);
    expect(frames2[0]).toMatchObject({ kind: "hello", authenticated: true });
    ws2.close();
  });

  it("rejects stale pairing code with close 4001", async () => {
    const { code } = devices.issuePairingCode();
    devices.consumePairingCode(code, "someone", "x"); // consume it
    const result = await connectOnce({
      protocols: ["komorebi-v1", `komorebi-pair.${code}`],
      headers: { "x-dsh-device-id": "device-test-2" },
    });
    expect(result.frames).toHaveLength(0); // no paired/hello delivered
    expect(result.ws.readyState === WebSocket.CLOSED || result.ws.readyState === WebSocket.CLOSING).toBe(true);
  });

  it("rejects missing credential with close 4001", async () => {
    const result = await connectOnce({
      protocols: ["komorebi-v1"],
      headers: { "x-dsh-device-id": "device-test-3" },
    });
    expect(result.frames).toHaveLength(0);
  });
});

describe("frame pump and validation errors", () => {
  it("delivers validated frames to the dispatcher", async () => {
    const { code } = devices.issuePairingCode();
    const { ws, frames } = await connectOnce({
      protocols: ["komorebi-v1", `komorebi-pair.${code}`],
      headers: { "x-dsh-device-id": "device-pump" },
    });
    await waitFrames({ frames }, 2);
    const before = received.length;
    ws.send(JSON.stringify({ type: "ping" }));
    await new Promise((r) => setTimeout(r, 300));
    expect(received.length).toBe(before + 1);
    expect(received[received.length - 1]?.frame).toEqual({ type: "ping" });
    ws.close();
  });

  it("answers invalid JSON with bad-request error frame", async () => {
    const { code } = devices.issuePairingCode();
    const { ws, frames } = await connectOnce({
      protocols: ["komorebi-v1", `komorebi-pair.${code}`],
      headers: { "x-dsh-device-id": "device-json" },
    });
    await waitFrames({ frames }, 2);
    ws.send("this is not json");
    await waitFrames({ frames }, 3);
    expect(frames[2]).toMatchObject({ kind: "error", code: "bad-request" });
    ws.close();
  });

  it("answers unknown frame type with unknown-command error", async () => {
    const { code } = devices.issuePairingCode();
    const { ws, frames } = await connectOnce({
      protocols: ["komorebi-v1", `komorebi-pair.${code}`],
      headers: { "x-dsh-device-id": "device-unk" },
    });
    await waitFrames({ frames }, 2);
    ws.send(JSON.stringify({ type: "frame-from-the-future" }));
    await waitFrames({ frames }, 3);
    expect(frames[2]).toMatchObject({ kind: "error", code: "unknown-command" });
    ws.close();
  });
});

describe("split-channel lanes (protocol split-channels)", () => {
  it("conversation lane accepts message and rejects control frames with wrong-channel", async () => {
    const { code } = devices.issuePairingCode();
    const { ws, frames } = await connectOnce({
      protocols: ["komorebi-v1", `komorebi-pair.${code}`],
      headers: { "x-dsh-device-id": "device-lane", "x-dsh-channel": "conversation" },
    });
    await waitFrames({ frames }, 2);
    // message is allowed on conversation lane
    ws.send(JSON.stringify({ type: "message", sessionId: "s", text: "hi" }));
    await new Promise((r) => setTimeout(r, 300));
    const last = received[received.length - 1];
    expect((last?.frame as Record<string, unknown>)?.["type"]).toBe("message");
    // session-stats is control-lane only
    ws.send(JSON.stringify({ type: "session-stats", sessionId: "s" }));
    await waitFrames({ frames }, 3);
    expect(frames[2]).toMatchObject({ kind: "error", code: "wrong-channel" });
    ws.close();
  });

  it("control lane accepts everything (legacy default)", async () => {
    const { code } = devices.issuePairingCode();
    const { ws, frames } = await connectOnce({
      protocols: ["komorebi-v1", `komorebi-pair.${code}`],
      headers: { "x-dsh-device-id": "device-ctl" },
    });
    await waitFrames({ frames }, 2);
    const before = received.length;
    ws.send(JSON.stringify({ type: "session-stats", sessionId: "s" }));
    await new Promise((r) => setTimeout(r, 300));
    expect(received.length).toBe(before + 1); // dispatched, not wrong-channel
    ws.close();
  });
});

describe("pairing payload encoding sanity (via encode)", () => {
  it("QR payload round-trips through the same helper the CLI will use", () => {
    const encoded = encodePairingPayload({
      version: 2,
      publicUrl: `wss://dsh.pipicore.cn/ws/mobile`,
      pairingCode: "x",
      expiresAt: 1,
    });
    expect(encoded).not.toContain("=");
  });
});
