# Long-Running Operation Bottlenecks — Implementation Plan

## Context

`docs/long-running-bottlenecks.md` catalogs 10 issues that make propio-agent unsuitable for long-running, multi-step work. `docs/mature-project-limits.md` describes the layered-defense pattern used by a more mature agentic CLI. This plan combines both: adopt the mature project's pattern (configurable limits, retry budgets, persisted tool outputs, circuit breakers) and add a lightweight durability layer to address the gaps the mature project's pattern alone doesn't cover.

Line numbers reflect the state of the repo at the time of writing — verify against current source before relying on them.

## Revisions from review feedback

`docs/long-running-bottlenecks-plan-feedback.md` flagged seven issues with the prior revision. Five are accepted as-is; two (#1, #7) are partially accepted with the rationale for the pushback documented below.

**Accepted:**

2. **Summary work moved to the right layer.** Deleting `SUMMARY_MAX_CHARS` was wrong — it controls per-tool-result summary text, not long-term memory. The real long-term-memory lever is the rolling summary (`SummaryPolicy.summaryTargetTokens`, the summary serializer, and `RollingSummaryRecord` shape). Phase 5 (new) targets those. `SUMMARY_MAX_CHARS` becomes a config knob, not a deletion.
3. **Tool-output persistence respects current ownership.** Tools continue to return strings. The agent/context layer detects large outputs and persists them. No tool-to-`ArtifactRecord` crossing.
4. **`Read` slicing ships with persistence.** Phase 3 adds `startLine` / `lineCount` (and `offset` / `limit` for byte mode) to the `read` tool, updates the tool description, and adds slicing tests. Persisted-output preview text references the new params.
5. **Streaming retries split by stream position.** `withRetry` only wraps pre-stream failures (connection error, response status before chunk consumption). Mid-stream failures bubble; post-emission failures never auto-retry. Phase 4 specifies the boundary.
6. **Normalized stream terminal event added before continuation recovery.** Phase 2's output-token recovery is gated on Phase 4.5 (new): a provider-agnostic `StreamTerminalEvent` carrying `stopReason: "max_tokens" | "stop_sequence" | "tool_use" | "end_turn" | "error"`. No continuation logic runs until that event exists.

**Pushed back (partially accepted):**

1. **Mid-turn durability — telemetry first, autosave only if data justifies it.** The feedback recommends a full autosave subsystem (rolling per-session file, async single-flight writes, `cleanExit` flag, launch-time resume prompt, partial-turn rollback, new `/session resume` command). That's ~6 file changes, a new slash command, and new tests — a meaningful complexity bump to address a failure mode (kill -9 / segfault / OOM mid-turn) whose actual frequency is unmeasured. The mature-project pattern explicitly handles durability through circuit breakers + retries + output persistence rather than snapshots, and those layers already cover most of the recoverable failure space.

   Rationale for pushback: build the cheap thing first, measure, decide. Phase 7 is reduced to a **crash telemetry probe**: write a per-session "in-progress" marker at turn start, clear it on clean completion, surface a banner + diagnostic on relaunch if the marker survives. No rolling snapshots, no resume flow, no new commands. The atomic-write fix to `writeSnapshot` (which is good hygiene regardless) stays. The full autosave proposal is captured as a deferred follow-up gated on telemetry data: if mid-turn crashes are observed at rate ≥ X over Y sessions across the user base, ship the full subsystem. Otherwise close it out. This keeps Phase 7 small (one file's worth of changes) and avoids paying for complexity that may never get used.

7. **Streak deletion — gate behind a config flag, don't run two authoritative paths in parallel.** The feedback recommends shipping the no-progress detector as a logged-only observation for a release while `MAX_EMPTY_TOOL_ONLY_STREAK` remains authoritative. That's risk-averse but leaves users hitting the streak's known false positives for the entire telemetry window.

   Rationale for pushback: a config flag is a better forcing function than parallel observation. Phase 2 ships the detector as **the authoritative exit when `runtimeConfig.useNoProgressDetector === true`** (default true). When false, the old streak heuristic is the fallback. Both branches exist, but only one runs at a time. If the detector misbehaves in the wild, operators flip the flag and we ship a fix; we don't need a release of parallel data to validate it. Streak heuristic + flag both get deleted in the next release if no regressions are reported. This compresses the timeline by one release cycle and avoids the awkward "two ways to exit a stuck loop" state.

## Direction Summary

- **Configure, don't hardcode.** Every operational limit becomes overridable via env var, `~/.propio/settings.json`, and (where user-facing) a CLI flag. Safe defaults stay in code.
- **Tool output is a bounded resource.** Persist large outputs to a per-session artifacts dir in the agent/context layer; tool result strings get a structured preview pointing at the file. The model re-reads narrower slices via `read` with slicing parameters.
- **Retry budgets at every external boundary — only where safe.** Shared `withRetry` helper wraps pre-stream provider calls. Mid-stream failures and post-emission failures have different recovery rules, documented explicitly.
- **Circuit breakers around recovery paths.** Compaction failures, repeated context-shrinks, and stream stalls each get a bounded retry budget that emits a diagnostic and gives up cleanly.
- **Crash telemetry probe instead of mid-turn autosave (for now).** Cheap in-progress marker measures whether mid-turn crashes actually happen at a rate that justifies a full autosave subsystem. Full autosave is a documented follow-up gated on the telemetry data. Existing `/exit` snapshot stays; `writeSnapshot` becomes atomic.
- **Rolling summary improvements at the right layer.** Increase `summaryTargetTokens`, structure the summary into sections, and harden the serializer against blind clipping.
- **Prefer deletion over configuration where the mechanism itself is misdesigned.** Three deletions are kept; the SUMMARY_MAX_CHARS deletion is dropped.

## Removals

These mechanisms are deleted outright. Five candidates from the prior revision are reduced to three after the feedback.

1. **Delete retry-level 3's `(0, 0)` cliff in `RETRY_LEVELS`** (`promptBuilder.ts:65–69`). A level that erases all recent turns and artifacts is never the right escalation. Keep levels 0–2 unchanged. At level 3, abort the turn cleanly with a `context_pressure_circuit_breaker` diagnostic instead of escalating to oblivion. `MAX_CONTEXT_RETRY_LEVEL` stays at 3; semantics change from "erase context" to "give up".
2. **Delete OpenRouter's bespoke "retry once without tools" path** (`openrouter.ts:561–615`). Replaced by general `withRetry` with an `onFinalRetry` hook OpenRouter passes; no provider-specific retry code.
3. **Delete silent truncation in `bash.ts`, `read.ts`, `grep.ts`.** Today, output > 50 KB is cut with a marker the model often misses. After Phase 3, the agent layer always persists large outputs and inserts a structured preview. There's no in-tool `truncateText`-then-return-string path left.

**Not deleted (changed from prior revision):**
- `MAX_EMPTY_TOOL_ONLY_STREAK` — kept until the no-progress detector ships, runs in parallel for one release as a logged-only signal, then deleted in a follow-up.
- `SUMMARY_MAX_CHARS` — controls per-tool-result summary text, not long-term memory. Becomes a config knob (`toolResultSummaryMaxChars`) with a higher default. The real summary fix targets the rolling summary (Phase 5).

## Scope (all 10 bottlenecks)

| # | Bottleneck | Action | Approach |
|---|---|---|---|
| 1 | `maxIterations = 10` | Tune + configure | Default 50; env `PROPIO_MAX_ITERATIONS`; CLI `--max-iterations`; settings field |
| 2 | `MAX_EMPTY_TOOL_ONLY_STREAK = 3` | Replace behind flag, then delete | Detector is authoritative when `useNoProgressDetector` flag is on (default); streak is fallback only. Both deleted next release if no regressions |
| 3 | Retry-level cliff at level 3 `(0,0)` | **Delete** | Level 3 policy removed; replaced by circuit-breaker abort |
| 4 | `SUMMARY_MAX_CHARS = 1500` | Configure (per-tool); **fix rolling summary separately** | Make per-tool cap configurable; Phase 5 targets actual long-term memory layer |
| 5 | Recent-turn / artifact caps | Configure | Expose `maxRecentTurns`, `artifactInlineCharCap`, `REHYDRATION_MAX_CHARS` via settings + env |
| 6 | 50 KB tool-output caps | **Delete** + replace | Silent truncation removed; agent/context layer persists; `read` gets slicing |
| 7 | Bash default timeout 30 s | Tune + configure | Default 120 s, max 600 s; env `PROPIO_BASH_DEFAULT_TIMEOUT_MS` / `_MAX_TIMEOUT_MS` |
| 8 | No mid-turn checkpointing | **Crash telemetry probe** (autosave deferred) | In-progress marker + banner on relaunch + atomic snapshot write. Full autosave gated on observed crash rate |
| 9 | Thin provider retries | **Delete** bespoke + add general | Pre-stream `withRetry`; explicit semantics for mid-stream and post-emission |
| 10 | Background summary race | Add circuit breaker | After 3 consecutive failures, disable refresh; stream-idle watchdog (90 s default) |

Bonus mature-project items folded in: output-token recovery (gated on normalized stream terminal event), aggregate per-message tool-result cap, and consistent `PROPIO_*` env var naming.

---

## Phases & critical files

### Phase 1 — Config surface and easy tuning (foundational, low risk)

Create a single source of truth for all operational limits, then thread it through the call sites.

**New file: `src/config/runtimeConfig.ts`**
- Export `RuntimeConfig` type and `loadRuntimeConfig()` that merges (highest precedence first): CLI flags, env vars, `~/.propio/settings.json`, in-code defaults.
- Fields: `maxIterations`, `maxRetries`, `bashDefaultTimeoutMs`, `bashMaxTimeoutMs`, `streamIdleTimeoutMs`, `maxRecentTurns`, `artifactInlineCharCap`, `rehydrationMaxChars`, `pinnedMemoryMaxContentLength`, `toolOutputInlineLimit`, `toolOutputPersistThreshold`, `aggregateToolResultsLimit`, `toolResultSummaryMaxChars`, `compactionFailureLimit`, `outputTokenRecoveryLimit`, `consecutive529FallbackLimit`, `useNoProgressDetector`, `emptyToolOnlyStreakLimit`, `rollingSummaryTargetTokens`.
- No `autosaveEnabled` / `autosaveMaxAgeDays` — autosave is deferred (see Phase 7).
- Env-var names follow `PROPIO_*` convention. Document in module-level comment listing all envs.

**Modify: `src/agent.ts`**
- Constructor accepts `runtimeConfig: RuntimeConfig` (default = `loadRuntimeConfig()`).
- Replace `const maxIterations = 10` (line 1385) with `this.runtimeConfig.maxIterations`.
- (Deletion of `MAX_EMPTY_TOOL_ONLY_STREAK` deferred — see Phase 2.)

**Modify: `src/context/contextManager.ts`**
- `SUMMARY_MAX_CHARS = 1500` (line 49) → read from `runtimeConfig.toolResultSummaryMaxChars`; default unchanged at 1500 since this is per-tool-result text, not long-term memory. Knob exists for callers that need to relax it.
- `REHYDRATION_MAX_CHARS = 12000` (line 50) → read from config.

**Modify: `src/context/types.ts`**
- `DEFAULT_BUDGET_POLICY` (lines 49–95) keeps current defaults; caller can pass overrides from `RuntimeConfig`. Wire `maxRecentTurns`, `artifactInlineCharCap` through.
- `DEFAULT_SUMMARY_POLICY` (lines ~80–95): `summaryTargetTokens` becomes config-driven (`runtimeConfig.rollingSummaryTargetTokens`). Default raised to 2048 (from 512). Phase 5 adds structured-summary support.

**Modify: `src/context/promptBuilder.ts`**
- `RETRY_LEVELS` (lines 65–69): **delete the level-3 `(0, 0)` entry**. Table becomes 3 levels (0, 1, 2 unchanged).
- `MAX_CONTEXT_RETRY_LEVEL` stays at 3, but at level 3 the caller emits `context_pressure_circuit_breaker` and aborts. Add the abort path at `agent.ts:1421-1437` and `agent.ts:1024-1039`.

**Modify: `src/tools/bash.ts`**
- Default timeout 30 s → 120 s; max 600 s; both from `RuntimeConfig`.
- `MAX_OUTPUT_SIZE` (line 13) read from `RuntimeConfig.toolOutputInlineLimit`. Silent-truncation deletion is in Phase 3.

**Modify: `src/tools/read.ts`, `src/tools/grep.ts`**
- `READ_OUTPUT_LIMIT` (read.ts:6), `GREP_OUTPUT_LIMIT` (grep.ts:10) → from `RuntimeConfig.toolOutputInlineLimit`.

**Modify: `src/context/memoryManager.ts`**
- `MAX_CONTENT_LENGTH = 500` (line 23) → from `RuntimeConfig.pinnedMemoryMaxContentLength`; raise default to 2000.

**CLI surface — modify: `src/index.ts`**
- Parse `--max-iterations`, `--max-retries`, `--bash-timeout-ms`, `--stream-idle-timeout-ms` flags; pass into `loadRuntimeConfig({ cliOverrides })`.

**Settings:** new top-level `runtime` object in `~/.propio/settings.json` mirroring `RuntimeConfig` fields.

---

### Phase 2 — Loop cap, no-progress detector (parallel-running), output-token recovery

**Modify: `src/agent.ts`**

1. **`AgentStreamOptions` (lines 124–126):** add `maxIterations?: number` override. Falls through to runtime config.

2. **No-progress detector — authoritative when flag is on.** New private helper `detectNoProgress(history, lookback)` returns true if the last `lookback` iterations:
   - produced no new artifacts (compare artifact ids before/after),
   - issued only repeats of prior tool-call shapes (same tool + similar args hash),
   - and produced no new assistant text.
   Default lookback = 5. When triggered, emits `no_progress_detected` diagnostic and calls `requestFinalResponseWithoutTools`. Gated by `runtimeConfig.useNoProgressDetector` (default `true`).

3. **`MAX_EMPTY_TOOL_ONLY_STREAK` becomes the fallback for `useNoProgressDetector === false` only.** Read from `runtimeConfig.emptyToolOnlyStreakLimit` (default still 3). The branch at lines 1293–1326 only runs when the detector flag is off. Marked `@deprecated` with a comment pointing at the detector. Both branches are mutually exclusive — never both authoritative at once.

   **Follow-up (next release):** if no regressions reported with the detector authoritative, delete `MAX_EMPTY_TOOL_ONLY_STREAK`, `emptyToolOnlyStreakLimit`, `useNoProgressDetector`, and the fallback branch. The flag exists to give operators an escape hatch during the validation window, not to be a permanent toggle.

4. **Output-token recovery — gated on Phase 4.5 (normalized stream terminal event).** When `StreamTerminalEvent.stopReason === "max_tokens"`, request a continuation up to `runtimeConfig.outputTokenRecoveryLimit` (default 3) times. Hook after `collectProviderStream` (line 1408). Diagnostic `output_token_recovery_attempt`. **Do not implement before Phase 4.5 lands.**

5. **Iteration-end diagnostic shape:** when the cap is reached (`max_iterations_reached`, line 1471), include `noProgressDetected: boolean` and the last-5-iteration tool-call histogram.

**Modify: `src/diagnostics.ts`**
- Add event types: `no_progress_detected_observation`, `output_token_recovery_attempt`, `output_token_recovery_exhausted`, `compaction_circuit_breaker_tripped`, `stream_idle_aborted`, `tool_output_persisted`, `context_pressure_circuit_breaker`, `autosave_written`, `autosave_failed`.

**Follow-up phase (post-release):** delete `MAX_EMPTY_TOOL_ONLY_STREAK` and flip the detector from logged-only to authoritative once data shows it triggers correctly.

---

### Phase 3 — Tool output persistence (agent/context layer) + `read` slicing

Persistence happens in the agent/context layer, not inside tools. Tools continue to return strings.

**New file: `src/tools/outputPersistence.ts`**
- Exports `persistToolOutput({ toolName, content, mediaType, sessionDir, runtimeConfig })` → `{ artifactId, path, sizeBytes, lineCount, preview }`.
- Storage: `~/.propio/sessions/{workspaceHash}/artifacts/{sessionId}/{toolName}-{timestamp}-{rand}.{ext}`.
- `preview` = first `runtimeConfig.toolOutputInlineLimit` bytes (default 50 KB), prefixed by a structured header:
  ```
  [output persisted: tool=bash size=2.4MB lines=18432 path=<sessionId>/bash-…log
   preview shows first 50000 bytes; read the full file with the Read tool using startLine/lineCount or offset/limit]
  ```
- Atomic write via temp-file + rename.

**Modify: `src/agent.ts` or `src/context/contextManager.ts` — single persistence call site**
- Decision: persistence lives in **`Agent.processToolCall()`** (or whichever helper turns a tool's string return into a `ToolInvocationRecord` + result). This keeps the change minimal and respects the existing ownership boundary.
- Flow: tool returns string → agent measures length → if `> runtimeConfig.toolOutputPersistThreshold`, call `persistToolOutput`, replace the tool result content with the preview block, create the `ArtifactRecord` referencing the file (still in the context manager, as today). If ≤ threshold, pass through unchanged.
- Tools never see the persistence concept. The current `truncateText` calls in `bash.ts:23–35`-style result construction are deleted from the tool path (silent-truncation removal — Removal #3).

**`read` tool slicing — modify: `src/tools/read.ts`**
- Add parameters: `startLine?: number`, `lineCount?: number`, `offset?: number`, `limit?: number`.
- Line-based (`startLine` + `lineCount`) is the primary interface; byte-based (`offset` + `limit`) is a fallback for binary or very long lines.
- Validation: `startLine >= 1`; `lineCount >= 1` and ≤ a sensible cap (e.g. 5000 lines); `offset >= 0`; `limit >= 1` and ≤ `runtimeConfig.toolOutputInlineLimit`.
- Update the tool description so the model knows it can re-read persisted artifact paths with these params. Mention this explicitly in the persistence preview's hint text.
- Tests:
  - Read full file (no params) — unchanged behavior.
  - Read with `startLine: 100, lineCount: 50` returns exactly that range.
  - Read with `offset` / `limit` returns byte slice.
  - Read a persisted artifact file written by `outputPersistence` in slices.
  - Out-of-range params produce a clear error, not silent empty result.

**Aggregate tool-result cap per assistant message**
- In `src/context/contextManager.ts` (where tool results attach to a turn), track total tool-result chars in the pending assistant message. If total exceeds `runtimeConfig.aggregateToolResultsLimit` (default 200 KB), force-persist additional results even if individually under threshold. Mirrors mature project's `MAX_TOOL_RESULTS_PER_MESSAGE_CHARS = 200,000`.

**Pruning:** on launch, prune session-artifact directories older than 7 days (configurable). Add to existing startup path in `src/index.ts`.

---

### Phase 4 — Shared retry helper with stream-position-aware semantics

**New file: `src/providers/withRetry.ts`**

Three retry categories, explicitly distinguished:

1. **Pre-stream retries (auto, default).** Wrap the HTTP request and the initial response-header parse. If the request fails before any stream chunk has been consumed, retry per the budget. This is the common case: connection errors, 408, 409, 429, 5xx (except amplified 529s).
2. **Buffered-mode retries (opt-in, off by default).** A `bufferBeforeEmit` option that consumes the entire stream into memory before emitting any chunk to the agent loop. If a buffered stream fails mid-way, the request can be retried since nothing has been surfaced. Costs latency; suitable for short tool-result-only responses, not for long assistant text. Default off.
3. **Post-emission failures: no auto-retry.** Once any chunk has been emitted to the agent (assistant text streamed, or tool call surfaced), failure bubbles to the caller as a terminal error. Continuation-via-retry would duplicate text or re-invoke tools. The only mid-stream recovery is the Phase 4.5 `StreamTerminalEvent.stopReason === "max_tokens"` continuation, which is a *protocol-level* continuation, not a retry.

API:
```ts
withRetry<T>(fn: () => Promise<T>, opts: {
  maxRetries: number;          // pre-stream attempt budget
  baseDelayMs: number;         // default 500
  maxDelayMs: number;          // default 32_000
  isRetryable: (err) => bool;
  on529Fallback?: () => void;
  onFinalRetry?: () => Partial<RequestOptions>;  // e.g. drop tools on last attempt
}): Promise<T>
```

- Default `maxRetries = runtimeConfig.maxRetries` (10).
- 529 ladder: after `runtimeConfig.consecutive529FallbackLimit` (default 3) consecutive 529s, call `on529Fallback` and abort.
- Each retry emits a `provider_retry` diagnostic with attempt count, delay, reason.

**Modify: all providers in `src/providers/`** (`anthropic.ts`, `openai.ts`, `openrouter.ts`)
- Wrap the *pre-stream* HTTP path with `withRetry`. The streaming consumer is outside the retry boundary.
- **Delete `openrouter.ts:561–615`** — bespoke `shouldRetryWithoutTools` + retry-without-tools block. Straight deletion.
- Move the no-tools-on-final-attempt behavior into `withRetry`'s `onFinalRetry` hook. OpenRouter passes `{ onFinalRetry: () => ({ tools: undefined }) }`; other providers don't.
- Document at each provider call site which retry category applies. Mid-stream errors translate to a `provider_stream_error` diagnostic and bubble.

---

### Phase 4.5 — Normalized stream terminal event (prerequisite for output-token recovery)

This phase is small and self-contained. It must land before Phase 2's output-token recovery is wired up.

**Modify: `src/providers/types.ts` (or wherever provider stream events are typed)**
- Add `StreamTerminalEvent`:
  ```ts
  type StopReason = "end_turn" | "tool_use" | "max_tokens" | "stop_sequence" | "error";
  interface StreamTerminalEvent {
    kind: "terminal";
    stopReason: StopReason;
    rawProviderReason?: string;  // for diagnostics
  }
  ```
- Each provider's stream consumer maps its native terminal signal to a `StreamTerminalEvent`:
  - Anthropic: `message_stop` event + `stop_reason` field on the final `message_delta`.
  - OpenAI: `finish_reason` on the final choice (`"length"` → `max_tokens`, `"stop"` → `end_turn`, `"tool_calls"` → `tool_use`, etc.).
  - OpenRouter: passthrough of the underlying provider's signal.

**Modify: `src/agent.ts`**
- `collectProviderStream` (or its consumer) surfaces the `StreamTerminalEvent` to the loop. The loop uses `stopReason === "max_tokens"` as the trigger for output-token recovery (Phase 2 item 4).

Tests: each provider's stream test produces the correct normalized event for each native terminal signal. Round-trip mapping is exhaustive.

---

### Phase 5 — Rolling summary at the right layer (the actual long-term-memory fix)

The original bottleneck doc identified `SUMMARY_MAX_CHARS = 1500` as the long-term-memory bottleneck. That was wrong — it controls per-tool-result summary text. The real long-term memory lives in `RollingSummaryRecord` (`src/context/types.ts:101–106`), produced by `SummaryManager`, with guidance from `SummaryPolicy.summaryTargetTokens` (default 512).

**Modify: `src/context/types.ts`**
- `DEFAULT_SUMMARY_POLICY.summaryTargetTokens`: 512 → 2048 (configurable; already wired in Phase 1).
- Extend `RollingSummaryRecord` shape (or add a `sections` field) to support structured sections:
  ```ts
  interface RollingSummarySections {
    goals: string[];
    decisions: string[];
    constraints: string[];
    filesTouched: string[];
    testStatus: string;
    openThreads: string[];
    narrative: string;  // free-form fallback
  }
  ```
- Persistence: bump `PersistedSessionV3` to V4 (or add optional fields on V3 — preferred for backward compatibility).

**Modify: `src/context/summaryManager.ts`**
- Update the summarization prompt to request the structured shape. The LLM returns JSON-shaped sections, parsed and stored.
- Fallback: if the LLM returns plain text, store it as `{ narrative: text, …other fields empty }`. Never throw on shape mismatch — degrade to the existing flat-narrative behavior.

**Modify: `src/context/promptBuilder.ts` — summary rendering**
- Render the structured summary as a compact block:
  ```
  ## Session summary
  Goals: …
  Decisions: …
  Constraints: …
  Files touched: …
  Test status: …
  Open threads: …
  ```
  Narrative-only summaries (older sessions / fallback) render as today.

**Modify: `src/context/summaryManager.ts` — selective preservation**
- Today's summary serializer (the part that prepares prior turns for the summarizer LLM) clips tool invocation summaries blindly. Change to: preserve full tool invocation summaries up to a per-summary budget; clip oldest first. Important late-session tool results stay legible to the summarizer.

**Tests:**
- Structured summary round-trips through serialize/parse.
- LLM-returned plain text falls back to narrative-only.
- Selective preservation keeps the most recent N tool summaries intact under budget pressure.
- Prompt rendering produces the expected block.

---

### Phase 6 — Circuit breakers and watchdogs

**Modify: `src/agent.ts`**

1. **Compaction circuit breaker.** In `runSummaryRefresh` (line 701) and `attemptSynchronousShrink` (line 782), track consecutive failure count. After `runtimeConfig.compactionFailureLimit` (default 3) consecutive failures, disable further refresh attempts for the rest of the session; emit `compaction_circuit_breaker_tripped`. Reset on successful refresh.
2. **Synchronous-shrink loop guard.** Track number of `attemptSynchronousShrink` invocations within a single turn; cap at `MAX_CONTEXT_RETRY_LEVEL + 1`. Prevents (context error → shrink → still too long → context error) loops.
3. **Stream-idle watchdog.** In the provider stream consumer, if no chunk arrives in `runtimeConfig.streamIdleTimeoutMs` (default 90 s), abort the stream, emit `stream_idle_aborted`. **Treat the abort as a mid-stream failure**: it bubbles (no auto-retry), since chunks may already have been consumed. Env-overridable via `PROPIO_STREAM_IDLE_TIMEOUT_MS`.

**Modify: `src/context/contextManager.ts`**
- Track compaction failure count on the `ContextManager` instance, exposed to the agent for circuit-breaker decisions.

---

### Phase 7 — Crash telemetry probe (autosave deferred)

Bottleneck #8 says a crash mid-turn loses all in-memory progress. The mature-project pattern (retries + circuit breakers + output persistence) covers most *recoverable* mid-turn failures. What it doesn't cover is hard process termination — segfault, kill -9, OOM, panic. Whether that's a real problem for propio-agent users is unmeasured. This phase measures it cheaply; the full autosave subsystem from the prior plan revision is deferred until the data supports it.

**Atomic snapshot write (independent good-hygiene fix)**

**Modify: `src/sessions/sessionHistory.ts:170–201`**
- `writeSnapshot` currently uses `fs.writeFileSync` directly. A SIGKILL mid-write leaves a truncated JSON. Switch to write-temp-then-rename:
  ```
  fs.writeFileSync(`${file}.tmp`, json);
  fs.renameSync(`${file}.tmp`, file);
  ```
- This benefits every session save, not just the telemetry path. Land it independent of everything else.

**In-progress marker**

**Modify: `src/sessions/sessionHistory.ts`**
- Add helpers `writeInProgressMarker(sessionsDir, sessionId, metadata)` and `clearInProgressMarker(sessionsDir, sessionId)`. Marker is a tiny JSON file (`inprogress-{sessionId}.json`) holding `{ pid, startedAt, providerName, modelKey, turnIndex }`. Atomic write per above.
- Add `findStaleMarkers(sessionsDir)`: returns any marker whose `pid` is no longer running (or whose `startedAt` is older than a sanity cap like 7 days). Stale = the prior process died without clearing.

**Modify: `src/agent.ts`**
- Write the marker at the start of each `streamChat` turn (before line 1388), updating `turnIndex`. Clear the marker on clean turn completion (after line 1467).
- This is two file ops per turn, both tiny — negligible cost. No async machinery, no single-flight, no rolling files. The marker is metadata, not state.
- The marker is **intentionally not recoverable state**. It only signals "a prior process died here." Nothing in this phase tries to restore work.

**Modify: `src/index.ts` (launch path)**
- On startup, call `findStaleMarkers(sessionsDir)`. For each stale marker:
  - Emit a `mid_turn_crash_detected` diagnostic with the marker's metadata (provider, model, turn index, age).
  - Print a one-line banner: `Detected an incomplete session from {when} ({provider}/{model}, turn {n}). Work since the last /exit was not saved.`
  - Delete the marker.
- That's it. No resume prompt, no `/session resume`, no rolling autosave file.

**Telemetry acceptance criteria for the deferred follow-up**

Document in this phase (and in the diagnostics doc) the threshold for promoting telemetry to full autosave:
- If `mid_turn_crash_detected` fires at a rate ≥ 1 per 100 sessions across instrumented users over one release cycle, ship the full autosave subsystem (the design from the prior plan revision: async rolling file, `cleanExit` flag, launch resume prompt, partial-turn rollback, `/session resume`).
- Below that threshold, close out the follow-up. The atomic write + telemetry banner are sufficient.
- Document this acceptance criterion in `docs/long-running-bottlenecks.md` so a future contributor isn't tempted to reopen the autosave question without evidence.

**What this phase explicitly does NOT include** (deferred until the data justifies it):
- No `cleanExit` flag in `PersistedSessionV3`.
- No `autosave-*.json` rolling file.
- No async single-flight write machinery.
- No new `/session resume` command.
- No partial-turn rollback logic.
- No autosave pruning policy.

**Tests:**
- `src/sessions/__tests__/sessionHistory.test.ts` — atomic write survives mid-write SIGKILL simulation; marker write/clear/find-stale round trip; `findStaleMarkers` skips live pids and old-but-cleanly-cleared marker absences.
- `src/__tests__/agent.test.ts` — marker is written at turn start, cleared on completion, written in the catch block before rethrow.
- `src/__tests__/index.test.ts` (or wherever startup is tested) — stale marker on launch produces the diagnostic + banner; non-stale marker (live pid) is ignored.

---

## Verification

**Unit tests** (add to existing test files unless marked new):
- `src/__tests__/agent.test.ts` — iteration cap configurable; no-progress detector is authoritative when flag on; streak fallback runs when flag off; output-token recovery loop (after Phase 4.5); in-progress marker write/clear/catch-block-rethrow.
- `src/context/__tests__/promptBuilder.test.ts` — level-3 cliff deleted; level-3 abort emits circuit-breaker diagnostic.
- `src/context/__tests__/contextManager.test.ts` — compaction circuit breaker; aggregate tool-result cap; `toolResultSummaryMaxChars` knob.
- `src/context/__tests__/summaryManager.test.ts` — structured sections round-trip; plain-text fallback; selective preservation under budget pressure.
- `src/providers/__tests__/withRetry.test.ts` (new) — pre-stream retry budget, 529 ladder, `isRetryable` predicate, `onFinalRetry` hook, **no retry after first emitted chunk**.
- `src/providers/__tests__/streamTerminalEvent.test.ts` (new) — each provider maps native terminal signals to `StreamTerminalEvent`.
- `src/tools/__tests__/outputPersistence.test.ts` (new) — large output written to disk, preview structure, atomic write, persistence ownership in agent layer (tool unchanged).
- `src/tools/__tests__/read.test.ts` — slicing with `startLine`/`lineCount` and `offset`/`limit`; reads persisted artifact in slices.
- `src/tools/__tests__/bash.test.ts` — default 120 s, env override, large stdout flows through agent persistence.
- `src/config/__tests__/runtimeConfig.test.ts` (new) — precedence (CLI > env > settings > defaults).
- `src/sessions/__tests__/sessionHistory.test.ts` — atomic write survives mid-write SIGKILL simulation; in-progress marker write/clear/find-stale; `findStaleMarkers` skips live pids.

**Manual / integration checks:**
1. 30-iteration synthetic scenario: cap engages with `max_iterations_reached` + no-progress histogram.
2. `bash sleep 60` completes under the 120 s default.
3. Large `grep -r` (10+ MB): persisted to disk; preview inline; model re-reads with `startLine`/`lineCount`.
4. Force a 429 from OpenRouter: pre-stream retry succeeds; verify no retry triggers mid-stream.
5. Context-length error mid-stream: shrink loop bounded by synchronous-shrink guard; eventual abort with circuit-breaker diagnostic.
6. Fake provider stream stalled for 90 s: watchdog aborts; failure bubbles (no retry, as designed).
7. `PROPIO_MAX_ITERATIONS=5` and `--max-iterations=20`: CLI wins.
8. Crash mid-turn (kill -9 during bash execution): on relaunch, stale in-progress marker is detected, `mid_turn_crash_detected` diagnostic fires, banner prints, marker is deleted. No resume offered.
9. Long session with multiple tool calls: structured rolling summary contains goals/decisions/files-touched sections, not just narrative.
10. `max_tokens` hit on a long assistant turn: continuation recovery fires up to 3 times.

**Docs to update:**
- `docs/limits.md` — refresh constants, add env var / settings reference.
- `docs/long-running-bottlenecks.md` — mark items addressed.
- `README.md` or new `docs/configuration.md` — list all `PROPIO_*` env vars, CLI flags, `settings.json` fields, autosave behavior.

## Critical files (consolidated)

**New:**
- `src/config/runtimeConfig.ts`
- `src/providers/withRetry.ts`
- `src/tools/outputPersistence.ts`
- `src/config/__tests__/runtimeConfig.test.ts`
- `src/providers/__tests__/withRetry.test.ts`
- `src/providers/__tests__/streamTerminalEvent.test.ts`
- `src/tools/__tests__/outputPersistence.test.ts`

**Modified:**
- `src/agent.ts` (loop cap, no-progress detector authoritative + streak fallback under flag, output-token recovery, circuit breakers, stream watchdog, in-progress marker writes/clears)
- `src/context/contextManager.ts` (config wiring, compaction circuit breaker, aggregate tool-result cap, persistence call site)
- `src/context/promptBuilder.ts` (level-3 cliff deletion, circuit breaker abort, structured-summary rendering)
- `src/context/types.ts` (policy overrides, `RollingSummaryRecord` sections, `summaryTargetTokens` default)
- `src/context/summaryManager.ts` (structured summary prompt, selective preservation)
- `src/context/memoryManager.ts` (`MAX_CONTENT_LENGTH` from config)
- `src/context/persistence.ts` (no changes in this revision; `cleanExit` / `sessionUuid` deferred with the full autosave proposal)
- `src/providers/openrouter.ts`, `anthropic.ts`, `openai.ts` (use `withRetry`; emit `StreamTerminalEvent`; delete OpenRouter bespoke path)
- `src/providers/types.ts` (`StreamTerminalEvent`)
- `src/tools/bash.ts`, `src/tools/read.ts`, `src/tools/grep.ts` (config wiring; tools stay string-returning; `read` gains slicing)
- `src/sessions/sessionHistory.ts` (atomic writes, in-progress marker helpers)
- `src/sessions/sessionCommands.ts` (no changes in this revision; `/session resume` and `--all` deferred with full autosave proposal)
- `src/diagnostics.ts` (new event types)
- `src/index.ts` (CLI flags, stale-marker detection on startup, artifact pruning)
- `docs/limits.md`, `docs/long-running-bottlenecks.md`, `README.md` / new `docs/configuration.md`

## Rollout order

1. **Phase 1** (config surface + tuning + level-3 cliff deletion) — ships first; everything downstream depends on `RuntimeConfig`.
2. **Phase 7** (atomic snapshot write + in-progress marker + crash telemetry) — small, independent, ships early so telemetry starts accumulating immediately.
3. **Phase 4.5** (normalized `StreamTerminalEvent`) — small, prerequisite for output-token recovery.
4. **Phase 4** (withRetry with stream-position semantics + OpenRouter bespoke-path deletion).
5. **Phase 2** (loop cap configurable + no-progress detector authoritative behind flag + output-token recovery) — depends on Phase 1, 4.5.
6. **Phase 3** (tool output persistence in agent layer + delete silent truncation + `read` slicing) — depends on Phase 1.
7. **Phase 5** (rolling summary improvements) — depends on Phase 1; mostly orthogonal.
8. **Phase 6** (circuit breakers + watchdog) — depends on Phases 1, 2, 4.

**Deferred follow-ups (next release, gated):**
- Delete `MAX_EMPTY_TOOL_ONLY_STREAK`, `emptyToolOnlyStreakLimit`, `useNoProgressDetector`, and the streak fallback branch if no regressions reported with the detector authoritative.
- Full mid-turn autosave subsystem (rolling file, `cleanExit` flag, `/session resume`, partial-turn rollback) if `mid_turn_crash_detected` telemetry shows crash rate ≥ 1 per 100 sessions across one release. Otherwise close out — atomic write + telemetry banner are sufficient.

Net effect: meaningful additions in Phases 4.5 and 5; small additions in Phase 7; deletions in Phases 1, 3, and 4. Phases 2 and 6 are roughly balanced. The revised Phase 7 is roughly 1/4 the size of the prior revision's autosave phase.
