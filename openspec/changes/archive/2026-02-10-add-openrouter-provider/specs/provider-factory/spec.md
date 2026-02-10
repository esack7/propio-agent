## MODIFIED Requirements

### Requirement: Factory function for provider creation

The system SHALL provide a factory function that creates LLMProvider instances from ProviderConfig objects.

#### Scenario: Factory creates Ollama provider from new config shape

- **WHEN** createProvider is called with a ProviderConfig where type: 'ollama'
- **THEN** it SHALL return an OllamaProvider instance configured with the specified model and host from top-level config fields

#### Scenario: Factory creates Bedrock provider from new config shape

- **WHEN** createProvider is called with a ProviderConfig where type: 'bedrock'
- **THEN** it SHALL return a BedrockProvider instance configured with the specified model and region from top-level config fields

#### Scenario: Factory creates OpenRouter provider

- **WHEN** createProvider is called with a ProviderConfig where type: 'openrouter'
- **THEN** it SHALL return an OpenRouterProvider instance configured with the specified model, apiKey, httpReferer, and xTitle from top-level config fields

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
- **THEN** it SHALL be the only module that imports OllamaProvider, BedrockProvider, and OpenRouterProvider classes

#### Scenario: Factory uses switch statement on type field

- **WHEN** factory determines which provider to instantiate
- **THEN** it SHALL use a switch statement on config.type for type-safe provider selection

#### Scenario: Factory uses type assertion for provider-specific config

- **WHEN** factory instantiates a provider
- **THEN** it SHALL use type assertion (e.g., config as OllamaProviderConfig, config as OpenRouterProviderConfig) to access provider-specific fields like host, region, apiKey, httpReferer, or xTitle

### Requirement: Error handling

The system SHALL provide clear, actionable error messages for factory failures.

#### Scenario: Unknown provider error includes suggestions

- **WHEN** factory encounters unknown provider type
- **THEN** error message SHALL include list of valid provider types

#### Scenario: Error format is descriptive

- **WHEN** factory throws an error
- **THEN** error message SHALL follow format: "Unknown provider type: \"{type}\". Valid providers: ollama, bedrock, openrouter"
