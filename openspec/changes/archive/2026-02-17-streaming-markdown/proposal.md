## Why

LLM responses frequently contain markdown (headers, code blocks, lists, bold/italic), but the CLI currently renders all assistant text as flat gray plain text. This makes structured responses harder to read and loses the formatting the model is producing. Rendering markdown with syntax highlighting, proper headings, and styled code blocks brings the terminal experience closer to what users expect from modern AI tools.

## What Changes

- Add a new `MarkdownStreamer` class that accumulates streaming tokens, debounces re-renders (~50ms), and uses ANSI cursor control to replace previous output with fully-parsed markdown on each render cycle
- Integrate `marked` (v15) + `marked-terminal` (v7.3) for synchronous markdown-to-ANSI conversion with syntax highlighting, tables, and emoji support
- Style markdown output using the existing Atom Dark color palette from `src/ui/colors.ts` (blue headers, yellow code spans, gray body text)
- Flush and reset the markdown buffer on tool call boundaries so tool status messages appear cleanly between markdown segments
- Non-TTY and JSON modes fall back to a passthrough streamer with no cursor control or markdown parsing (preserves existing behavior)
- Replace direct `writeAssistant(token)` streaming in `streamAssistantResponse` with the new `MarkdownStreamer` push/flush/finish lifecycle

## Capabilities

### New Capabilities

- `markdown-streaming`: Streaming markdown rendering for LLM assistant responses — covers the MarkdownStreamer class, debounced re-render with ANSI cursor control, marked/marked-terminal integration, tool-call flush boundaries, and mode-aware fallback behavior

### Modified Capabilities

- `operation-feedback`: Assistant response output changes from plain-text token streaming to buffered markdown rendering with cursor rewind; tool call boundaries now trigger a flush/reset cycle on the markdown stream before spinner display

## Impact

- **New file**: `src/ui/markdownRenderer.ts` — MarkdownStreamer class
- **Modified files**: `src/ui/terminal.ts` (factory method), `src/index.ts` (streamAssistantResponse wiring)
- **New dependencies**: `marked` (^15.0.0), `marked-terminal` (^7.3.0)
- **Terminal behavior**: Assistant output now uses ANSI cursor-up + clear-to-end for re-rendering; hidden cursor during re-render cycles
- **No breaking changes**: Non-TTY, JSON, and non-interactive modes retain current behavior via passthrough fallback
