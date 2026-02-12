## Why

The agent has 10 built-in tools with an existing enable/disable API on the registry and agent, but there is no way for users to view or toggle tools from the TUI. Users must modify code to change which tools are available. A `/tools` command with an interactive menu would let users inspect registered tools and toggle them at runtime, providing visibility and control over agent capabilities—especially important for security-sensitive tools like `run_bash` and `remove`.

## What Changes

- Add a `/tools` slash command to the TUI that opens a tool management menu
- The menu displays all registered tools with their current enabled/disabled status as a numbered list
- Users select a tool by typing its number, then confirm to toggle its state
- Display confirmation warnings when enabling potentially dangerous tools (`run_bash`, `remove`)
- Text-based interaction for now (numbered prompts), but structured so the menu logic is isolated and can be swapped to an interactive arrow-key UI (e.g., `inquirer`) in the future
- Extend the command dispatch system in the main chat loop to support the new command
- Update startup help text to include the `/tools` command

## Capabilities

### New Capabilities

- `tool-menu`: Text-based TUI menu for viewing and toggling registered tools, including danger warnings for security-sensitive tools. Designed with a separated menu module to allow future migration to interactive (arrow-key) selection.

### Modified Capabilities

_None. The existing `tools-module` spec covers the registry API (enable/disable/introspection) which already supports this feature. No spec-level requirement changes are needed—only a new UI layer on top._

## Impact

- **Code**: `src/index.ts` (command dispatch, menu rendering), potentially a new `src/ui/toolMenu.ts` module for menu logic
- **UI**: New text-based menu using existing `readline` for numbered-list selection (no new dependencies)
- **Dependencies**: No new external dependencies expected—built on existing `readline` and `src/ui/` formatting utilities
- **Tools module**: No changes needed—`ToolRegistry` already exposes `getToolNames()`, `isToolEnabled()`, and the agent already has `enableTool()`/`disableTool()`
