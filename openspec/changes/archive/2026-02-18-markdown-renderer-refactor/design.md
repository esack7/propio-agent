## Context

`MarkdownStreamer` currently renders markdown by calling `this.marked.parse(buffer)` on each throttle tick. The `Marked` instance is configured with `markedTerminal()`, which plugs in a custom renderer over `marked`'s internal rendering pipeline. This approach provides no access to per-token structure, so code blocks receive no per-language highlighting, table layout is imprecise, and string measurement ignores ANSI escape codes.

The streaming/delta algorithm itself (throttle, `committedOutput` prefix diff, divergence rewind) is correct and will not change.

## Goals / Non-Goals

**Goals:**
- Replace `marked-terminal` with a custom token-based renderer that gives precise control over every element type
- Add per-language syntax highlighting via `cli-highlight`
- Add Unicode surrogate sanitization so malformed LLM output does not corrupt the terminal
- Add ANSI-aware string measurement and word wrapping for table cells and paragraphs
- Keep the `Streamer` interface, `MarkdownStreamer` constructor signature, and all streaming/delta logic unchanged

**Non-Goals:**
- Changing the streaming or delta-rendering algorithm
- Modifying `TerminalUi`, `createMarkdownStream()`, `PassthroughStreamer`, or `NullStreamer`
- Supporting themes other than Atom Dark at this time

## Decisions

### Decision 1: Use `marked.lexer()` instead of `marked.parse()` with a renderer plugin

`marked.lexer()` returns a flat token array. A custom `renderMarkdown()` function iterates the tokens and produces ANSI lines directly, with full visibility into every token's type, language hint, and nesting. This is cleaner than overriding marked's renderer hooks, which require matching undocumented internal call signatures and are harder to test in isolation.

**Alternative considered**: Patch `marked-terminal` or fork it. Rejected — the library has no typed extension points for the behaviors we need (ANSI-aware wrapping, `cli-highlight` integration), and its table renderer is a known weak point.

### Decision 2: `MarkdownTheme` interface with discrete style functions

Each element type gets its own `(text: string) => string` style function in the theme. This makes the theme testable in isolation and easy to override per-element without touching the render logic. The `highlightCode?: (code: string, lang?: string) => string[]` field returns lines so the renderer can prefix each with the border/indent without re-splitting.

**Alternative considered**: A flat palette object (hex colors only). Rejected — code blocks need multi-line prefix logic that a simple color value can't express.

### Decision 3: `defaultTheme(width)` replaces `createMarkedInstance(stderr)`

The factory takes `width: number` (already computed as `stderr.columns - 1`) and wires `cli-highlight` into `highlightCode`. This moves width into the theme so `renderMarkdown(buffer, theme, width)` is a pure function with no `stderr` reference — easier to unit-test.

### Decision 4: Sanitize surrogates at push time

`sanitizeSurrogates(token)` is called in `push()` before appending to the buffer. This prevents malformed UTF-16 sequences from accumulating and corrupting the ANSI output. The function strips unpaired surrogates (`\uD800`–`\uDFFF` that are not part of a valid surrogate pair) using a regex replacement.

### Decision 5: ANSI-aware measurement only where needed

`visibleLength(str)` strips `\x1b[...m` codes before calling `.length`. `wrapTextToWidth(line, width)` uses `visibleLength` to break lines at word boundaries. These are applied only in table cell layout and long paragraph wrapping — not in every code path, to keep the hot render path fast.

## Risks / Trade-offs

- **Partial token rendering accuracy**: `renderMarkdown` must handle incomplete markdown gracefully (e.g., unclosed fences mid-stream). `marked.lexer()` is lenient about partial input, but edge cases may produce slightly different intermediate output than `marked-terminal`. The final `finish()` render always uses the complete buffer, so correctness at rest is guaranteed.

- **`cli-highlight` failure isolation**: If `cli-highlight` throws for an unknown language or malformed code, it must be caught and the raw code returned instead. This is handled inside the `highlightCode` closure in `defaultTheme`.

- **`stripTrailingAnsi` still needed**: The delta diff logic strips trailing ANSI resets for prefix comparison. The new renderer will produce its own trailing resets; `stripTrailingAnsi` must remain and its regex may need adjustment if the new renderer's reset codes differ from `marked-terminal`'s.

## Migration Plan

1. `npm install cli-highlight` and remove `marked-terminal` from `package.json`
2. Rewrite `src/ui/markdownRenderer.ts` in place — no new files needed
3. Update the one test in `src/__tests__/markdownRenderer.test.ts` that reaches into `(streamer as any).marked.parse`; mock `renderMarkdown` or replace the test approach since the internal field is gone
4. Run `npm run build` and `npm test` to verify; no callers outside this file need changes
