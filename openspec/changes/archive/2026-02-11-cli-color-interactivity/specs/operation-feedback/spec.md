## ADDED Requirements

### Requirement: Spinner for async operations

The system SHALL provide spinner-based progress indicators for async operations such as tool execution and LLM response generation.

#### Scenario: Start spinner for operation

- **WHEN** an operation begins
- **THEN** the system SHALL display a spinner with the operation description

#### Scenario: Stop spinner on success

- **WHEN** an operation completes successfully
- **THEN** the system SHALL replace the spinner with a success symbol and message

#### Scenario: Stop spinner on failure

- **WHEN** an operation fails
- **THEN** the system SHALL replace the spinner with an error symbol and message

#### Scenario: Spinner respects NO_COLOR

- **WHEN** NO_COLOR environment variable is set
- **THEN** the spinner SHALL display in plain text without color or animation

### Requirement: OperationSpinner wrapper class

The system SHALL provide an OperationSpinner class that wraps ora for consistent spinner behavior.

#### Scenario: Create spinner with text

- **WHEN** OperationSpinner is instantiated with operation text
- **THEN** it SHALL create an ora spinner instance configured with that text

#### Scenario: Start spinner

- **WHEN** start() method is called
- **THEN** the spinner SHALL begin animating and display the operation text

#### Scenario: Succeed with message

- **WHEN** succeed() method is called with a success message
- **THEN** the spinner SHALL stop and display a success symbol with the message

#### Scenario: Fail with message

- **WHEN** fail() method is called with an error message
- **THEN** the spinner SHALL stop and display an error symbol with the message

#### Scenario: Stop spinner without status

- **WHEN** stop() method is called
- **THEN** the spinner SHALL stop animating and clear the line

### Requirement: Tool execution spinner integration

The system SHALL display spinners during tool execution in the agent's streamChat operation.

#### Scenario: Tool execution triggers spinner

- **WHEN** the agent begins executing a tool
- **THEN** a spinner SHALL start with text indicating the tool name

#### Scenario: Tool completion stops spinner with success

- **WHEN** tool execution completes successfully
- **THEN** the spinner SHALL stop and display a success message with the tool name

#### Scenario: Tool failure stops spinner with error

- **WHEN** tool execution fails
- **THEN** the spinner SHALL stop and display an error message with the tool name

#### Scenario: Spinner stops before streaming output

- **WHEN** tool execution completes and streaming output begins
- **THEN** the spinner MUST be stopped before any stdout writes to prevent output conflicts

### Requirement: Backward compatibility for spinner callbacks

The system SHALL maintain backward compatibility for code that does not use spinner callbacks.

#### Scenario: Agent works without spinner callbacks

- **WHEN** streamChat is called without onToolStart/onToolEnd callbacks
- **THEN** the agent SHALL emit tool execution status through onToken as bracketed text (existing behavior)

#### Scenario: Spinner callbacks override onToken tool messages

- **WHEN** streamChat is called with onToolStart and onToolEnd callbacks
- **THEN** the agent SHALL NOT emit bracketed tool status through onToken, only call the provided callbacks
