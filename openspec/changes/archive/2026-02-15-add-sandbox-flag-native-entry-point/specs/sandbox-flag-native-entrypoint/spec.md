## ADDED Requirements

### Requirement: Native CLI sandbox flag

The system SHALL accept a `--sandbox` flag on the native CLI entrypoint and delegate execution to the canonical sandbox wrapper.

#### Scenario: Run sandbox mode from native entrypoint

- **WHEN** the user runs `node dist/index.js --sandbox`
- **THEN** the process invokes `bin/propio-sandbox` and does not start native agent initialization in the current process

#### Scenario: Run sandbox mode through npm script

- **WHEN** the user runs `npm start -- --sandbox`
- **THEN** behavior matches `node dist/index.js --sandbox` and delegates to `bin/propio-sandbox`

### Requirement: Wrapper invocation argument handling

The system SHALL remove only `--sandbox` from forwarded arguments while preserving all other CLI arguments and flags when delegating to the wrapper.

#### Scenario: Forward non-sandbox arguments

- **WHEN** the user runs `node dist/index.js --sandbox --help`
- **THEN** the wrapper is invoked with `--help` and without `--sandbox`

#### Scenario: Preserve argument order

- **WHEN** the user runs `node dist/index.js --sandbox --foo bar`
- **THEN** forwarded arguments remain in the original order excluding the removed `--sandbox`

#### Scenario: Preserve unrelated flags for future compatibility

- **WHEN** the user runs `node dist/index.js --sandbox --verbose --profile dev`
- **THEN** forwarded arguments include `--verbose --profile dev` in the same order, excluding only `--sandbox`

### Requirement: Deterministic wrapper resolution

The system SHALL resolve `bin/propio-sandbox` relative to the runtime entrypoint location rather than the current working directory.

#### Scenario: Invoke from non-repo directory

- **WHEN** the user runs `/path/to/propio/dist/index.js --sandbox` from another directory
- **THEN** the wrapper path resolves to `/path/to/propio/bin/propio-sandbox` and executes successfully

#### Scenario: Invoke from repo root

- **WHEN** the user runs `node dist/index.js --sandbox` from the repository root
- **THEN** wrapper resolution succeeds without requiring absolute paths

### Requirement: Exit code and error propagation

The system SHALL propagate wrapper process outcomes to the native CLI caller.

#### Scenario: Wrapper exits non-zero

- **WHEN** `bin/propio-sandbox` exits with a non-zero status
- **THEN** `dist/index.js --sandbox` exits with the same non-zero status

#### Scenario: Wrapper missing or not executable

- **WHEN** the resolved wrapper file does not exist or cannot be executed
- **THEN** the CLI prints a clear error message and exits non-zero

#### Scenario: Wrapper spawn failure

- **WHEN** process spawn fails due to runtime OS error
- **THEN** the CLI surfaces the error message and exits non-zero
