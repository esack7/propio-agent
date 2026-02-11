## Why

The tools module API (from `extract-tools-module`) is correct but has three limitations identified during PR review that are best addressed before the API solidifies: synchronous-only execution prevents future async tools, no way to introspect registry state, and `any` types that weaken type safety.

## What Changes

- **BREAKING**: `ExecutableTool.execute()` return type changes from `string` to `Promise<string>`, and `ToolRegistry.execute()` becomes async accordingly. All callers (`Agent.chat()`, `Agent.streamChat()`, `Agent.saveContext()`) must await tool results.
- Add introspection methods to `ToolRegistry`: `getToolNames()`, `hasTool(name)`, `isToolEnabled(name)` for querying registry state without needing full schemas.
- Change `ExecutableTool.execute()` parameter type from `Record<string, any>` to `Record<string, unknown>` for stricter type safety.
- Add explicit `ToolContext` type annotation to the factory function return in `agent.ts`.

## Capabilities

### New Capabilities

_(none)_

### Modified Capabilities

- `tools-module`: Execution becomes async (`Promise<string>`), registry gains introspection methods, execute args type tightened to `unknown`.

## Impact

- `src/tools/interface.ts` — `ExecutableTool` interface signature changes
- `src/tools/registry.ts` — `execute()` becomes async, new introspection methods added
- `src/tools/fileSystem.ts`, `src/tools/sessionContext.ts` — `execute()` return type changes to `Promise<string>`
- `src/agent.ts` — Tool execution calls must be awaited, factory function gets explicit return type
- `src/tools/__tests__/` — Tests updated for async execution and new introspection methods
