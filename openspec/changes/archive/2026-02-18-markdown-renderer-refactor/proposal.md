## Why

The current `marked-terminal` dependency produces imprecise table output, lacks per-language syntax highlighting, performs ANSI-unaware word wrapping, and does not sanitize unpaired Unicode surrogates. Replacing it with a custom token-based renderer (using `marked`'s lexer directly) and `cli-highlight` corrects all four issues without changing the streaming architecture.

## What Changes

- Remove `marked-terminal` from `package.json`
- Add `cli-highlight` to `package.json` (keep `marked` for lexing)
- Rewrite `src/ui/markdownRenderer.ts`:
  - Add `sanitizeSurrogates()` to strip unpaired Unicode surrogates from incoming tokens
  - Add `visibleLength()` and `wrapTextToWidth()` for ANSI-aware string measurement and wrapping
  - Add `MarkdownTheme` interface and `defaultTheme(width)` factory (replaces `createMarkedInstance()` / `TerminalOptions`)
  - Add `renderMarkdown(text, theme, width)` as the core render function (calls `marked.lexer()`, dispatches to token-specific helpers)
  - Update `MarkdownStreamer`: `push()` calls `sanitizeSurrogates()`, `parseBufferSafely()` calls `renderMarkdown()` instead of `this.marked.parse()`; internal `marked` field replaced with `theme` and `width`
- Fix `src/__tests__/markdownRenderer.test.ts`: update the error-fallback test that accesses `(streamer as any).marked.parse`

## Capabilities

### New Capabilities

_(none — this is a refactor of an existing capability)_

### Modified Capabilities

- `markdown-streaming`: Requirements for the markdown rendering engine change — replaces `marked-terminal` with a custom token renderer, adds per-language syntax highlighting via `cli-highlight`, adds Unicode surrogate sanitization on token push, and adds ANSI-aware word wrapping for table cells and long paragraphs.

## Impact

- **Dependencies**: `marked-terminal` removed; `cli-highlight` added
- **Source**: `src/ui/markdownRenderer.ts` (full render step rewrite); `MarkdownStreamer` class updated
- **Tests**: `src/__tests__/markdownRenderer.test.ts` (one test updated)
- **No behavior change** for callers: `Streamer` interface, `TerminalUi`, `createMarkdownStream()`, `PassthroughStreamer`, and `NullStreamer` are all unchanged
