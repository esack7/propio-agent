## MODIFIED Requirements

### Requirement: Flat provider-specific options

The system SHALL support flat provider-specific configuration options instead of nested objects.

#### Scenario: Ollama provider with host option

- **WHEN** OllamaProviderConfig is created
- **THEN** it SHALL include an optional host field at the top level of the config object (not nested in an ollama sub-object)

#### Scenario: Bedrock provider with region option

- **WHEN** BedrockProviderConfig is created
- **THEN** it SHALL include an optional region field at the top level of the config object (not nested in a bedrock sub-object)

#### Scenario: OpenRouter provider with API key and headers

- **WHEN** OpenRouterProviderConfig is created
- **THEN** it SHALL include an optional apiKey field at the top level of the config object
- **AND** it SHALL include optional httpReferer and xTitle fields for site tracking

#### Scenario: Type field discriminates provider type

- **WHEN** a ProviderConfig is created
- **THEN** it MUST include a type field with value matching the provider type (e.g., 'ollama', 'bedrock', 'openrouter')

### Requirement: Configuration interfaces

The system SHALL provide TypeScript interfaces for configuration structure.

#### Scenario: Model interface structure

- **WHEN** a Model is defined
- **THEN** it SHALL include name (string) and key (string) fields

#### Scenario: ProviderConfig base interface structure

- **WHEN** a ProviderConfig is defined
- **THEN** it SHALL include name (string), type (string), models (Model[]), and defaultModel (string) fields

#### Scenario: OllamaProviderConfig extends base

- **WHEN** OllamaProviderConfig is defined
- **THEN** it SHALL extend ProviderConfig with type: 'ollama' and optional host field

#### Scenario: BedrockProviderConfig extends base

- **WHEN** BedrockProviderConfig is defined
- **THEN** it SHALL extend ProviderConfig with type: 'bedrock' and optional region field

#### Scenario: OpenRouterProviderConfig extends base

- **WHEN** OpenRouterProviderConfig is defined
- **THEN** it SHALL extend ProviderConfig with type: 'openrouter'
- **AND** it SHALL include optional apiKey (string), httpReferer (string), and xTitle (string) fields

#### Scenario: ProviderConfig is discriminated union

- **WHEN** ProviderConfig type is defined
- **THEN** it SHALL be a discriminated union of OllamaProviderConfig, BedrockProviderConfig, and OpenRouterProviderConfig

#### Scenario: ProvidersConfig top-level interface

- **WHEN** ProvidersConfig is defined
- **THEN** it SHALL include providers (ProviderConfig[]) and default (string) fields
