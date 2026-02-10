## 1. Create Provider Factory Module

- [x] 1.1 Create `src/providers/factory.ts` file with TypeScript exports
- [x] 1.2 Import LLMProvider interface and ProviderConfig type in factory
- [x] 1.3 Import OllamaProvider and BedrockProvider in factory
- [x] 1.4 Implement `createProvider(config: ProviderConfig): LLMProvider` function with switch statement
- [x] 1.5 Add switch case for 'ollama' provider returning `new OllamaProvider(config.ollama)`
- [x] 1.6 Add switch case for 'bedrock' provider returning `new BedrockProvider(config.bedrock)`
- [x] 1.7 Add default case throwing error: "Unknown provider type: \"{type}\". Valid providers: ollama, bedrock"
- [x] 1.8 Implement `extractModelFromConfig(config: ProviderConfig): string | undefined` utility function
- [x] 1.9 Add logic to extract model from config.ollama.model when provider is 'ollama'
- [x] 1.10 Add logic to extract model from config.bedrock.model when provider is 'bedrock'
- [x] 1.11 Return undefined for unknown provider types in extractModelFromConfig

## 2. Write Factory Tests

- [x] 2.1 Create `src/providers/__tests__/factory.test.ts` file
- [x] 2.2 Add test: createProvider creates OllamaProvider for 'ollama' config
- [x] 2.3 Add test: createProvider creates BedrockProvider for 'bedrock' config
- [x] 2.4 Add test: createProvider returns LLMProvider interface type
- [x] 2.5 Add test: createProvider throws error for unknown provider type
- [x] 2.6 Add test: error message includes list of valid providers
- [x] 2.7 Add test: extractModelFromConfig returns model for Ollama config
- [x] 2.8 Add test: extractModelFromConfig returns model for Bedrock config
- [x] 2.9 Add test: extractModelFromConfig returns undefined for missing model
- [x] 2.10 Run factory tests to verify they pass

## 3. Refactor Agent Constructor

- [x] 3.1 Remove `model?: string` from Agent constructor options type
- [x] 3.2 Remove `host?: string` from Agent constructor options type
- [x] 3.3 Make `providerConfig` a required parameter (remove optional marker)
- [x] 3.4 Remove import statements for OllamaProvider and BedrockProvider from agent.ts
- [x] 3.5 Add import for createProvider and extractModelFromConfig from factory
- [x] 3.6 Remove `createProvider` method from Agent class
- [x] 3.7 Remove `getModelFromConfig` method from Agent class
- [x] 3.8 Update constructor to call `this.provider = createProvider(options.providerConfig)`
- [x] 3.9 Update constructor to call `this.model = extractModelFromConfig(options.providerConfig) || 'qwen3-coder:30b'`
- [x] 3.10 Remove all if/else logic for legacy options handling
- [x] 3.11 Verify Agent class no longer imports concrete provider classes

## 4. Update Entry Point

- [x] 4.1 Open `src/index.ts` and locate Agent instantiation
- [x] 4.2 Update Agent constructor call to use providerConfig structure
- [x] 4.3 Wrap model and host from environment into providerConfig.ollama object
- [x] 4.4 Ensure systemPrompt and sessionContextFilePath remain as separate options
- [x] 4.5 Verify the application builds successfully with `npm run build`

## 5. Update Tests

- [x] 5.1 Update `src/__tests__/agent.test.ts` to use providerConfig in all Agent instantiations
- [x] 5.2 Remove any tests that test legacy constructor options (model, host)
- [x] 5.3 Add test: Agent constructor requires providerConfig
- [x] 5.4 Add test: Agent uses factory to create provider
- [x] 5.5 Add test: Agent does not import concrete providers
- [x] 5.6 Update integration tests to use new constructor API
- [x] 5.7 Run full test suite with `npm test`
- [x] 5.8 Fix any failing tests due to API changes

## 6. Documentation and Cleanup

- [x] 6.1 Add JSDoc comments to createProvider function explaining usage
- [x] 6.2 Add JSDoc comments to extractModelFromConfig function
- [x] 6.3 Update Agent class constructor JSDoc with new parameter requirements
- [x] 6.4 Add inline comment in factory explaining switch statement pattern
- [x] 6.5 Verify no unused imports remain in agent.ts
- [x] 6.6 Run TypeScript compiler to verify no type errors
- [x] 6.7 Verify all tests pass with final implementation
