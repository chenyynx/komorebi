/**
 * Gateway configuration: load once at startup, immutable thereafter.
 * All values may be overridden by environment variables (MGW_*).
 * @module config
 */

import { readFileSync, statSync } from "node:fs";

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
  /**
   * Host-level default model, read from the Claude Code settings file's
   * env.ANTHROPIC_MODEL. pp switches upstream providers with a host `sm`
   * command that rewrites exactly that field, so a gateway that pins its own
   * model silently defeats every switch — which is what produced
   * "API Error: 400 … you passed qwen3.8-flash" on every phone message after
   * pp moved to deepseek (incident 2026-09-10). undefined = host says nothing.
   */
  readonly hostModel: string | undefined;
  /** Settings file the host model is read from (injectable for tests). */
  readonly hostSettingsPath: string;
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

/**
 * Read env.ANTHROPIC_MODEL out of a Claude Code settings file. Never throws.
 *
 * `sm` (~/bin/switch-model) rewrites that file's env block on every provider
 * switch and does NOT touch pm2 — so a cached process.env / boot-time read goes
 * stale. The config object is frozen at startup, which is exactly why callers
 * that need to stay current must use currentHostModel() below instead.
 */
function readHostModel(path: string): string | undefined {
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as { env?: Record<string, unknown> };
    const model = raw["env"]?.["ANTHROPIC_MODEL"];
    return typeof model === "string" && model.trim() !== "" ? model.trim() : undefined;
  } catch {
    // missing / unreadable / invalid JSON → no host knowledge, callers fall back
    return undefined;
  }
}

let hostCache: { readonly key: string; readonly model: string | undefined } | undefined;

/**
 * The host's current default model, re-read only when the file actually changed.
 * Cheap enough to call per request; a corrupt file yields undefined (callers
 * fall back) without poisoning the cache, and the path is part of the key so two
 * files that happen to share size and mtime can never share an entry.
 */
export function currentHostModel(path: string): string | undefined {
  let stat;
  try {
    stat = statSync(path);
  } catch {
    hostCache = undefined;
    return undefined;
  }
  const key = `${path}:${stat.mtimeMs}:${stat.size}`;
  if (hostCache !== undefined && hostCache.key === key) return hostCache.model;
  const model = readHostModel(path);
  hostCache = { key, model };
  return model;
}

/**
 * The model set as it stands RIGHT NOW: the host's current model first (the app
 * renders this list verbatim), then the configured whitelist minus duplicates.
 * A provider switch therefore reaches the phone without any restart.
 */
export function withHostModel(
  models: readonly ModelEntry[],
  hostModel: string | undefined,
): readonly ModelEntry[] {
  if (hostModel === undefined || hostModel === "") return models;
  const rest = models.filter((m) => m.id !== hostModel);
  const declared = models.find((m) => m.id === hostModel);
  return [
    { id: hostModel, name: declared?.name ?? "跟随 sm（宿主默认）" },
    ...rest,
  ];
}

/**
 * MGW_MODELS="id:Label,id2:Label2" pins an explicit whitelist. Without it the
 * host model leads, so the picker can never offer an id the current upstream
 * would reject; the historical list stays behind it only as extra choices and
 * as the last resort when the host declares nothing.
 */
function resolveModels(hostModel: string | undefined): readonly ModelEntry[] {
  const raw = process.env["MGW_MODELS"];
  if (raw !== undefined && raw.trim() !== "") {
    const entries = raw.split(",")
      .map((part) => part.trim())
      .filter((part) => part !== "")
      .map((part) => {
        const sep = part.indexOf(":");
        if (sep < 0) return { id: part, name: part };
        const id = part.slice(0, sep).trim();
        return { id, name: part.slice(sep + 1).trim() === "" ? id : part.slice(sep + 1).trim() };
      });
    if (entries.length > 0) return entries;
  }
  if (hostModel !== undefined) {
    return [{ id: hostModel, name: "跟随 sm（宿主默认）" }, ...DEFAULT_MODELS.filter((m) => m.id !== hostModel)];
  }
  return DEFAULT_MODELS;
}

/**
 * Which model to hand the SDK for one turn: an explicit pick wins only if the
 * current whitelist knows it; a stale pin (e.g. a default left over from an
 * upstream that has since been switched with `sm`) is dropped so the host
 * default applies instead of 400-ing every message.
 */
export function resolveSpawnModel(
  wanted: string | undefined,
  models: readonly ModelEntry[],
): string | undefined {
  if (wanted === undefined) return undefined;
  return models.some((m) => m.id === wanted) ? wanted : undefined;
}

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
  const hostSettingsPath =
    overrides?.hostSettingsPath ??
    `${process.env["HOME"] ?? "/home/ubuntu"}/.claude/settings.json`;
  const hostModel = overrides?.hostModel ?? readHostModel(hostSettingsPath);
  const config: Config = {
    port: intEnv("MGW_PORT", 3090),
    wsPath: strEnv("MGW_WS_PATH", "/ws/mobile"),
    publicUrl: strEnv("MGW_PUBLIC_URL", "wss://dsh.pipicore.cn/ws/mobile"),
    dataDir: strEnv("MGW_DATA_DIR", "/home/ubuntu/komorebi/server/data"),
    workspaceRoot: strEnv("MGW_WORKSPACE_ROOT", "/home/ubuntu"),
    sessionCwdRoot: strEnv("MGW_SESSION_CWD_ROOT", "/home/ubuntu"),
    models: overrides?.models ?? resolveModels(hostModel),
    // NOTE: frozen at boot on purpose; live consumers must call
    // currentHostModel(hostSettingsPath) + withHostModel(...) instead
    hostSettingsPath,
    hostModel,
    defaultPermission: "workspace-write",
    pairingTtlMs: 5 * 60 * 1000,
    maxPayloadBytes: 144 * 1024 * 1024,
    authMaxFailures: 5,
    authWindowMs: 15 * 60 * 1000,
    ...overrides,
  };
  return Object.freeze(config);
}
