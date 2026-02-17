# markdown-streaming Specification

## Purpose

Provide real-time streaming markdown rendering in the terminal with ANSI styling and cursor rewind capability, enabling live display of assistant responses as they arrive from the LLM.
## Requirements
### Requirement: MarkdownStreamer class

The system SHALL provide a MarkdownStreamer class that accumulates streaming tokens and renders them as ANSI-styled markdown terminal output.

#### Scenario: Push token into buffer

- **WHEN** `push(token)` is called with a text token
- **THEN** the token SHALL be appended to the internal buffer
- **AND** a debounced re-render SHALL be scheduled

#### Scenario: Flush commits current segment

- **WHEN** `flush()` is called
- **THEN** the current buffer SHALL be rendered immediately as final markdown output
- **AND** the rendered output SHALL be committed (cursor rewind boundary resets)
- **AND** the buffer SHALL be cleared for the next segment

#### Scenario: Finish completes the stream

- **WHEN** `finish()` is called
- **THEN** the current buffer SHALL be flushed
- **AND** cursor visibility SHALL be restored
- **AND** any pending debounce timers SHALL be cancelled

#### Scenario: Empty buffer flush is a no-op

- **WHEN** `flush()` or `finish()` is called with an empty buffer
- **THEN** no output SHALL be written
- **AND** no ANSI cursor control sequences SHALL be emitted

### Requirement: Debounced re-rendering

The system SHALL debounce markdown re-renders to limit rendering frequency during rapid token arrival.

#### Scenario: Tokens within debounce window are batched

- **WHEN** multiple tokens arrive within a 50ms window
- **THEN** only one re-render SHALL occur at the end of the window

#### Scenario: Flush bypasses debounce

- **WHEN** `flush()` is called while a debounce timer is pending
- **THEN** the pending timer SHALL be cancelled
- **AND** an immediate render SHALL occur

#### Scenario: Finish bypasses debounce

- **WHEN** `finish()` is called while a debounce timer is pending
- **THEN** the pending timer SHALL be cancelled
- **AND** an immediate final render SHALL occur

### Requirement: ANSI cursor control for output replacement

The system SHALL use ANSI escape sequences to replace previously rendered output on each re-render cycle.

#### Scenario: Cursor moves up to rewrite previous output

- **WHEN** a re-render occurs after previous output has been written
- **THEN** the system SHALL move the cursor up by the number of previously rendered lines using `\x1b[<N>A`
- **AND** clear from cursor to end of screen using `\x1b[0J`
- **AND** write the newly rendered markdown output

#### Scenario: First render has no cursor rewind

- **WHEN** the first render occurs (no previous output)
- **THEN** the system SHALL write the rendered output without any cursor-up movement

#### Scenario: Flush resets the rewind boundary

- **WHEN** `flush()` commits the current segment
- **THEN** the tracked line count SHALL reset to zero
- **AND** subsequent re-renders SHALL NOT rewind past the committed output

### Requirement: Cursor visibility management

The system SHALL hide the terminal cursor during re-render cycles to prevent flicker.

#### Scenario: Cursor hidden during re-render

- **WHEN** a re-render cycle begins
- **THEN** the cursor SHALL be hidden using `\x1b[?25l` before cursor movement
- **AND** the cursor SHALL be restored using `\x1b[?25h` after output is written

#### Scenario: Cursor restored on finish

- **WHEN** `finish()` is called
- **THEN** the cursor SHALL be restored to visible state regardless of current render state

#### Scenario: Cursor restored on error

- **WHEN** an error occurs during rendering
- **THEN** the cursor SHALL be restored to visible state before the error propagates

### Requirement: Markdown parsing with marked and marked-terminal

The system SHALL use `marked` for markdown parsing and `marked-terminal` for ANSI terminal rendering.

#### Scenario: Full markdown syntax support

- **WHEN** the buffer contains markdown with headers, code blocks, inline code, lists, bold, italic, links, blockquotes, or tables
- **THEN** the rendered output SHALL display each element with appropriate ANSI styling

#### Scenario: Syntax highlighting in fenced code blocks

- **WHEN** a fenced code block includes a language identifier
- **THEN** the rendered output SHALL include syntax highlighting for that language

#### Scenario: Partial markdown constructs render gracefully

- **WHEN** the buffer contains unclosed code fences, incomplete tables, or partial formatting markers during streaming
- **THEN** `marked` SHALL parse the incomplete content without errors
- **AND** the final `finish()` render SHALL use complete content for correct output

### Requirement: Markdown styling matches Atom Dark palette

The system SHALL configure `marked-terminal` styling to align with the existing color palette defined in `src/ui/colors.ts`.

#### Scenario: Headers styled with info color

- **WHEN** markdown headers are rendered
- **THEN** they SHALL be displayed in bold with the info color (`#61AFEF`)

#### Scenario: Code elements styled with command color

- **WHEN** code blocks or inline code are rendered
- **THEN** they SHALL be displayed with the command color (`#E5C07B`)

#### Scenario: Body text styled with assistant color

- **WHEN** paragraph text and list items are rendered
- **THEN** they SHALL use the assistant color (`#ABB2BF`)

#### Scenario: Blockquotes styled with subtle color

- **WHEN** blockquotes are rendered
- **THEN** they SHALL be displayed with the subtle color (`#5C6370`) and italic formatting

#### Scenario: Output width matches terminal

- **WHEN** markdown is rendered
- **THEN** the output width SHALL be set to `stderr.columns - 1`
- **AND** `reflowText` SHALL be enabled to handle word wrapping

### Requirement: Mode-aware streamer factory

The system SHALL provide a factory method on TerminalUi that creates the appropriate streamer implementation based on the current output mode.

#### Scenario: Interactive TTY mode returns MarkdownStreamer

- **WHEN** `createMarkdownStream()` is called in interactive mode with a TTY stderr
- **THEN** it SHALL return a MarkdownStreamer instance that renders markdown with ANSI cursor control

#### Scenario: Plain mode returns passthrough streamer

- **WHEN** `createMarkdownStream()` is called in plain mode
- **THEN** it SHALL return a passthrough streamer that writes tokens directly without markdown parsing or cursor control

#### Scenario: JSON mode returns passthrough streamer

- **WHEN** `createMarkdownStream()` is called in JSON mode
- **THEN** it SHALL return a passthrough streamer that suppresses all output (consistent with existing JSON mode behavior)

#### Scenario: Non-TTY returns passthrough streamer

- **WHEN** `createMarkdownStream()` is called and stderr is not a TTY
- **THEN** it SHALL return a passthrough streamer that writes tokens directly without ANSI cursor control

### Requirement: Integration with streamAssistantResponse

The system SHALL replace the current direct token-write pattern in `streamAssistantResponse` with the MarkdownStreamer lifecycle.

#### Scenario: Tokens routed through markdown streamer

- **WHEN** `onToken` callback receives a token during assistant response streaming
- **THEN** the token SHALL be passed to `mdStream.push(token)` instead of `ui.writeAssistant(token)`

#### Scenario: Stream finished after response completes

- **WHEN** `agent.streamChat()` resolves
- **THEN** `mdStream.finish()` SHALL be called to render final output and clean up

