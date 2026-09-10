/**
 * Gateway WebSocket server — upgrade handshake, pairing/bearer auth,
 * split-channel lanes, frame pump. Owns no business logic: validated frames
 * are handed to the dispatcher, outbound frames come from the broadcaster.
 * @module ws/server
 */

import { IncomingMessage, Server as HttpServer, createServer } from "node:http";
import { Duplex } from "node:stream";
import { WebSocket, WebSocketServer } from "ws";
import { DeviceStore } from "../auth/device-store.js";
import { extractAuthFromRequest, extractPairingFromRequest } from "../auth/pairing.js";
import { Config } from "../config.js";
import { errorFrame, helloFrame, pairedFrame } from "../protocol/frames.js";
import { validateInbound } from "../protocol/validation.js";

export type Lane = "control" | "conversation";

export interface AuthenticatedConnection {
  readonly ws: WebSocket;
  readonly lane: Lane;
  /** true = opened via explicit X-DSH-Channel (lane-restricted); false = legacy single connection. */
  readonly split: boolean;
  readonly deviceId: string;
  readonly deviceName: string;
}

export interface FrameDispatch {
  /** Called for each validated inbound frame on any authenticated connection. */
  onFrame(conn: AuthenticatedConnection, frame: unknown): void;
  /** Called right after the handshake (paired/hello delivered). */
  onOpen?(conn: AuthenticatedConnection): void;
  /** Called when a connection closes for cleanup. */
  onClose(conn: AuthenticatedConnection, code: number, reason: string): void;
}

export class GatewayServer {
  private readonly wss: WebSocketServer;
  private readonly http: HttpServer;
  private readonly connections = new Set<AuthenticatedConnection>();

  constructor(
    private readonly config: Config,
    private readonly devices: DeviceStore,
    private readonly dispatch: FrameDispatch,
  ) {
    this.http = createServer((_req, res) => {
      res.writeHead(404).end("not found");
    });
    this.wss = new WebSocketServer({
      server: this.http,
      path: config.wsPath,
      maxPayload: config.maxPayloadBytes,
    });
    this.wss.on("connection", (ws, req) => this.handleConnection(ws, req));
  }

  /** Bind loopback; supports port 0 (OS-assigned) — resolves with the actual port. */
  listen(): Promise<number> {
    return new Promise((resolve, reject) => {
      this.http.once("error", reject);
      this.http.listen(this.config.port, "127.0.0.1", () => {
        const address = this.http.address();
        resolve(typeof address === "object" && address !== null ? address.port : this.config.port);
      });
    });
  }

  close(): Promise<void> {
    for (const conn of this.connections) conn.ws.close(4004, "gateway shutdown");
    return new Promise((resolve) => {
      this.wss.close(() => this.http.close(() => resolve()));
    });
  }

  /** All live authenticated connections (for the broadcaster). */
  get liveConnections(): readonly AuthenticatedConnection[] {
    return [...this.connections];
  }

  private handleConnection(ws: WebSocket, req: IncomingMessage): void {
    const headers = {
      "sec-websocket-protocol": req.headers["sec-websocket-protocol"],
      "x-dsh-device-id": req.headers["x-dsh-device-id"] as string | undefined,
      authorization: req.headers["authorization"],
    };
    const clientIp = req.socket.remoteAddress ?? "unknown";

    // First connect: pairing subprotocol. Reconnect: bearer/dsh-auth token.
    const pairing = extractPairingFromRequest(headers);
    let deviceId: string;
    let deviceName: string;

    if (pairing.ok) {
      const consumed = this.devices.consumePairingCode(pairing.pairingCode, pairing.deviceId, "iPhone");
      if (!consumed.ok) {
        ws.close(4001, `pairing rejected: ${consumed.reason}`);
        return;
      }
      deviceId = pairing.deviceId;
      deviceName = "iPhone";
      const paired = pairedFrame(consumed.token, { id: deviceId, name: deviceName, createdAt: Date.now() });
      ws.send(JSON.stringify(paired));
    } else {
      const auth = extractAuthFromRequest(headers);
      if (!auth.ok) {
        ws.close(4001, "missing credential");
        return;
      }
      const verify = this.devices.verifyToken(auth.token, clientIp);
      if (!verify.ok) {
        ws.close(4003, `auth failed: ${verify.reason}`);
        return;
      }
      deviceId = verify.device.id;
      deviceName = verify.device.name;
    }

    const { lane, split } = this.laneOf(req);
    const conn: AuthenticatedConnection = { ws, lane, split, deviceId, deviceName };
    this.connections.add(conn);

    // hello immediately after (protocol: pushed on connect)
    ws.send(JSON.stringify(helloFrame(this.config.port, this.connections.size)));
    this.dispatch.onOpen?.(conn);

    ws.on("message", (data) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(String(data));
      } catch {
        ws.send(JSON.stringify(errorFrame("bad-request", "frame must be valid JSON")));
        return;
      }
      const validated = validateInbound(parsed);
      if (!validated.ok) {
        ws.send(
          JSON.stringify(
            errorFrame(validated.code, validated.message, typeof parsed === "object" && parsed !== null && "type" in parsed ? String((parsed as Record<string, unknown>)["type"]) : undefined),
          ),
        );
        return;
      }
      // Lane policy (protocol: wrong-channel for lane violations)
      if (this.wrongLane(validated.value.type, lane)) {
        const wrongLaneFrame = errorFrame("wrong-channel", `request ${validated.value.type} must be sent on the control channel`, validated.value.type);
        ws.send(JSON.stringify(wrongLaneFrame));
        return;
      }
      this.dispatch.onFrame(conn, validated.value);
    });

    ws.on("close", (code, reason) => {
      this.connections.delete(conn);
      this.dispatch.onClose(conn, code, reason.toString("utf8"));
    });
  }

  private laneOf(req: IncomingMessage): { lane: Lane; split: boolean } {
    const channel = req.headers["x-dsh-channel"];
    if (typeof channel === "string" && channel === "conversation") return { lane: "conversation", split: true };
    if (typeof channel === "string" && channel === "control") return { lane: "control", split: true };
    return { lane: "control", split: false };
  }

  /** Conversation lane accepts only the protocol §split-channels message set. */
  private wrongLane(frameType: string, lane: Lane): boolean {
    if (lane === "conversation") {
      return !(frameType === "message" || frameType === "history" || frameType === "subscribe" || frameType === "unsubscribe" || frameType === "ping");
    }
    return false;
  }
}
