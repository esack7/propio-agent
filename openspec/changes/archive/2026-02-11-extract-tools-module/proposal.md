## Why

The `src/agent.ts` file currently mixes orchestration logic with tool definition and execution. Tool schemas are hardcoded in `initializeTools()` and execution logic lives in a large `executeTool()` switch statement. This tight coupling makes it difficult to add, remove, enable, or disable tools at runtime, and violates separation of concerns.

## What Changes

- Extract all tool definitions and execution logic from `src/agent.ts` into a dedicated `src/tools/` module
- Introduce an `ExecutableTool` interface that bundles each tool's LLM schema and execution logic together
- Create a `ToolRegistry` class that manages tool lifecycle (register, unregister, enable, disable, execute)
- Implement a `ToolContext` interface for dependency injection (replacing direct coupling to Agent state)
- Create a factory function `createDefaultToolRegistry()` that provides the three built-in tools
- Refactor `src/agent.ts` to delegate all tool operations to the registry
- Add public methods to Agent for runtime tool management: `addTool()`, `removeTool()`, `enableTool()`, `disableTool()`

This follows the same architectural pattern as the existing `src/providers/` module.

## Capabilities

### New Capabilities

- `tools-module`: A pluggable tools system with registry-based management, enabling runtime tool composition and independent tool implementation

### Modified Capabilities

<!-- No existing capabilities are being modified - this is a pure refactoring -->

## Impact

**Files Modified:**

- `src/agent.ts` — Remove ~80 lines of hardcoded tool logic, add registry delegation (net reduction)

**Files Created:**

- `src/tools/interface.ts` — ExecutableTool interface
- `src/tools/types.ts` — ToolContext interface
- `src/tools/registry.ts` — ToolRegistry class
- `src/tools/fileSystem.ts` — ReadFileTool, WriteFileTool implementations
- `src/tools/sessionContext.ts` — SaveSessionContextTool implementation
- `src/tools/factory.ts` — createDefaultToolRegistry() factory
- `src/tools/__tests__/registry.test.ts` — Registry unit tests
- `src/tools/__tests__/implementations.test.ts` — Tool implementation tests

**API Impact:**

- Agent constructor signature unchanged (backward compatible)
- New public methods: `addTool()`, `removeTool()`, `enableTool()`, `disableTool()`
- All existing tool behavior preserved (read_file, write_file, save_session_context)
- Test surface remains the same (tests mock at provider level)

**Unlocks:**

- Runtime tool composition (add/remove tools after agent creation)
- Tool marketplace potential (third-party tool packages)
- Easier testing (mock individual tools vs entire agent)
- Tool-specific configuration and state management
