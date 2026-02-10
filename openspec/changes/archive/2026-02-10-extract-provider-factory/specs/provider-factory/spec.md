## ADDED Requirements

### Requirement: Factory function for provider creation

The system SHALL provide a factory function that creates LLMProvider instances from ProviderConfig objects.

#### Scenario: Factory creates Ollama provider

- **WHEN** createProvider is called with provider: 'ollama' configuration
- **THEN** it SHALL return an OllamaProvider instance configured with the specified host and model

#### Scenario: Factory creates Bedrock provider

- **WHEN** createProvider is called with provider: 'bedrock' configuration
- **THEN** it SHALL return a BedrockProvider instance configured with the specified region and model

#### Scenario: Factory returns LLMProvider interface

- **WHEN** createProvider returns a provider instance
- **THEN** the return type SHALL be LLMProvider interface, hiding concrete implementation details

#### Scenario: Factory throws on unknown provider type

- **WHEN** createProvider is called with an unrecognized provider type
- **THEN** it SHALL throw an error with message listing valid provider types

### Requirement: Provider instantiation encapsulation

The system SHALL encapsulate all provider instantiation logic within the factory module, preventing direct imports of concrete providers elsewhere.

#### Scenario: Factory imports concrete providers

- **WHEN** the factory module is loaded
- **THEN** it SHALL be the only module that imports OllamaProvider and BedrockProvider classes

#### Scenario: Factory uses switch statement for type resolution

- **WHEN** factory determines which provider to instantiate
- **THEN** it SHALL use a switch statement on config.provider for type-safe provider selection

#### Scenario: Factory extracts provider-specific config

- **WHEN** factory instantiates a provider
- **THEN** it SHALL extract the provider-specific configuration (ollama or bedrock) from ProviderConfig

### Requirement: Configuration model extraction

The system SHALL provide a utility function to extract the model name from ProviderConfig.

#### Scenario: Extract model from Ollama config

- **WHEN** extractModelFromConfig is called with Ollama ProviderConfig
- **THEN** it SHALL return config.ollama.model value

#### Scenario: Extract model from Bedrock config

- **WHEN** extractModelFromConfig is called with Bedrock ProviderConfig
- **THEN** it SHALL return config.bedrock.model value

#### Scenario: Return undefined for missing model

- **WHEN** extractModelFromConfig is called with config lacking model field
- **THEN** it SHALL return undefined

### Requirement: Error handling

The system SHALL provide clear, actionable error messages for factory failures.

#### Scenario: Unknown provider error includes suggestions

- **WHEN** factory encounters unknown provider type
- **THEN** error message SHALL include list of valid provider types

#### Scenario: Error format is descriptive

- **WHEN** factory throws an error
- **THEN** error message SHALL follow format: "Unknown provider type: \"{type}\". Valid providers: ollama, bedrock"

### Requirement: Type safety

The system SHALL maintain TypeScript type safety throughout the factory implementation.

#### Scenario: Factory parameter is typed

- **WHEN** createProvider function is declared
- **THEN** it SHALL accept config parameter typed as ProviderConfig

#### Scenario: Factory return type is interface

- **WHEN** createProvider function is declared
- **THEN** it SHALL return type LLMProvider (interface, not concrete class)

#### Scenario: Provider-specific config narrowing

- **WHEN** factory extracts provider-specific config in switch cases
- **THEN** it SHALL maintain type safety through discriminated union narrowing
