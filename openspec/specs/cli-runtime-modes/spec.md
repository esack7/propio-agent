## ADDED Requirements

### Requirement: Runtime mode detection

The system SHALL determine CLI interaction behavior from terminal capability, CI environment, and explicit flags.

#### Scenario: Interactive mode on local TTY

- **WHEN** stdin/stdout are TTY, CI is not enabled, and neither `--no-interactive` nor `--json` is set
- **THEN** the system SHALL run the prompt loop with interactive UX features

#### Scenario: Non-interactive mode in CI or non-TTY

- **WHEN** output is non-TTY, CI is enabled, or `--no-interactive` is set
- **THEN** the system SHALL disable prompt-driven interaction and consume one request from stdin

### Requirement: Centralized terminal writer

The system SHALL route terminal output through a dedicated UI layer rather than scattered direct console writes.

#### Scenario: Status and line output use UI methods

- **WHEN** the CLI emits status, info, warning, error, or success messages
- **THEN** output SHALL be emitted via UI methods that coordinate spinner lifecycle and line stability

### Requirement: JSON output contract

The system SHALL provide machine-readable output mode.

#### Scenario: JSON mode success output

- **WHEN** `--json` is enabled and request execution succeeds
- **THEN** stdout SHALL contain only JSON payload output

#### Scenario: JSON mode disables interactive styling

- **WHEN** `--json` is enabled
- **THEN** colors and spinner animation SHALL be disabled

### Requirement: LLM diagnostics visibility

The system SHALL provide optional introspection for LLM request lifecycle events.

#### Scenario: Debug diagnostics enabled by flag

- **WHEN** `--debug-llm` is set
- **THEN** the CLI SHALL emit structured diagnostics for request start, streaming progress, tool execution, and provider errors
- **AND** diagnostics SHALL be written to stderr without changing stdout payloads

#### Scenario: Debug diagnostics persisted to file

- **WHEN** `--debug-llm-file <path>` is set
- **THEN** the CLI SHALL append structured diagnostics for request start, streaming progress, tool execution, and provider errors to the specified file path
- **AND** the CLI SHALL create missing parent directories for the file path
- **AND** diagnostics written to file SHALL NOT alter stdout payloads

#### Scenario: Empty response warning

- **WHEN** a request completes without provider error and the final assistant response is empty or whitespace
- **THEN** the CLI SHALL display a warning indicating an empty response occurred
- **AND** the warning SHALL include guidance to enable LLM diagnostics

### Requirement: Cancellation and cleanup

The system SHALL treat interruption and terminal cleanup as first-class behavior.

#### Scenario: SIGINT cancels active request

- **WHEN** the process receives `SIGINT` during an in-flight request
- **THEN** the request SHALL be aborted via `AbortController`
- **AND** the process SHALL exit with status code `130`

#### Scenario: Exit path restores terminal state

- **WHEN** the CLI exits due to success, error, or interruption
- **THEN** any active spinner SHALL be stopped
- **AND** output SHALL end with a trailing newline
