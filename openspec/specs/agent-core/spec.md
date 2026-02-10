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
