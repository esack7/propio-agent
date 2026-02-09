## ADDED Requirements

### Requirement: Factory pattern for provider instantiation

The system SHALL provide a factory pattern as the canonical way to create provider instances from configuration.

#### Scenario: Factory exported from providers module
- **WHEN** code needs to create a provider instance
- **THEN** it SHALL use the createProvider factory function from src/providers/factory.ts

#### Scenario: Factory decouples consumers from implementations
- **WHEN** new provider types are added
- **THEN** only the factory module SHALL require modification, not provider consumers

#### Scenario: Factory is the single point of provider creation
- **WHEN** a component needs a provider instance
- **THEN** it SHALL use createProvider rather than directly instantiating provider classes
