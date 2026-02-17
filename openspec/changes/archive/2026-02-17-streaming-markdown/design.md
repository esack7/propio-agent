## Context

Assistant responses are currently rendered token-by-token as flat gray text via `TerminalUi.writeAssistant()`. Each token is written immediately to stderr with the assistant color applied. There is no buffering, no markdown parsing, and no ability to rewrite previously emitted output.

The `streamAssistantResponse` function in `src/index.ts` drives this: it calls `agent.streamChat()` with an `onToken` callback that writes each token directly. Tool call boundaries are handled by `onToolStart`/`onToolEnd` callbacks that display spinners via the existing `TerminalUi.status()`/`success()`/`error()` methods.

The terminal UI already has mode-awareness (`interactive`, `plain`, `json`) and handles spinner lifecycle, word wrapping (`fitToTerminalWidth`), and output stream coordination (`pendingStderrLine` tracking).

## Goals / Non-Goals

**Goals:**

- Render LLM assistant markdown (headers, code blocks, lists, bold, italic, tables) as styled ANSI terminal output with syntax highlighting
- Stream output smoothly using debounced re-renders that replace previous output via cursor control
- Cleanly segment markdown around tool call boundaries (flush before tool spinner, fresh buffer after)
- Preserve existing behavior for non-TTY, plain, and JSON modes via a passthrough fallback
- Align markdown styling with the existing Atom Dark palette from `src/ui/colors.ts`

**Non-Goals:**

- Interactive markdown features (clickable links, collapsible sections)
- Image rendering or rich media in terminal
- Custom markdown extensions beyond what `marked` + `marked-terminal` support
- Changing the tool call spinner/status rendering — only the boundary handoff changes
- Supporting markdown in non-assistant output (user input, status messages, errors)

## Decisions

### D1: `marked` (v15) + `marked-terminal` (v7.3) for parsing and rendering

**Choice**: Use `marked` for markdown-to-token parsing and `marked-terminal` as a renderer that produces ANSI-styled terminal output.

**Rationale**: `marked` is the most mature synchronous markdown parser in the Node ecosystem (4.3M weekly downloads). Synchronous parsing is essential for the streaming re-render approach — we need to re-parse the full buffer on every render cycle without async overhead. `marked-terminal` is the canonical terminal renderer for `marked`, providing syntax highlighting (via `cli-highlight`), table rendering, emoji support, and full chalk integration out of the box.

**Alternatives considered**:
- `markdown-it` + custom renderer: More extensible but async-oriented and would require writing a terminal renderer from scratch
- `ink` / React-based terminal rendering: Too heavy; would require rearchitecting the entire UI layer
- ANSI escape code generation from scratch: Fragile, large maintenance surface, no syntax highlighting

### D2: Full-buffer re-render with ANSI cursor rewind

**Choice**: On each render cycle, move the cursor up by the number of previously rendered lines, clear to end of screen, and write the full re-rendered markdown output.

**Rationale**: Markdown is context-sensitive — a token arriving later can change how earlier tokens are parsed (e.g., a closing ``` changes an inline segment into a code block). The only correct approach is to re-parse the full accumulated buffer each time. The ANSI cursor-up (`\x1b[<N>A`) + clear-to-end (`\x1b[0J`) technique is lightweight and widely supported across terminal emulators.

**Alternatives considered**:
- Incremental/differential rendering: Markdown's context-sensitivity makes diffs unreliable — a single token can reflow an entire block
- Write-once streaming (current approach): Loses all formatting since tokens arrive as fragments

### D3: Debounced rendering at ~50ms intervals

**Choice**: Batch token arrivals and re-render at most every 50ms. Immediate render on `flush()` and `finish()`.

**Rationale**: LLM tokens arrive at 10-100+ tokens/second. Re-rendering on every token would cause visible flicker and waste CPU on redundant `marked.parse()` calls. A 50ms debounce caps re-renders at ~20/sec — fast enough to feel responsive, slow enough to stay efficient. The debounce is bypassed on flush/finish to ensure final output is always complete.

### D4: MarkdownStreamer as a standalone class in `src/ui/markdownRenderer.ts`

**Choice**: Create a new `MarkdownStreamer` class with `push(token)`, `flush()`, and `finish()` methods, instantiated via a factory method on `TerminalUi`.

**Rationale**: Keeps the streaming/rendering lifecycle separate from `TerminalUi`'s general-purpose output methods. The factory method (`createMarkdownStream()`) lets `TerminalUi` inject the correct behavior based on mode — a real `MarkdownStreamer` for interactive TTY, or a passthrough implementation for plain/json/non-TTY modes. This preserves the existing architecture boundary where mode-awareness lives in `TerminalUi`.

### D5: Tool call boundaries trigger flush/reset

**Choice**: When `onToolStart` fires, call `mdStream.flush()` to commit the current markdown segment, then let the spinner display normally. When text resumes after tool execution, tokens push into a fresh buffer and a new markdown segment begins.

**Rationale**: The cursor rewind mechanism must not rewind past tool status messages (spinners, success/error lines). Flushing commits the current output — the line count resets to 0, so subsequent rewinds only affect the new segment. This keeps tool output cleanly interleaved between markdown segments without any special coordination with the spinner system.

### D6: `marked-terminal` styling mapped to existing color palette

**Choice**: Configure `marked-terminal` options to use the Atom Dark palette already defined in `src/ui/colors.ts`:
- Headers: bold + `#61AFEF` (info blue)
- Code/codespan: `#E5C07B` (command yellow)
- Body/paragraph/list text: `#ABB2BF` (assistant gray)
- Blockquotes: `#5C6370` (subtle gray) + italic
- Links: `#61AFEF` (info blue)
- Bold: chalk.bold, Italic: chalk.italic
- `width`: `stderr.columns - 1`
- `reflowText`: true

**Rationale**: Matches the existing visual language. Users already see these colors for other semantic roles; reusing them for markdown elements creates consistency. Setting `width` and `reflowText` delegates word-wrapping to `marked-terminal`, which understands ANSI escape sequences and won't break them mid-sequence (unlike the current `fitToTerminalWidth` which operates on raw strings).

### D7: Hide cursor during re-render cycles

**Choice**: Write `\x1b[?25l` (hide cursor) before cursor-up + clear, and `\x1b[?25h` (show cursor) after writing the new output. Restore cursor visibility in `finish()` and on error.

**Rationale**: Without hiding the cursor, the rapid cursor-up movement and screen clearing causes visible cursor flicker. This is a standard technique used by `ora`, `ink`, and other terminal rendering libraries.

## Risks / Trade-offs

**[Risk] Terminal compatibility with cursor control sequences** → The ANSI sequences used (`CSI <n>A`, `CSI 0J`, `CSI ?25l/h`) are supported by all modern terminal emulators (iTerm2, Terminal.app, Windows Terminal, GNOME Terminal, etc.). The passthrough fallback for non-TTY contexts avoids issues with piped/redirected output.

**[Risk] Performance on very long responses** → `marked.parse()` is synchronous and re-parses the entire buffer on each render. For typical LLM responses (< 10KB), this is sub-millisecond. For extremely long responses (> 100KB), parse time could become noticeable. The 50ms debounce mitigates this by capping render frequency. If needed in the future, a sliding-window approach could limit re-parsing to the last N lines.

**[Risk] Partial markdown constructs during streaming** → Unclosed code fences, incomplete tables, or partial links will be parsed as-is by `marked` on intermediate renders. `marked` handles these gracefully (treats remaining text as part of the open block). The final `finish()` render uses the complete content, so the end result is always correct.

**[Risk] SIGINT during re-render leaves cursor hidden** → If the process is killed during a re-render cycle, the cursor may remain hidden. The existing SIGINT handler in `src/index.ts` calls `ui.cleanup()` — we extend this path to also restore cursor visibility. Most terminals also auto-restore cursor on process exit.

**[Trade-off] Full re-render vs. incremental** → Re-rendering the full buffer on each cycle is simpler and always correct, but uses more CPU than a hypothetical incremental approach. Given the 50ms debounce and typical response sizes, this trade-off strongly favors simplicity.

**[Trade-off] New dependencies** → Adding `marked` and `marked-terminal` increases the dependency footprint. Both are well-maintained, widely used, and ESM-compatible. The alternative (building a markdown-to-ANSI renderer from scratch) would be a much larger maintenance burden.
