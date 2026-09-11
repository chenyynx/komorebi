/**
 * Pairing service — QR payload generation and first-connect verification.
 * Protocol §1: payload is {version:2, publicUrl, pairingCode, expiresAt},
 * encoded as unpadded Base64URL of UTF-8 JSON. First connect uses the
 * `komorebi-v1, komorebi-pair.<code>` subprotocol plus X-Komorebi-Device-ID header
 * (legacy dsh-* spellings are still accepted during the rename migration).
 * @module auth/pairing
 */

export interface PairingPayload {
  readonly version: 2;
  readonly publicUrl: string;
  readonly pairingCode: string;
  readonly expiresAt: number;
}

/** Strict Base64URL alphabet per protocol: A-Z a-z 0-9 - _ (no padding). */
const BASE64URL_STRICT = /^[A-Za-z0-9_-]+$/;

export function encodePairingPayload(payload: PairingPayload): string {
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

/** Decode and validate: strict Base64URL, then JSON, then version + expiry. */
export function decodePairingPayload(text: string): { ok: true; payload: PairingPayload } | { ok: false; reason: "encoding" | "json" | "version" | "shape" } {
  const trimmed = text.trim();
  if (trimmed === "" || trimmed.includes("=") || !BASE64URL_STRICT.test(trimmed)) {
    return { ok: false, reason: "encoding" };
  }
  let decoded: string;
  try {
    decoded = Buffer.from(trimmed, "base64url").toString("utf8");
  } catch {
    return { ok: false, reason: "encoding" };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(decoded);
  } catch {
    return { ok: false, reason: "json" };
  }
  if (typeof parsed !== "object" || parsed === null) {
    return { ok: false, reason: "shape" };
  }
  const raw = parsed as Record<string, unknown>;
  if (raw["version"] !== 2) {
    return { ok: false, reason: "version" };
  }
  const publicUrl = raw["publicUrl"];
  const pairingCode = raw["pairingCode"];
  const expiresAt = raw["expiresAt"];
  if (typeof publicUrl !== "string" || typeof pairingCode !== "string" || typeof expiresAt !== "number" || !Number.isSafeInteger(expiresAt)) {
    return { ok: false, reason: "shape" };
  }
  return { ok: true, payload: { version: 2, publicUrl, pairingCode, expiresAt } };
}

/** Extract pairing code + device id from the first-connect WS upgrade request. */
export function extractPairingFromRequest(headers: {
  "sec-websocket-protocol"?: string | undefined;
  "x-dsh-device-id"?: string | undefined;
  "x-komorebi-device-id"?: string | undefined;
}): { ok: true; pairingCode: string; deviceId: string } | { ok: false; reason: "missing-protocol" | "missing-device-id" | "missing-pair" } {
  const protocol = headers["sec-websocket-protocol"];
  if (typeof protocol !== "string" || protocol.length === 0) {
    return { ok: false, reason: "missing-protocol" };
  }
  const parts = protocol.split(",").map((p) => p.trim()).filter((p) => p.length > 0);
  if (!parts.includes("komorebi-v1") && !parts.includes("dsh-mobile-v1")) {
    return { ok: false, reason: "missing-protocol" };
  }
  const pairPart = parts.find((p) => p.startsWith("komorebi-pair."))
    ?? parts.find((p) => p.startsWith("dsh-pair."));
  if (pairPart === undefined) {
    return { ok: false, reason: "missing-pair" };
  }
  const deviceId = headers["x-komorebi-device-id"] ?? headers["x-dsh-device-id"];
  if (typeof deviceId !== "string" || deviceId.trim() === "") {
    return { ok: false, reason: "missing-device-id" };
  }
  const prefix = pairPart.startsWith("komorebi-pair.") ? "komorebi-pair." : "dsh-pair.";
  return { ok: true, pairingCode: pairPart.slice(prefix.length), deviceId: deviceId.trim() };
}

/** Extract bearer token or dsh-auth subprotocol from a reconnect request. */
export function extractAuthFromRequest(headers: {
  authorization?: string | undefined;
  "sec-websocket-protocol"?: string | undefined;
}): { ok: true; token: string } | { ok: false; reason: "missing" } {
  const auth = headers["authorization"];
  if (typeof auth === "string" && auth.startsWith("Bearer ")) {
    const token = auth.slice("Bearer ".length).trim();
    if (token !== "") return { ok: true, token };
  }
  const protocol = headers["sec-websocket-protocol"];
  if (typeof protocol === "string") {
    const parts = protocol.split(",").map((p) => p.trim());
    const authPart = parts.find((p) => p.startsWith("dsh-auth."));
    if (authPart !== undefined) {
      const token = authPart.slice("dsh-auth.".length);
      if (token !== "") return { ok: true, token };
    }
  }
  return { ok: false, reason: "missing" };
}

/** Public pairing URL → ws(s) endpoint URL for the QR payload. */
export function publicWebSocketUrl(publicUrl: string, wsPath: string): string {
  const url = new URL(publicUrl);
  if (url.protocol === "https:") url.protocol = "wss:";
  else if (url.protocol === "http:") url.protocol = "ws:";
  url.pathname = wsPath;
  return url.toString();
}
