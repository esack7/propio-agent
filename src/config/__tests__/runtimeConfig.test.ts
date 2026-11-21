import { describe, it, expect, beforeEach, afterEach } from "@jest/globals";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import {
  createRuntimeConfigOrigins,
  loadRuntimeConfig,
  loadRuntimeConfigWithOrigins,
} from "../runtimeConfig.js";

describe("RuntimeConfig", () => {
  const originalEnv = process.env;
  const testSettingsDir = path.join(os.tmpdir(), `propio-test-${Date.now()}`);

  beforeEach(() => {
    process.env = { ...originalEnv };
    fs.mkdirSync(testSettingsDir, { recursive: true });
  });

  afterEach(() => {
    process.env = originalEnv;
    fs.rmSync(testSettingsDir, { recursive: true, force: true });
  });

  it("loads defaults when no overrides are provided", () => {
    const config = loadRuntimeConfig();
    expect(config.maxIterations).toBe(50);
    expect(config.maxRetries).toBe(10);
    expect(config.bashDefaultTimeoutMs).toBe(120000);
    expect(config.useNoProgressDetector).toBe(true);
  });

  it("CLI overrides take highest precedence", () => {
    process.env.PROPIO_MAX_ITERATIONS = "100";
    const config = loadRuntimeConfig({
      cliOverrides: { maxIterations: 75 },
    });
    expect(config.maxIterations).toBe(75);
  });

  it("reports the source of every effective setting", () => {
    const settingsPath = path.join(testSettingsDir, "settings.json");
    fs.writeFileSync(
      settingsPath,
      JSON.stringify({
        runtime: {
          maxIterations: 60,
          maxRetries: 12,
          maxRecentTurns: 40,
        },
      }),
    );
    process.env.PROPIO_MAX_ITERATIONS = "70";
    process.env.PROPIO_MAX_RETRIES = "14";

    const resolved = loadRuntimeConfigWithOrigins({
      settingsPath,
      cliOverrides: { maxIterations: 80 },
    });

    expect(resolved.config.maxIterations).toBe(80);
    expect(resolved.origins.maxIterations).toBe("cli");
    expect(resolved.origins.maxRetries).toBe("environment");
    expect(resolved.origins.maxRecentTurns).toBe("settings");
    expect(resolved.origins.artifactRetentionDays).toBe("default");
  });

  it("creates complete origins for application-provided configuration", () => {
    expect(
      createRuntimeConfigOrigins("application", {
        maxIterations: "runtime_change",
      }),
    ).toMatchObject({
      maxIterations: "runtime_change",
      maxRetries: "application",
      allowGlobalInstallsWithoutPrompt: "application",
    });
  });

  it("environment variables override defaults", () => {
    process.env.PROPIO_MAX_ITERATIONS = "100";
    process.env.PROPIO_MAX_RETRIES = "20";
    const config = loadRuntimeConfig();
    expect(config.maxIterations).toBe(100);
    expect(config.maxRetries).toBe(20);
  });

  it("ignores invalid environment variable values", () => {
    process.env.PROPIO_MAX_ITERATIONS = "not-a-number";
    const config = loadRuntimeConfig();
    expect(config.maxIterations).toBe(50); // falls back to default
  });

  it("parses boolean environment variables", () => {
    process.env.PROPIO_USE_NO_PROGRESS_DETECTOR = "false";
    const config = loadRuntimeConfig();
    expect(config.useNoProgressDetector).toBe(false);

    process.env.PROPIO_USE_NO_PROGRESS_DETECTOR = "true";
    const config2 = loadRuntimeConfig();
    expect(config2.useNoProgressDetector).toBe(true);
  });

  it("parses all numeric fields", () => {
    process.env.PROPIO_ARTIFACT_RETENTION_DAYS = "14";
    process.env.PROPIO_COMPACTION_FAILURE_LIMIT = "5";
    const config = loadRuntimeConfig();
    expect(config.artifactRetentionDays).toBe(14);
    expect(config.compactionFailureLimit).toBe(5);
  });

  it("defaults allowGlobalInstallsWithoutPrompt to false", () => {
    delete process.env.PROPIO_ALLOW_GLOBAL_INSTALLS;
    const config = loadRuntimeConfig();
    expect(config.allowGlobalInstallsWithoutPrompt).toBe(false);
  });

  it("parses PROPIO_ALLOW_GLOBAL_INSTALLS=1 as true", () => {
    process.env.PROPIO_ALLOW_GLOBAL_INSTALLS = "1";
    const config = loadRuntimeConfig();
    expect(config.allowGlobalInstallsWithoutPrompt).toBe(true);
  });

  it("honors allowGlobalInstallsWithoutPrompt from settings file", () => {
    const settingsPath = path.join(testSettingsDir, "settings.json");
    fs.writeFileSync(
      settingsPath,
      JSON.stringify({
        runtime: {
          allowGlobalInstallsWithoutPrompt: true,
        },
      }),
    );

    const config = loadRuntimeConfig({ settingsPath });
    expect(config.allowGlobalInstallsWithoutPrompt).toBe(true);
  });
});

describe("trace capture configuration", () => {
  const original = process.env.PROPIO_TRACE_CAPTURE_LEVEL;
  let directory: string;
  let settingsPath: string;
  beforeEach(() => {
    delete process.env.PROPIO_TRACE_CAPTURE_LEVEL;
    directory = fs.mkdtempSync(path.join(os.tmpdir(), "capture-settings-"));
    settingsPath = path.join(directory, "settings.json");
  });
  afterEach(() => {
    if (original === undefined) delete process.env.PROPIO_TRACE_CAPTURE_LEVEL;
    else process.env.PROPIO_TRACE_CAPTURE_LEVEL = original;
    fs.rmSync(directory, { recursive: true, force: true });
  });
  it("resolves CLI > environment > settings > privacy default with origins", () => {
    const read = (cliOverrides = {}) =>
      loadRuntimeConfigWithOrigins({ settingsPath, cliOverrides });
    const expectCapture = (
      value: string,
      origin: string,
      cliOverrides = {},
    ) => {
      const result = read(cliOverrides);
      expect(result.config.traceCaptureLevel).toBe(value);
      expect(result.origins.traceCaptureLevel).toBe(origin);
    };
    expectCapture("standard", "default");
    fs.writeFileSync(
      settingsPath,
      JSON.stringify({
        runtime: { traceCaptureLevel: "full", maxRetries: 8 },
        unrelated: true,
      }),
    );
    expectCapture("full", "settings");
    expect(read().config.maxRetries).toBe(8);
    process.env.PROPIO_TRACE_CAPTURE_LEVEL = "standard";
    expectCapture("standard", "environment");
    expectCapture("full", "cli", { traceCaptureLevel: "full" });
    expect(JSON.parse(fs.readFileSync(settingsPath, "utf8")).unrelated).toBe(
      true,
    );
  });
  it.each(["", "off", "FULL", null, 1])(
    "rejects invalid effective settings: %p",
    (value) => {
      fs.writeFileSync(
        settingsPath,
        JSON.stringify({ runtime: { traceCaptureLevel: value } }),
      );
      expect(() => loadRuntimeConfigWithOrigins({ settingsPath })).toThrow(
        "traceCaptureLevel (settings) must be standard or full",
      );
    },
  );
  it("rejects invalid environment input and allows an explicit CLI override", () => {
    process.env.PROPIO_TRACE_CAPTURE_LEVEL = "off";
    expect(() => loadRuntimeConfigWithOrigins({ settingsPath })).toThrow(
      "environment",
    );
    expect(
      loadRuntimeConfigWithOrigins({
        settingsPath,
        cliOverrides: { traceCaptureLevel: "standard" },
      }).config.traceCaptureLevel,
    ).toBe("standard");
  });
});
