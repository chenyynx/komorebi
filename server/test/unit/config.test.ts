/**
 * Minimal S0 smoke test: config loads, freezes, and applies env overrides.
 * S1 will replace this placeholder coverage with real suites.
 */
import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, PROVIDER_ID, currentHostModel, resolveSpawnModel, withHostModel } from "../../src/config";

describe("loadConfig", () => {
  it("returns a frozen config object", () => {
    const config = loadConfig();
    expect(Object.isFrozen(config)).toBe(true);
  });

  it("exposes the protocol port and path defaults", () => {
    const config = loadConfig();
    expect(config.port).toBe(3090);
    expect(config.wsPath).toBe("/ws/mobile");
  });

  it("applies explicit overrides", () => {
    const config = loadConfig({ port: 1234 });
    expect(config.port).toBe(1234);
  });

  it("falls back to the three static models only when the host declares none", () => {
    // a path that cannot exist = "host says nothing"; the real host settings file
    // is deliberately NOT what this case reads
    const config = loadConfig({ hostSettingsPath: "/nonexistent/mgw-host-settings.json" });
    expect(config.hostModel).toBeUndefined();
    expect(config.models.map((m) => m.id)).toEqual([
      "glm-5.3-flash[1m]",
      "qwen3.8-flash[1m]",
      "hy3[1m]",
    ]);
  });

  it("defaults permission to workspace-write per pp decision", () => {
    const config = loadConfig();
    expect(config.defaultPermission).toBe("workspace-write");
  });

  it("opens the workspace root at /home/ubuntu per pp decision", () => {
    const config = loadConfig();
    expect(config.workspaceRoot).toBe("/home/ubuntu");
  });
});

describe("PROVIDER_ID", () => {
  it("is the single claude-code provider id", () => {
    expect(PROVIDER_ID).toBe("claude-code");
  });
});

describe("host model inheritance (F7 — pp switches upstream with `sm`)", () => {
  function withHost(env: Record<string, unknown> | undefined): ReturnType<typeof loadConfig> {
    const dir = mkdtempSync(join(tmpdir(), "mgw-host-"));
    const file = join(dir, "settings.json");
    writeFileSync(file, env === undefined ? "{ not json" : JSON.stringify({ env }), "utf8");
    const config = loadConfig({ hostSettingsPath: file });
    rmSync(dir, { recursive: true, force: true });
    return config;
  }

  it("reads env.ANTHROPIC_MODEL and puts it first in the whitelist", () => {
    const config = withHost({ ANTHROPIC_MODEL: "deepseek-v4.1-flash-expires-on-0910[1m]" });
    expect(config.hostModel).toBe("deepseek-v4.1-flash-expires-on-0910[1m]");
    expect(config.models[0]?.id).toBe("deepseek-v4.1-flash-expires-on-0910[1m]");
    expect(config.models[0]?.name).toContain("sm");
    // the host id must pass select-model validation, which checks the whitelist
    expect(config.models.some((m) => m.id === config.hostModel)).toBe(true);
  });

  it("a blank or missing ANTHROPIC_MODEL yields no host knowledge", () => {
    expect(withHost({ ANTHROPIC_MODEL: "   " }).hostModel).toBeUndefined();
    expect(withHost({ OTHER: 1 }).hostModel).toBeUndefined();
    expect(withHost(undefined).hostModel).toBeUndefined(); // unreadable file, never throws
  });

  it("MGW_MODELS overrides everything, with or without labels", () => {
    const previous = process.env["MGW_MODELS"];
    process.env["MGW_MODELS"] = "deepseek-flash:Flash版, deepseek-v4-pro";
    try {
      const config = withHost({ ANTHROPIC_MODEL: "irrelevant" });
      expect(config.models).toEqual([
        { id: "deepseek-flash", name: "Flash版" },
        { id: "deepseek-v4-pro", name: "deepseek-v4-pro" },
      ]);
    } finally {
      if (previous === undefined) delete process.env["MGW_MODELS"];
      else process.env["MGW_MODELS"] = previous;
    }
  });
});

describe("resolveSpawnModel (stale pin guard)", () => {
  const models = [{ id: "deepseek-flash", name: "Flash" }];

  it("no explicit pick → undefined so the host default applies", () => {
    expect(resolveSpawnModel(undefined, models)).toBeUndefined();
  });

  it("a whitelisted pick is honoured", () => {
    expect(resolveSpawnModel("deepseek-flash", models)).toBe("deepseek-flash");
  });

  it("a stale pin is dropped instead of 400-ing every message", () => {
    // exactly the 2026-09-10 failure: a persisted default from a previous upstream
    expect(resolveSpawnModel("qwen3.8-flash[1m]", models)).toBeUndefined();
  });

  it("empty whitelist drops any pick (nothing can be validated)", () => {
    expect(resolveSpawnModel("anything", [])).toBeUndefined();
  });
});

describe("currentHostModel (sm switches without a restart)", () => {
  function fileWith(model: string | undefined): { dir: string; file: string } {
    const dir = mkdtempSync(join(tmpdir(), "mgw-host-"));
    const file = join(dir, "settings.json");
    writeFileSync(file, model === undefined ? "{ broken" : JSON.stringify({ env: { ANTHROPIC_MODEL: model } }), "utf8");
    return { dir, file };
  }
  const wipe = (dir: string) => rmSync(dir, { recursive: true, force: true });

  it("reads the host default out of the settings file", () => {
    const { dir, file } = fileWith("kimi-k3[1m]");
    try {
      expect(currentHostModel(file)).toBe("kimi-k3[1m]");
    } finally { wipe(dir); }
  });

  it("re-reads as soon as the file changes (mtime invalidation)", () => {
    const dir = mkdtempSync(join(tmpdir(), "mgw-host-"));
    const file = join(dir, "settings.json");
    try {
      writeFileSync(file, JSON.stringify({ env: { ANTHROPIC_MODEL: "first" } }), "utf8");
      expect(currentHostModel(file)).toBe("first");
      writeFileSync(file, JSON.stringify({ env: { ANTHROPIC_MODEL: "second" } }), "utf8");
      // identical length on purpose: the timestamp alone must be enough
      const later = new Date(Date.now() + 5000);
      utimesSync(file, later, later);
      expect(currentHostModel(file)).toBe("second");
    } finally { wipe(dir); }
  });

  it("a corrupt file yields no host knowledge and does not poison the cache", () => {
    const { dir, file } = fileWith(undefined);
    try {
      expect(currentHostModel(file)).toBeUndefined();
      writeFileSync(file, JSON.stringify({ env: { ANTHROPIC_MODEL: "recovered" } }), "utf8");
      const later = new Date(Date.now() + 5000);
      utimesSync(file, later, later);
      expect(currentHostModel(file)).toBe("recovered");
    } finally { wipe(dir); }
  });

  it("two files never share a cache entry even with identical content", () => {
    const a = fileWith("model-a");
    const b = fileWith("model-b");
    try {
      const stamp = new Date(1_700_000_000_000);
      utimesSync(a.file, stamp, stamp);
      utimesSync(b.file, stamp, stamp);
      expect(currentHostModel(a.file)).toBe("model-a");
      expect(currentHostModel(b.file)).toBe("model-b");
    } finally { wipe(a.dir); wipe(b.dir); }
  });

  it("an unreadable path is simply no host model", () => {
    expect(currentHostModel("/nonexistent/mgw-settings.json")).toBeUndefined();
  });
});

describe("withHostModel", () => {
  const base = [
    { id: "glm-5.3-flash[1m]", name: "GLM 5.3 Flash" },
    { id: "qwen3.8-flash[1m]", name: "Qwen 3.8 Flash" },
  ];

  it("puts the current host model first", () => {
    expect(withHostModel(base, "deepseek-v4-pro[1m]").map((m) => m.id))
      .toEqual(["deepseek-v4-pro[1m]", "glm-5.3-flash[1m]", "qwen3.8-flash[1m]"]);
  });

  it("moves an already-listed model to the front instead of duplicating it", () => {
    expect(withHostModel(base, "qwen3.8-flash[1m]").map((m) => m.id))
      .toEqual(["qwen3.8-flash[1m]", "glm-5.3-flash[1m]"]);
    // its original label survives
    expect(withHostModel(base, "qwen3.8-flash[1m]")[0]?.name).toBe("Qwen 3.8 Flash");
  });

  it("no host model means the configured list unchanged", () => {
    expect(withHostModel(base, undefined)).toBe(base);
    expect(withHostModel(base, "")).toBe(base);
  });
});
