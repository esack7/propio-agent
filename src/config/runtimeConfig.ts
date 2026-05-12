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
};

/**
 * CLI flag overrides (passed in by the index.ts).
 */
export interface CLIOverrides {
  readonly maxIterations?: number;
  readonly maxRetries?: number;
  readonly bashDefaultTimeoutMs?: number;
  readonly streamIdleTimeoutMs?: number;
}

/**
 * Load RuntimeConfig from all sources: CLI > env > settings file > defaults.
 */
export function loadRuntimeConfig(overrides?: {
  cliOverrides?: CLIOverrides;
}): RuntimeConfig {
  const envVars = parseEnvVars();
  const settingsFile = loadSettingsFile();

  const config: { -readonly [K in keyof RuntimeConfig]: RuntimeConfig[K] } = {
    maxIterations:
      overrides?.cliOverrides?.maxIterations ??
      envVars.maxIterations ??
      settingsFile.maxIterations ??
      DEFAULTS.maxIterations,

    maxRetries:
      overrides?.cliOverrides?.maxRetries ??
      envVars.maxRetries ??
      settingsFile.maxRetries ??
      DEFAULTS.maxRetries,

    useNoProgressDetector:
      envVars.useNoProgressDetector ??
      settingsFile.useNoProgressDetector ??
      DEFAULTS.useNoProgressDetector,

    emptyToolOnlyStreakLimit:
      envVars.emptyToolOnlyStreakLimit ??
      settingsFile.emptyToolOnlyStreakLimit ??
      DEFAULTS.emptyToolOnlyStreakLimit,

    bashDefaultTimeoutMs:
      overrides?.cliOverrides?.bashDefaultTimeoutMs ??
      envVars.bashDefaultTimeoutMs ??
      settingsFile.bashDefaultTimeoutMs ??
      DEFAULTS.bashDefaultTimeoutMs,

    bashMaxTimeoutMs:
      envVars.bashMaxTimeoutMs ??
      settingsFile.bashMaxTimeoutMs ??
      DEFAULTS.bashMaxTimeoutMs,

    streamIdleTimeoutMs:
      overrides?.cliOverrides?.streamIdleTimeoutMs ??
      envVars.streamIdleTimeoutMs ??
      settingsFile.streamIdleTimeoutMs ??
      DEFAULTS.streamIdleTimeoutMs,

    maxRecentTurns:
      envVars.maxRecentTurns ??
      settingsFile.maxRecentTurns ??
      DEFAULTS.maxRecentTurns,

    artifactInlineCharCap:
      envVars.artifactInlineCharCap ??
      settingsFile.artifactInlineCharCap ??
      DEFAULTS.artifactInlineCharCap,

    rehydrationMaxChars:
      envVars.rehydrationMaxChars ??
      settingsFile.rehydrationMaxChars ??
      DEFAULTS.rehydrationMaxChars,

    pinnedMemoryMaxContentLength:
      envVars.pinnedMemoryMaxContentLength ??
      settingsFile.pinnedMemoryMaxContentLength ??
      DEFAULTS.pinnedMemoryMaxContentLength,

    toolOutputInlineLimit:
      envVars.toolOutputInlineLimit ??
      settingsFile.toolOutputInlineLimit ??
      DEFAULTS.toolOutputInlineLimit,

    toolOutputPersistThreshold:
      envVars.toolOutputPersistThreshold ??
      settingsFile.toolOutputPersistThreshold ??
      DEFAULTS.toolOutputPersistThreshold,

    aggregateToolResultsLimit:
      envVars.aggregateToolResultsLimit ??
      settingsFile.aggregateToolResultsLimit ??
      DEFAULTS.aggregateToolResultsLimit,

    toolResultSummaryMaxChars:
      envVars.toolResultSummaryMaxChars ??
      settingsFile.toolResultSummaryMaxChars ??
      DEFAULTS.toolResultSummaryMaxChars,

    artifactRetentionDays:
      envVars.artifactRetentionDays ??
      settingsFile.artifactRetentionDays ??
      DEFAULTS.artifactRetentionDays,

    compactionFailureLimit:
      envVars.compactionFailureLimit ??
      settingsFile.compactionFailureLimit ??
      DEFAULTS.compactionFailureLimit,

    outputTokenRecoveryLimit:
      envVars.outputTokenRecoveryLimit ??
      settingsFile.outputTokenRecoveryLimit ??
      DEFAULTS.outputTokenRecoveryLimit,

    consecutive529FallbackLimit:
      envVars.consecutive529FallbackLimit ??
      settingsFile.consecutive529FallbackLimit ??
      DEFAULTS.consecutive529FallbackLimit,

    rollingSummaryTargetTokens:
      envVars.rollingSummaryTargetTokens ??
      settingsFile.rollingSummaryTargetTokens ??
      DEFAULTS.rollingSummaryTargetTokens,
  };

  return config;
}

/**
 * Parse PROPIO_* environment variables into a typed object.
 * Invalid values are silently ignored (fallback to next source in precedence).
 */
function parseEnvVars(): Record<keyof RuntimeConfig, any> {
  const result: Record<string, any> = {};

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

  return result as Record<keyof RuntimeConfig, any>;
}

/**
 * Load settings from ~/.propio/settings.json, specifically the runtime object.
 */
function loadSettingsFile(): Record<keyof RuntimeConfig, any> {
  try {
    const settingsPath = path.join(os.homedir(), ".propio", "settings.json");
    if (!fs.existsSync(settingsPath)) {
      return {} as Record<keyof RuntimeConfig, any>;
    }

    const content = fs.readFileSync(settingsPath, "utf-8");
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
    } as Record<keyof RuntimeConfig, any>;
  } catch (error) {
    return {} as Record<keyof RuntimeConfig, any>;
  }
}
