## ADDED Requirements

### Requirement: ExecutableTool interface

The system SHALL provide an `ExecutableTool` interface that bundles tool schema and execution logic. Each tool implementation MUST expose a unique `name` property, a `getSchema()` method that returns a `ChatTool` object, and an `execute(args)` method that accepts argument records and returns a string result.

#### Scenario: Tool provides schema

- **WHEN** a tool's `getSchema()` method is called
- **THEN** the system returns a `ChatTool` object containing the tool's function definition for LLM consumption

#### Scenario: Tool executes with arguments

- **WHEN** a tool's `execute()` method is called with valid arguments
- **THEN** the system executes the tool logic and returns a string result

#### Scenario: Tool name matches schema

- **WHEN** a tool's `getSchema()` method returns a schema
- **THEN** the schema's function name MUST match the tool's `name` property

### Requirement: ToolRegistry manages tool lifecycle

The system SHALL provide a `ToolRegistry` class that manages tool registration, unregistration, enabling, disabling, and execution. The registry MUST maintain a collection of tools and track which tools are enabled.

#### Scenario: Register new tool

- **WHEN** `register(tool)` is called with an ExecutableTool
- **THEN** the tool is added to the registry and enabled by default

#### Scenario: Unregister existing tool

- **WHEN** `unregister(name)` is called with a registered tool name
- **THEN** the tool is removed from the registry

#### Scenario: Unregister nonexistent tool

- **WHEN** `unregister(name)` is called with an unregistered tool name
- **THEN** the system does nothing (idempotent operation)

#### Scenario: Enable tool

- **WHEN** `enable(name)` is called with a registered tool name
- **THEN** the tool is marked as enabled and included in schema exports

#### Scenario: Disable tool

- **WHEN** `disable(name)` is called with a registered tool name
- **THEN** the tool is marked as disabled and excluded from schema exports

#### Scenario: Get enabled schemas

- **WHEN** `getEnabledSchemas()` is called
- **THEN** the system returns an array of `ChatTool` schemas only for tools that are currently enabled

#### Scenario: Execute disabled tool

- **WHEN** `execute(name, args)` is called for a disabled tool
- **THEN** the system returns an error string indicating the tool is not available

### Requirement: ToolRegistry wraps execution in error handling

The system SHALL wrap tool execution in try-catch blocks, converting thrown exceptions into error message strings. This maintains backward compatibility with the current error handling behavior.

#### Scenario: Tool executes successfully

- **WHEN** `execute(name, args)` is called and the tool completes normally
- **THEN** the system returns the tool's string result

#### Scenario: Tool throws exception

- **WHEN** `execute(name, args)` is called and the tool throws an error
- **THEN** the system returns a string formatted as "Error executing {name}: {error.message}"

#### Scenario: Execute nonexistent tool

- **WHEN** `execute(name, args)` is called with an unregistered tool name
- **THEN** the system returns an error string indicating the tool was not found

### Requirement: ToolContext interface for dependency injection

The system SHALL provide a `ToolContext` interface with `systemPrompt`, `sessionContext`, and `sessionContextFilePath` properties. Tools that need agent state MUST receive a ToolContext instance rather than coupling to the Agent class.

#### Scenario: Tool receives context

- **WHEN** a tool constructor accepts a ToolContext parameter
- **THEN** the tool can access current agent state through the context properties

#### Scenario: Context reflects live state

- **WHEN** agent state changes (e.g., `clearContext()` or `setSystemPrompt()`)
- **THEN** the ToolContext properties MUST return the updated values (via property getters)

### Requirement: Tool execution is synchronous

The system SHALL execute tools synchronously. All tool `execute()` methods MUST return string results directly, not promises or callbacks.

#### Scenario: Synchronous execution

- **WHEN** `ToolRegistry.execute()` is called
- **THEN** the method returns a string result immediately without awaiting async operations

### Requirement: Default tool registry factory

The system SHALL provide a `createDefaultToolRegistry(context)` factory function that creates a ToolRegistry pre-loaded with the three built-in tools: `read_file`, `write_file`, and `save_session_context`.

#### Scenario: Create default registry

- **WHEN** `createDefaultToolRegistry(context)` is called with a ToolContext
- **THEN** the system returns a ToolRegistry with all three built-in tools registered and enabled

#### Scenario: Built-in tools are enabled

- **WHEN** `getEnabledSchemas()` is called on a default registry
- **THEN** the system returns schemas for `read_file`, `write_file`, and `save_session_context`

### Requirement: Agent provides tool management API

The system SHALL extend the Agent class with public methods for runtime tool management: `addTool(tool)`, `removeTool(name)`, `enableTool(name)`, and `disableTool(name)`. These methods MUST delegate to the internal ToolRegistry.

#### Scenario: Add custom tool at runtime

- **WHEN** `agent.addTool(customTool)` is called after agent construction
- **THEN** the tool is registered in the registry and available for execution

#### Scenario: Remove tool at runtime

- **WHEN** `agent.removeTool(name)` is called
- **THEN** the tool is unregistered and no longer available

#### Scenario: Enable tool at runtime

- **WHEN** `agent.enableTool(name)` is called
- **THEN** the tool is included in LLM requests

#### Scenario: Disable tool at runtime

- **WHEN** `agent.disableTool(name)` is called
- **THEN** the tool is excluded from LLM requests but remains registered

### Requirement: Agent delegates tool operations to registry

The system SHALL refactor Agent to delegate all tool operations to the ToolRegistry. The `getTools()` method MUST delegate to `toolRegistry.getEnabledSchemas()`. Tool execution in `chat()` and `streamChat()` MUST call `toolRegistry.execute()`. The `saveContext()` method MUST use `toolRegistry.execute("save_session_context", { reason })`.

#### Scenario: Get tools returns enabled schemas

- **WHEN** `agent.getTools()` is called
- **THEN** the system returns only schemas for currently enabled tools

#### Scenario: Chat executes tools via registry

- **WHEN** the LLM requests a tool call during `chat()`
- **THEN** the system executes the tool using `toolRegistry.execute()`

#### Scenario: Save context uses registry

- **WHEN** `agent.saveContext(reason)` is called
- **THEN** the system executes the save_session_context tool via the registry

### Requirement: Backward compatibility preserved

The system MUST preserve all existing tool behavior. The Agent constructor signature SHALL remain unchanged. The three built-in tools (`read_file`, `write_file`, `save_session_context`) MUST function identically to the current implementation.

#### Scenario: Constructor signature unchanged

- **WHEN** `new Agent(provider, options)` is called
- **THEN** the constructor creates an agent with the default tool registry (no API breaking changes)

#### Scenario: Read file tool behavior preserved

- **WHEN** the `read_file` tool is executed with file path and optional encoding
- **THEN** the system reads the file and returns its contents as a string (matching current behavior)

#### Scenario: Write file tool behavior preserved

- **WHEN** the `write_file` tool is executed with file path and content
- **THEN** the system writes the content to the file and returns a success message (matching current behavior)

#### Scenario: Save session context tool behavior preserved

- **WHEN** the `save_session_context` tool is executed with a reason
- **THEN** the system writes the session context to the configured file path (matching current behavior)

### Requirement: Tool implementations follow flat module structure

The system SHALL organize tool code in `src/tools/` using a flat file structure with no barrel index file. This MUST follow the same pattern as `src/providers/`.

#### Scenario: Interface and types separated

- **WHEN** tools are imported
- **THEN** the ExecutableTool interface is in `interface.ts` and ToolContext is in `types.ts`

#### Scenario: Registry is standalone

- **WHEN** the registry is imported
- **THEN** it is defined in `registry.ts` without dependencies on tool implementations

#### Scenario: Tool implementations are separate files

- **WHEN** built-in tools are imported
- **THEN** file system tools are in `fileSystem.ts` and session context tool is in `sessionContext.ts`

#### Scenario: Factory is separate

- **WHEN** the factory is imported
- **THEN** it is defined in `factory.ts` and creates a registry with all built-in tools

### Requirement: Tool implementations are independently testable

The system SHALL structure tools to enable testing without instantiating the Agent class. Each tool implementation MUST be testable in isolation by providing mock dependencies (e.g., mock ToolContext).

#### Scenario: Test tool with mock context

- **WHEN** a tool is instantiated with a mock ToolContext
- **THEN** the tool can be tested without creating an Agent instance

#### Scenario: Test registry in isolation

- **WHEN** ToolRegistry tests create a registry instance
- **THEN** the tests can register mock tools and verify lifecycle methods without real tool implementations
