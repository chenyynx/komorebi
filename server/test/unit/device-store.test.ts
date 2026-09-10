/**
 * Device store tests — plan §7.1 auth/device-store.ts row:
 * TTL expiry, one-shot consumption, digest-only storage, instant revocation,
 * failure lockout (5 in 15min), restart recovery.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DeviceStore, sha256Hex } from "../../src/auth/device-store";

let dataDir: string;
let nowMs: number;
const NOW = 1787111700000;

function createStore(overrides?: Partial<ConstructorParameters<typeof DeviceStore>[0]>): DeviceStore {
  return new DeviceStore({
    dataDir,
    pairingTtlMs: 5 * 60 * 1000,
    maxFailures: 5,
    failureWindowMs: 15 * 60 * 1000,
    now: () => nowMs,
    ...overrides,
  });
}

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "mgw-devices-"));
  nowMs = NOW;
});

afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

describe("pairing codes", () => {
  it("issues a code with 5-minute TTL and 256-bit entropy", () => {
    const store = createStore();
    const { code, expiresAt } = store.issuePairingCode();
    // base64url of 32 bytes → 43 chars, no padding
    expect(code).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(expiresAt).toBe(NOW + 5 * 60 * 1000);
  });

  it("rejects a code past its TTL", () => {
    const store = createStore();
    const { code } = store.issuePairingCode();
    nowMs += 5 * 60 * 1000 + 1;
    const result = store.consumePairingCode(code, "device-1", "iPhone");
    expect(result).toEqual({ ok: false, reason: "expired" });
  });

  it("consumes a valid code exactly once (one-shot)", () => {
    const store = createStore();
    const { code } = store.issuePairingCode();
    const first = store.consumePairingCode(code, "device-1", "iPhone");
    expect(first.ok).toBe(true);
    const second = store.consumePairingCode(code, "device-1", "iPhone");
    expect(second).toEqual({ ok: false, reason: "unknown" }); // consumed codes are removed
  });

  it("rejects an unknown code", () => {
    const store = createStore();
    expect(store.consumePairingCode("bogus", "d", "n")).toEqual({ ok: false, reason: "unknown" });
  });
});

describe("token storage and verification", () => {
  it("stores only the sha256 digest on disk — never the token", () => {
    const store = createStore();
    const { code } = store.issuePairingCode();
    const result = store.consumePairingCode(code, "device-1", "iPhone");
    if (!result.ok) throw new Error("consume failed");
    const onDisk = readFileSync(join(dataDir, "devices.json"), "utf8");
    expect(onDisk).not.toContain(result.token);
    expect(onDisk).toContain(sha256Hex(result.token));
  });

  it("verifies the issued token and returns the device", () => {
    const store = createStore();
    const { code } = store.issuePairingCode();
    const result = store.consumePairingCode(code, "device-1", "iPhone");
    if (!result.ok) throw new Error("consume failed");
    const verify = store.verifyToken(result.token, "1.2.3.4");
    expect(verify.ok).toBe(true);
    if (verify.ok) {
      expect(verify.device.id).toBe("device-1");
      expect(verify.device.name).toBe("iPhone");
    }
  });

  it("digestsMatch is constant-time-safe comparator", () => {
    const a = sha256Hex("alpha");
    const b = sha256Hex("alpha");
    const c = sha256Hex("beta");
    expect(DeviceStore.digestsMatch(a, b)).toBe(true);
    expect(DeviceStore.digestsMatch(a, c)).toBe(false);
  });
});

describe("revocation", () => {
  it("revoked device token is immediately rejected", () => {
    const store = createStore();
    const { code } = store.issuePairingCode();
    const result = store.consumePairingCode(code, "device-1", "iPhone");
    if (!result.ok) throw new Error("consume failed");
    expect(store.revoke("device-1")).toBe(true);
    const verify = store.verifyToken(result.token, "1.2.3.4");
    expect(verify).toEqual({ ok: false, reason: "revoked" });
  });

  it("revoking an unknown device returns false", () => {
    const store = createStore();
    expect(store.revoke("ghost")).toBe(false);
  });

  it("listDevices excludes revoked devices", () => {
    const store = createStore();
    const { code } = store.issuePairingCode();
    store.consumePairingCode(code, "device-1", "iPhone");
    store.revoke("device-1");
    expect(store.listDevices()).toHaveLength(0);
  });
});

describe("failure lockout", () => {
  it("locks the IP after 5 failures within the window", () => {
    const store = createStore();
    for (let i = 0; i < 5; i++) {
      const result = store.verifyToken("wrong-token", "9.9.9.9");
      expect(result.ok).toBe(false);
    }
    const locked = store.verifyToken("wrong-token", "9.9.9.9");
    expect(locked).toEqual({ ok: false, reason: "locked" });
  });

  it("other IPs are unaffected by one IP's lockout", () => {
    const store = createStore();
    for (let i = 0; i < 5; i++) store.verifyToken("wrong-token", "9.9.9.9");
    const other = store.verifyToken("wrong-token", "8.8.8.8");
    expect(other).toEqual({ ok: false, reason: "invalid" }); // not locked
  });

  it("failures outside the 15-minute window do not count", () => {
    const store = createStore();
    for (let i = 0; i < 4; i++) store.verifyToken("wrong-token", "9.9.9.9");
    nowMs += 15 * 60 * 1000 + 1; // window slides past all failures
    const result = store.verifyToken("wrong-token", "9.9.9.9");
    expect(result).toEqual({ ok: false, reason: "invalid" }); // counter reset, not locked
  });
});

describe("restart recovery", () => {
  it("reload from disk restores devices and pending codes", () => {
    const store1 = createStore();
    const { code } = store1.issuePairingCode();
    const consumed = store1.consumePairingCode(code, "device-1", "iPhone");
    if (!consumed.ok) throw new Error("consume failed");

    const store2 = createStore(); // fresh instance, same dataDir
    const verify = store2.verifyToken(consumed.token, "1.2.3.4");
    expect(verify.ok).toBe(true);
  });

  it("pending pairing code survives restart within TTL", () => {
    const store1 = createStore();
    const { code } = store1.issuePairingCode();
    const store2 = createStore();
    const result = store2.consumePairingCode(code, "device-2", "iPad");
    expect(result.ok).toBe(true);
  });

  it("failed attempts counter survives restart", () => {
    const store1 = createStore();
    for (let i = 0; i < 5; i++) store1.verifyToken("wrong", "9.9.9.9");
    const store2 = createStore();
    const locked = store2.verifyToken("wrong", "9.9.9.9");
    expect(locked).toEqual({ ok: false, reason: "locked" });
  });
});
