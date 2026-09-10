/**
 * Pairing service tests — QR payload encode/decode strictness and
 * WS request extraction, per protocol §1 rules.
 */
import { describe, expect, it } from "vitest";
import {
  decodePairingPayload,
  encodePairingPayload,
  extractAuthFromRequest,
  extractPairingFromRequest,
  publicWebSocketUrl,
} from "../../src/auth/pairing";

const PAYLOAD = {
  version: 2 as const,
  publicUrl: "wss://dsh.pipicore.cn/ws/mobile",
  pairingCode: "abc123-_XYZ",
  expiresAt: 1787112000000,
};

describe("pairing payload codec", () => {
  it("round-trips through strict unpadded Base64URL", () => {
    const encoded = encodePairingPayload(PAYLOAD);
    expect(encoded).not.toContain("=");
    expect(encoded).toMatch(/^[A-Za-z0-9_-]+$/);
    const decoded = decodePairingPayload(encoded);
    expect(decoded).toEqual({ ok: true, payload: PAYLOAD });
  });

  it("rejects padded base64 (protocol: no = accepted)", () => {
    const encoded = encodePairingPayload(PAYLOAD);
    const padded = encoded + "==";
    expect(decodePairingPayload(padded)).toEqual({ ok: false, reason: "encoding" });
  });

  it("rejects plain JSON (must be Base64URL first)", () => {
    expect(decodePairingPayload(JSON.stringify(PAYLOAD))).toEqual({ ok: false, reason: "encoding" });
  });

  it("rejects garbage bytes with reason json", () => {
    const garbage = Buffer.from("not json at all!!").toString("base64url");
    expect(decodePairingPayload(garbage)).toEqual({ ok: false, reason: "json" });
  });

  it("rejects version != 2", () => {
    const v1 = encodePairingPayload({ ...PAYLOAD, version: 1 as unknown as 2 });
    expect(decodePairingPayload(v1)).toEqual({ ok: false, reason: "version" });
  });

  it("rejects malformed shape (missing expiresAt)", () => {
    const bad = Buffer.from(JSON.stringify({ version: 2, publicUrl: "wss://x", pairingCode: "c" }), "utf8").toString("base64url");
    expect(decodePairingPayload(bad)).toEqual({ ok: false, reason: "shape" });
  });
});

describe("first-connect request extraction", () => {
  it("extracts pairing code and device id (protocol §1 headers)", () => {
    const result = extractPairingFromRequest({
      "sec-websocket-protocol": "dsh-mobile-v1, dsh-pair.CODE123",
      "x-dsh-device-id": "  UUID-ABC  ",
    });
    expect(result).toEqual({ ok: true, pairingCode: "CODE123", deviceId: "UUID-ABC" });
  });

  it("rejects missing device id (protocol: no anonymous pairing)", () => {
    const result = extractPairingFromRequest({
      "sec-websocket-protocol": "dsh-mobile-v1, dsh-pair.CODE",
    });
    expect(result).toEqual({ ok: false, reason: "missing-device-id" });
  });

  it("rejects missing pairing subprotocol part", () => {
    const result = extractPairingFromRequest({
      "sec-websocket-protocol": "dsh-mobile-v1",
      "x-dsh-device-id": "UUID",
    });
    expect(result).toEqual({ ok: false, reason: "missing-pair" });
  });

  it("rejects missing dsh-mobile-v1 base protocol", () => {
    const result = extractPairingFromRequest({
      "sec-websocket-protocol": "dsh-pair.CODE",
      "x-dsh-device-id": "UUID",
    });
    expect(result).toEqual({ ok: false, reason: "missing-protocol" });
  });
});

describe("reconnect auth extraction", () => {
  it("prefers Authorization Bearer header (protocol recommendation)", () => {
    const result = extractAuthFromRequest({
      authorization: "Bearer TOKEN-XYZ",
      "sec-websocket-protocol": "dsh-mobile-v1",
    });
    expect(result).toEqual({ ok: true, token: "TOKEN-XYZ" });
  });

  it("falls back to dsh-auth subprotocol", () => {
    const result = extractAuthFromRequest({
      "sec-websocket-protocol": "dsh-mobile-v1, dsh-auth.TOKEN-XYZ",
    });
    expect(result).toEqual({ ok: true, token: "TOKEN-XYZ" });
  });

  it("returns missing when no credential present", () => {
    expect(extractAuthFromRequest({})).toEqual({ ok: false, reason: "missing" });
    expect(extractAuthFromRequest({ authorization: "Basic zzz" })).toEqual({ ok: false, reason: "missing" });
  });

  it("empty bearer token is treated as missing", () => {
    expect(extractAuthFromRequest({ authorization: "Bearer " })).toEqual({ ok: false, reason: "missing" });
  });
});

describe("publicWebSocketUrl", () => {
  it("maps https origin to wss with the mobile path", () => {
    expect(publicWebSocketUrl("https://dsh.pipicore.cn", "/ws/mobile")).toBe("wss://dsh.pipicore.cn/ws/mobile");
  });

  it("maps http to ws", () => {
    expect(publicWebSocketUrl("http://192.168.1.5:3081", "/ws/mobile")).toBe("ws://192.168.1.5:3081/ws/mobile");
  });

  it("keeps wss endpoints as-is", () => {
    expect(publicWebSocketUrl("wss://dsh.pipicore.cn/whatever", "/ws/mobile")).toBe("wss://dsh.pipicore.cn/ws/mobile");
  });
});
