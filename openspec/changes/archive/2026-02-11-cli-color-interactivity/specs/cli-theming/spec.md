## ADDED Requirements

### Requirement: Color palette definition

The system SHALL provide a color palette based on the One Atom Dark theme with semantic role assignments.

#### Scenario: Color roles are defined with hex values

- **WHEN** a module imports the color palette
- **THEN** it SHALL have access to color functions for user input (#56B6C2), assistant text (#ABB2BF), tool/function (#C678DD), success (#98C379), error (#E06C75), warning (#D19A66), command (#E5C07B), subtle/muted (#5C6370), and info (#61AFEF)

#### Scenario: Colors support truecolor terminals

- **WHEN** the terminal supports truecolor (24-bit)
- **THEN** the system SHALL render colors using exact hex values via chalk.hex()

#### Scenario: Colors degrade gracefully on limited terminals

- **WHEN** the terminal supports only 256-color or basic ANSI
- **THEN** the system SHALL automatically downgrade to the nearest available color

### Requirement: NO_COLOR environment variable support

The system SHALL respect the NO_COLOR environment variable to disable colored output.

#### Scenario: NO_COLOR disables all colors

- **WHEN** NO_COLOR environment variable is set to any value
- **THEN** all color formatting functions SHALL return unstyled text

#### Scenario: FORCE_COLOR overrides NO_COLOR

- **WHEN** FORCE_COLOR environment variable is set
- **THEN** the system SHALL enable colors even in non-TTY contexts

### Requirement: Terminal capability detection

The system SHALL detect terminal capabilities and adjust output accordingly.

#### Scenario: Non-TTY output disables colors

- **WHEN** stdout is not a TTY (e.g., piped to a file or another process)
- **THEN** the system SHALL automatically disable colored output

#### Scenario: Terminal color level detection

- **WHEN** rendering colored output
- **THEN** the system SHALL use chalk's built-in detection to determine the appropriate color level

### Requirement: Symbol definitions with fallbacks

The system SHALL provide Unicode symbols with ASCII fallbacks for limited terminals.

#### Scenario: Unicode symbols on supported terminals

- **WHEN** the terminal supports Unicode characters
- **THEN** the system SHALL use Unicode symbols (❯, ◆, ✔, ✖, …)

#### Scenario: ASCII fallbacks on limited terminals

- **WHEN** the terminal does not support Unicode or platform is Windows without UTF-8 support
- **THEN** the system SHALL use ASCII fallback symbols (>, \*, √, x, ...)

#### Scenario: Symbol detection based on platform and TERM

- **WHEN** determining whether to use Unicode or ASCII
- **THEN** the system SHALL check process.platform and process.env.TERM for Unicode support indicators

### Requirement: High-level formatting functions

The system SHALL provide high-level formatting functions for common message types in the CLI.

#### Scenario: Format user input messages

- **WHEN** formatUserMessage is called with text
- **THEN** it SHALL return text styled with the user input color

#### Scenario: Format assistant response messages

- **WHEN** formatAssistantMessage is called with text
- **THEN** it SHALL return text styled with the assistant color

#### Scenario: Format tool execution messages

- **WHEN** formatToolExecution is called with a tool name
- **THEN** it SHALL return text styled with the tool/function color

#### Scenario: Format success messages

- **WHEN** formatSuccess is called with text
- **THEN** it SHALL return text styled with the success color

#### Scenario: Format error messages

- **WHEN** formatError is called with text
- **THEN** it SHALL return text styled with the error color

#### Scenario: Format warning messages

- **WHEN** formatWarning is called with text
- **THEN** it SHALL return text styled with the warning color

#### Scenario: Format command messages

- **WHEN** formatCommand is called with text
- **THEN** it SHALL return text styled with the command color

#### Scenario: Format info messages

- **WHEN** formatInfo is called with text
- **THEN** it SHALL return text styled with the info color

#### Scenario: Format muted/subtle messages

- **WHEN** formatSubtle is called with text
- **THEN** it SHALL return text styled with the subtle/muted color

### Requirement: UI module structure

The system SHALL organize terminal formatting functionality in a src/ui/ module with separate concerns.

#### Scenario: Colors module provides palette

- **WHEN** colors.ts is imported
- **THEN** it SHALL export color functions using chalk for all semantic roles

#### Scenario: Symbols module provides icon definitions

- **WHEN** symbols.ts is imported
- **THEN** it SHALL export symbol constants with appropriate Unicode or ASCII values

#### Scenario: Formatting module provides high-level functions

- **WHEN** formatting.ts is imported
- **THEN** it SHALL export formatting functions that compose colors and symbols for message types

#### Scenario: Spinner module provides operation feedback

- **WHEN** spinner.ts is imported
- **THEN** it SHALL export an OperationSpinner class that wraps ora functionality
