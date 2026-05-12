# Feedback on Long-Running Bottlenecks Implementation Plan

This is feedback on `docs/long-running-bottlenecks-plan.md` as an implementation plan for addressing the issues cataloged in `docs/long-running-bottlenecks.md`.

## Overall Assessment

The plan has a strong strategic direction: configurable operational limits, removal of brittle loop heuristics, better provider retry behavior, bounded recovery paths, and persisted large tool outputs are all useful moves for long-running agent work.

That said, I would revise the plan before implementation. A few sections either do not fully address the original bottleneck or assume APIs and ownership boundaries that the current codebase does not yet have. The highest-risk gaps are around mid-turn durability, rolling-summary quality, tool-output persistence boundaries, and retrying streaming provider calls.

## Key Feedback

### 1. Do not replace mid-turn checkpointing with retries and output persistence alone

`docs/long-running-bottlenecks.md` identifies the lack of mid-turn checkpointing as a durability problem: a crash, fatal provider error, or unrecoverable context error can lose all in-memory progress since the last user message.

The plan replaces explicit checkpointing with retry budgets, circuit breakers, and disk-persisted large tool outputs. Those are useful, but they do not preserve the full turn state:

- Small tool results may never be persisted to disk.
- Assistant messages, pending tool calls, reasoning state, and current turn metadata remain in memory.
- Existing session snapshots still happen primarily on explicit exit paths.

Recommendation: add a lightweight autosave/checkpoint after important state mutations, especially after assistant responses and tool-result commits. This does not need to be elaborate, but the plan should include a real persistence point for turn state.

### 2. The summary fix targets the wrong layer

The plan treats deleting `SUMMARY_MAX_CHARS` and `generateTextSummary()` as the main answer to the undersized-summary bottleneck. In the current code, that constant controls per-tool-result summaries stored on tool invocations, not the rolling long-term session summary.

The rolling summary is governed by `SummaryPolicy.summaryTargetTokens`, and the summary serializer further clips tool invocation summaries before sending them to the summarizer. So removing `generateTextSummary()` may increase prompt bloat without materially improving long-term continuity.

Recommendation: revise the summary work to explicitly improve the rolling summary layer. Options include:

- Raise or configure `summaryTargetTokens`.
- Make summaries more structured, with sections for goals, constraints, decisions, files touched, test status, and open threads.
- Adjust the summarization serializer so important tool results are preserved selectively rather than blindly clipped.
- Keep per-tool-result summaries bounded unless persistence/rehydration semantics are clearly changed.

### 3. Tool-output persistence needs to respect current ownership boundaries

The plan says tools should persist output and create `ArtifactRecord`s, but current tools return only strings, and artifact records are created centrally by the context manager when tool results are recorded.

That means the proposed implementation crosses an ownership boundary that does not currently exist. Either the tool interface needs to change deliberately, or persistence should happen in the agent/context layer after tool execution.

Recommendation: choose one clear design:

- Keep tools returning strings, then persist large outputs in `Agent.processToolCall()` or `ContextManager.recordToolResults()`.
- Or change the tool execution interface to return structured results with optional persisted-output metadata.

The first option is likely smaller and more consistent with the current architecture.

### 4. Add read slicing before relying on persisted-output re-reading

The plan’s preview text tells the model to re-read persisted output with `offset` and `limit`, but the current `read` tool only accepts a `path`.

Recommendation: include `read` enhancements in the same phase as output persistence:

- Add `offset` and `limit`, or preferably line-based `startLine` and `lineCount`.
- Update the tool description so the model knows how to page through persisted logs.
- Add tests for reading persisted artifacts in slices.

Without this, persisted output helps avoid silent truncation but does not provide a complete workflow for inspecting large logs or search results.

### 5. Streaming retries need more precise semantics

The shared `withRetry` idea is good, but provider streaming makes retries tricky. If a provider fails after partial output has already been streamed to the user or committed to state, blindly retrying can duplicate text, repeat tool calls, or corrupt the turn.

Recommendation: split retry behavior into explicit categories:

- Safe retries before any response body chunks are consumed.
- Optional buffered retries before anything is emitted to the agent/user.
- No automatic retry after assistant text or tool calls have been surfaced, unless a continuation protocol exists.

The plan should specify where retries wrap provider calls and how partial stream output is handled.

### 6. Output-token recovery needs provider/event model support

The plan proposes continuation when the provider stream surfaces `max_output_tokens`, but the current stream event model does not expose a terminal stop reason. Some providers may know about `max_tokens` internally, but the agent does not receive that as a normalized event.

Recommendation: first add a provider-agnostic terminal stream event or error type that can carry stop reasons such as `max_tokens`. Then implement continuation recovery on top of that event. This keeps the recovery feature from becoming provider-specific glue.

### 7. Be cautious about deleting the empty-tool-only streak before replacement is proven

Deleting the current heuristic is reasonable, but the proposed no-progress detector is more complex than it sounds. “Same tool plus similar args hash,” “new artifacts,” and “new assistant text” can all produce false positives or false negatives.

Recommendation: implement this as a narrowly scoped replacement with good diagnostics and tests. Consider landing it behind configuration or emitting warnings before forcing a no-tools final response.

## Suggested Plan Revisions

Before implementation, I would update the plan to include:

1. A real mid-turn autosave/checkpoint mechanism after assistant and tool-result commits.
2. A rolling-summary-focused fix, not just deletion of per-tool-result truncation.
3. A clear ownership decision for output persistence.
4. `read` slicing support as part of the output-persistence phase.
5. A streaming-safe retry model that distinguishes pre-stream failures from mid-stream failures.
6. A normalized terminal stream event for stop reasons before output-token recovery.
7. More precise tests for no-progress detection and streaming retry behavior.

## Bottom Line

The plan is directionally strong, but it is not yet implementation-ready. With the revisions above, it would better address the original bottlenecks without introducing fragile cross-layer behavior or accidentally solving the wrong problem at the wrong abstraction layer.
