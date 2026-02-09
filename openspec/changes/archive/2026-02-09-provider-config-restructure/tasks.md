## 1. Update Configuration Types

- [x] 1.1 Rewrite `src/providers/config.ts` with new interfaces (Model, ProviderConfig, OllamaProviderConfig, BedrockProviderConfig, ProvidersConfig)
- [x] 1.2 Update `src/providers/__tests__/config.test.ts` to test new configuration types

## 2. Create Configuration Loader Module

- [x] 2.1 Create `src/providers/configLoader.ts` with `loadProvidersConfig()` function
- [x] 2.2 Implement `resolveProvider()` function in configLoader.ts
- [x] 2.3 Implement `resolveModelKey()` function in configLoader.ts
- [x] 2.4 Add validation logic for required fields and references
- [x] 2.5 Create `src/providers/__tests__/configLoader.test.ts` with tests for loading, validation, and resolution

## 3. Update Provider Factory

- [x] 3.1 Update `createProvider()` in `src/providers/factory.ts` to accept ProviderConfig with type field and optional modelKey parameter
- [x] 3.2 Change factory switch statement from config.provider to config.type
- [x] 3.3 Update Ollama provider instantiation to use flat config structure (config.host, modelKey || config.defaultModel)
- [x] 3.4 Update Bedrock provider instantiation to use flat config structure (config.region, modelKey || config.defaultModel)
- [x] 3.5 Simplify `extractModelFromConfig()` to return config.defaultModel
- [x] 3.6 Update `src/providers/__tests__/factory.test.ts` to use new config shape

## 4. Update Agent Class

- [x] 4.1 Update Agent constructor signature to accept providersConfig (ProvidersConfig | string), optional providerName, and optional modelKey
- [x] 4.2 Add logic to load ProvidersConfig from file path if string is provided
- [x] 4.3 Add logic to resolve provider using resolveProvider(config, providerName)
- [x] 4.4 Add logic to resolve model using resolveModelKey(provider, modelKey)
- [x] 4.5 Store providersConfig in Agent instance for use by switchProvider()
- [x] 4.6 Update `switchProvider()` method to accept providerName and optional modelKey, resolve from stored config
- [x] 4.7 Update `src/__tests__/agent.test.ts` to use new constructor signature and config format

## 5. Create Default Configuration File

- [x] 5.1 Create `providers.json` at project root with sample configuration for Ollama and Bedrock providers
- [x] 5.2 Ensure providers.json includes multiple model examples per provider with name and key fields

## 6. Update Entry Point and Examples

- [x] 6.1 Update `src/index.ts` to load config from './providers.json' instead of inline object
- [x] 6.2 Update `src/__tests__/integration.test.ts` to use new config format

## 7. Verification

- [x] 7.1 Run `npm test` and ensure all tests pass
- [x] 7.2 Manually test `src/index.ts` entry point to verify JSON config loading works
- [x] 7.3 Verify provider switching works with multiple providers configured in providers.json
