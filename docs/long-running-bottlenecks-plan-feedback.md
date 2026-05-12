# Re-Review Feedback on Long-Running Bottlenecks Implementation Plan

This is feedback on the revised `docs/long-running-bottlenecks-plan.md` as an implementation plan for addressing `docs/long-running-bottlenecks.md`.

## Overall Assessment

The revised plan is much stronger than the prior version. It correctly moves the long-term-memory work to the rolling-summary layer, keeps tool-output persistence out of individual tools, adds `read` slicing, clarifies streaming retry semantics, and gates output-token recovery on a normalized terminal stream event.

There are still a few remaining issues to fix before this is implementation-ready. The main risks are artifact persistence/schema ownership, inconsistent no-progress rollout language, provider scope drift, runtime config injection into tools, and the fact that crash telemetry intentionally measures rather than fixes the mid-turn checkpointing bottleneck.

## Findings

### 1. Persisted tool artifacts still need schema/ownership clarification

Phase 3 says persistence lives in `Agent.processToolCall()`: the agent measures tool output, persists large content, replaces the tool result with a preview block, and then the context manager creates the `ArtifactRecord` referencing the file.

The current artifact model stores inline content. It does not currently have a file reference or external-storage field. If the agent passes only the preview to the context manager, the artifact will contain only the preview, not the full persisted output.

The aggregate tool-result cap has a related issue: the plan says `ContextManager` should force-persist additional results once aggregate tool-result chars exceed the cap, but `ContextManager` does not currently own the persistence layer or session artifact directory.

Recommendation:

- Extend `ArtifactRecord` / persisted artifact schema with explicit external storage metadata, such as `externalPath`, `storageRef`, or `contentLocation`.
- Decide whether persistence lives entirely in the agent before `recordToolResults()`, or entirely in the context layer with access to a persistence dependency.
- Avoid splitting the decision across agent and context unless the data contract is explicit.
- Add tests proving the full persisted output survives session export/import and can be re-read by path.

### 2. No-progress detector rollout language is contradictory

The revised plan contains three different rollout stories:

- The review-response section says the no-progress detector is authoritative by default when `runtimeConfig.useNoProgressDetector === true`.
- The “Not deleted” section says `MAX_EMPTY_TOOL_ONLY_STREAK` runs in parallel for one release as a logged-only signal.
- Phase 2 later says to flip the detector from logged-only to authoritative once data shows it triggers correctly.

These cannot all be true at once.

Recommendation: pick one rollout model and make every section consistent. The cleanest version is:

- `useNoProgressDetector: true` means the detector is authoritative.
- `useNoProgressDetector: false` means the old streak heuristic is authoritative fallback.
- No parallel logged-only path.
- Delete the fallback flag and streak branch in the next release if no regressions are reported.

### 3. Provider file list is out of date

The plan references provider files such as `anthropic.ts` and `openai.ts`, but the current repository providers are `bedrock.ts`, `gemini.ts`, `ollama.ts`, `openrouter.ts`, and `xai.ts`.

The terminal-event mapping also mentions Anthropic/OpenAI-specific signals. That may be useful conceptually, but implementers need mappings for the providers that actually exist in this repo.

Recommendation:

- Update Phase 4 and Phase 4.5 to list current provider files.
- Specify terminal stop-reason mapping for Bedrock, Gemini, Ollama, OpenRouter, and xAI.
- Keep Anthropic/OpenAI examples only if clearly labeled as future/provider-family guidance.

### 4. Runtime config injection into tools is underspecified

Phase 1 says `bash`, `read`, and `grep` should read limits from `RuntimeConfig`. Today, built-in tools expose `execute(args)` and receive no runtime config or execution context.

Recommendation: specify the wiring mechanism before implementation. Options:

- Constructor-inject `RuntimeConfig` into built-in tools when they are registered.
- Add a `ToolExecutionContext` argument to `ExecutableTool.execute()`.
- Keep tools simple and enforce limits/persistence in the agent layer only.

Constructor injection is probably the smallest change for timeout and limit defaults.

### 5. Crash telemetry measures bottleneck #8 but does not fix it

The plan now intentionally defers full autosave and adds an in-progress marker instead. That is a reasonable product tradeoff, but it should be described as “measured/deferred,” not “addressed.”

Also, the plan says the follow-up is gated on crash rate “across instrumented users,” but current diagnostics are local/debug-oriented. There is no obvious aggregation channel.

Recommendation:

- Mark bottleneck #8 as “telemetry/deferred” in the scope table.
- Define where crash telemetry is recorded and how the rate is computed.
- If telemetry is only local, phrase the acceptance criterion as local/project-maintainer observed data, not cross-user instrumentation.

### 6. Stream terminal event should follow existing event discriminators

The proposed `StreamTerminalEvent` uses `kind: "terminal"`, while the existing stream event model uses `type` as the discriminator.

Recommendation: use the existing convention:

```ts
interface StreamTerminalEvent {
  type: "terminal";
  stopReason: StopReason;
  rawProviderReason?: string;
}
```

This keeps event normalization consistent across providers and the agent loop.

## Bottom Line

The revised plan is directionally solid and substantially improved. Before implementation, I would revise the persistence/schema section, clean up the no-progress rollout contradiction, update provider scope to match the repo, and clarify runtime-config injection into tools. After those fixes, the plan should be ready to split into implementable phases.
