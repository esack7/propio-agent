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
