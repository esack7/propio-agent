# Tool Call UI Output Flow

A Mermaid diagram of the mature tool-call UI pattern described in `docs/tool-call-ui-output.md`. The key idea is that provider messages, tool execution events, and rendered UI rows are related by tool call ID, but they are not the same data structure.

```mermaid
flowchart TB
    User([User])

    subgraph Provider["Model / Provider Transcript"]
        AssistantText[Assistant text chunks]
        ToolUse[Assistant tool_use block<br/>id, name, partial input]
        ToolResult[User tool_result block<br/>tool_use_id, model-facing content]
    end

    subgraph Executor["Tool Execution Layer"]
        Registry[Tool registry<br/>find by name]
        InputSchema[Parse input<br/>tool.inputSchema]
        Permission[Permission checks<br/>classifiers + PreToolUse hooks]
        Queue[Queued tool call]
        Run[Execute tool]
        Progress[Progress events<br/>attached to tool_use_id]
        RawResult[Raw tool result<br/>UI-facing structured value]
        Error[Error / reject / cancel]
        PostHooks[PostToolUse hooks]
    end

    subgraph Normalizer["UI Normalization Layer"]
        Normalize[Normalize messages<br/>one renderable block per row]
        Lookups[Build lookup maps<br/>tool use, result, progress,<br/>resolved IDs, errored IDs]
        Reorder[Reorder display<br/>place result under matching use]
        Filter[Filter hidden rows<br/>meta messages, raw progress,<br/>transcript-only blocks]
        Group[Group / collapse<br/>read, search, repeated tool types]
    end

    subgraph ToolDisplay["Tool Display Adapter"]
        Label[userFacingName]
        UseMsg[renderToolUseMessage]
        QueueMsg[renderToolUseQueuedMessage]
        ProgressMsg[renderToolUseProgressMessage]
        ResultMsg[renderToolResultMessage]
        ErrorMsg[renderToolUseErrorMessage<br/>renderToolUseRejectedMessage]
    end

    subgraph UI["Rendered Chat UI"]
        TextRow[Assistant text row]
        ToolRow[Tool row<br/>name + compact summary]
        AttachedProgress[Attached progress<br/>not standalone transcript rows]
        ResultRow[Compact result row<br/>or hidden if renderer returns null]
        ErrorRow[Error / rejected / canceled row]
        CollapsedRow[Collapsed or grouped row<br/>non-verbose mode]
    end

    User -->|prompt| AssistantText
    AssistantText --> TextRow
    AssistantText --> ToolUse

    ToolUse --> Registry
    Registry --> InputSchema
    InputSchema --> Queue
    Queue --> Permission
    Permission --> Run
    Permission -->|denied| Error

    Run --> Progress
    Run --> RawResult
    Run -->|failure| Error
    RawResult --> PostHooks
    PostHooks --> ToolResult
    Error --> ToolResult

    AssistantText --> Normalize
    ToolUse --> Normalize
    ToolResult --> Normalize
    Progress --> Normalize

    Normalize --> Lookups
    Lookups --> Reorder
    Reorder --> Filter
    Filter --> Group

    Group --> Label
    Group --> UseMsg
    Group --> QueueMsg
    Group --> ProgressMsg
    Group --> ResultMsg
    Group --> ErrorMsg

    Label --> ToolRow
    UseMsg --> ToolRow
    QueueMsg --> AttachedProgress
    ProgressMsg --> AttachedProgress
    ResultMsg --> ResultRow
    ErrorMsg --> ErrorRow
    Group --> CollapsedRow

    ToolRow --> User
    AttachedProgress --> User
    ResultRow --> User
    ErrorRow --> User
    CollapsedRow --> User
```

## State View

```mermaid
stateDiagram-v2
    [*] --> StreamingUse: assistant emits tool_use
    StreamingUse --> Queued: tool call known
    Queued --> PermissionCheck: executor starts
    PermissionCheck --> Rejected: denied / user rejects
    PermissionCheck --> Running: approved
    Running --> Running: progress event
    Running --> Success: tool returns result
    Running --> Error: tool throws / validation fails
    Running --> Canceled: user interrupts
    Success --> PostHooks: run post hooks
    PostHooks --> Resolved: emit tool_result
    Rejected --> Resolved: emit error tool_result
    Error --> Resolved: emit error tool_result
    Canceled --> Resolved: emit canceled tool_result
    Resolved --> [*]
```

## Reading Guide

The provider transcript remains faithful to the model protocol: assistant text, assistant `tool_use`, and user `tool_result` blocks.

The execution layer owns running the tool and producing progress, structured UI-facing results, and failure states.

The UI normalization layer joins those pieces by `tool_use_id`, hides protocol noise, reorders results under their matching calls, and optionally groups repeated or low-value rows.

The display adapter is where each tool translates raw execution data into human-facing UI. This is why a file read can show "Read 86 lines" while the model still receives the actual file contents.
