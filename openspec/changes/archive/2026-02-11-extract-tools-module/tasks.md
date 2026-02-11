## 1. Module Setup

- [x] 1.1 Create `src/tools/` directory
- [x] 1.2 Create `src/tools/__tests__/` directory

## 2. Core Interfaces and Types

- [x] 2.1 Create `src/tools/interface.ts` with ExecutableTool interface (name, getSchema(), execute())
- [x] 2.2 Create `src/tools/types.ts` with ToolContext interface (systemPrompt, sessionContext, sessionContextFilePath)
- [x] 2.3 Add JSDoc comments to interface.ts explaining property getter pattern for ToolContext

## 3. ToolRegistry Implementation

- [x] 3.1 Create `src/tools/registry.ts` with ToolRegistry class skeleton
- [x] 3.2 Implement `register(tool)` method (adds tool, enables by default)
- [x] 3.3 Implement `unregister(name)` method (removes tool, idempotent)
- [x] 3.4 Implement `enable(name)` method (marks tool as enabled)
- [x] 3.5 Implement `disable(name)` method (marks tool as disabled)
- [x] 3.6 Implement `getEnabledSchemas()` method (returns ChatTool[] for enabled tools only)
- [x] 3.7 Implement `execute(name, args)` method with try-catch error handling (returns error strings on failure)
- [x] 3.8 Add error handling for executing disabled tools (return "tool not available" message)
- [x] 3.9 Add error handling for executing nonexistent tools (return "tool not found" message)

## 4. Tool Implementations

- [x] 4.1 Create `src/tools/fileSystem.ts` with ReadFileTool class implementing ExecutableTool
- [x] 4.2 Implement ReadFileTool.getSchema() (return read_file ChatTool schema from current agent.ts)
- [x] 4.3 Implement ReadFileTool.execute() (migrate logic from executeTool() switch case)
- [x] 4.4 Create WriteFileTool class implementing ExecutableTool in same file
- [x] 4.5 Implement WriteFileTool.getSchema() (return write_file ChatTool schema from current agent.ts)
- [x] 4.6 Implement WriteFileTool.execute() (migrate logic from executeTool() switch case)
- [x] 4.7 Create `src/tools/sessionContext.ts` with SaveSessionContextTool class implementing ExecutableTool
- [x] 4.8 Implement SaveSessionContextTool constructor accepting ToolContext parameter
- [x] 4.9 Implement SaveSessionContextTool.getSchema() (return save_session_context ChatTool schema from current agent.ts)
- [x] 4.10 Implement SaveSessionContextTool.execute() (migrate logic from executeTool() switch case, use context properties)

## 5. Factory Implementation

- [x] 5.1 Create `src/tools/factory.ts` with createDefaultToolRegistry() function
- [x] 5.2 Implement factory to instantiate ReadFileTool, WriteFileTool, SaveSessionContextTool
- [x] 5.3 Implement factory to create ToolRegistry and register all three tools
- [x] 5.4 Return configured registry from factory

## 6. Agent Refactoring

- [x] 6.1 Import ToolRegistry and createDefaultToolRegistry in agent.ts
- [x] 6.2 Replace `private tools: ChatTool[]` field with `private toolRegistry: ToolRegistry`
- [x] 6.3 Update constructor to create ToolContext using property getters (get systemPrompt(), get sessionContext(), get sessionContextFilePath())
- [x] 6.4 Update constructor to replace `this.tools = this.initializeTools()` with `this.toolRegistry = createDefaultToolRegistry(toolContext)`
- [x] 6.5 Update `getTools()` method to delegate to `this.toolRegistry.getEnabledSchemas()`
- [x] 6.6 Update `chat()` method to replace `this.executeTool()` calls with `this.toolRegistry.execute()`
- [x] 6.7 Update `chat()` method to replace `this.tools` references with `this.toolRegistry.getEnabledSchemas()`
- [x] 6.8 Update `streamChat()` method to replace `this.executeTool()` calls with `this.toolRegistry.execute()`
- [x] 6.9 Update `streamChat()` method to replace `this.tools` references with `this.toolRegistry.getEnabledSchemas()`
- [x] 6.10 Update `saveContext()` method to delegate to `this.toolRegistry.execute("save_session_context", { reason })`
- [x] 6.11 Add public `addTool(tool: ExecutableTool)` method delegating to `this.toolRegistry.register(tool)`
- [x] 6.12 Add public `removeTool(name: string)` method delegating to `this.toolRegistry.unregister(name)`
- [x] 6.13 Add public `enableTool(name: string)` method delegating to `this.toolRegistry.enable(name)`
- [x] 6.14 Add public `disableTool(name: string)` method delegating to `this.toolRegistry.disable(name)`
- [x] 6.15 Remove `initializeTools()` method (lines 144-201)
- [x] 6.16 Remove `executeTool()` method (lines 371-414)

## 7. Testing

- [x] 7.1 Create `src/tools/__tests__/registry.test.ts`
- [x] 7.2 Write test: Register tool makes it available
- [x] 7.3 Write test: Unregister tool removes it
- [x] 7.4 Write test: Unregister nonexistent tool is idempotent
- [x] 7.5 Write test: Enable tool includes it in schemas
- [x] 7.6 Write test: Disable tool excludes it from schemas
- [x] 7.7 Write test: Execute disabled tool returns error
- [x] 7.8 Write test: Execute nonexistent tool returns error
- [x] 7.9 Write test: Execute successful tool returns result
- [x] 7.10 Write test: Execute throwing tool returns error string
- [x] 7.11 Create `src/tools/__tests__/implementations.test.ts`
- [x] 7.12 Write test: ReadFileTool reads file and returns content
- [x] 7.13 Write test: WriteFileTool writes content to file
- [x] 7.14 Write test: SaveSessionContextTool writes context to file using ToolContext
- [x] 7.15 Write test: SaveSessionContextTool reads live context values via property getters
- [x] 7.16 Write test: createDefaultToolRegistry creates registry with 3 tools enabled

## 8. Verification

- [x] 8.1 Run `npm run build` to ensure TypeScript compilation succeeds
- [x] 8.2 Run `npm test` to ensure all existing tests pass
- [x] 8.3 Verify `agent.getTools()` returns same 3 tool schemas as before refactor
- [x] 8.4 Verify tool execution works end-to-end (read_file, write_file, save_session_context)
- [x] 8.5 Verify backward compatibility: Agent constructor signature unchanged
- [x] 8.6 Check line count reduction in agent.ts (should be ~80 lines fewer)
