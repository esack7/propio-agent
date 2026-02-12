## Context

The TUI currently has three slash commands (`/exit`, `/clear`, `/context`) handled by simple string matching in `src/index.ts`. The `ToolRegistry` already exposes introspection methods (`getToolNames()`, `isToolEnabled()`) and the `Agent` has `enableTool()`/`disableTool()` methods, but there is no user-facing way to invoke them. All user interaction is line-based via `readline.question()` — no interactive selection libraries are available.

Two tools (`remove` and `run_bash`) are disabled by default due to their destructive potential and require explicit opt-in.

## Goals / Non-Goals

**Goals:**

- Let users view all registered tools and their enabled/disabled status from the TUI
- Let users toggle tools on/off by typing a number from a list
- Warn users before enabling dangerous tools (`run_bash`, `remove`)
- Keep the menu module isolated so it can later be replaced with an interactive (arrow-key) UI
- Expose the `ToolRegistry` to the command layer so the menu can query and mutate tool state

**Non-Goals:**

- Interactive arrow-key navigation (future work)
- Persisting tool enable/disable state across sessions
- A general-purpose command dispatch/registry system (commands stay as simple `if` blocks for now)
- Adding or removing tools from the menu (only enable/disable)

## Decisions

### 1. New module: `src/ui/toolMenu.ts`

The menu logic lives in a dedicated module rather than inline in `src/index.ts`. This keeps the main loop lean and makes the menu swappable for a future interactive implementation.

The module exports a single function:

```ts
showToolMenu(
  rl: readline.Interface,
  agent: Agent,
  onDone: () => void
): void
```

It takes the existing `readline` interface (to prompt the user), the `Agent` (to query/toggle tools), and a callback to return control to the main prompt loop when the user exits the menu.

**Why a callback instead of a Promise?** The existing prompt loop in `index.ts` uses a recursive `rl.question()` pattern, not async/await. A callback-based `onDone` fits naturally into this pattern without refactoring the main loop.

**Alternatives considered:**
- Inline in `index.ts`: Rejected — bloats the main loop and makes future replacement harder.
- Class-based menu: Rejected — over-engineering for a single function with no state between invocations.

### 2. Agent exposes tool introspection

The `Agent` class needs two new methods to expose registry state to the UI layer:

```ts
getToolNames(): string[]
isToolEnabled(name: string): boolean
```

These are thin delegations to `ToolRegistry`, matching the existing pattern of `enableTool()` / `disableTool()` / `getTools()`. The UI should not access the registry directly — the `Agent` is the public API.

**Alternatives considered:**
- Expose `ToolRegistry` directly: Rejected — breaks encapsulation. The Agent owns the registry.
- Pass registry to the menu function: Rejected — same encapsulation issue, and inconsistent with how other Agent interactions work.

### 3. Dangerous tools list defined as a constant

A `DANGEROUS_TOOLS` set (containing `"run_bash"` and `"remove"`) is defined in `toolMenu.ts`. When a user attempts to enable one of these tools, the menu shows a warning and requires explicit `y/n` confirmation before proceeding.

**Why not metadata on the tool itself?** The `ExecutableTool` interface doesn't have a `dangerous` flag, and adding one would be a larger change touching all tool implementations. A simple constant in the menu module is sufficient and easy to extend.

### 4. Menu flow

The `/tools` command triggers the following text-based interaction:

```
Tools:
  1. read_file       [enabled]
  2. write_file      [enabled]
  3. run_bash        [disabled]
  ...

Enter tool number to toggle, or 'q' to quit:
```

- User types a number → tool is toggled (with warning if dangerous)
- User types `q` or empty → returns to main prompt
- After toggling, the menu re-displays so the user can make additional changes
- Invalid input shows a brief error and re-prompts

### 5. Command wiring in `index.ts`

The `/tools` command is added as another `if` block in the existing command dispatch chain, matching the pattern of `/exit`, `/clear`, `/context`. The menu takes over the readline interface and calls `prompt()` via `onDone` when the user exits.

The startup help text is updated to include `/tools`.

## Risks / Trade-offs

- **No persistence** → Tool toggles reset on restart. This is acceptable for now; persistence can be added later via `~/.propio/settings.json` without changing the menu API.
- **Hardcoded dangerous tools list** → If new dangerous tools are added, `DANGEROUS_TOOLS` must be updated manually. Acceptable trade-off vs. adding metadata to the tool interface.
- **Callback-based API** → Slightly less ergonomic than async/await, but fits the existing codebase pattern. Can be migrated when/if the main loop is refactored.
