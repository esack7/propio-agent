## Why

The current `ProviderConfig` is a discriminated union with nested provider-specific objects (`{ provider: 'ollama', ollama: { model, host } }`). This design works for 2 providers but doesn't scale to support 1-100 providers with multiple models each. A JSON-based configuration system is needed to support enterprise use cases with multiple LLM providers and models configured declaratively.

## What Changes

- **BREAKING**: Replace discriminated union `ProviderConfig` with new multi-provider configuration interfaces
- **BREAKING**: Agent constructor now accepts `providersConfig` (object or file path) instead of `providerConfig`
- Create `ProvidersConfig` type to represent multiple providers with a default provider setting
- Add `Model` interface to represent model definitions within each provider
- Add `configLoader.ts` module for loading and validating JSON configuration files
- Create default `providers.json` file at project root with sample configuration
- Update factory to switch on `config.type` instead of `config.provider`
- Agent constructor accepts optional `providerName` and `modelKey` to override defaults
- Update `switchProvider()` method to work with new multi-provider config structure

## Capabilities

### New Capabilities

- `json-config-loading`: Load and validate multi-provider configuration from external JSON files with descriptive error messages for missing or invalid fields
- `multi-provider-config`: Support 1-100 providers in a single configuration, each with multiple models, a default model, and flat provider-specific options

### Modified Capabilities

- `agent-core`: Constructor signature changes from `providerConfig` to `providersConfig`, adds optional `providerName` and `modelKey` parameters, uses config loader utilities
- `provider-factory`: Factory switches on `config.type` (was `config.provider`), extracts model from `config.defaultModel`, accepts new config shape with flat provider-specific options

## Impact

**Files to Modify:**

- `src/providers/config.ts` - Rewrite types to new interface structure
- `src/providers/configLoader.ts` - **New file** for JSON loading and validation
- `src/providers/factory.ts` - Update to handle new config shape
- `src/agent.ts` - New constructor signature and initialization logic
- `src/index.ts` - Use file-based config instead of inline object
- `providers.json` - **New file** at project root

**Test Files:**

- `src/providers/__tests__/config.test.ts`
- `src/providers/__tests__/factory.test.ts`
- `src/__tests__/agent.test.ts`
- `src/__tests__/integration.test.ts`

**Breaking Changes:**

- All existing code that instantiates `Agent` with inline `providerConfig` must migrate to new `providersConfig` format
- Factory consumers that depend on discriminated union structure will need updates
