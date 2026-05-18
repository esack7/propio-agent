# Tool Call UI Output Pattern

A detailed read of how the mature reference project handles tool-call display: what gets shown, when it gets shown, what stays hidden, and how raw tool protocol messages are transformed into human-readable UI.

The main lesson is that model-facing tool execution and user-facing tool display are deliberately separate. The transcript sent to the model may contain raw `tool_use` and `tool_result` blocks, but the UI builds its own view model keyed by `tool_use_id` and lets each tool decide how its activity should be summarized.

## Core Shape

The central abstraction is the `Tool` type in the mature project's `src/Tool.ts`. A tool does not only define execution behavior such as `call(...)`, `inputSchema`, and optional `outputSchema`; it also owns much of its display behavior.

Important display hooks include:

| Hook | Purpose |
| --- | --- |
| `userFacingName(...)` | Label shown in the UI for the tool. |
| `renderToolUseMessage(...)` | Compact summary of the requested action. |
| `renderToolUseProgressMessage(...)` | Live progress while the tool is running. |
| `renderToolUseQueuedMessage(...)` | Waiting / queued state. |
| `renderToolResultMessage(...)` | Success output shown to the user. |
| `renderToolUseErrorMessage(...)` | Tool-specific error display. |
| `renderToolUseRejectedMessage(...)` | Tool-specific rejection / cancellation display. |
| `isResultTruncated(...)` | Whether the rendered result can be expanded. |
| `extractSearchText(...)` | Searchable text for visible tool output. |

This is the first reusable design point: the central UI coordinates state, but each tool owns the semantics of its display. The UI does not generally render raw tool JSON.

## Lifecycle: What Is Shown When

### 1. Tool call starts streaming

When the assistant begins emitting a `tool_use` block, the UI can show it before the full model turn has completed. The mature project creates synthetic streaming assistant messages for in-flight tool uses so they can render immediately and then settle into the normalized message list later.

The tool input may still be partial at this point, so `renderToolUseMessage(...)` is designed to tolerate partial input. The UI parses what it can and asks the tool for a compact user-facing summary.

Example behavior:

```text
Bash (npm test)
Read (/path/to/file.ts)
Grep (pattern: "renderToolResultMessage", path: "src")
```

The exact text is tool-specific.

### 2. Tool is queued

If the tool call is known but has not started, the UI renders a queued state. The row usually shows the tool name plus a dim or pending indicator, and the tool can provide a custom queued message such as "Waiting...".

Queued state is derived from lookup data:

```ts
isQueued = !inProgressToolUseIDs.has(toolUseID) && !resolvedToolUseIDs.has(toolUseID)
```

### 3. Permission checks and hooks run

Before execution, tools may run permission checks, classifier checks, or pre-tool hooks. These are shown as progress attached to the tool call, not as independent transcript messages.

The mature UI can show states such as:

```text
Waiting for permission...
Checking command...
Running PreToolUse hook...
```

The important pattern is attachment: pre-execution status belongs visually under the tool call that caused it.

### 4. Tool executes

While a tool is running, progress messages are collected by `tool_use_id`. They are filtered out of the main transcript and rendered under the associated tool call through the tool's progress renderer.

For example:

| Tool | Progress style |
| --- | --- |
| Bash | Running output, elapsed time, line count, byte count, timeout state. |
| MCP | "Processing..." or progress bar if progress / total is available. |
| Long-running wrappers | May hide their own chrome and show delegated progress only. |

This keeps the transcript from becoming a stream of noisy internal status messages.

### 5. Tool succeeds

When the corresponding `tool_result` arrives, the UI visually places the result underneath the original tool call. The raw result is not automatically printed. Instead, the tool's `renderToolResultMessage(...)` decides what the human sees.

For example:

| Tool | Typical visible success result |
| --- | --- |
| Read | "Read 120 lines", "Read image", "Unchanged since last read". |
| Grep | "Found 4 files", "Found 12 matches". |
| Bash | Command result summary and optionally truncated output. |
| MCP | Rendered text / JSON / special compact integration output. |

Notice the asymmetry: the model may receive full file contents, command output, or structured data, while the human receives a concise display summary.

### 6. Tool errors, is rejected, or is canceled

Tool result messages can represent failure states. The mature project handles several cases separately:

| Case | UI behavior |
| --- | --- |
| User canceled | Shows cancellation / interruption message. |
| Permission rejected | Shows rejection message, often with reason. |
| Tool validation failed | Shows invalid tool parameters, usually compact unless verbose. |
| Runtime error | Uses tool-specific error renderer or fallback. |
| Auto-classifier denial | Shows a denial-specific error state. |

Fallback error rendering strips internal tags, truncates long output in non-verbose mode, and offers expansion in verbose / transcript views.

### 7. Output stabilizes and may collapse

After all sibling tool calls from the same assistant message are resolved, the UI can switch to static rendering. In non-verbose mode, related tool calls may be grouped or collapsed.

Examples:

- Multiple reads can collapse into a read group.
- Search-like tools can collapse into a search group.
- Repeated tool types from the same assistant message can use grouped rendering if the tool supports it.

Verbose or transcript mode shows more detail.

## Message Normalization and Reordering

The mature project does not render the raw message list directly. It first normalizes messages into one content block per renderable row, then builds lookup tables and reorders UI display.

Key lookup maps include:

| Lookup | Purpose |
| --- | --- |
| `toolUseByToolUseID` | Finds the original assistant tool call. |
| `toolResultByToolUseID` | Finds the corresponding result. |
| `progressMessagesByToolUseID` | Attaches progress to the matching tool. |
| `resolvedToolUseIDs` | Marks completed calls. |
| `erroredToolUseIDs` | Marks failed calls. |
| sibling tool IDs | Tracks tool calls emitted together. |
| hook counts | Tracks pre/post hook progress. |

This lets the UI reconstruct a human-readable sequence:

```text
Assistant text
Tool use
  PreToolUse hook progress
  Tool progress
  Tool result
  PostToolUse hook progress
Assistant text
```

That display order may differ from the protocol order sent to the model.

## Parsing Rules for UI Display

The UI parses tool display data defensively.

Assistant `tool_use` blocks are matched to a registered tool by name. The input is parsed with the tool's `inputSchema`. If parsing fails or the tool is missing, the UI may render nothing or use a fallback error path.

User `tool_result` blocks are matched back to the original `tool_use` by `tool_use_id`. For success display, the mature project uses a stored parsed result object (`toolUseResult`) rather than relying only on the model-facing `tool_result.content`. If the tool has an `outputSchema`, the UI validates the stored result before rendering it.

That separation matters. The model-facing result may be optimized for the LLM, while the UI-facing result may be structured for display.

## What Is Intentionally Not Shown

The mature project hides a lot of internal detail by default.

| Hidden or suppressed item | Reason |
| --- | --- |
| Raw tool input JSON | Replaced by tool-specific summaries. |
| Raw tool result content | Often too large or meant for the model, not the user. |
| Progress messages as standalone rows | Rendered under the matching tool call instead. |
| Meta user messages | Not useful in normal chat UI. |
| Transcript-only messages | Only shown in transcript mode. |
| Thinking / redacted thinking | Hidden unless verbose / transcript mode. |
| Unknown or unsupported server tool blocks | Logged or ignored rather than shown as broken UI. |
| Tool result renderers returning `null` | Allows tools to intentionally produce no visible result. |
| Transparent wrapper tools | May hide their own call and show delegated progress only. |

This is another major design point: not every protocol event deserves a visible row.

## Concrete Tool Examples

### Bash

The Bash UI shows a compact command summary. In non-verbose mode, long commands are truncated. Some shell commands are summarized as file paths or labels instead of displayed in full.

While running, Bash can show live shell progress: output preview, elapsed time, line count, byte count, and timeout state. The final result renderer decides how much output to show.

### Read

The Read UI shows the file path and optional line range / page information. It does not dump file contents into the UI. The visible success state is a summary such as:

```text
Read 86 lines
Read image
Read PDF
Unchanged since last read
```

This is a strong example of model-facing content being much richer than user-facing content.

### Grep

The Grep UI shows the search pattern and path. The result is summarized by files, matches, or lines found. In verbose mode, the UI can display more of the actual match content.

### MCP

MCP tools flatten structured input into readable key/value snippets and truncate long values in non-verbose mode. Their result renderer tries to present useful rich output instead of raw nested JSON, with special cases for known integrations and large-response warnings.

## Applying The Pattern To A Smaller Program

A less mature program does not need the full architecture. The reusable pattern is smaller:

```ts
type ToolDisplayAdapter<Input, Result, Progress> = {
  label(input: Partial<Input>): string
  renderUse(input: Partial<Input>): UI | null
  renderQueued?(input: Partial<Input>): UI | null
  renderProgress?(progress: Progress[], input: Partial<Input>): UI | null
  renderResult?(result: Result, input: Input): UI | null
  renderError?(error: unknown, input?: Partial<Input>): UI | null
}
```

Then keep a UI-side state record keyed by tool call ID:

```ts
type ToolCallView = {
  id: string
  toolName: string
  input: unknown
  status: "queued" | "permission" | "running" | "success" | "error" | "rejected" | "canceled"
  progress: unknown[]
  result?: unknown
  error?: unknown
}
```

A good implementation boundary is:

| Layer | Responsibility |
| --- | --- |
| Model transcript | Preserve exact messages needed by the model/provider. |
| Tool executor | Run tools, emit progress, final result, and errors. |
| UI normalizer | Join tool use, progress, hooks, and result by ID. |
| Tool display adapter | Decide human-facing labels, summaries, and result rendering. |
| Transcript renderer | Render the normalized display sequence. |

## Practical Recommendations

Start with a simple `toolCallId -> ToolCallView` map. Do not render raw provider messages directly.

Give every tool a display adapter, even if the first version only returns a label and a one-line result.

Make progress messages attach to a tool call instead of becoming independent chat rows.

Keep model-facing results and UI-facing results separate. The model may need full content; the user often needs a short confirmation.

Add a verbose mode early. It gives you somewhere to put rawer diagnostics without making the normal UI noisy.

Treat "render nothing" as a valid result. Some tools are wrappers, background helpers, or produce output that is better represented elsewhere.

The mature project's design is less about React-specific code and more about respecting three different streams: protocol events, execution state, and human display. The UI becomes much calmer once those are related by ID but not treated as the same thing.
