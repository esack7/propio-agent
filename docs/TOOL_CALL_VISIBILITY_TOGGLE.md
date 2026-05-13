# Tool Call Visibility Toggle Feature

## Overview
Add a keyboard shortcut (Ctrl+O) to toggle tool calling output on and off during interactive sessions, reducing visual clutter while preserving the ability to see details when needed.

## Rationale
Tool calling can muddy up the UI output, but it's useful to see when debugging. A toggle allows users to control the verbosity on-the-fly without restarting the session or using CLI flags.

## Recommended Implementation Approach

### 1. Extend the Visibility State Model
- Currently in `src/index.ts`, there's an `AssistantTurnVisibilityOptions` interface that already handles visibility toggles:
  - `showActivity`
  - `showStatus`
  - `showReasoningSummary`
  - `showContextStats`
  - `showPromptPlan`
- **Add**: `showToolCalls` boolean flag to this interface

### 2. Make it Mutable During Runtime
- Create a new file: `src/ui/visibilityState.ts` to manage the current visibility state during an interactive session
- This state can be toggled via keyboard shortcut without interrupting the conversation
- Keep the original `visibility` options from CLI args as the baseline

### 3. Hook Keyboard Input in `chatPromptSession.ts`
- This file already handles keyboard shortcuts (Ctrl+C, Ctrl+D, Ctrl+R, etc.)
- Add handling for **Ctrl+O** to toggle `showToolCalls`
- Display a small status indicator showing the current toggle state in the prompt footer

### 4. Pass Mutable Visibility Through Context
- Modify the `InteractiveSubmissionContext` to include a `visibilityState` object
- Update `runInteractiveTurn` and `streamAssistantTurn` to use this runtime state
- The `assistantTurnRenderer.ts` already filters tool output based on visibility, so it will automatically respect the toggle

### 5. Add to Slash Commands Help
- Document in `src/ui/slashCommands.ts` help text as a quick reference

## Why This Fits

- **Minimal architectural change**: Extends existing visibility patterns rather than introducing new concepts
- **Focused**: Doesn't touch the agent or tool logic, only rendering/UI layer
- **Composable**: Respects the existing `src/ui/` boundary and uses established patterns
- **Non-breaking**: CLI flags remain unchanged; the runtime toggle is additive
- **Testable**: Visibility state logic can be unit tested independently

## Files to Create/Modify

1. **Create** `src/ui/visibilityState.ts` — runtime visibility state manager
2. **Modify** `src/ui/chatPromptSession.ts` — add Ctrl+O handler
3. **Modify** `src/index.ts` — pass mutable visibility through context
4. **Modify** `src/ui/assistantTurnRenderer.ts` — use mutable visibility when available
5. **Modify** `src/ui/slashCommands.ts` — document the shortcut

## Implementation Notes

### Key Locations in Codebase

- **Visibility initialization**: `src/index.ts` line ~667
- **Interactive context**: `src/index.ts` line ~274 (`InteractiveSubmissionContext`)
- **Turn execution**: `src/index.ts` line ~285 (`runInteractiveTurn`)
- **Keyboard handlers**: `src/ui/chatPromptSession.ts` (search for `key.ctrl`)
- **Tool output filtering**: `src/ui/assistantTurnRenderer.ts` line ~30 (`previewToolResult`)

### Keyboard Shortcut Reference

Existing Ctrl bindings in `chatPromptSession.ts`:
- Ctrl+C — interrupt
- Ctrl+D — exit
- Ctrl+R — reverse history search
- Ctrl+E — open editor
- Ctrl+X — clear input
- Ctrl+G — cancel search

**Proposed**: Ctrl+O — toggle tool calls visibility (mnemonic: "Output")

### UX Considerations

- Show a brief indicator when toggle is activated (e.g., in prompt footer)
- Consider showing current state in the command line (enabled/disabled)
- Should survive session state but not persist between sessions unless explicitly saved to config

## Testing Strategy

1. Unit tests for `visibilityState.ts` state transitions
2. Integration tests for keyboard input handling in `chatPromptSession.ts`
3. E2E test verifying tool output appears/disappears when toggled
4. Verify non-interactive mode is unaffected (no runtime state mutations)
