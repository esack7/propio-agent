## ADDED Requirements

### Requirement: Tool execution lifecycle callbacks

The system SHALL provide optional callbacks for tool execution start and end events to enable UI integration.

#### Scenario: onToolStart callback on tool execution

- **WHEN** the agent begins executing a tool during streamChat
- **THEN** if onToolStart callback is provided, it SHALL be invoked with the tool name as a parameter

#### Scenario: onToolEnd callback on tool completion

- **WHEN** the agent completes tool execution during streamChat
- **THEN** if onToolEnd callback is provided, it SHALL be invoked with the tool name and result summary as parameters

#### Scenario: Tool callbacks are optional

- **WHEN** streamChat is called without onToolStart or onToolEnd callbacks
- **THEN** the agent SHALL function normally and emit tool status through onToken callback (existing behavior)

#### Scenario: Tool callbacks suppress onToken tool messages

- **WHEN** both onToolStart and onToolEnd callbacks are provided to streamChat
- **THEN** the agent SHALL NOT emit bracketed tool status messages (e.g., "[Executing tool: X]") through the onToken callback

#### Scenario: Partial callback support

- **WHEN** only one of onToolStart or onToolEnd is provided
- **THEN** the agent SHALL invoke the provided callback and use onToken for the missing event

### Requirement: streamChat API extension

The system SHALL extend the streamChat method signature to accept optional tool lifecycle callbacks.

#### Scenario: streamChat accepts onToolStart parameter

- **WHEN** streamChat is called
- **THEN** it SHALL accept an optional onToolStart parameter of type (toolName: string) => void

#### Scenario: streamChat accepts onToolEnd parameter

- **WHEN** streamChat is called
- **THEN** it SHALL accept an optional onToolEnd parameter of type (toolName: string, result: string) => void

#### Scenario: Callback parameters maintain type safety

- **WHEN** callbacks are provided to streamChat
- **THEN** TypeScript SHALL enforce the correct function signatures for onToolStart and onToolEnd

### Requirement: Backward compatibility for streamChat

The system SHALL maintain backward compatibility for existing streamChat usage without tool callbacks.

#### Scenario: Existing code without callbacks continues to work

- **WHEN** streamChat is called with only existing parameters (messages, onToken, etc.)
- **THEN** the agent SHALL behave identically to the previous implementation

#### Scenario: onToken receives all non-tool messages

- **WHEN** tool callbacks are provided
- **THEN** onToken SHALL still receive all streaming tokens for assistant responses, just not tool status messages
