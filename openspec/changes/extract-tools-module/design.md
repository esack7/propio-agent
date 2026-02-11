## Context

The current `src/agent.ts` implementation has ~400 lines of mixed concerns. Tool definitions are hardcoded in a 57-line `initializeTools()` method that builds `ChatTool` objects inline. Tool execution lives in a 43-line `executeTool()` switch statement. The agent's `private tools: ChatTool[]` field only stores schemas - execution logic is disconnected.

This creates several problems:
1. **No runtime composition**: Tools can't be added, removed, or toggled after agent creation
2. **Tight coupling**: The `save_session_context` tool directly accesses agent internals (`this.systemPrompt`, `this.sessionContext`, `this.sessionContextFilePath`)
3. **Violation of SRP**: Agent handles orchestration AND tool management
4. **Testing friction**: Can't mock or test individual tools without instantiating entire agent

The codebase already has precedent for modular architecture: `src/providers/` uses a flat-file pattern with interface-based implementations (OpenAI, Anthropic, OpenRouter).

## Goals / Non-Goals

**Goals:**
- Separate tool concerns from agent orchestration
- Enable runtime tool composition (add/remove/enable/disable after creation)
- Support dependency injection for stateful tools
- Maintain 100% backward compatibility (same 3 tools, same behavior)
- Reduce Agent class size (~80 line reduction)
- Follow existing providers module architectural pattern

**Non-Goals:**
- Async tool execution (current tools are synchronous, maintain this)
- Tool versioning or migration system
- Tool discovery/plugin system (future work)
- Tool-to-tool communication
- Streaming tool results (all tools return strings)

## Decisions

### 1. ExecutableTool interface bundles schema + execution

**Decision**: Each tool implements `ExecutableTool` with `name`, `getSchema()`, and `execute()` methods.

**Rationale**:
- The current architecture splits schema definition (in `initializeTools()`) from execution logic (in `executeTool()`), requiring developers to update two distant locations when modifying a tool
- Bundling creates a cohesive unit - tool authors implement one class containing both LLM schema and behavior
- Enables tool implementations to be self-contained and independently testable

**Alternatives considered**:
- *Separate schema and executor*: Rejected because it perpetuates the current split-brain problem
- *Function-based tools*: Rejected because classes provide better encapsulation for stateful tools like `SaveSessionContextTool`

### 2. ToolContext interface for dependency injection

**Decision**: Define `ToolContext` interface with `systemPrompt`, `sessionContext`, and `sessionContextFilePath`. Agent creates context object using JavaScript property getters, not a static snapshot.

**Rationale**:
- `SaveSessionContextTool` needs access to current agent state, but shouldn't couple to the Agent class directly
- Property getters ensure tools always read fresh values (critical because `sessionContext` is reassigned in `clearContext()` and `systemPrompt` can change via `setSystemPrompt()`)
- Interface-based injection makes tools testable (pass mock context in tests)

**Alternatives considered**:
- *Pass Agent instance*: Rejected because it creates tight coupling and makes tools dependent on entire Agent API
- *Static snapshot*: Rejected because state changes (clearContext, setSystemPrompt) would not propagate to tools

**Implementation**:
```typescript
const toolContext: ToolContext = {
  get systemPrompt() { return this.systemPrompt; },
  get sessionContext() { return this.sessionContext; },
  get sessionContextFilePath() { return this.sessionContextFilePath; }
};
```

### 3. Enable/disable as registry concern, not tool concern

**Decision**: `ToolRegistry` tracks enabled state. Tools remain stateless - they don't know if they're enabled or disabled.

**Rationale**:
- Enable/disable is an orchestration concern, not tool logic
- Allows enable/disable without mutating tool instances
- Registry can enforce rules (e.g., prevent disabling required tools) in future iterations
- Simpler tool implementations - authors don't think about lifecycle

**Alternatives considered**:
- *Tools have enabled flag*: Rejected because it adds state to tools and mixes concerns

### 4. Registry wraps tool execution in error handling

**Decision**: `ToolRegistry.execute()` wraps tool calls in try/catch, returning error messages as strings on failure.

**Rationale**:
- Current `executeTool()` behavior returns string error messages (e.g., "Error writing file: ...")
- Maintains backward compatibility with provider expectations
- Centralizes error formatting (tools throw, registry formats)
- Allows tools to use standard TypeScript error handling

**Current behavior preserved**:
```typescript
execute(name: string, args: Record<string, any>): string {
  try {
    const tool = this.getTool(name);
    return tool.execute(args);
  } catch (error) {
    return `Error executing ${name}: ${error.message}`;
  }
}
```

### 5. Flat module structure following providers pattern

**Decision**: Use flat file structure in `src/tools/` with no barrel index, matching `src/providers/`.

**Rationale**:
- Consistency with existing codebase architecture
- Explicit imports improve IDE navigation and reduce circular dependency risk
- Separate files for interface, types, registry, implementations, and factory

**Structure**:
```
src/tools/
├── interface.ts          # ExecutableTool interface
├── types.ts              # ToolContext interface
├── registry.ts           # ToolRegistry class
├── fileSystem.ts         # ReadFileTool, WriteFileTool
├── sessionContext.ts     # SaveSessionContextTool
├── factory.ts            # createDefaultToolRegistry()
└── __tests__/
```

### 6. Factory function creates default registry

**Decision**: Export `createDefaultToolRegistry(context: ToolContext): ToolRegistry` rather than requiring manual tool registration.

**Rationale**:
- Ergonomic default case: `new Agent()` just works with standard tools
- Encapsulates "which tools are built-in" knowledge
- Extensibility: Advanced users can create empty registry and register custom tools

**Usage**:
```typescript
// Default case (in Agent constructor)
this.toolRegistry = createDefaultToolRegistry(toolContext);

// Advanced case (custom tools)
const registry = new ToolRegistry();
registry.register(new CustomTool());
```

## Risks / Trade-offs

**[Risk]** Property getter pattern for ToolContext is less common than passing methods/callbacks
→ **Mitigation**: Document clearly in types.ts. Pattern is used successfully in reactive frameworks (Vue, MobX).

**[Risk]** String-based tool execution (`execute(name, args)`) loses type safety
→ **Mitigation**: Current implementation already lacks type safety. Future improvement could use TypeScript template literals or tool-specific execute methods. Not changing behavior in this refactor.

**[Risk]** Three built-in tools hardcoded in factory limits extensibility
→ **Mitigation**: Public `addTool()` API allows runtime addition. Factory is convenience, not restriction.

**[Trade-off]** More files (8 new) increases cognitive overhead for simple changes
→ **Benefit**: Better separation makes complex changes easier (e.g., adding tool with new dependencies). Net win as system grows.

**[Trade-off]** Indirection through registry adds call stack depth
→ **Benefit**: Negligible performance impact (tool execution is I/O bound). Maintainability gains justify abstraction cost.
