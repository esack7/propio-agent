## MODIFIED Requirements

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
