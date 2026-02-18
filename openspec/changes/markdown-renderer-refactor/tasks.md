## 1. Dependencies

- [ ] 1.1 Add `cli-highlight` to `package.json` dependencies (`npm install cli-highlight`)
- [ ] 1.2 Remove `marked-terminal` from `package.json` dependencies (`npm uninstall marked-terminal`)

## 2. Core Utilities

- [ ] 2.1 Implement `sanitizeSurrogates(text: string): string` — strip unpaired Unicode surrogates via regex
- [ ] 2.2 Implement `visibleLength(str: string): number` — strip `\x1b[...m` ANSI codes then return `.length`
- [ ] 2.3 Implement `wrapTextToWidth(line: string, width: number): string[]` — word-wrap a single line using `visibleLength` for measurement

## 3. Theme

- [ ] 3.1 Define `MarkdownTheme` interface with all style function fields (`heading`, `link`, `linkUrl`, `code`, `codeBlock`, `codeBlockBorder`, `quote`, `quoteBorder`, `hr`, `listBullet`, `bold`, `italic`, `strikethrough`, `highlightCode`, `codeBlockIndent`)
- [ ] 3.2 Implement `defaultTheme(width: number): MarkdownTheme` — Atom Dark palette, wire `cli-highlight` into `highlightCode` with a try/catch fallback for unknown languages

## 4. Token Renderer

- [ ] 4.1 Implement `renderInlineTokens(tokens, theme): string` — handle `strong`, `em`, `codespan`, `link`, `del`, `text` inline token types
- [ ] 4.2 Implement `renderList(token, theme, width): string` — ordered and unordered lists, recursive for nested items
- [ ] 4.3 Implement `renderTable(token, theme, width): string` — header and body rows with ANSI-aware column width calculation and `wrapTextToWidth` for cell values
- [ ] 4.4 Implement `renderToken(token, theme, width): string` — dispatch for block-level tokens: `heading`, `paragraph`, `code`, `blockquote`, `list`, `table`, `hr`, `space`; fall back to raw text for unknown types
- [ ] 4.5 Implement `renderMarkdown(text: string, theme: MarkdownTheme, width: number): string` — call `marked.lexer(text)`, iterate tokens via `renderToken`, join with `\n`

## 5. MarkdownStreamer Update

- [ ] 5.1 Replace `private readonly marked: Marked` field with `private readonly theme: MarkdownTheme` and `private readonly width: number`
- [ ] 5.2 Replace `createMarkedInstance(stderr)` call in constructor with `defaultTheme(Math.max((stderr.columns ?? 80) - 1, 40))` and width capture
- [ ] 5.3 Update `push()` to call `sanitizeSurrogates(token)` before appending to buffer
- [ ] 5.4 Update `parseBufferSafely()` to call `renderMarkdown(buffer, this.theme, this.width)` instead of `this.marked.parse(buffer)`
- [ ] 5.5 Remove `createMarkedInstance()` function and all `marked-terminal` imports

## 6. Tests

- [ ] 6.1 Update the `"should fallback to raw buffer when markdown parsing throws"` test (line 362) — replace the internal `(streamer as any).marked.parse` mock with a `vi.spyOn` / module-level mock on `renderMarkdown` or trigger the fallback via a malformed input approach
- [ ] 6.2 Add unit tests for `sanitizeSurrogates` — valid input passthrough and unpaired surrogate stripping
- [ ] 6.3 Add unit tests for `visibleLength` — with and without ANSI escape codes
- [ ] 6.4 Add unit tests for `renderMarkdown` covering: headings, paragraphs, fenced code blocks (with and without language), lists, blockquotes, inline bold/italic/code

## 7. Build and Verify

- [ ] 7.1 Run `npm run build` — verify TypeScript compilation with no errors
- [ ] 7.2 Run `npm test` — verify all tests pass
- [ ] 7.3 Run `npm run format:check` — verify formatting compliance
