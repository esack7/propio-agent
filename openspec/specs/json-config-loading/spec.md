## Requirements

### Requirement: Load providers configuration from JSON file

The system SHALL provide a function to load and parse a ProvidersConfig object from a JSON file.

#### Scenario: Load valid JSON file

- **WHEN** loadProvidersConfig is called with a path to a valid providers.json file
- **THEN** it SHALL return a ProvidersConfig object with the parsed providers array and default provider name

#### Scenario: Throw error for missing file

- **WHEN** loadProvidersConfig is called with a path to a non-existent file
- **THEN** it SHALL throw a descriptive error indicating the file was not found

#### Scenario: Throw error for invalid JSON

- **WHEN** loadProvidersConfig is called with a path to a file containing malformed JSON
- **THEN** it SHALL throw a descriptive error indicating JSON parsing failed

#### Scenario: Throw error for missing required fields

- **WHEN** loadProvidersConfig is called with JSON missing the providers array or default field
- **THEN** it SHALL throw a descriptive error listing which required fields are missing

### Requirement: Validate provider configuration structure

The system SHALL validate that the loaded configuration meets all structural requirements.

#### Scenario: Validate default references valid provider

- **WHEN** ProvidersConfig is loaded with a default value
- **THEN** it SHALL verify that the default value matches the name of a provider in the providers array
- **AND** throw a descriptive error if no matching provider is found

#### Scenario: Validate defaultModel references valid model key

- **WHEN** each ProviderConfig is validated
- **THEN** it SHALL verify that defaultModel matches a key in the models array
- **AND** throw a descriptive error if no matching model is found

#### Scenario: Validate required provider fields

- **WHEN** each ProviderConfig is validated
- **THEN** it SHALL verify that name, type, models, and defaultModel fields are present
- **AND** throw a descriptive error listing any missing fields

#### Scenario: Validate models array structure

- **WHEN** a provider's models array is validated
- **THEN** it SHALL verify each model has both name and key fields
- **AND** throw a descriptive error if any model is missing required fields

### Requirement: Resolve provider from configuration

The system SHALL provide a function to resolve a specific provider from ProvidersConfig by name.

#### Scenario: Resolve provider by name

- **WHEN** resolveProvider is called with a provider name that exists in the config
- **THEN** it SHALL return the matching ProviderConfig object

#### Scenario: Resolve default provider when no name provided

- **WHEN** resolveProvider is called without a provider name
- **THEN** it SHALL return the ProviderConfig for the provider specified in config.default

#### Scenario: Throw error for unknown provider name

- **WHEN** resolveProvider is called with a provider name that doesn't exist in the config
- **THEN** it SHALL throw a descriptive error listing all available provider names

### Requirement: Resolve model key from provider configuration

The system SHALL provide a function to resolve a specific model key from a ProviderConfig.

#### Scenario: Return provided model key when valid

- **WHEN** resolveModelKey is called with a modelKey that exists in the provider's models array
- **THEN** it SHALL return that model key

#### Scenario: Return default model when no key provided

- **WHEN** resolveModelKey is called without a modelKey parameter
- **THEN** it SHALL return the provider's defaultModel value

#### Scenario: Throw error for invalid model key

- **WHEN** resolveModelKey is called with a modelKey that doesn't exist in the provider's models array
- **THEN** it SHALL throw a descriptive error listing all available model keys for that provider
