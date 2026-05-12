import { describe, it, expect, beforeEach, afterEach } from "@jest/globals";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { loadRuntimeConfig, CLIOverrides } from "../runtimeConfig.js";

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
});
