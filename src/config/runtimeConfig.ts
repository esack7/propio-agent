import * as fs from "fs";
import * as path from "path";
import * as os from "os";

/**
 * RuntimeConfig: Single source of truth for all operational limits.
 * Merges (in precedence): CLI flags > env vars > ~/.propio/settings.json > in-code defaults.
 *
 * Environment variable naming convention: PROPIO_* (e.g., PROPIO_MAX_ITERATIONS).
 */
export interface RuntimeConfig {
  // Iteration and loop control
  readonly maxIterations: number;
  readonly maxRetries: number;
  readonly useNoProgressDetector: boolean;
  readonly emptyToolOnlyStreakLimit: number;

  // Timeouts
  readonly bashDefaultTimeoutMs: number;
  readonly bashMaxTimeoutMs: number;
  readonly streamIdleTimeoutMs: number;

  // Context and artifact caps
  readonly maxRecentTurns: number;
  readonly artifactInlineCharCap: number;
  readonly rehydrationMaxChars: number;
  readonly pinnedMemoryMaxContentLength: number;

  // Tool output persistence and retention
  readonly toolOutputInlineLimit: number;
  readonly toolOutputPersistThreshold: number;
  readonly aggregateToolResultsLimit: number;
  readonly toolResultSummaryMaxChars: number;
  readonly artifactRetentionDays: number;

  // Circuit breakers and recovery
  readonly compactionFailureLimit: number;
  readonly outputTokenRecoveryLimit: number;
  readonly consecutive529FallbackLimit: number;

  // Summary configuration
  readonly rollingSummaryTargetTokens: number;

  // Safety gates
  readonly allowGlobalInstallsWithoutPrompt: boolean;
}

export type RuntimeConfigSource =
  | "default"
  | "settings"
  | "environment"
  | "cli"
  | "application"
  | "runtime_change";

export type RuntimeConfigOrigins = {
  readonly [K in keyof RuntimeConfig]: RuntimeConfigSource;
};

export interface ResolvedRuntimeConfig {
  readonly config: RuntimeConfig;
  readonly origins: RuntimeConfigOrigins;
}

/**
 * Default configuration values.
 */
const DEFAULTS: RuntimeConfig = {
  maxIterations: 50,
  maxRetries: 10,
  useNoProgressDetector: true,
  emptyToolOnlyStreakLimit: 3,

  bashDefaultTimeoutMs: 120000,
  bashMaxTimeoutMs: 600000,
  streamIdleTimeoutMs: 90000,

  maxRecentTurns: 50,
  artifactInlineCharCap: 12000,
  rehydrationMaxChars: 12000,
  pinnedMemoryMaxContentLength: 2000,

  toolOutputInlineLimit: 50 * 1024,
  toolOutputPersistThreshold: 100 * 1024,
  aggregateToolResultsLimit: 500 * 1024,
  toolResultSummaryMaxChars: 1500,
  artifactRetentionDays: 7,

  compactionFailureLimit: 3,
  outputTokenRecoveryLimit: 3,
  consecutive529FallbackLimit: 3,

  rollingSummaryTargetTokens: 2048,

  allowGlobalInstallsWithoutPrompt: false,
};

const RUNTIME_CONFIG_KEYS = [
  "maxIterations",
  "maxRetries",
  "useNoProgressDetector",
  "emptyToolOnlyStreakLimit",
  "bashDefaultTimeoutMs",
  "bashMaxTimeoutMs",
  "streamIdleTimeoutMs",
  "maxRecentTurns",
  "artifactInlineCharCap",
  "rehydrationMaxChars",
  "pinnedMemoryMaxContentLength",
  "toolOutputInlineLimit",
  "toolOutputPersistThreshold",
  "aggregateToolResultsLimit",
  "toolResultSummaryMaxChars",
  "artifactRetentionDays",
  "compactionFailureLimit",
  "outputTokenRecoveryLimit",
  "consecutive529FallbackLimit",
  "rollingSummaryTargetTokens",
  "allowGlobalInstallsWithoutPrompt",
] as const satisfies ReadonlyArray<keyof RuntimeConfig>;

/**
 * CLI flag overrides (passed in by the index.ts).
 */
export interface CLIOverrides {
  readonly maxIterations?: number;
  readonly maxRetries?: number;
  readonly bashDefaultTimeoutMs?: number;
  readonly streamIdleTimeoutMs?: number;
}

type ConfigSourceValues = Partial<Record<keyof RuntimeConfig, unknown>>;

function resolveConfigValue<K extends keyof RuntimeConfig>(
  key: K,
  cliValues: ConfigSourceValues,
  envValues: ConfigSourceValues,
  settingsValues: ConfigSourceValues,
): { readonly value: RuntimeConfig[K]; readonly source: RuntimeConfigSource } {
  const cliValue = cliValues[key];
  if (cliValue !== undefined) {
    return { value: cliValue as RuntimeConfig[K], source: "cli" };
  }

  const envValue = envValues[key];
  if (envValue !== undefined) {
    return { value: envValue as RuntimeConfig[K], source: "environment" };
  }

  const settingsValue = settingsValues[key];
  if (settingsValue !== undefined) {
    return { value: settingsValue as RuntimeConfig[K], source: "settings" };
  }

  return { value: DEFAULTS[key], source: "default" };
}

export function createRuntimeConfigOrigins(
  source: RuntimeConfigSource,
  overrides: Partial<RuntimeConfigOrigins> = {},
): RuntimeConfigOrigins {
  return Object.fromEntries(
    RUNTIME_CONFIG_KEYS.map((key) => [key, overrides[key] ?? source]),
  ) as RuntimeConfigOrigins;
}

/**
 * Load RuntimeConfig from all sources: CLI > env > settings file > defaults.
 */
export function loadRuntimeConfigWithOrigins(overrides?: {
  cliOverrides?: CLIOverrides;
  settingsPath?: string;
}): ResolvedRuntimeConfig {
  const envVars = parseEnvVars();
  const settingsFile = loadSettingsFile(overrides?.settingsPath);
  const cliValues = overrides?.cliOverrides ?? {};
  const resolved = RUNTIME_CONFIG_KEYS.map(
    (key) =>
      [key, resolveConfigValue(key, cliValues, envVars, settingsFile)] as const,
  );

  return {
    config: Object.fromEntries(
      resolved.map(([key, entry]) => [key, entry.value]),
    ) as unknown as RuntimeConfig,
    origins: Object.fromEntries(
      resolved.map(([key, entry]) => [key, entry.source]),
    ) as RuntimeConfigOrigins,
  };
}

/** Load only the effective RuntimeConfig values for backward compatibility. */
export function loadRuntimeConfig(overrides?: {
  cliOverrides?: CLIOverrides;
  settingsPath?: string;
}): RuntimeConfig {
  return loadRuntimeConfigWithOrigins(overrides).config;
}

/**
 * Parse PROPIO_* environment variables into a typed object.
 * Invalid values are silently ignored (fallback to next source in precedence).
 */
function parseEnvVars(): ConfigSourceValues {
  const result: Record<string, unknown> = {};

  const parseNum = (env: string): number | undefined => {
    const val = process.env[env];
    if (!val) return undefined;
    const num = Number.parseInt(val, 10);
    return isNaN(num) ? undefined : num;
  };

  const parseBoolean = (env: string): boolean | undefined => {
    const val = process.env[env];
    if (!val) return undefined;
    return val === "true" || val === "1";
  };

  result.maxIterations = parseNum("PROPIO_MAX_ITERATIONS");
  result.maxRetries = parseNum("PROPIO_MAX_RETRIES");
  result.useNoProgressDetector = parseBoolean(
    "PROPIO_USE_NO_PROGRESS_DETECTOR",
  );
  result.emptyToolOnlyStreakLimit = parseNum(
    "PROPIO_EMPTY_TOOL_ONLY_STREAK_LIMIT",
  );
  result.bashDefaultTimeoutMs = parseNum("PROPIO_BASH_DEFAULT_TIMEOUT_MS");
  result.bashMaxTimeoutMs = parseNum("PROPIO_BASH_MAX_TIMEOUT_MS");
  result.streamIdleTimeoutMs = parseNum("PROPIO_STREAM_IDLE_TIMEOUT_MS");
  result.maxRecentTurns = parseNum("PROPIO_MAX_RECENT_TURNS");
  result.artifactInlineCharCap = parseNum("PROPIO_ARTIFACT_INLINE_CHAR_CAP");
  result.rehydrationMaxChars = parseNum("PROPIO_REHYDRATION_MAX_CHARS");
  result.pinnedMemoryMaxContentLength = parseNum(
    "PROPIO_PINNED_MEMORY_MAX_CONTENT_LENGTH",
  );
  result.toolOutputInlineLimit = parseNum("PROPIO_TOOL_OUTPUT_INLINE_LIMIT");
  result.toolOutputPersistThreshold = parseNum(
    "PROPIO_TOOL_OUTPUT_PERSIST_THRESHOLD",
  );
  result.aggregateToolResultsLimit = parseNum(
    "PROPIO_AGGREGATE_TOOL_RESULTS_LIMIT",
  );
  result.toolResultSummaryMaxChars = parseNum(
    "PROPIO_TOOL_RESULT_SUMMARY_MAX_CHARS",
  );
  result.artifactRetentionDays = parseNum("PROPIO_ARTIFACT_RETENTION_DAYS");
  result.compactionFailureLimit = parseNum("PROPIO_COMPACTION_FAILURE_LIMIT");
  result.outputTokenRecoveryLimit = parseNum(
    "PROPIO_OUTPUT_TOKEN_RECOVERY_LIMIT",
  );
  result.consecutive529FallbackLimit = parseNum(
    "PROPIO_CONSECUTIVE_529_FALLBACK_LIMIT",
  );
  result.rollingSummaryTargetTokens = parseNum(
    "PROPIO_ROLLING_SUMMARY_TARGET_TOKENS",
  );
  result.allowGlobalInstallsWithoutPrompt = parseBoolean(
    "PROPIO_ALLOW_GLOBAL_INSTALLS",
  );

  return result;
}

/**
 * Load settings from ~/.propio/settings.json, specifically the runtime object.
 */
function loadSettingsFile(settingsPath?: string): ConfigSourceValues {
  try {
    const resolvedSettingsPath =
      settingsPath ?? path.join(os.homedir(), ".propio", "settings.json");
    if (!fs.existsSync(resolvedSettingsPath)) {
      return {};
    }

    const content = fs.readFileSync(resolvedSettingsPath, "utf-8");
    const json = JSON.parse(content);
    const runtime = json.runtime ?? {};

    return {
      maxIterations: runtime.maxIterations,
      maxRetries: runtime.maxRetries,
      useNoProgressDetector: runtime.useNoProgressDetector,
      emptyToolOnlyStreakLimit: runtime.emptyToolOnlyStreakLimit,
      bashDefaultTimeoutMs: runtime.bashDefaultTimeoutMs,
      bashMaxTimeoutMs: runtime.bashMaxTimeoutMs,
      streamIdleTimeoutMs: runtime.streamIdleTimeoutMs,
      maxRecentTurns: runtime.maxRecentTurns,
      artifactInlineCharCap: runtime.artifactInlineCharCap,
      rehydrationMaxChars: runtime.rehydrationMaxChars,
      pinnedMemoryMaxContentLength: runtime.pinnedMemoryMaxContentLength,
      toolOutputInlineLimit: runtime.toolOutputInlineLimit,
      toolOutputPersistThreshold: runtime.toolOutputPersistThreshold,
      aggregateToolResultsLimit: runtime.aggregateToolResultsLimit,
      toolResultSummaryMaxChars: runtime.toolResultSummaryMaxChars,
      artifactRetentionDays: runtime.artifactRetentionDays,
      compactionFailureLimit: runtime.compactionFailureLimit,
      outputTokenRecoveryLimit: runtime.outputTokenRecoveryLimit,
      consecutive529FallbackLimit: runtime.consecutive529FallbackLimit,
      rollingSummaryTargetTokens: runtime.rollingSummaryTargetTokens,
      allowGlobalInstallsWithoutPrompt:
        runtime.allowGlobalInstallsWithoutPrompt,
    };
  } catch (error) {
    return {};
  }
}
