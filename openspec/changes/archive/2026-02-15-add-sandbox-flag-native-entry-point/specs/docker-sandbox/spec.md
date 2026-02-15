## MODIFIED Requirements

### Requirement: CLI wrapper invocation

The system SHALL provide both direct wrapper invocation and native-entrypoint delegation for starting sandbox mode.

#### Scenario: Invoke from native entrypoint with sandbox flag

- **WHEN** user runs `node dist/index.js --sandbox`
- **THEN** the process delegates to `bin/propio-sandbox` and starts sandbox mode using the caller's current working directory as workspace
- **AND** delegation removes only `--sandbox`, forwarding all other CLI arguments unchanged

#### Scenario: Invoke via npm start with sandbox flag

- **WHEN** user runs `npm start -- --sandbox`
- **THEN** the process delegates to `bin/propio-sandbox` with behavior equivalent to direct wrapper invocation

### Requirement: Native mode compatibility

The system SHALL maintain native execution as default behavior and only delegate to sandbox mode when explicitly requested.

#### Scenario: Native default without sandbox flag

- **WHEN** user runs `node dist/index.js` (or `npm start`) without `--sandbox`
- **THEN** the agent runs natively without Docker, preserving existing behavior

#### Scenario: Delegation does not alter native path

- **WHEN** user enables sandbox via `--sandbox`
- **THEN** native initialization is skipped for that invocation only, without changing default native behavior for future runs

### Requirement: Error handling

The system SHALL surface wrapper execution failures consistently when sandbox mode is requested through native entrypoint delegation.

#### Scenario: Wrapper missing or non-executable

- **WHEN** user runs `node dist/index.js --sandbox` and the resolved `bin/propio-sandbox` is missing or not executable
- **THEN** the CLI displays a clear error and exits non-zero

#### Scenario: Wrapper exits with prerequisite failure

- **WHEN** delegated wrapper reports Docker prerequisite failures (for example, daemon not running or image not built)
- **THEN** the same wrapper error message is shown to the user and the process exits with the wrapper's non-zero status
