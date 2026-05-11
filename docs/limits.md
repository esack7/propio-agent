# Limits and Caps Reference

A catalog of every limit, cap, retry budget, and timeout in propio-agent, grouped by what each one protects against. Line numbers reflect the state of the repo at the time of writing — verify against current source before relying on them.

## Agentic loop limits (`src/agent.ts`)

The most important set — these bound how long the model can spin within a single user turn.

| Constant | Value | Location | Purpose |
| --- | --- | --- | --- |
| `maxIterations` | `10` | `src/agent.ts:1385` | Hard cap on tool-call rounds per user turn. When hit, emits a `max_iterations_reached` diagnostic and exits the loop. |
| `MAX_EMPTY_TOOL_ONLY_STREAK` | `3` | `src/agent.ts:143` | Breaks the loop if the model returns tool calls only (no text) three turns in a row. Detects "stuck in tool-spam" behavior. |
| `MAX_CONTEXT_RETRY_LEVEL` | `3` | `src/agent.ts:145` | Escalation levels available to `PromptBuilder` for re-trimming context after a token-limit error (used at `agent.ts:967`, `1025`, `1422`). |
| `MAX_VISIBILITY_PREVIEW_CHARS` | `120` | `src/agent.ts:144` | Truncation cap for tool-arg previews in activity output (display only). |

## Provider-level retries

| Behavior | Location | Purpose |
| --- | --- | --- |
| OpenRouter tool-disable retry | `src/providers/openrouter.ts` | On 429/503 with tools enabled, retries **once** without tools and emits a `provider_retry` diagnostic (see README §Troubleshooting). |
| `ProviderRateLimitError` | `src/providers/types.ts:150` | Shared error type with optional retry info; raised by `bedrock.ts:512`, `xai.ts:330`, `gemini.ts:202`, `openrouter.ts:751`. Agent surfaces these but does not auto-retry beyond what each provider does. |

## Tool execution limits

### `bash` tool — `src/tools/bash.ts`

| Constant | Value | Notes |
| --- | --- | --- |
| `DEFAULT_TIMEOUT` | `30000` ms | Overridable per-call via the `timeout` arg. |
| `MAX_OUTPUT_SIZE` | `50 * 1024` bytes | Applies to stdout and stderr; child buffer is 2× this. Output beyond the cap is truncated with a marker. |

### Other tools

| Constant | Value | Location |
| --- | --- | --- |
| `READ_OUTPUT_LIMIT` | `50 KB` | `src/tools/read.ts:6` |
| `GREP_OUTPUT_LIMIT` | `50 KB` | `src/tools/grep.ts:10` |
| `DEFAULT_OUTPUT_LIMIT` | `50 KB` | `src/tools/shared.ts:4` — used by `truncateText()` |

## Context / prompt building (`src/context/`)

| Constant | Value | Location | Purpose |
| --- | --- | --- | --- |
| `SUMMARY_MAX_CHARS` | `1500` | `contextManager.ts:49` | Rolling-summary truncation. |
| `REHYDRATION_MAX_CHARS` | `12000` | `contextManager.ts:50`, `promptBuilder.ts:42` | Cap on inlined tool artifacts pulled back into the prompt. |
| `PromptBuilder.maxTurns` | computed | `promptBuilder.ts:118` | Turn-window limit; each retry level shrinks it further. |
| `MAX_CONTENT_LENGTH` | `500` | `memoryManager.ts:23` | Per-entry size cap for pinned memory. |

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

If a real run is misbehaving, the dial that matters most is **`maxIterations`** (`agent.ts:1385`) — it is a local `const` rather than a constructor option or config flag, so changing it currently requires a code edit. The 50 KB output caps in `bash`/`read`/`grep` are the next most common tuning points. Everything else is mostly defensive.
