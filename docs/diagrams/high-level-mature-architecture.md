# Mature Project Data Flow

A high-level Mermaid diagram of how the mature project works, focused on startup, interaction modes, the core query loop, tool execution, and persistence.

```mermaid
flowchart TD
  User["User / CLI / SDK Caller"]

  User --> Entry["CLI Entrypoint<br/>src/entrypoints/cli.tsx"]
  Entry --> Main["Main Commander App<br/>src/main.tsx"]

  Main --> Init["Init + Config<br/>settings, auth, telemetry,<br/>feature gates, migrations"]
  Init --> Setup["Session Setup<br/>cwd, trust, hooks,<br/>worktree, UDS, session id"]

  Setup --> Mode{"Run Mode"}

  Mode --> Interactive["Interactive Terminal UI<br/>React Ink REPL"]
  Mode --> Headless["Print / SDK Mode<br/>non-interactive stream"]
  Mode --> Subcommands["Subcommands<br/>mcp, auth, plugin, doctor,<br/>server, update, etc."]

  Interactive --> AppState["AppState Store<br/>messages, permissions,<br/>MCP, tools, UI state"]
  Interactive --> Input["Prompt Input / Slash Commands"]

  Input --> CommandCheck{"Slash command<br/>or user prompt?"}
  CommandCheck -->|Slash command| Commands["Command Handlers<br/>src/commands/*"]
  Commands --> AppState

  CommandCheck -->|User prompt| BuildContext["Build Query Context<br/>system prompt, user context,<br/>tools, MCP clients, permissions"]

  Headless --> BuildContext
  BuildContext --> Query["Core Agent Loop<br/>src/query.ts"]

  Query --> Prep["Prepare Request<br/>normalize messages,<br/>attachments, memory,<br/>token budget"]
  Prep --> Compact["Context Management<br/>microcompact, autocompact,<br/>context collapse, snip"]
  Compact --> API["Claude API Streaming<br/>src/services/api/claude.ts"]

  API --> StreamOut["Assistant Stream Events<br/>text, thinking, tool_use,<br/>errors, usage"]
  StreamOut --> AppState
  StreamOut --> HeadlessOutput["stdout / SDK stream"]

  StreamOut --> ToolUse{"Tool use requested?"}

  ToolUse -->|No| StopHooks["Stop Hooks / Finalization"]
  StopHooks --> Persist["Transcript + Session Storage<br/>analytics, cost, summaries"]
  Persist --> Done["Turn Complete"]

  ToolUse -->|Yes| Permission["Permission Check<br/>canUseTool + permission mode"]
  Permission --> ToolRunner["Tool Orchestration<br/>serial or concurrent batches"]

  ToolRunner --> BuiltinTools["Built-in Tools<br/>Read, Edit, Bash, Agent,<br/>WebFetch, etc."]
  ToolRunner --> MCP["MCP Tools / Resources<br/>src/services/mcp/*"]
  ToolRunner --> LSP["LSP / IDE Services"]
  ToolRunner --> Agents["Subagents / Tasks<br/>local, remote, shell"]

  BuiltinTools --> ToolResult["Tool Result Messages"]
  MCP --> ToolResult
  LSP --> ToolResult
  Agents --> ToolResult

  ToolResult --> Query

  Setup -.-> Remote["Remote / Bridge Sessions<br/>WebSocket, SDK adapters,<br/>permission bridge"]
  Remote -.-> Query
  Remote -.-> AppState
```

## Reading Guide

`src/main.tsx` is the front door: it parses CLI arguments, initializes configuration, and runs session setup. From there, the program chooses an interactive React Ink REPL, a headless print/SDK path, or a subcommand path.

The main behavioral loop lives in `src/query.ts`. It prepares messages and context, handles compaction, streams from the Claude API, executes requested tools, feeds tool results back into the model, and repeats until the assistant returns a final answer.
