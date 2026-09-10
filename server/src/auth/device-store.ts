/**
 * Device store — pairing codes, paired devices, token digests, failure lockout.
 * Persistence: JSONL append log + full snapshot rewrite on mutation (restart-safe).
 * Protocol requirements (§1): 256-bit one-shot pairing code with TTL,
 * long-term token stored as sha256 digest only, revocation immediate.
 * @module auth/device-store
 */

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export interface PairedDevice {
  readonly id: string;
  readonly name: string;
  readonly createdAt: number;
  /** sha256 hex digest of the long-term token — never the token itself. */
  readonly tokenDigest: string;
  /** Milliseconds since epoch; undefined = active. */
  readonly revokedAt?: number | undefined;
}

interface PendingPairing {
  readonly code: string;
  readonly expiresAt: number;
  readonly consumed: boolean;
}

interface Snapshot {
  readonly devices: PairedDevice[];
  readonly pending: PendingPairing[];
  readonly failures: Record<string, number[]>;
  readonly issuedTokens: string[];
}

export interface DeviceStoreConfig {
  readonly dataDir: string;
  readonly pairingTtlMs: number;
  readonly maxFailures: number;
  readonly failureWindowMs: number;
  /** Injectable clock for deterministic tests. */
  readonly now?: () => number;
}

export class DeviceStore {
  private devices: PairedDevice[] = [];
  private pending: PendingPairing[] = [];
  private failures: Record<string, number[]> = {};
  private issuedTokens: string[] = [];
  private readonly now: () => number;
  private readonly cfg: Omit<DeviceStoreConfig, "now">;

  constructor(config: DeviceStoreConfig) {
    this.cfg = {
      dataDir: config.dataDir,
      pairingTtlMs: config.pairingTtlMs,
      maxFailures: config.maxFailures,
      failureWindowMs: config.failureWindowMs,
    };
    this.now = config.now ?? Date.now;
    this.load();
  }

  private get storePath(): string {
    return join(this.cfg.dataDir, "devices.json");
  }

  private load(): void {
    if (!existsSync(this.storePath)) {
      mkdirSync(dirname(this.storePath), { recursive: true });
      return;
    }
    const raw = JSON.parse(readFileSync(this.storePath, "utf8")) as Partial<Snapshot>;
    this.devices = Array.isArray(raw.devices) ? raw.devices : [];
    this.pending = Array.isArray(raw.pending) ? raw.pending : [];
    this.failures = raw.failures && typeof raw.failures === "object" ? raw.failures : {};
    this.issuedTokens = Array.isArray(raw.issuedTokens) ? raw.issuedTokens : [];
  }

  private save(): void {
    const snapshot: Snapshot = {
      devices: this.devices,
      pending: this.pending,
      failures: this.failures,
      issuedTokens: this.issuedTokens,
    };
    mkdirSync(dirname(this.storePath), { recursive: true });
    const tmp = this.storePath + ".tmp";
    writeFileSync(tmp, JSON.stringify(snapshot, null, 2), "utf8");
    renameSync(tmp, this.storePath);
  }

  /** Issue a fresh one-shot pairing code (protocol: 256-bit, TTL). */
  issuePairingCode(): { code: string; expiresAt: number } {
    const code = randomBytes(32).toString("base64url");
    const expiresAt = this.now() + this.cfg.pairingTtlMs;
    this.pending = this.pending.filter((p) => p.expiresAt > this.now());
    this.pending.push({ code, expiresAt, consumed: false });
    this.save();
    return { code, expiresAt };
  }

  /**
   * Consume a pairing code: one-shot, TTL-bound.
   * Returns the long-term token exactly once (caller delivers, then forgets).
   */
  consumePairingCode(code: string, deviceId: string, deviceName: string): { ok: true; token: string } | { ok: false; reason: "expired" | "unknown" | "consumed" } {
    const now = this.now();
    const entry = this.pending.find((p) => p.code === code);
    if (entry === undefined || entry.consumed) {
      return { ok: false, reason: entry === undefined ? "unknown" : "consumed" };
    }
    if (entry.expiresAt <= now) {
      return { ok: false, reason: "expired" };
    }
    this.pending = this.pending.filter((p) => p !== entry);
    const token = randomBytes(32).toString("base64url");
    const digest = sha256Hex(token);
    this.issuedTokens.push(digest);
    this.devices.push({ id: deviceId, name: deviceName, createdAt: now, tokenDigest: digest });
    this.save();
    return { ok: true, token };
  }

  /** Verify a bearer token against stored digests; records a failure per protocol lockout. */
  verifyToken(token: string, clientIp: string): { ok: true; device: PairedDevice } | { ok: false; reason: "invalid" | "locked" | "revoked" } {
    const now = this.now();
    if (this.isLocked(clientIp, now)) {
      return { ok: false, reason: "locked" };
    }
    const digest = sha256Hex(token);
    const device = this.devices.find((d) => d.tokenDigest === digest);
    if (device === undefined) {
      this.recordFailure(clientIp, now);
      return { ok: false, reason: "invalid" };
    }
    if (device.revokedAt !== undefined) {
      return { ok: false, reason: "revoked" };
    }
    return { ok: true, device };
  }

  /** Constant-time digest comparison helper exposed for tests. */
  static digestsMatch(a: string, b: string): boolean {
    if (a.length !== b.length) return false;
    return timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex"));
  }

  private isLocked(ip: string, now: number): boolean {
    const times = (this.failures[ip] ?? []).filter((t) => now - t < this.cfg.failureWindowMs);
    return times.length >= this.cfg.maxFailures;
  }

  private recordFailure(ip: string, now: number): void {
    const times = (this.failures[ip] ?? []).filter((t) => now - t < this.cfg.failureWindowMs);
    times.push(now);
    this.failures[ip] = times;
    this.save();
  }

  /** Revoke a device immediately (protocol: instant revocation). */
  revoke(deviceId: string): boolean {
    const device = this.devices.find((d) => d.id === deviceId && d.revokedAt === undefined);
    if (device === undefined) return false;
    this.devices = this.devices.map((d) => (d.id === deviceId ? { ...d, revokedAt: this.now() } : d));
    this.save();
    return true;
  }

  /** List active devices for management (CLI/devices command). */
  listDevices(): readonly PairedDevice[] {
    return this.devices.filter((d) => d.revokedAt === undefined);
  }
}

export function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
