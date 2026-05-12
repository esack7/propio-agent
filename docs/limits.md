# Limits and Caps Reference

A catalog of every limit, cap, retry budget, and timeout in propio-agent, grouped by what each one protects against. Line numbers reflect the state of the repo at the time of writing — verify against current source before relying on them.

## Agentic loop limits (`src/agent.ts`)

The most important set — these bound how long the model can spin within a single user turn. All values are now runtime-configurable via env vars, `~/.propio/settings.json`, or CLI flags (see `src/config/runtimeConfig.ts`).

| Knob | Default | Override | Purpose |
| --- | --- | --- | --- |
| `maxIterations` | `50` | `PROPIO_MAX_ITERATIONS` / `--max-iterations` | Hard cap on tool-call rounds per user turn. Emits `max_iterations_reached` diagnostic when hit. |
| no-progress detector | enabled | `runtimeConfig.useNoProgressDetector` | Exits the loop when the same tool call (same name + identical args) repeats ≥ 3 times with no new artifacts or assistant text. Fallback: `MAX_EMPTY_TOOL_ONLY_STREAK` (authoritative only when detector is disabled). |
| `MAX_CONTEXT_RETRY_LEVEL` | `3` | — | Escalation levels for re-trimming context on token-limit errors; level 3 now triggers a `context_pressure_circuit_breaker` abort instead of erasing all turns. |
| `MAX_VISIBILITY_PREVIEW_CHARS` | `120` | — | Truncation cap for tool-arg previews in activity output (display only). |

## Provider-level retries

All providers use the shared `withRetry` helper (`src/providers/withRetry.ts`) to retry transient pre-stream failures with exponential back-off + full jitter. Mid-stream failures and post-emission failures are not auto-retried.

| Provider | Retryable conditions | Extra behavior |
| --- | --- | --- |
| OpenRouter | Any `ProviderError` except auth / not-found / context-length | On final retry, drops tools from request (`onFinalRetry`) |
| Bedrock | `ThrottlingException`, `ServiceUnavailableException`, `InternalServerException` | — |
| xAI / Gemini / Ollama | Provider-specific rate-limit / server errors | — |

`maxRetries` (default 3) and `consecutive529Limit` (default 3) are configurable via `runtimeConfig`.

## Tool execution limits

### `bash` tool — `src/tools/bash.ts`

| Knob | Default | Override |
| --- | --- | --- |
| `defaultTimeoutMs` | `120000` ms (2 min) | `PROPIO_BASH_DEFAULT_TIMEOUT_MS` |
| `maxTimeoutMs` | `600000` ms (10 min) | `PROPIO_BASH_MAX_TIMEOUT_MS` |
| `toolOutputInlineLimit` | `50 KB` | `PROPIO_TOOL_OUTPUT_INLINE_LIMIT` |

Outputs exceeding `toolOutputPersistThreshold` are persisted to a per-session artifacts directory by the agent layer; the tool result contains a structured preview + absolute path for re-reading via the `read` tool.

### Other tools

| Tool | Inline limit | Notes |
| --- | --- | --- |
| `read` | `toolOutputInlineLimit` (50 KB default) | Supports line-based (`startLine`/`lineCount`) and byte-based (`offset`/`limit`) slicing for large files. `limit` is capped to `toolOutputInlineLimit`. |
| `grep` | `toolOutputInlineLimit` (50 KB default) | — |

## Context / prompt building (`src/context/`)

| Knob | Default | Override | Purpose |
| --- | --- | --- | --- |
| `toolResultSummaryMaxChars` | `1500` | `PROPIO_TOOL_RESULT_SUMMARY_MAX_CHARS` | Per-tool-result summary text cap. |
| `rehydrationMaxChars` | `12000` | `PROPIO_REHYDRATION_MAX_CHARS` | Cap on inlined tool artifact content pulled back into the prompt. Passed through `PromptBuildRequest` — no longer hardcoded in `promptBuilder.ts`. |
| `maxRecentTurns` | `50` | `PROPIO_MAX_RECENT_TURNS` | Turn-window limit; each retry level shrinks it further. Wired into `buildPlan()`. |
| `artifactInlineCharCap` | `12000` | `PROPIO_ARTIFACT_INLINE_CHAR_CAP` | Per-artifact inline size cap. Wired into `buildPlan()`. |
| `rollingSummaryTargetTokens` | `2048` | `PROPIO_ROLLING_SUMMARY_TARGET_TOKENS` | Soft token cap for generated rolling summaries. |
| `pinnedMemoryMaxContentLength` | `2000` | `PROPIO_PINNED_MEMORY_MAX_CONTENT_LENGTH` | Per-entry size cap for pinned memory. |

## MCP (`src/mcp/manager.ts`)

| Constant | Value | Purpose |
| --- | --- | --- |
| `DEFAULT_CONNECT_TIMEOUT_MS` | `10_000` | Time to wait for an MCP server to start (line 26). |
| `CLEANUP_TIMEOUT_MS` | `500` | Graceful shutdown window (line 27). |
| `MAX_STDERR_TAIL_CHARS` | `4000` | Buffer cap on captured stderr from MCP child processes (line 28). |

## UI / file search

| Constant | Value | Location | Purpose |
| --- | --- | --- | --- |
| `PROMPT_HISTORY_LIMIT` | `200` | `ui/promptComposer.ts:69`, `ui/promptHistory.ts:19` | Saved prompt history depth. |
| Markdown render throttle | `~80 ms` | `ui/markdownRenderer.ts:390` | Batches streaming tokens to avoid render starvation. |
| `MAX_DIRECTORY_ENTRIES` | `1000` | `fileSearch/attachmentResolver.ts:19` | Cap on directory expansion in `@`-mentions. |
| `REFRESH_THROTTLE_MS` | `5000` | `fileSearch/fileSearchIndex.ts:27` | Minimum gap between file-index refreshes. |
| `MAX_SKILL_DISCOVERY_CHARS` | `3000` | `skills/discovery.ts:3` | Cap on skill-metadata text added to the system prompt. |

## Tuning notes

If a real run is misbehaving, the dial that matters most is **`maxIterations`** — raise it with `PROPIO_MAX_ITERATIONS=100` or `--max-iterations 100`. The tool output inline limit and persist threshold are the next most common tuning points (`PROPIO_TOOL_OUTPUT_INLINE_LIMIT`, `PROPIO_TOOL_OUTPUT_PERSIST_THRESHOLD`). All knobs listed above accept env-var overrides without a code edit.
