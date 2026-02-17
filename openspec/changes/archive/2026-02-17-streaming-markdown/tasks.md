## 1. Dependencies

- [x] 1.1 Install `marked` (^15.0.0) and `marked-terminal` (^7.3.0) via npm
- [x] 1.2 Verify both packages resolve correctly and `npm run build` still compiles

## 2. MarkdownStreamer Core

- [x] 2.1 Create `src/ui/markdownRenderer.ts` with a `MarkdownStreamer` class that has `push(token)`, `flush()`, and `finish()` methods
- [x] 2.2 Implement internal buffer: `push()` appends token to string buffer and schedules a debounced re-render (~50ms)
- [x] 2.3 Implement debounce logic: batch tokens within the window, cancel pending timer on `flush()`/`finish()` and render immediately
- [x] 2.4 Implement render cycle: count lines of previous output, emit `\x1b[<N>A` + `\x1b[0J` to rewind and clear, call `marked.parse(buffer)` with `marked-terminal` renderer, write result to stderr, track new line count
- [x] 2.5 Implement cursor visibility: hide (`\x1b[?25l`) before cursor movement, show (`\x1b[?25h`) after write; always restore in `finish()` and on error
- [x] 2.6 Implement `flush()`: render immediately, commit output (reset tracked line count to 0), clear the buffer
- [x] 2.7 Implement `finish()`: call `flush()`, restore cursor visibility, cancel any pending timers
- [x] 2.8 Handle empty buffer edge case: `flush()`/`finish()` with empty buffer is a no-op (no ANSI sequences emitted)

## 3. Markdown Styling Configuration

- [x] 3.1 Configure `marked-terminal` options: headers bold + `#61AFEF`, code/codespan `#E5C07B`, paragraph/list `#ABB2BF`, blockquotes `#5C6370` italic, links `#61AFEF`, bold chalk.bold, italic chalk.italic
- [x] 3.2 Set `width` to `stderr.columns - 1` and `reflowText` to true

## 4. Passthrough Streamer

- [x] 4.1 Create a `PassthroughStreamer` class (or inline object) implementing the same `push`/`flush`/`finish` interface — `push()` writes token directly via `writeAssistant()`, `flush()`/`finish()` are no-ops
- [x] 4.2 Create a `NullStreamer` for JSON mode — all methods are no-ops (suppresses output)

## 5. TerminalUi Factory Method

- [x] 5.1 Add `createMarkdownStream()` method to `TerminalUi` in `src/ui/terminal.ts`
- [x] 5.2 Return `MarkdownStreamer` when interactive mode + TTY stderr; return `PassthroughStreamer` for plain/non-TTY; return `NullStreamer` for JSON mode
- [x] 5.3 Export the streamer interface type from the ui module

## 6. streamAssistantResponse Integration

- [x] 6.1 Update `streamAssistantResponse` in `src/index.ts`: replace `ui.writeAssistant(token)` with `mdStream.push(token)` using a stream created by `ui.createMarkdownStream()`
- [x] 6.2 Add `mdStream.flush()` call inside `onToolStart` callback before `ui.status()` spinner display
- [x] 6.3 Add `mdStream.finish()` call after `agent.streamChat()` resolves, before `ui.newline()`

## 7. Verification

- [x] 7.1 Run `npm run build` to verify TypeScript compilation succeeds with no errors
- [x] 7.2 Run `npm test` to verify all existing tests pass
- [x] 7.3 Manual smoke test: run an interactive session and verify markdown renders with styled headers, code blocks, and lists
