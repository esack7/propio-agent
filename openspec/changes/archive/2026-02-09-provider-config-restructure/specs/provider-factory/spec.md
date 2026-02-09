## MODIFIED Requirements

### Requirement: Factory function for provider creation

The system SHALL provide a factory function that creates LLMProvider instances from ProviderConfig objects.

#### Scenario: Factory creates Ollama provider from new config shape
- **WHEN** createProvider is called with a ProviderConfig where type: 'ollama'
- **THEN** it SHALL return an OllamaProvider instance configured with the specified model and host from top-level config fields

#### Scenario: Factory creates Bedrock provider from new config shape
- **WHEN** createProvider is called with a ProviderConfig where type: 'bedrock'
- **THEN** it SHALL return a BedrockProvider instance configured with the specified model and region from top-level config fields

#### Scenario: Factory accepts model key parameter
- **WHEN** createProvider is called with a ProviderConfig and optional modelKey parameter
- **THEN** it SHALL use the provided modelKey for provider instantiation instead of config.defaultModel

#### Scenario: Factory returns LLMProvider interface
- **WHEN** createProvider returns a provider instance
- **THEN** the return type SHALL be LLMProvider interface, hiding concrete implementation details

#### Scenario: Factory throws on unknown provider type
- **WHEN** createProvider is called with an unrecognized type value
- **THEN** it SHALL throw an error with message listing valid provider types

### Requirement: Provider instantiation encapsulation

The system SHALL encapsulate all provider instantiation logic within the factory module, preventing direct imports of concrete providers elsewhere.

#### Scenario: Factory imports concrete providers
- **WHEN** the factory module is loaded
- **THEN** it SHALL be the only module that imports OllamaProvider and BedrockProvider classes

#### Scenario: Factory uses switch statement on type field
- **WHEN** factory determines which provider to instantiate
- **THEN** it SHALL use a switch statement on config.type for type-safe provider selection

#### Scenario: Factory uses type assertion for provider-specific config
- **WHEN** factory instantiates a provider
- **THEN** it SHALL use type assertion (e.g., config as OllamaProviderConfig) to access provider-specific fields like host or region

### Requirement: Configuration model extraction

The system SHALL provide a utility function to extract the model name from ProviderConfig.

#### Scenario: Extract default model from config
- **WHEN** extractModelFromConfig is called with a ProviderConfig
- **THEN** it SHALL return config.defaultModel value

#### Scenario: Return value regardless of provider type
- **WHEN** extractModelFromConfig is called with any valid ProviderConfig
- **THEN** it SHALL return the defaultModel field since all providers now have this field at the top level
