## ADDED Requirements

### Requirement: ToolRegistry provides introspection methods

The system SHALL provide methods on `ToolRegistry` to query registry state without requiring full schema retrieval. The registry MUST expose `getToolNames()`, `hasTool(name)`, and `isToolEnabled(name)`.

#### Scenario: Get all tool names

- **WHEN** `getToolNames()` is called on a registry with registered tools
- **THEN** the system returns a `string[]` of all registered tool names (both enabled and disabled), preserving registration order

#### Scenario: Get tool names from empty registry

- **WHEN** `getToolNames()` is called on an empty registry
- **THEN** the system returns an empty array

#### Scenario: Check existing tool

- **WHEN** `hasTool(name)` is called with a registered tool name
- **THEN** the system returns `true`

#### Scenario: Check nonexistent tool

- **WHEN** `hasTool(name)` is called with an unregistered tool name
- **THEN** the system returns `false`

#### Scenario: Check enabled tool

- **WHEN** `isToolEnabled(name)` is called with a registered and enabled tool name
- **THEN** the system returns `true`

#### Scenario: Check disabled tool

- **WHEN** `isToolEnabled(name)` is called with a registered but disabled tool name
- **THEN** the system returns `false`

#### Scenario: Check unregistered tool enabled status

- **WHEN** `isToolEnabled(name)` is called with an unregistered tool name
- **THEN** the system returns `false`

## MODIFIED Requirements

### Requirement: ExecutableTool interface

The system SHALL provide an `ExecutableTool` interface that bundles tool schema and execution logic. Each tool implementation MUST expose a unique `name` property, a `getSchema()` method that returns a `ChatTool` object, and an `execute(args)` method that accepts `Record<string, unknown>` arguments and returns a `Promise<string>` result.

#### Scenario: Tool provides schema

- **WHEN** a tool's `getSchema()` method is called
- **THEN** the system returns a `ChatTool` object containing the tool's function definition for LLM consumption

#### Scenario: Tool executes with arguments

- **WHEN** a tool's `execute()` method is called with valid arguments
- **THEN** the system executes the tool logic and returns a `Promise<string>` result

#### Scenario: Tool name matches schema

- **WHEN** a tool's `getSchema()` method returns a schema
- **THEN** the schema's function name MUST match the tool's `name` property

#### Scenario: Tool args use unknown type

- **WHEN** a tool's `execute()` method signature is defined
- **THEN** the args parameter MUST be typed as `Record<string, unknown>`, not `Record<string, any>`

### Requirement: ToolRegistry wraps execution in error handling

The system SHALL wrap tool execution in try-catch blocks, converting thrown exceptions and rejected promises into error message strings. The `execute()` method MUST be async and return `Promise<string>`.

#### Scenario: Tool executes successfully

- **WHEN** `execute(name, args)` is called and the tool's promise resolves normally
- **THEN** the system returns the tool's string result wrapped in a resolved promise

#### Scenario: Tool throws exception

- **WHEN** `execute(name, args)` is called and the tool throws a synchronous error or returns a rejected promise
- **THEN** the system returns a string formatted as "Error executing {name}: {error.message}"

#### Scenario: Execute nonexistent tool

- **WHEN** `execute(name, args)` is called with an unregistered tool name
- **THEN** the system returns an error string indicating the tool was not found

### Requirement: Agent delegates tool operations to registry

The system SHALL refactor Agent to delegate all tool operations to the ToolRegistry. The `getTools()` method MUST delegate to `toolRegistry.getEnabledSchemas()`. Tool execution in `chat()` and `streamChat()` MUST `await` `toolRegistry.execute()`. The `saveContext()` method MUST be async, returning `Promise<string>`, and MUST `await` `toolRegistry.execute("save_session_context", { reason })`.

The default tool registry created by the factory MUST register all built-in tools: `read_file`, `write_file`, `save_session_context`, `list_dir`, `mkdir`, `remove`, `move`, `search_text`, `search_files`, and `run_bash`. The factory MUST disable `remove` and `run_bash` immediately after registration. All other tools MUST be enabled by default.

#### Scenario: Get tools returns enabled schemas

- **WHEN** `agent.getTools()` is called
- **THEN** the system returns only schemas for currently enabled tools

#### Scenario: Chat awaits tool execution via registry

- **WHEN** the LLM requests a tool call during `chat()`
- **THEN** the system awaits `toolRegistry.execute()` for each tool call

#### Scenario: Stream chat awaits tool execution via registry

- **WHEN** the LLM requests a tool call during `streamChat()`
- **THEN** the system awaits `toolRegistry.execute()` for each tool call

#### Scenario: Save context is async

- **WHEN** `agent.saveContext(reason)` is called
- **THEN** the method returns `Promise<string>` and awaits the registry execution

#### Scenario: Default factory registers all built-in tools

- **WHEN** the default tool registry is created via `createDefaultToolRegistry()`
- **THEN** the registry contains all ten built-in tools: `read_file`, `write_file`, `save_session_context`, `list_dir`, `mkdir`, `remove`, `move`, `search_text`, `search_files`, and `run_bash`

#### Scenario: Destructive tools are disabled by default

- **WHEN** the default tool registry is created via `createDefaultToolRegistry()`
- **THEN** `isToolEnabled("remove")` returns `false` AND `isToolEnabled("run_bash")` returns `false` AND all other tools return `true` from `isToolEnabled()`

## REMOVED Requirements

### Requirement: Tool execution is synchronous

**Reason**: Replaced by async execution. The synchronous constraint prevented future tools from performing async I/O operations (API calls, database queries, async file operations).
**Migration**: All `execute()` methods now return `Promise<string>`. Synchronous tool implementations declare `async execute()` and return strings directly (auto-wrapped as resolved promises). Callers must `await` all `execute()` calls.
