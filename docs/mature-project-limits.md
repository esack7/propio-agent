# Mature Project Limits Reference

This document catalogs where a mature agentic CLI project sets limits, caps, retry budgets, and timeout guards. It is intended as comparison material and design direction for propio-agent.

Source path references are relative to the Mature Project repository, not to propio-agent.

## Main Limit Layers

The mature project does not keep every limit in one file. The important limits are layered across the agent loop, API retry logic, tool orchestration, tool result storage, context compaction, remote transports, and individual tools.

| Area | Location | What It Controls |
| --- | --- | --- |
| Agent loop | `src/query.ts` | Max turns, output-token recovery, token-budget continuation, stop-hook retry flow, recursive tool-result loop. |
| CLI options | `src/main.tsx` | User-facing options such as `--max-turns`, `--max-budget-usd`, `--task-budget`, and max thinking tokens. |
| API retries | `src/services/api/withRetry.ts` | Retry count, 529 fallback behavior, retry delays, persistent unattended retry mode. |
| Tool orchestration | `src/services/tools/toolOrchestration.ts` | Parallel vs serial tool execution and max concurrent safe tools. |
| Tool result size | `src/constants/toolLimits.ts` | Per-result and aggregate result caps before persisting or previewing output. |
| Context compaction | `src/services/compact/autoCompact.ts`, `src/services/compact/compact.ts` | Auto-compact thresholds, compaction retry budgets, circuit breakers. |
| API streaming | `src/services/api/claude.ts` | Non-streaming fallback timeout and optional stream idle watchdog. |
| Tool-specific limits | `src/tools/*`, `src/utils/*` | Bash timeouts, file-read caps, web-fetch limits, media limits, output persistence. |
| Remote sessions | `src/remote/SessionsWebSocket.ts` | WebSocket reconnect attempts and transient session-not-found retry budget. |

## Agent Loop Limits

The core behavior is bounded in `src/query.ts`.

| Limit | Value / Source | Purpose |
| --- | --- | --- |
| `maxTurns` | Passed via `QueryParams`; exposed in non-interactive mode through `--max-turns` | Caps how many agentic tool-call rounds can happen before returning `max_turns_reached`. |
| `MAX_OUTPUT_TOKENS_RECOVERY_LIMIT` | `3` | Allows up to three recovery continuations after `max_output_tokens` before surfacing the error. |
| Output-token escalation | Escalates once to `ESCALATED_MAX_TOKENS` when enabled and no explicit `CLAUDE_CODE_MAX_OUTPUT_TOKENS` is set | Gives one larger-output retry before using multi-turn recovery. |
| Stop-hook retry guard | `stopHookActive` and preserved reactive-compact guard | Prevents infinite loops such as compact -> still too long -> stop-hook blocking -> compact again. |
| Token-budget continuation | `src/query/tokenBudget.ts` | Continues while below 90% of budget, but stops on diminishing returns after repeated low-token progress. |

Notably, there does not appear to be a simple "same tool may only run N times" counter. Repeated tool use is mostly bounded by `maxTurns`, permissions, stop-hook guards, and prompt instructions.

## API Retry Limits

API retry behavior is concentrated in `src/services/api/withRetry.ts`.

| Limit | Value / Override | Purpose |
| --- | --- | --- |
| Default API retries | `10` | General retry budget for retryable API failures. |
| Override | `CLAUDE_CODE_MAX_RETRIES` | Environment override for default retry count. |
| Consecutive 529 fallback | `3` | After repeated overloads, may trigger fallback model behavior or stop with repeated-overload messaging. |
| Base retry delay | `500ms` | Exponential backoff base. |
| Normal retry delay cap | `32s` | Default maximum delay for standard retries. |
| Persistent retry max backoff | `5min` | Used by unattended retry mode. |
| Persistent reset cap | `6hr` | Caps long retry waits in persistent mode. |
| Persistent heartbeat interval | `30s` | Emits keep-alive progress while waiting. |

Retryable errors include connection errors, selected 5xx statuses, 408, 409, some 401/403 auth-refresh cases, and 429 depending on subscriber/enterprise state. Non-foreground 529s intentionally do not amplify retries.

## Streaming And Fallback Timeouts

`src/services/api/claude.ts` adds request-level and stream-level safety.

| Limit | Value / Override | Purpose |
| --- | --- | --- |
| Non-streaming fallback timeout | `300s` default | Prevents fallback requests from hanging indefinitely. |
| Remote non-streaming timeout | `120s` | Keeps remote sessions below container idle-kill windows. |
| Timeout override | `API_TIMEOUT_MS` | Applies to API request timeout behavior. |
| Stream idle watchdog | `90s` default when enabled | Aborts streams that stop yielding chunks. |
| Watchdog envs | `CLAUDE_ENABLE_STREAM_WATCHDOG`, `CLAUDE_STREAM_IDLE_TIMEOUT_MS` | Enable and tune idle stream aborts. |

## Tool Execution Limits

Tool scheduling is handled in `src/services/tools/toolOrchestration.ts`.

| Limit | Value / Override | Purpose |
| --- | --- | --- |
| Max safe-tool concurrency | `10` default | Caps concurrent execution of read-only/concurrency-safe tool batches. |
| Override | `CLAUDE_CODE_MAX_TOOL_USE_CONCURRENCY` | Tunes parallel tool execution. |
| Serial execution | One non-safe tool at a time | Prevents write-like tools from racing each other. |

Tools mark themselves concurrency-safe through `isConcurrencySafe()`. Consecutive safe tool calls can be batched; non-safe tools split the batch.

## Tool Result Size Limits

General result caps live in `src/constants/toolLimits.ts`.

| Limit | Value | Purpose |
| --- | --- | --- |
| `DEFAULT_MAX_RESULT_SIZE_CHARS` | `50,000` chars | Default cap before large results are persisted and previewed. |
| `MAX_TOOL_RESULT_TOKENS` | `100,000` tokens | Upper bound for individual tool results. |
| `MAX_TOOL_RESULT_BYTES` | `400,000` bytes | Derived from token cap at 4 bytes/token. |
| `MAX_TOOL_RESULTS_PER_MESSAGE_CHARS` | `200,000` chars | Aggregate cap for one user message containing multiple tool results. |
| `TOOL_SUMMARY_MAX_LENGTH` | `50` chars | Display summary truncation. |

This is a useful mature-project pattern: large output is not merely truncated; it can be persisted to disk and replaced with a structured preview/path so the model can read narrower portions later.

## Bash And Shell Limits

Bash limits are split across `src/utils/timeouts.ts`, `src/tools/BashTool/BashTool.tsx`, `src/utils/Shell.ts`, and task-output helpers.

| Limit | Value / Override | Purpose |
| --- | --- | --- |
| Bash default timeout | `120,000ms` | Default tool-facing bash timeout. |
| Bash max timeout | `600,000ms` | Max tool-facing timeout. |
| Timeout overrides | `BASH_DEFAULT_TIMEOUT_MS`, `BASH_MAX_TIMEOUT_MS` | Environment tuning. |
| Lower-level shell default | `30min` | Fallback shell execution timeout in `src/utils/Shell.ts`. |
| Assistant blocking budget | `15s` | Long blocking bash commands in assistant mode can be auto-backgrounded. |
| Blocked leading sleep | `sleep N` where `N >= 2` | Nudges the model toward background/monitor behavior instead of passive polling. |
| Inline bash output default | `30,000` chars | Controlled by `BASH_MAX_OUTPUT_LENGTH`, with upper cap in shell output helpers. |
| Background task disk cap | `5GB` | Kills background command output that grows beyond disk cap. |
| Persisted large bash output | `64MB` max copied artifact | Large output can be stored for later reading. |

## File, Web, And Media Limits

| Area | Limit | Location |
| --- | --- | --- |
| File read output tokens | `25,000` default; env override `CLAUDE_CODE_FILE_READ_MAX_OUTPUT_TOKENS` | `src/tools/FileReadTool/limits.ts` |
| File read size gate | `0.25MB` default via `MAX_OUTPUT_SIZE` | `src/utils/file.ts`, `src/tools/FileReadTool/limits.ts` |
| Glob result count | `100` default | `src/tools/GlobTool/GlobTool.ts` |
| Web fetch cache | `15min` TTL, `50MB` LRU | `src/tools/WebFetchTool/utils.ts` |
| Web fetch URL length | `2,000` chars | `src/tools/WebFetchTool/utils.ts` |
| Web fetch content length | `10MB` | `src/tools/WebFetchTool/utils.ts` |
| Image base64 limit | `5MB` | `src/constants/apiLimits.ts` |
| Image dimensions | `2000 x 2000` client-side resize target | `src/constants/apiLimits.ts` |
| PDF raw target | `20MB` | `src/constants/apiLimits.ts` |
| PDF pages | `100` API cap; `20` pages per read | `src/constants/apiLimits.ts` |
| Media per API request | `100` | `src/constants/apiLimits.ts` |

## Context And Compaction Limits

Compaction limits make long sessions survivable and prevent doomed retry loops.

| Limit | Value | Location |
| --- | --- | --- |
| Auto-compact buffer | `13,000` tokens | `src/services/compact/autoCompact.ts` |
| Warning / error threshold buffers | `20,000` tokens | `src/services/compact/autoCompact.ts` |
| Manual compact buffer | `3,000` tokens | `src/services/compact/autoCompact.ts` |
| Consecutive autocompact failures | `3` | Circuit breaker to stop repeated failed compaction attempts. |
| Compact streaming retries | `2` when feature-enabled, otherwise `1` attempt | `src/services/compact/compact.ts` |
| Compact max output tokens | `20,000` | `src/utils/context.ts`, used by compaction. |

## Remote And Structured IO Limits

| Limit | Value | Location |
| --- | --- | --- |
| WebSocket reconnect delay | `2s` | `src/remote/SessionsWebSocket.ts` |
| WebSocket reconnect attempts | `5` | `src/remote/SessionsWebSocket.ts` |
| Session-not-found retries | `3` | Handles transient stale-session windows during compaction. |
| Ping interval | `30s` | `src/remote/SessionsWebSocket.ts` |
| Resolved tool-use IDs cache | `1,000` | `src/cli/structuredIO.ts` |

The resolved tool-use ID cache exists to ignore duplicate control responses after reconnects or delayed permission responses. This is not a model-behavior limit, but it prevents duplicated tool execution and duplicate `tool_use` IDs from corrupting conversation state.

## Repeated Tool Calls

The mature project does not appear to enforce a direct per-tool repetition counter like "Bash may only be called five times." Instead, it combines several softer and harder controls:

- `maxTurns` caps the recursive model -> tool -> model loop.
- Tool permissions can reject or require approval.
- The system prompt instructs the model not to repeat the exact same denied tool call.
- Duplicate SDK/control responses are deduped so transport retries do not re-run tools.
- Stop-hook and compaction guards avoid API/tool retry death spirals.
- Tool result size and output persistence keep repeated large outputs from flooding context.

## Direction For Propio

The clearest mature-project pattern is layered defense:

- Keep a simple agentic loop cap, like Propio's `maxIterations`.
- Add retry budgets at every external boundary: provider calls, MCP connections, web fetch, remote transports.
- Treat tool output as a bounded resource: cap inline content, persist large results, and give the model a path to read narrower slices.
- Add circuit breakers around recovery paths such as compaction and stop-hook retries.
- Prefer explicit environment/config overrides for operational tuning, while keeping safe defaults in code.
- Deduplicate transport-level responses separately from model-level loop limits.

