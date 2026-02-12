## Why

The CLI currently outputs everything as unstyled plain text, making it difficult for users to visually distinguish between their own input, assistant responses, tool execution events, and errors. Adding color coding and interactive feedback (spinners) will improve usability by creating clear visual hierarchy and providing real-time progress indication during async operations.

## What Changes

- Add a new `src/ui/` module with color palette, symbol definitions, and high-level formatting functions based on the One Atom Dark color scheme
- Add `chalk` dependency for terminal color support and `ora` for spinner animations
- Update `src/index.ts` to use colored output for welcome messages, command help, prompts, context display, streaming responses, and error handling
- Update `src/agent.ts` to use colored tool execution notifications and spinner feedback during tool calls
- Support `NO_COLOR` environment variable and terminal capability detection for graceful degradation

## Capabilities

### New Capabilities

- `cli-theming`: Color palette, symbol definitions, and formatting functions for terminal output (One Atom Dark theme with NO_COLOR support)
- `operation-feedback`: Spinner-based progress indicators for async operations (tool execution, LLM response generation)

### Modified Capabilities

- `agent-core`: Tool execution notifications will use colored formatters and spinners instead of plain-text callbacks

## Impact

- **Dependencies**: Adds `chalk` (5.6.2) and `ora` (9.3.0) as pinned production dependencies
- **Code**: New `src/ui/` directory with colors, symbols, formatting, and spinner modules. Modifications to `src/index.ts` (console output calls) and `src/agent.ts` (tool notification callbacks)
- **APIs**: No API changes. The `onToken` callback signature in agent.ts remains the same; formatting is applied at the call site
- **Compatibility**: Respects NO_COLOR env var and auto-detects terminal capabilities. Falls back to plain text when colors are unsupported or stdout is redirected
