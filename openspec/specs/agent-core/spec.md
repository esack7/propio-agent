## Requirements

### Requirement: Provider configuration

The system SHALL allow the Agent class to be configured with an LLM provider at instantiation time using ProvidersConfig.

#### Scenario: Agent accepts providers configuration object

- **WHEN** Agent is instantiated with a providersConfig parameter containing a ProvidersConfig object
- **THEN** it SHALL use the config loader to resolve the provider and create the appropriate LLMProvider implementation

#### Scenario: Agent accepts providers configuration file path

- **WHEN** Agent is instantiated with a providersConfig parameter containing a string file path
- **THEN** it SHALL load the ProvidersConfig from the JSON file and use it to create the LLMProvider

#### Scenario: Agent requires providers configuration

- **WHEN** Agent constructor is called
- **THEN** it SHALL require a providersConfig parameter (no defaults or legacy options)

#### Scenario: Agent accepts optional provider name override

- **WHEN** Agent is instantiated with a providerName parameter
- **THEN** it SHALL use that provider instead of the default specified in ProvidersConfig

#### Scenario: Agent accepts optional model key override

- **WHEN** Agent is instantiated with a modelKey parameter
- **THEN** it SHALL use that model instead of the defaultModel specified in the provider configuration

#### Scenario: Configure Ollama provider from multi-provider config

- **WHEN** Agent is instantiated with ProvidersConfig containing an Ollama provider entry
- **THEN** it SHALL use factory to create an OllamaProvider with the resolved model and host settings

#### Scenario: Configure Bedrock provider from multi-provider config

- **WHEN** Agent is instantiated with ProvidersConfig containing a Bedrock provider entry
- **THEN** it SHALL use factory to create a BedrockProvider with the resolved model and region settings

#### Scenario: Agent stores providers configuration for runtime switching

- **WHEN** Agent is instantiated with ProvidersConfig
- **THEN** it SHALL store the configuration for use by switchProvider() method

### Requirement: Runtime provider switching

The system SHALL allow switching the LLM provider at runtime without losing session context.

#### Scenario: Switch provider by name from stored config

- **WHEN** Agent.switchProvider() is called with a provider name from the stored ProvidersConfig
- **THEN** it SHALL resolve the provider configuration and create a new provider instance while preserving sessionContext

#### Scenario: Switch provider with model key override

- **WHEN** Agent.switchProvider() is called with a provider name and optional modelKey
- **THEN** it SHALL resolve the model key using resolveModelKey() and create provider with that model

#### Scenario: Session context preserved across switch

- **WHEN** provider is switched
- **THEN** all messages in sessionContext SHALL remain intact using provider-agnostic ChatMessage format

#### Scenario: Provider switch validates configuration

- **WHEN** Agent.switchProvider() is called with invalid provider name
- **THEN** it SHALL throw an error from resolveProvider() without modifying the current provider

#### Scenario: Provider switch validates model key

- **WHEN** Agent.switchProvider() is called with invalid modelKey for the provider
- **THEN** it SHALL throw an error from resolveModelKey() without modifying the current provider

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
