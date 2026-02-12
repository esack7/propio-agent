## 1. Agent Introspection Methods

- [x] 1.1 Add `getToolNames(): string[]` method to `Agent` in `src/agent.ts` that delegates to `this.toolRegistry.getToolNames()`
- [x] 1.2 Add `isToolEnabled(name: string): boolean` method to `Agent` in `src/agent.ts` that delegates to `this.toolRegistry.isToolEnabled(name)`
- [x] 1.3 Write tests for `agent.getToolNames()` and `agent.isToolEnabled()` verifying they return correct values for enabled, disabled, and nonexistent tools

## 2. Tool Menu Module

- [x] 2.1 Create `src/ui/toolMenu.ts` with `DANGEROUS_TOOLS` set containing `"run_bash"` and `"remove"`
- [x] 2.2 Implement `showToolMenu(rl, agent, onDone)` function that displays the numbered tool list with `[enabled]`/`[disabled]` status
- [x] 2.3 Implement tool toggle logic: parse user number input, call `agent.enableTool()` or `agent.disableTool()`, re-display the list
- [x] 2.4 Implement dangerous tool confirmation: show warning and prompt for `y` before enabling a dangerous tool; any other input leaves the tool disabled
- [x] 2.5 Implement exit handling: `q` or empty input calls `onDone` to return to the main prompt
- [x] 2.6 Implement invalid input handling: non-numeric text (other than `q`) and out-of-range numbers show an error and re-prompt
- [x] 2.7 Write tests for `showToolMenu` covering: tool list display, toggle enabled→disabled, toggle disabled→enabled, dangerous tool confirmation, dangerous tool decline, invalid input, and exit

## 3. Command Wiring

- [x] 3.1 Add `/tools` command to the `if` chain in `src/index.ts` that calls `showToolMenu(rl, agent, prompt)`
- [x] 3.2 Update the startup help text to include `/tools` alongside `/clear`, `/context`, `/exit`
