# Long-Running Operation Bottlenecks — Implementation Plan

## Context

`docs/long-running-bottlenecks.md` catalogs 10 issues that make propio-agent unsuitable for long-running, multi-step work: a hardcoded 10-iteration cap, a context retry cliff, undersized summaries, blind tool-output truncation, thin provider retries, and no resilience around recovery paths. `docs/mature-project-limits.md` describes the layered-defense pattern used by a more mature agentic CLI (configurable loop cap with diminishing-returns guard, retry budgets at every external boundary, tool outputs persisted to disk and re-readable in narrower slices, circuit breakers around compaction, env-var-based operational tuning).

This plan adopts the mature project's pattern. We replace the originally-considered "mid-turn checkpointing" with the mature project's durability primitives: retry budgets, circuit breakers, and disk-persisted tool output. The result is a propio-agent that can sustain hours-long sessions without losing fidelity, time out cleanly when truly stuck, and recover from transient provider failures.

Line numbers reflect the state of the repo at the time of writing — verify against current source before relying on them.

## Direction Summary

- **Configure, don't hardcode.** Every limit becomes overridable via env var, `~/.propio/settings.json`, and (where user-facing) a CLI flag. Safe defaults stay in code.
- **Tool output is a bounded resource.** Persist large outputs to a per-session artifacts dir; inline content becomes a structured preview pointing at the file. The model re-reads narrower slices via existing read tools.
- **Retry budgets at every external boundary.** Replace the current ad-hoc OpenRouter-only retry with a shared `withRetry` helper used by all providers, with exponential backoff and configurable budget.
- **Circuit breakers around recovery paths.** Compaction failures, repeated context-shrinks, and stream stalls each get a bounded retry budget that emits a diagnostic and gives up cleanly.
- **No explicit mid-turn checkpointing.** Durability comes from the layers above. (Existing on-`/exit` snapshot stays.)
- **Prefer deletion over configuration.** Where a bottleneck represents a misdesigned mechanism rather than a too-small number, delete the mechanism entirely instead of adding a knob for it.

## Removals (not adjustments)

These bottlenecks come out as deletions. They're listed first because they shrink the surface area before Phase 1 begins.

1. **Delete `MAX_EMPTY_TOOL_ONLY_STREAK` and its fallback path.** The streak heuristic (agent.ts:143, 1293–1326) misfires on quiet-but-productive models. Replaced by the no-progress detector (Phase 2), which uses real progress signals (new artifacts, new tool-call shapes, new text) instead of an imperfect proxy. Don't soften the threshold; delete the constant and the branch.
2. **Delete retry-level 3's `(0, 0)` cliff in `RETRY_LEVELS`.** A level that erases all recent turns and artifacts is never the right escalation. Keep levels 0–2 (`promptBuilder.ts:65–69`) unchanged. At level 3, abort the turn cleanly with a `context_pressure_circuit_breaker` diagnostic instead of escalating to oblivion. `MAX_CONTEXT_RETRY_LEVEL` stays at 3; its semantics change from "erase context" to "give up".
3. **Delete OpenRouter's bespoke "retry once without tools" path** (`openrouter.ts:561–615`). Replaced by general `withRetry` with `tools=false` as the last attempt only when the original request included tools. No provider-specific retry code.
4. **Delete silent truncation in `bash.ts`, `read.ts`, `grep.ts`.** Today, output > 50 KB is cut with a marker the model often misses. After Phase 3, outputs > 50 KB are *always* persisted with a structured preview; outputs ≤ 50 KB are returned in full. There's no `truncateText`-then-return-string path left. `shared.ts:25–38` `truncateText` is removed from the tool path (kept only if needed for diagnostic UI strings).
5. **Delete `SUMMARY_MAX_CHARS` and `generateTextSummary`'s truncation step.** With Phase 3, the structured preview block is the tool-result summary. The 1500-char flat truncation in `contextManager.ts:49, 235–242` becomes dead code. Remove the constant and the truncation branch; turn-record summaries derive directly from the preview block. (`REHYDRATION_MAX_CHARS` is a different concept and stays.)

Net effect: five separate mechanisms removed. Phase 1 no longer needs config knobs for `summaryMaxChars` or `emptyToolOnlyStreakLimit`. The retry-level policy table shrinks from 4 entries to 3.

## Scope (all 10 bottlenecks)

| # | Bottleneck | Action | Approach |
|---|---|---|---|
| 1 | `maxIterations = 10` | Tune + configure | Default 50; env `PROPIO_MAX_ITERATIONS`; CLI `--max-iterations`; settings field |
| 2 | `MAX_EMPTY_TOOL_ONLY_STREAK = 3` | **Delete** | Constant and fallback branch removed; replaced by no-progress detector |
| 3 | Retry-level cliff at level 3 `(0,0)` | **Delete** | Level 3 policy removed; replaced by circuit-breaker abort |
| 4 | `SUMMARY_MAX_CHARS = 1500` | **Delete** | Constant and `generateTextSummary` truncation removed; preview block is the summary |
| 5 | Recent-turn / artifact caps | Configure | Expose `maxRecentTurns`, `artifactInlineCharCap`, `REHYDRATION_MAX_CHARS` via settings + env |
| 6 | 50 KB tool-output caps | **Delete** + replace | Silent truncation removed; large outputs persisted; preview points at file |
| 7 | Bash default timeout 30 s | Tune + configure | Default 120 s, max 600 s; env `PROPIO_BASH_DEFAULT_TIMEOUT_MS` / `_MAX_TIMEOUT_MS` |
| 8 | No mid-turn checkpointing | **Not added** | Replaced by retry budgets + circuit breakers + output persistence |
| 9 | Thin provider retries | **Delete** bespoke + add general | Remove OpenRouter-specific retry path; shared `withRetry` with default budget 10 |
| 10 | Background summary race | Add circuit breaker | After 3 consecutive failures, disable refresh; stream-idle watchdog (90 s default) |

Five deletions, three tune+configures, one add (withRetry), one circuit breaker. Bonus mature-project items folded in: output-token recovery (3 attempts), aggregate per-message tool-result cap, and consistent `PROPIO_*` env var naming.

---

## Phases & critical files

### Phase 1 — Config surface and easy tuning (foundational, low risk)

Create a single source of truth for all operational limits, then thread it through the call sites.

**New file: `src/config/runtimeConfig.ts`**
- Export `RuntimeConfig` type and `loadRuntimeConfig()` that merges (highest precedence first): CLI flags, env vars, `~/.propio/settings.json`, in-code defaults.
- Fields: `maxIterations`, `maxRetries`, `bashDefaultTimeoutMs`, `bashMaxTimeoutMs`, `streamIdleTimeoutMs`, `maxRecentTurns`, `artifactInlineCharCap`, `rehydrationMaxChars`, `pinnedMemoryMaxContentLength`, `toolOutputInlineLimit`, `toolOutputPersistThreshold`, `aggregateToolResultsLimit`, `compactionFailureLimit`, `outputTokenRecoveryLimit`, `consecutive529FallbackLimit`.
- No `summaryMaxChars` or `emptyToolOnlyStreakLimit` — those are removed mechanisms (see Removals section), not configurable.
- Env-var names follow `PROPIO_*` convention. Document in module-level comment listing all envs.

**Modify: `src/agent.ts`**
- Constructor accepts `runtimeConfig: RuntimeConfig` (with default = `loadRuntimeConfig()`).
- Replace `const maxIterations = 10` (line 1385) with `this.runtimeConfig.maxIterations`.
- (Deletion of `MAX_EMPTY_TOOL_ONLY_STREAK` happens in Phase 2 with the no-progress detector.)

**Modify: `src/context/contextManager.ts`**
- `REHYDRATION_MAX_CHARS = 12000` (line 50) → read from config.
- (`SUMMARY_MAX_CHARS` deletion happens in Phase 3 alongside the persistence work.)

**Modify: `src/context/types.ts`**
- `DEFAULT_BUDGET_POLICY` (lines 49–95) keeps current defaults but caller can pass overrides from `RuntimeConfig`.
- Wire `maxRecentTurns`, `artifactInlineCharCap` through.

**Modify: `src/context/promptBuilder.ts`**
- `RETRY_LEVELS` (lines 65–69): **delete the level-3 `(0, 0)` entry**. Table becomes 3 levels:
  - Level 0: `{ 1.0, 1.0 }` (unchanged)
  - Level 1: `{ 0.5, 1.0 }` (unchanged)
  - Level 2: `{ 0.25, 0.5 }` (unchanged)
- `MAX_CONTEXT_RETRY_LEVEL` stays at 3, but the semantic at level 3 changes: instead of indexing into `RETRY_LEVELS[3]` (now out of bounds), the caller observes "would-be level 3" and aborts via a `context_pressure_circuit_breaker` diagnostic. Add the abort path in the call sites at `agent.ts:1421-1437` and `agent.ts:1024-1039`.
- No smoothing, no level 4 — just remove the cliff entry and let the abort handle it.

**Modify: `src/tools/bash.ts`**
- Default timeout 30 s → 120 s; max 600 s. Both read from `RuntimeConfig`.
- `MAX_OUTPUT_SIZE` (line 13) read from `RuntimeConfig.toolOutputInlineLimit` (default still 50 KB). The full deletion of the silent-truncation path happens in Phase 3.

**Modify: `src/tools/read.ts`, `src/tools/grep.ts`**
- `READ_OUTPUT_LIMIT` (read.ts:6), `GREP_OUTPUT_LIMIT` (grep.ts:10) → read from `RuntimeConfig.toolOutputInlineLimit`.

**Modify: `src/context/memoryManager.ts`**
- `MAX_CONTENT_LENGTH = 500` (line 23) → read from `RuntimeConfig.pinnedMemoryMaxContentLength`; raise default to 2000.

**CLI surface — modify: `src/index.ts`**
- Parse `--max-iterations`, `--max-retries`, `--bash-timeout-ms`, `--stream-idle-timeout-ms` flags; pass into `loadRuntimeConfig({ cliOverrides })`.

**Settings — extend `~/.propio/settings.json` reader:**
- New top-level `runtime` object mirroring `RuntimeConfig` fields. Document in README / docs.

---

### Phase 2 — Loop cap, no-progress detector, output-token recovery

**Modify: `src/agent.ts`**

1. **`AgentStreamOptions` (lines 124–126):** add `maxIterations?: number` override. Falls through to runtime config.

2. **Delete `MAX_EMPTY_TOOL_ONLY_STREAK` and its fallback** — remove the constant at line 143, the streak tracking at line 1293–1294, and the fallback branch at 1297–1326 (which removes the offending assistant message and calls `requestFinalResponseWithoutTools`). The `requestFinalResponseWithoutTools` helper itself stays — the no-progress detector still uses it.

3. **No-progress detector** — new private helper `detectNoProgress(history, lookback)` that returns true if the last `lookback` iterations:
   - produced no new artifacts (compare artifact ids before/after),
   - issued only repeats of prior tool-call shapes (same tool + similar args hash),
   - and produced no new assistant text.
   Default lookback = 5. Emits `no_progress_detected` diagnostic, then calls `requestFinalResponseWithoutTools`. This is strictly a replacement, not an addition, for the deleted streak logic — same exit branch, better signal.

4. **Output-token recovery** — when the provider stream surfaces `max_output_tokens`, request a continuation up to `runtimeConfig.outputTokenRecoveryLimit` (default 3) times before surfacing the error. Hook into the response collection path (after `collectProviderStream`, around line 1408). New diagnostic `output_token_recovery_attempt`.

5. **Iteration-end diagnostic shape:** when the cap is reached (`max_iterations_reached`, line 1471), include `noProgressDetected: boolean` and the last-5-iteration tool-call histogram, so users can see whether the cap saved them from a loop or cut off real work.

**Modify: `src/diagnostics.ts`**
- Add event types: `no_progress_detected`, `output_token_recovery_attempt`, `output_token_recovery_exhausted`, `compaction_circuit_breaker_tripped`, `stream_idle_aborted`, `tool_output_persisted`.

---

### Phase 3 — Tool output persistence (mature-style)

**New file: `src/tools/outputPersistence.ts`**
- Exports `persistToolOutput({ toolName, content, mediaType, sessionDir })` → `{ artifactId, path, sizeBytes, lineCount, preview }`.
- Storage: `~/.propio/sessions/{workspaceHash}/artifacts/{sessionId}/{toolName}-{timestamp}-{rand}.{ext}`.
- `preview` = first `runtimeConfig.toolOutputInlineLimit` bytes (default 50 KB), with structured header:
  ```
  [output persisted: tool=bash size=2.4MB lines=18432 path=<sessionId>/bash-…log
   preview shows first 50000 bytes; read the full file with the Read tool using offset/limit]
  ```
- Atomic write via temp-file + rename.

**Modify: `src/tools/bash.ts`, `src/tools/read.ts`, `src/tools/grep.ts`** — and delete the silent-truncation path
- Today's flow: `output → truncateText(output, MAX_OUTPUT_SIZE) → string with marker`. This silent-truncation branch is **deleted**.
- New flow: `output.length > toolOutputPersistThreshold` → call `persistToolOutput`, return structured preview block, create `ArtifactRecord` referencing the file. `output.length ≤ threshold` → return as-is. There is no third "truncate inline" path.
- Remove `truncateText` calls from the tool result construction. (The `truncateText` helper in `src/tools/shared.ts:25–38` may stay if used by diagnostic strings elsewhere; not in the tool result path.)

**Modify: `src/tools/read.ts`**
- Verify it supports a persisted-artifact path as input (it should: it's just a file path). Add a note in the tool description so the model knows it can `Read` the persisted path with `offset`/`limit`.

**Delete `SUMMARY_MAX_CHARS` and `generateTextSummary`'s truncation**
- `src/context/contextManager.ts:49` — delete `SUMMARY_MAX_CHARS = 1500`.
- `src/context/contextManager.ts:235–242` — delete the flat-truncation branch in `generateTextSummary`. With the persistence work above, large tool outputs already arrive as preview blocks; small outputs are stored in full. The turn-record summary becomes "use the preview block as-is, or use the full content if it's small enough to keep". No separate flat-truncation step.
- This is a deletion in `contextManager.ts`, not a reconfiguration.

**New: aggregate tool-result cap per assistant message**
- In `src/context/contextManager.ts` (where tool results are attached to a turn), track total tool-result chars in the current pending assistant message. If the total exceeds `runtimeConfig.aggregateToolResultsLimit` (default 200 KB), force-persist additional results even if individually under threshold. Mirrors mature project's `MAX_TOOL_RESULTS_PER_MESSAGE_CHARS = 200,000`.

**Pruning:**
- On launch, prune session-artifact directories older than 7 days (configurable). Add to existing startup path in `src/index.ts`.

---

### Phase 4 — Shared retry helper at every provider boundary

**New file: `src/providers/withRetry.ts`**
- `withRetry<T>(fn: () => Promise<T>, opts: { maxRetries; baseDelayMs; maxDelayMs; isRetryable; on529Fallback? }): Promise<T>`
- Default `maxRetries = runtimeConfig.maxRetries` (10), `baseDelayMs = 500`, `maxDelayMs = 32_000`.
- Retryable: connection errors, 408, 409, 429, 5xx (except non-foreground 529 — see below).
- 529 ladder: after `runtimeConfig.consecutive529FallbackLimit` (default 3) consecutive 529s, call `on529Fallback` (e.g. surface a "provider overloaded" diagnostic and abort the turn rather than amplifying retries).
- Each retry emits a `provider_retry` diagnostic with attempt count + delay + reason.

**Modify: all provider files in `src/providers/`** (`anthropic.ts`, `openai.ts`, `openrouter.ts`, etc.)
- Wrap the streamChat HTTP call with `withRetry`.
- **Delete `openrouter.ts:561–615`** — the bespoke `shouldRetryWithoutTools` predicate and the retry-without-tools block. This is a straight deletion, not a refactor.
- Move the "no-tools fallback on final attempt" behavior into `withRetry` as a generic `onFinalRetry` hook the caller can supply. OpenRouter's call site passes `{ onFinalRetry: () => rebuildBodyWithoutTools() }`; other providers don't pass it. The no-tools fallback now lives in shared retry code, not in OpenRouter-specific code.

---

### Phase 5 — Circuit breakers and watchdogs

**Modify: `src/agent.ts`**

1. **Compaction circuit breaker.** In `runSummaryRefresh` (line 701) and `attemptSynchronousShrink` (line 782), track consecutive failure count. After `runtimeConfig.compactionFailureLimit` (default 3) consecutive failures, disable further refresh attempts for the rest of the session and emit `compaction_circuit_breaker_tripped`. Reset on successful refresh.

2. **Synchronous-shrink loop guard.** Track number of `attemptSynchronousShrink` invocations within a single turn; cap at `MAX_CONTEXT_RETRY_LEVEL + 1`. Prevents the (context error → shrink → still too long → context error) loop the doc warns about.

3. **Stream-idle watchdog.** In the provider stream consumer (after `collectProviderStream`, around line 1408 — or in each provider's stream consumer), if no chunk has arrived in `runtimeConfig.streamIdleTimeoutMs` (default 90 s), abort the stream, emit `stream_idle_aborted`, and either retry via `withRetry` or surface a clean error. Env-overridable via `PROPIO_STREAM_IDLE_TIMEOUT_MS`.

**Modify: `src/context/contextManager.ts`**
- Track compaction failure count on the `ContextManager` instance, exposed to the agent for circuit-breaker decisions.

---

## Verification

End-to-end check that the long-running scenarios work as intended.

**Unit tests** (add to existing test files):
- `src/__tests__/agent.test.ts` — iteration cap configurable, no-progress detector triggers correctly, output-token recovery loop.
- `src/context/__tests__/promptBuilder.test.ts` — new retry-level table; level 4 floor; circuit breaker abort.
- `src/context/__tests__/contextManager.test.ts` — compaction circuit breaker; aggregate tool-result cap.
- `src/providers/__tests__/withRetry.test.ts` (new) — backoff, 529 ladder, isRetryable predicate.
- `src/tools/__tests__/outputPersistence.test.ts` (new) — large output written to disk, preview structure, atomic write.
- `src/tools/__tests__/bash.test.ts` — default timeout 120 s, large stdout persisted, env override.
- `src/config/__tests__/runtimeConfig.test.ts` (new) — precedence (CLI > env > settings > defaults).

**Manual / integration checks:**
1. Run a synthetic 30-iteration scenario (script-driven) and confirm the cap engages cleanly with a `max_iterations_reached` diagnostic that includes the no-progress histogram.
2. Run a long-running bash command (`sleep 60`) — confirm it completes under the new 120 s default.
3. Capture a large `grep -r` output (10+ MB) and confirm it's persisted to disk, preview shown inline, and the model can re-read narrower slices via `Read`.
4. Force a 429 from OpenRouter (via a test stub) and confirm exponential backoff + 529 ladder behave as specified.
5. Trigger a context-length error mid-stream and confirm the shrink loop is bounded by the synchronous-shrink guard.
6. Stall a fake provider stream (no chunks for 90 s) and confirm the watchdog aborts with the right diagnostic.
7. Set `PROPIO_MAX_ITERATIONS=5` and run a task — confirm it caps at 5; then `--max-iterations=20` and confirm CLI override wins.

**Docs to update:**
- `docs/limits.md` — refresh constants and add the new env var / settings reference.
- `docs/long-running-bottlenecks.md` — mark items addressed; this doc becomes the "before" snapshot.
- `README.md` (or a new `docs/configuration.md`) — list all `PROPIO_*` env vars, CLI flags, and `settings.json` fields.

## Critical files (consolidated)

**New:**
- `src/config/runtimeConfig.ts`
- `src/providers/withRetry.ts`
- `src/tools/outputPersistence.ts`
- `src/config/__tests__/runtimeConfig.test.ts`
- `src/providers/__tests__/withRetry.test.ts`
- `src/tools/__tests__/outputPersistence.test.ts`

**Modified:**
- `src/agent.ts` (loop, iteration cap, no-progress detector, output-token recovery, circuit breakers, stream watchdog wiring)
- `src/context/contextManager.ts` (config wiring, compaction circuit breaker, aggregate tool-result cap)
- `src/context/promptBuilder.ts` (smoothed retry-level table, circuit breaker)
- `src/context/types.ts` (policy overrides)
- `src/context/memoryManager.ts` (`MAX_CONTENT_LENGTH` from config)
- `src/providers/openrouter.ts`, `anthropic.ts`, `openai.ts` (use `withRetry`; keep OpenRouter no-tools fallback as last attempt)
- `src/tools/bash.ts`, `src/tools/read.ts`, `src/tools/grep.ts` (config wiring, output persistence)
- `src/diagnostics.ts` (new event types)
- `src/index.ts` (CLI flags, startup pruning)
- `docs/limits.md`, `docs/long-running-bottlenecks.md`, `README.md` / new `docs/configuration.md`

## Rollout order

1. Phase 1 (config surface + tuning + level-3 cliff deletion) — ships first; everything downstream depends on `RuntimeConfig`. The retry-level deletion goes here because it's a tiny self-contained change.
2. Phase 4 (withRetry + provider boundaries + OpenRouter bespoke-path deletion) — independent, high value.
3. Phase 2 (loop cap configurable + delete `MAX_EMPTY_TOOL_ONLY_STREAK` + no-progress detector + output-token recovery) — depends on Phase 1.
4. Phase 3 (tool output persistence + delete silent truncation + delete `SUMMARY_MAX_CHARS`) — depends on Phase 1; touches tool surface, should land after the retry layer is stable.
5. Phase 5 (circuit breakers + watchdog) — depends on Phases 1, 2, 4.

Each phase ends with a net reduction in code (or close to it): the deletions are bigger than the additions in Phases 1, 2, 3, and 4.
