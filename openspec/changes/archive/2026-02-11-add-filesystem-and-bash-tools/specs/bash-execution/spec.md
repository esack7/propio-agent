## ADDED Requirements

### Requirement: run_bash tool executes shell commands

The system SHALL provide a `run_bash` tool that executes a shell command and returns its output. The tool MUST accept a `command` string (required), an optional `cwd` string (working directory, defaults to `process.cwd()`), an optional `env` object (additional environment variables merged with `process.env`), and an optional `timeout` number in milliseconds (default 30000). The tool MUST return a JSON string containing `stdout`, `stderr`, and `exit_code` fields.

#### Scenario: Execute a simple command

- **WHEN** `run_bash` is called with a `command` like `"echo hello"`
- **THEN** the system returns a JSON string with `stdout` containing `"hello\n"`, `stderr` containing `""`, and `exit_code` of `0`

#### Scenario: Command with non-zero exit code

- **WHEN** `run_bash` is called with a `command` that exits with a non-zero status
- **THEN** the system returns a JSON string with the captured `stdout`, `stderr`, and the actual `exit_code` (the tool MUST NOT throw on non-zero exit)

#### Scenario: Command with custom working directory

- **WHEN** `run_bash` is called with a `command` and a `cwd` pointing to a valid directory
- **THEN** the system executes the command in the specified working directory

#### Scenario: Command with additional environment variables

- **WHEN** `run_bash` is called with a `command` and an `env` object containing key-value pairs
- **THEN** the system executes the command with `process.env` merged with the provided `env` values (provided values override `process.env`)

#### Scenario: Command exceeds timeout

- **WHEN** `run_bash` is called with a `command` that does not complete within the specified `timeout`
- **THEN** the system kills the process and returns a JSON string with whatever output was captured, `exit_code` of `-1`, and a timeout indicator in `stderr`

#### Scenario: Output truncation on large stdout or stderr

- **WHEN** `run_bash` executes a command that produces `stdout` or `stderr` exceeding 50KB
- **THEN** the system truncates the exceeding field to 50KB and appends a truncation notice

### Requirement: run_bash is disabled by default

The system SHALL register the `run_bash` tool in the default tool factory but MUST disable it immediately after registration. The tool MUST NOT be available for execution until explicitly enabled by the user.

#### Scenario: run_bash is registered but disabled in default factory

- **WHEN** the default tool registry is created via the factory
- **THEN** `hasTool("run_bash")` returns `true` AND `isToolEnabled("run_bash")` returns `false`

#### Scenario: run_bash rejects execution when disabled

- **WHEN** `execute("run_bash", ...)` is called on a registry where `run_bash` is disabled
- **THEN** the system returns `"Tool not available: run_bash"`

#### Scenario: run_bash works after explicit enable

- **WHEN** the user calls `enableTool("run_bash")` and then `execute("run_bash", { command: "echo test" })`
- **THEN** the system executes the command and returns the JSON result
