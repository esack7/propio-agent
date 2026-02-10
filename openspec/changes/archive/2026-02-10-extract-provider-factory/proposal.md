## Why

The Agent class currently imports concrete provider implementations (OllamaProvider and BedrockProvider) directly, coupling it to specific provider types. This violates the Open/Closed Principle - every new provider requires modifying the Agent class, defeating the purpose of the provider abstraction layer.

## What Changes

- Extract provider instantiation logic into a dedicated factory module (`src/providers/factory.ts`)
- Remove direct imports of OllamaProvider and BedrockProvider from Agent.ts
- Agent delegates all provider creation to the factory
- Factory encapsulates provider type resolution and instantiation
- Simplify Agent constructor to only accept ProviderConfig (remove legacy model/host options)

## Capabilities

### New Capabilities

- `provider-factory`: Factory pattern for creating LLM provider instances from configuration, enabling new providers to be added without modifying the Agent class

### Modified Capabilities

- `llm-provider-abstraction`: Add factory pattern as the canonical way to instantiate providers from configuration
- `agent-core`: Remove direct provider dependencies, delegate provider creation to factory

## Impact

**Modified Files:**

- `src/agent.ts` - Remove OllamaProvider/BedrockProvider imports, use factory instead
- `src/providers/types.ts` or `src/providers/config.ts` - May need to export factory function

**New Files:**

- `src/providers/factory.ts` - Centralized provider creation logic
- `src/providers/__tests__/factory.test.ts` - Factory unit tests

**Dependencies:**

- No new external dependencies
- Internal dependency on existing provider implementations

**Breaking Changes:**

- **BREAKING**: Agent constructor no longer accepts legacy options (model, host)
- **BREAKING**: Agent constructor now requires providerConfig parameter
- Update src/index.ts to use new constructor API
