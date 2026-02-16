## ADDED Requirements

### Requirement: Startup banner displayed at CLI launch

The system SHALL display a fixed "Propio Agent" ASCII-art banner at the start of each normal CLI run. The banner SHALL appear before any other application output. The banner SHALL NOT be displayed when the process delegates to sandbox (e.g. when `--sandbox` is used and execution is handed off to the wrapper).

#### Scenario: Normal run shows banner first

- **WHEN** the user runs the CLI and the process does not delegate to sandbox
- **THEN** the first output to stdout SHALL be the startup banner
- **AND** the banner SHALL appear before configuration loading, agent setup, or prompt output

#### Scenario: Sandbox delegation does not show banner

- **WHEN** the user invokes the CLI with sandbox delegation (e.g. `--sandbox`) and the process exits after delegating
- **THEN** the startup banner SHALL NOT be printed
- **AND** only the wrapper's behavior and output SHALL be visible to the user

#### Scenario: Banner content identifies Propio Agent

- **WHEN** the startup banner is displayed
- **THEN** the banner SHALL include the word "PROPIO" in block-style ASCII art
- **AND** the banner SHALL include the text "A G E N T" (or equivalent) so the combined output reads as "Propio Agent"
