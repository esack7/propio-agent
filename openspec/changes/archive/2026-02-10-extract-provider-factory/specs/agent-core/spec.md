## MODIFIED Requirements

### Requirement: Provider configuration

The system SHALL allow the Agent class to be configured with an LLM provider at instantiation time using ProviderConfig.

#### Scenario: Agent accepts provider configuration

- **WHEN** Agent is instantiated with a providerConfig parameter
- **THEN** it SHALL use the factory to create the appropriate LLMProvider implementation

#### Scenario: Agent requires provider configuration

- **WHEN** Agent constructor is called
- **THEN** it SHALL require a providerConfig parameter (no defaults or legacy options)

#### Scenario: Configure Ollama provider

- **WHEN** Agent is instantiated with provider: 'ollama' configuration
- **THEN** it SHALL use factory to create an OllamaProvider with specified host and model settings

#### Scenario: Configure Bedrock provider

- **WHEN** Agent is instantiated with provider: 'bedrock' configuration
- **THEN** it SHALL use factory to create a BedrockProvider with specified region and model settings

### Requirement: Provider abstraction usage

The system SHALL refactor the Agent class to use the provider factory instead of creating providers directly.

#### Scenario: Agent uses factory for provider creation

- **WHEN** Agent constructor initializes a provider
- **THEN** it SHALL call createProvider(config) from the factory module

#### Scenario: Agent does not import concrete providers

- **WHEN** Agent class is refactored
- **THEN** it SHALL NOT import OllamaProvider or BedrockProvider classes directly

#### Scenario: Chat uses provider interface

- **WHEN** Agent.chat() is called with a user message
- **THEN** it SHALL build a ChatRequest and call provider.chat() instead of ollama.chat()

#### Scenario: Stream chat uses provider interface

- **WHEN** Agent.streamChat() is called with a user message
- **THEN** it SHALL build a ChatRequest and iterate over provider.streamChat() instead of ollama.chat()

#### Scenario: Use provider-agnostic types

- **WHEN** Agent manages session context
- **THEN** it SHALL use ChatMessage type instead of Ollama-specific Message type

## REMOVED Requirements

### Requirement: Backward compatibility

**Reason**: Simplifying Agent API to only use ProviderConfig, removing legacy constructor options (model, host) for cleaner architecture

**Migration**: Update Agent instantiation to use providerConfig parameter instead of legacy options:

```typescript
// OLD (no longer supported)
const agent = new Agent({
  model: "qwen3-coder:30b",
  host: "http://localhost:11434",
});

// NEW (required)
const agent = new Agent({
  providerConfig: {
    provider: "ollama",
    ollama: {
      model: "qwen3-coder:30b",
      host: process.env.OLLAMA_HOST || "http://localhost:11434",
    },
  },
});
```
