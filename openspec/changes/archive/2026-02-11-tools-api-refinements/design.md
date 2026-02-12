## Context

The tools module was extracted in `extract-tools-module` (PR #4) with a synchronous, `any`-typed API. During review, three API refinements were identified that are best made before downstream code depends on the current signatures.

The `chat()` and `streamChat()` methods in `Agent` are already async, but `ToolRegistry.execute()` and `Agent.saveContext()` are synchronous. All three built-in tool implementations use synchronous `fs` operations.

## Goals / Non-Goals

**Goals:**

- Make the tool execution API async to support future tools that perform I/O (API calls, database queries, async file operations)
- Add introspection methods to `ToolRegistry` so callers can query registry state without pulling full schemas
- Tighten type safety by replacing `any` with `unknown` in tool argument types

**Non-Goals:**

- Converting existing built-in tools to use async `fs` operations (they can return resolved promises)
- Adding structured return types (success/failure envelopes) — deferred per proposal
- File system security hardening (path traversal, size limits) — separate concern
- Changing the `Agent` public tool management API surface

## Decisions

### 1. Async execute via `async`/`await` (not union return type)

`ExecutableTool.execute()` changes to return `Promise<string>`. Tool implementations that are inherently synchronous simply declare `async execute()` and return a string directly — the runtime wraps it in a resolved promise.

**Alternatives considered:**

- `string | Promise<string>` union return — avoids forcing sync tools to be async, but pushes complexity to every caller (must always `await` or check), and `ToolRegistry` would need conditional awaiting logic. The uniform `Promise<string>` is simpler.
- Keep sync and add a separate `AsyncExecutableTool` interface — creates a parallel hierarchy and forces the registry to handle both, adding complexity without benefit.

**Rationale:** A single async interface is the simplest contract. The performance cost of wrapping sync returns in promises is negligible for tool execution. All call sites (`chat()`, `streamChat()`, `saveContext()`) are already in async contexts.

### 2. `Agent.saveContext()` becomes async

Currently `saveContext()` is synchronous, returning `string`. Since `ToolRegistry.execute()` now returns `Promise<string>`, `saveContext()` must return `Promise<string>`. This is a breaking change to the `Agent` public API.

**Rationale:** `saveContext()` delegates to `toolRegistry.execute()`, so its return type must match. Callers that currently ignore the return value are unaffected. Callers that use the return value need to `await` it.

### 3. Introspection via three focused methods

Add to `ToolRegistry`:

- `getToolNames(): string[]` — returns names of all registered tools (enabled and disabled), preserving registration order
- `hasTool(name: string): boolean` — checks if a tool is registered (regardless of enabled state)
- `isToolEnabled(name: string): boolean` — checks if a registered tool is currently enabled; returns `false` for unregistered tools

**Alternatives considered:**

- Single `getTools()` returning metadata objects — over-engineered for current needs, and the shape of tool metadata isn't settled yet.
- Expose `tools` and `enabledTools` as readonly — leaks internal data structures (`Map`, `Set`) and makes future refactoring harder.

**Rationale:** Three focused methods cover the introspection needs identified in the review (listing, existence checking, status checking) without coupling callers to internal data structures.

### 4. `Record<string, unknown>` for tool args

Change `execute(args: Record<string, any>)` to `execute(args: Record<string, unknown>)` on both `ExecutableTool` and `ToolRegistry.execute()`. Tool implementations must explicitly narrow/cast argument values.

**Rationale:** `unknown` forces explicit type checking at the point of use, catching type errors at compile time rather than runtime. Existing tools already access args by string key (`args.file_path`), so they need minor type assertions.

### 5. Explicit `ToolContext` type annotation in agent.ts

The `toolContext` variable in the `Agent` constructor (lines 122-132) relies on type inference. Add an explicit `: ToolContext` annotation to make the intent clear and catch accidental shape mismatches.

## Risks / Trade-offs

- **Breaking change to `saveContext()` return type** → Callers that use the return value must add `await`. Mitigated by: this is early in the API lifecycle with no known external consumers.
- **`Record<string, unknown>` requires type narrowing in tools** → Each tool's `execute()` method needs `as string` assertions or explicit checks when reading args. Mitigated by: this is a small number of tools with simple arg types, and the safety benefit outweighs the verbosity.
- **Async overhead for sync tools** → Wrapping sync returns in promises adds minimal overhead (microtask queue). Mitigated by: tool execution is not a hot path; LLM round-trip latency dominates.
