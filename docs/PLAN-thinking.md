# Optional Thinking UI

## Summary
Add live, provider-supplied thinking as an optional UI surface. Thinking is shown by default, toggled with `Ctrl+T` for the current interactive session, never persisted to session context, never included in final response text, and never emitted in `--json`.

## Implementation Changes
- Add `{ type: "thinking_delta"; delta: string }` to `ChatStreamEvent`, plus a matching `AgentVisibilityEvent`.
- Wire it through `Agent.normalizeStreamEvent()` and `normalizeAndEmitStreamEvent()` so thinking deltas call `emitVisibilityEvent(...)` but do not call `onToken`, do not affect `recordStreamChunk()` response text, and do not enter conversation history.
- Keep `thinking_delta` available to programmatic `onEvent` consumers; suppress it only from assistant response text, persisted session context, and CLI `--json` payloads.
- Update OpenRouter to emit `thinking_delta` immediately for every streamed `reasoning_content` chunk while still accumulating that same content for existing `reasoningContent` tool-call replay.
- Update Gemini to request visible thought summaries through its OpenAI-compatible `extra_body.google.thinking_config.include_thoughts` flag when live thinking is requested, while keeping `thoughtSignature` replay-only for tool-call rounds. Leave xAI/Bedrock/Ollama no-op for v1 unless they already expose an explicit reasoning stream.

## UI Behavior
- Rename `toolCallVisibility.ts` to `sessionVisibility.ts` and keep the same stateful toggle pattern, now with `showToolCalls` and `showThinking`; default `showThinking: true`.
- Change `getIdleFooterText(...)` to accept the visibility snapshot and render both shortcuts, for example: `Enter to send | ? help | Ctrl+O tools: shown | Ctrl+T thinking: shown`.
- Add `Ctrl+T` to `chatPromptSession.ts`, `promptComposer.ts`, footer refresh tests, and `/help` chat shortcuts.
- Hidden mode state rules:
  - Start `Thinking` / phase `thinking` only on first `thinking_delta`; non-thinking models do not get a synthetic thinking spinner.
  - If a provider only exposes thinking bundled with a later tool-call event and never emits per-chunk `thinking_delta`, hidden mode may skip `Thinking` and go straight to existing tool UI or `Working` status; acceptable for v1.
  - Clear hidden thinking on first non-whitespace assistant text, visible tool UI, abort/error, empty turn completion, or turn end.
  - If hidden tools begin while hidden thinking is active, switch to existing `Working` / phase `tool call`.
  - If more hidden thinking arrives after a tool finishes and before answer text, show `Thinking` again.
  - `--show-status` / `--show-trace` do not imply visible thinking; normal status traces continue, with tool/thinking status using the existing single status surface.
- Visible mode rendering:
  - Render a subtle retained `Thinking` block separate from `mdStream`; when thinking arrives before answer text, it appears above the assistant answer.
  - Keep already-rendered thinking visible after answer text starts, but do not buffer answer text behind the thinking stream; answer tokens should continue streaming as soon as they arrive.
  - When visible thinking and visible tool calls are both enabled, commit tool start/result output as transcript lines instead of retained bottom-zone updates. Close the current thinking line before tool output, then start later thinking deltas after the tool lines so the two surfaces do not repaint over each other.
  - In append-only terminal output, provider thinking that arrives after answer text has already streamed may render after the current answer text rather than being moved back into the earlier thinking block.
  - Do not remove the visible thinking block from `clearEphemeralSurfaces()`; hidden thinking spinners are ephemeral, visible thinking text is retained transcript state.
  - `Ctrl+T` during an in-flight turn affects only future deltas; do not replay thinking that was hidden before the toggle.
  - Coalesce high-frequency deltas in the UI layer before repainting to avoid terminal jitter.

## Tests
- Type tests for `thinking_delta`.
- OpenRouter tests for per-chunk `reasoning_content` live events and preserved tool-call `reasoningContent`.
- Agent tests proving thinking is forwarded as visibility only and excluded from final response/session context.
- Assistant renderer tests for hidden spinner lifecycle, tool precedence, visible thinking block, non-thinking streams, abort/error cleanup, and empty responses.
- Prompt/footer/help tests for `Ctrl+T`, full visibility snapshot footer text, and session-persistent toggle state.
- Retained TTY tests covering thinking block rendering and `clearEphemeralSurfaces()` interactions.

## Assumptions
- `Ctrl+T` is accepted as the thinking toggle and persists for the current interactive session only.
- This feature displays provider-supplied thinking content when available; it does not synthesize thinking for models that do not provide it.
- Visible thinking shows full provider-supplied deltas for v1; no preview truncation.
- Existing `--show-reasoning-summary` remains independent. If enabled alongside visible thinking, the post-turn summary still renders after the answer.
- The visible thinking stream plus post-turn reasoning summary can duplicate information; this is accepted for v1 to keep existing flags predictable.
- Piped/non-TTY/plain output does not print hidden thinking lines; visible thinking is an interactive UI feature.
