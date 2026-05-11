# Long-Running Operation: Bottlenecks and Hot Spots

An analysis of what would constrain propio-agent from successfully solving problems that require long-running, multi-step processes. Line numbers reflect the state of the repo at the time of writing — verify against current source before relying on them. See also `docs/limits.md` for the raw catalog of caps and constants.

## Showstoppers

### 1. `maxIterations = 10` (`src/agent.ts:1385`)

Single biggest blocker. One user turn can do at most 10 tool-call rounds before the loop exits with a `max_iterations_reached` diagnostic. Non-trivial problems (debug → repro → patch → test → fix → re-test) burn through 10 quickly. It's a local `const`, not a constructor option, so even raising it requires a code edit.

### 2. `MAX_EMPTY_TOOL_ONLY_STREAK = 3` (`src/agent.ts:143`)

Trips before `maxIterations`. Three consecutive turns of "tool calls only, no text" force a no-tools final answer. Models that work silently — which is often *good* behavior for long runs — will be wrongly classified as "stuck."

## Context Loss Over Time

### 3. Retry-level cliff (`src/context/promptBuilder.ts:65-69`)

At `MAX_CONTEXT_RETRY_LEVEL=3` the policy drops to `maxRecentTurnsFraction: 0, artifactCapFraction: 0` — i.e., no recent turns and no artifacts. So a context-pressure escalation late in a long run can effectively erase working state in one shot.

### 4. `SUMMARY_MAX_CHARS = 1500` (`src/context/contextManager.ts:49`)

The only long-term memory once turns roll off. That's roughly 300–400 tokens to compress hours of work — far too small for stateful problem solving. Pinned memory at `MAX_CONTENT_LENGTH = 500` per entry doesn't make up for it.

### 5. Recent-turn and artifact caps

- `maxRecentTurns: 50` (`src/context/types.ts:63`)
- `artifactInlineCharCap: 12000` (`src/context/types.ts:64`)
- `REHYDRATION_MAX_CHARS: 12000` (`src/context/contextManager.ts:50`, `src/context/promptBuilder.ts:42`)

Older turns get evicted, and any single artifact bigger than 12 KB is referenced rather than inlined. After dozens of file reads, the agent is reasoning against summaries of summaries.

## Tool-Output Blindness

### 6. 50 KB output caps everywhere

- `bash.ts MAX_OUTPUT_SIZE` = 50 KB
- `read.ts READ_OUTPUT_LIMIT` = 50 KB
- `grep.ts GREP_OUTPUT_LIMIT` = 50 KB

Truncation is silent-ish (a marker is appended, but the model often misses it). For long runs against large logs, builds, or datasets, the agent works on partial views and there's no chunking/paging strategy.

### 7. `bash` default timeout 30 s (`src/tools/bash.ts`)

Overridable per call, but the model has to remember to override. Long builds, large test suites, or any heavy command will time out and look like a tool failure.

## Recovery and Robustness

### 8. No mid-turn checkpointing

Session snapshots happen on `/exit`. A crash, a fatal provider error, or an unrecoverable context error mid-iteration loses all tool work since the last user message.

### 9. Provider retries are thin

OpenRouter retries once without tools on 429/503; other providers don't auto-retry at all (see `docs/limits.md` §Provider-level retries). A single transient rate-limit at hour 2 kills the turn.

### 10. Background summary can lose the race

`scheduleSummaryRefresh` is best-effort; the synchronous-shrink path (`src/agent.ts:782`) is the only safety net, and it only fires on a `ProviderContextLengthError` after the request already failed.

## Highest-Leverage Changes

If propio-agent is to be viable for long-running work, the three to target first:

1. **Make `maxIterations` configurable** and default it much higher (50–100), or remove the cap and rely on user cancellation + a "no progress" heuristic instead of a fixed integer.
2. **Raise `SUMMARY_MAX_CHARS` substantially** (or move to a hierarchical/structured summary) so summarized history retains usable detail.
3. **Add mid-turn checkpointing** so a crash or context exhaustion doesn't discard tool work.

The rest (output caps, retry-level cliff, empty-tool-streak heuristic) are tuning rather than architecture — easy follow-ups once the three above are in.
