## Requirements

### Requirement: Support multiple provider configurations

The system SHALL support configuration of 1 to 100 LLM providers in a single ProvidersConfig object.

#### Scenario: Configure multiple providers

- **WHEN** ProvidersConfig contains multiple provider entries in the providers array
- **THEN** the system SHALL allow selection of any configured provider at agent initialization

#### Scenario: Each provider has unique name

- **WHEN** ProvidersConfig is created or validated
- **THEN** each provider in the providers array MUST have a unique name value
- **AND** validation SHALL throw an error if duplicate names are detected

#### Scenario: Default provider is specified

- **WHEN** ProvidersConfig is created
- **THEN** it MUST include a default field that specifies which provider to use by default

### Requirement: Support multiple models per provider

The system SHALL allow each provider to define multiple model configurations.

#### Scenario: Provider defines multiple models

- **WHEN** a ProviderConfig is created
- **THEN** its models array SHALL contain one or more Model objects with name and key fields

#### Scenario: Each model has unique key within provider

- **WHEN** a provider's models array is validated
- **THEN** each model MUST have a unique key value within that provider
- **AND** validation SHALL throw an error if duplicate keys are detected

#### Scenario: Provider specifies default model

- **WHEN** a ProviderConfig is created
- **THEN** it MUST include a defaultModel field specifying which model key to use by default

### Requirement: Flat provider-specific options

The system SHALL support flat provider-specific configuration options instead of nested objects.

#### Scenario: Ollama provider with host option

- **WHEN** OllamaProviderConfig is created
- **THEN** it SHALL include an optional host field at the top level of the config object (not nested in an ollama sub-object)

#### Scenario: Bedrock provider with region option

- **WHEN** BedrockProviderConfig is created
- **THEN** it SHALL include an optional region field at the top level of the config object (not nested in a bedrock sub-object)

#### Scenario: Type field discriminates provider type

- **WHEN** a ProviderConfig is created
- **THEN** it MUST include a type field with value matching the provider type (e.g., 'ollama', 'bedrock')

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

#### Scenario: ProvidersConfig top-level interface

- **WHEN** ProvidersConfig is defined
- **THEN** it SHALL include providers (ProviderConfig[]) and default (string) fields
