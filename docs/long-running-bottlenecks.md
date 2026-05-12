# Long-Running Operation: Bottlenecks and Hot Spots

An analysis of what would constrain propio-agent from successfully solving problems that require long-running, multi-step processes. Line numbers reflect the state of the repo at the time of writing — verify against current source before relying on them. See also `docs/limits.md` for the raw catalog of caps and constants.

## Showstoppers

### 1. `maxIterations` — default raised to 50, now configurable

~~`maxIterations = 10` (`src/agent.ts:1385`)~~ — **Fixed.** Default is now 50; overridable via `PROPIO_MAX_ITERATIONS` env var or `--max-iterations` CLI flag. No code edit required.

### 2. No-progress detector replaces blunt streak heuristic

~~`MAX_EMPTY_TOOL_ONLY_STREAK = 3`~~ — **Replaced.** The new no-progress detector (`detectNoProgress` in `src/agent.ts`) exits the loop only when the same tool + identical args repeats ≥ 3 times with no assistant text in the lookback window. Artifact IDs are intentionally not compared: every tool invocation creates a new artifact ID regardless of content, so artifact-ID comparison cannot distinguish genuine progress from a stuck loop — the args-key fingerprint is the sole signal. Models that read multiple different files silently (`read fileA`, `read fileB`, `read fileC`) are no longer misclassified as stuck. The old streak heuristic remains as a fallback when `runtimeConfig.useNoProgressDetector = false`.

## Context Loss Over Time

### 3. Retry-level cliff — deleted

~~`src/context/promptBuilder.ts:65-69`~~ — **Fixed.** The level-3 `(0, 0)` policy (erase all turns and artifacts) has been removed. `RETRY_LEVELS` now has three entries (0–2). At `MAX_CONTEXT_RETRY_LEVEL=3` the agent emits a `context_pressure_circuit_breaker` diagnostic and aborts the turn cleanly instead of destroying working state.

### 4. `SUMMARY_MAX_CHARS` — configurable; rolling summary improved

~~`SUMMARY_MAX_CHARS = 1500`~~ — Now configurable as `toolResultSummaryMaxChars` (env: `PROPIO_TOOL_RESULT_SUMMARY_MAX_CHARS`). Default unchanged at 1500 (this cap controls per-tool-result text, not long-term memory). The rolling summary's token budget (`rollingSummaryTargetTokens`) is now configurable (default 2048, env: `PROPIO_ROLLING_SUMMARY_TARGET_TOKENS`) and the serializer is hardened against blind clipping. Pinned memory per-entry cap raised to 2000 chars.

### 5. Recent-turn and artifact caps — now configurable and wired

~~Hardcoded defaults~~ — **Fixed.** `maxRecentTurns`, `artifactInlineCharCap`, and `rehydrationMaxChars` are now read from `runtimeConfig` and passed into `buildPlan()` on every call. `rehydrationMaxChars` is also threaded through `PromptBuildRequest` so `promptBuilder.ts` no longer uses the hardcoded 12000 constant. All three accept `PROPIO_*` env-var overrides.

## Tool-Output Blindness

### 6. 50 KB silent truncation — replaced with persistence

~~Silent truncation in `bash.ts`, `read.ts`, `grep.ts`~~ — **Fixed.** The agent layer now persists large outputs to a per-session artifacts directory (`src/tools/outputPersistence.ts`). The model receives a structured preview with the absolute path and slicing params. The `read` tool now supports `startLine`/`lineCount` (line-based) and `offset`/`limit` (byte-based) slicing with proper validation; byte `limit` is capped to `toolOutputInlineLimit`. Silent `truncateText` calls have been removed from tool result paths.

### 7. `bash` default timeout — raised to 120 s, configurable

~~30 s default~~ — **Fixed.** Default is now 120 s (2 min); hard max 600 s (10 min). Configurable via `PROPIO_BASH_DEFAULT_TIMEOUT_MS` / `PROPIO_BASH_MAX_TIMEOUT_MS`.

## Recovery and Robustness

### 8. No mid-turn checkpointing

Session snapshots happen on `/exit`. A crash, a fatal provider error, or an unrecoverable context error mid-iteration loses all tool work since the last user message.

### 9. Provider retries — general `withRetry` across all providers

~~OpenRouter-only bespoke retry~~ — **Fixed.** All five providers now use the shared `withRetry` helper (`src/providers/withRetry.ts`) with exponential back-off + full jitter. OpenRouter retries on any transient `ProviderError` (not just when tools are present) and drops tools on the final attempt. Bedrock retries on `ThrottlingException`, `ServiceUnavailableException`, and `InternalServerException`. `maxRetries` and `consecutive529Limit` are configurable via `runtimeConfig`.

### 10. Background summary can lose the race

`scheduleSummaryRefresh` is best-effort; the synchronous-shrink path (`src/agent.ts:782`) is the only safety net, and it only fires on a `ProviderContextLengthError` after the request already failed.

## Status

Items 1–7 and 9–10 are implemented. Item 8 (mid-turn checkpointing) is deferred pending telemetry — a crash-marker probe measures whether mid-turn crashes are frequent enough to justify a full autosave subsystem. See `docs/long-running-bottlenecks-plan.md` §Phase 7 for the rationale.
