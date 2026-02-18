## MODIFIED Requirements

### Requirement: Markdown parsing with marked and marked-terminal

The system SHALL use `marked` for markdown lexing via `marked.lexer()` and a custom token-based renderer (`renderMarkdown`) for ANSI terminal output. The `marked-terminal` dependency SHALL be removed.

#### Scenario: Full markdown syntax support

- **WHEN** the buffer contains markdown with headers, code blocks, inline code, lists, bold, italic, links, blockquotes, or tables
- **THEN** the rendered output SHALL display each element with appropriate ANSI styling produced by the custom token renderer

#### Scenario: Syntax highlighting in fenced code blocks

- **WHEN** a fenced code block includes a language identifier
- **THEN** the rendered output SHALL include per-language syntax highlighting using `cli-highlight`

#### Scenario: Unknown or missing language identifier falls back gracefully

- **WHEN** a fenced code block has an unrecognized language identifier or no language identifier
- **THEN** the block SHALL be rendered without syntax highlighting and SHALL NOT throw an error

#### Scenario: Partial markdown constructs render gracefully

- **WHEN** the buffer contains unclosed code fences, incomplete tables, or partial formatting markers during streaming
- **THEN** `marked.lexer()` SHALL parse the incomplete content without errors
- **AND** the final `finish()` render SHALL use complete content for correct output

### Requirement: Markdown styling matches Atom Dark palette

The system SHALL provide a `MarkdownTheme` interface with discrete style functions, and a `defaultTheme(width)` factory that produces an Atom Dark-themed `MarkdownTheme` with `cli-highlight` wired into the `highlightCode` field.

#### Scenario: Headers styled with info color

- **WHEN** markdown headers are rendered
- **THEN** they SHALL be displayed in bold with the info color (`#61AFEF`)

#### Scenario: Code elements styled with command color

- **WHEN** inline code spans are rendered
- **THEN** they SHALL be displayed with the command color (`#E5C07B`)

#### Scenario: Code blocks rendered with border and per-language highlighting

- **WHEN** a fenced code block is rendered
- **THEN** each line of code SHALL be prefixed with a styled border character
- **AND** the code SHALL be syntax-highlighted via the theme's `highlightCode` function

#### Scenario: Body text styled with assistant color

- **WHEN** paragraph text and list items are rendered
- **THEN** they SHALL use the assistant color (`#ABB2BF`)

#### Scenario: Blockquotes styled with subtle color

- **WHEN** blockquotes are rendered
- **THEN** they SHALL be displayed with the subtle color (`#5C6370`) and italic formatting

#### Scenario: Output width constrains rendering

- **WHEN** markdown is rendered
- **THEN** the render width SHALL be set to `stderr.columns - 1`
- **AND** table cells and long paragraphs SHALL be word-wrapped to fit within that width

## ADDED Requirements

### Requirement: Unicode surrogate sanitization on token push

The system SHALL sanitize incoming tokens to remove unpaired Unicode surrogates before appending them to the internal buffer.

#### Scenario: Unpaired surrogates stripped from token

- **WHEN** `push(token)` is called with a token containing unpaired Unicode surrogates (U+D800–U+DFFF)
- **THEN** the unpaired surrogates SHALL be stripped from the token before it is appended to the buffer
- **AND** valid surrogate pairs SHALL be preserved

#### Scenario: Clean token passes through unmodified

- **WHEN** `push(token)` is called with a token containing no surrogates
- **THEN** the token SHALL be appended to the buffer without modification

### Requirement: ANSI-aware text measurement and word wrapping

The system SHALL provide ANSI-aware string length measurement and word wrapping utilities used when rendering table cells and long paragraphs.

#### Scenario: Visible length ignores ANSI escape codes

- **WHEN** `visibleLength(str)` is called on a string containing ANSI SGR escape sequences
- **THEN** the return value SHALL equal the visible character count with ANSI codes excluded

#### Scenario: Word wrap respects ANSI-aware width

- **WHEN** a paragraph line or table cell value exceeds the render width in visible characters
- **THEN** the text SHALL be wrapped at word boundaries such that no line exceeds the render width in visible characters
