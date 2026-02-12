## MODIFIED Requirements

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

#### Scenario: Agent accepts optional agentsMdContent for system prompt composition

- **WHEN** Agent is instantiated with an agentsMdContent parameter containing a non-empty string
- **THEN** it SHALL prepend the agentsMdContent to the system prompt (whether provided or default), separated by two newlines

#### Scenario: Agent without agentsMdContent uses system prompt unchanged

- **WHEN** Agent is instantiated without an agentsMdContent parameter (or with an empty string)
- **THEN** it SHALL use the systemPrompt parameter (or default) without modification, preserving existing behavior
