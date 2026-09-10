/**
 * Minimal S0 smoke test: config loads, freezes, and applies env overrides.
 * S1 will replace this placeholder coverage with real suites.
 */
import { describe, expect, it } from "vitest";
import { loadConfig, PROVIDER_ID } from "../../src/config";

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

  it("carries the three-model whitelist with [1m] suffixes", () => {
    const config = loadConfig();
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
