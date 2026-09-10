/**
 * Gateway configuration: load once at startup, immutable thereafter.
 * All values may be overridden by environment variables (MGW_*).
 * @module config
 */

export interface ModelEntry {
  readonly id: string;
  readonly name: string;
}

export interface Config {
  /** Loopback listen port (nginx terminates TLS in front). */
  readonly port: number;
  /** WebSocket path the mobile client connects to. */
  readonly wsPath: string;
  /** Public wss endpoint advertised in pairing payloads. */
  readonly publicUrl: string;
  /** Data directory for device store, sessions index, attachments. */
  readonly dataDir: string;
  /** Root directory exposed as workspace list (pp decision: open /home/ubuntu). */
  readonly workspaceRoot: string;
  /** Claude Code working root: sessions may pick any subdirectory. */
  readonly sessionCwdRoot: string;
  /** Model whitelist for the models frame (provider id fixed to claude-code). */
  readonly models: readonly ModelEntry[];
  /** Default permission mode for new sessions. */
  readonly defaultPermission: PermissionPreset;
  /** Pairing code TTL in ms (protocol: 5 minutes). */
  readonly pairingTtlMs: number;
  /** Max inbound WS frame size in bytes (protocol: 144 MiB image budget). */
  readonly maxPayloadBytes: number;
  /** Device auth failure lockout: max attempts within window. */
  readonly authMaxFailures: number;
  /** Device auth failure lockout window in ms. */
  readonly authWindowMs: number;
}

/** dsh permission presets the client can select. */
export type PermissionPreset =
  | "read-only"
  | "workspace-write"
  | "danger-full-access";

export const PROVIDER_ID = "claude-code" as const;

const DEFAULT_MODELS: readonly ModelEntry[] = [
  { id: "glm-5.3-flash[1m]", name: "GLM 5.3 Flash" },
  { id: "qwen3.8-flash[1m]", name: "Qwen 3.8 Flash" },
  { id: "hy3[1m]", name: "HY3" },
];

function intEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function strEnv(name: string, fallback: string): string {
  const raw = process.env[name];
  return raw !== undefined && raw.trim() !== "" ? raw.trim() : fallback;
}

export function loadConfig(overrides?: Partial<Config>): Config {
  const config: Config = {
    port: intEnv("MGW_PORT", 3090),
    wsPath: strEnv("MGW_WS_PATH", "/ws/mobile"),
    publicUrl: strEnv("MGW_PUBLIC_URL", "wss://dsh.pipicore.cn/ws/mobile"),
    dataDir: strEnv("MGW_DATA_DIR", "/home/ubuntu/dsh-mobile/server/data"),
    workspaceRoot: strEnv("MGW_WORKSPACE_ROOT", "/home/ubuntu"),
    sessionCwdRoot: strEnv("MGW_SESSION_CWD_ROOT", "/home/ubuntu"),
    models: DEFAULT_MODELS,
    defaultPermission: "workspace-write",
    pairingTtlMs: 5 * 60 * 1000,
    maxPayloadBytes: 144 * 1024 * 1024,
    authMaxFailures: 5,
    authWindowMs: 15 * 60 * 1000,
    ...overrides,
  };
  return Object.freeze(config);
}
