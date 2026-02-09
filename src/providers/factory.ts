import { LLMProvider } from './interface';
import { ProviderConfig, OllamaProviderConfig, BedrockProviderConfig } from './config';
import { OllamaProvider } from './ollama';
import { BedrockProvider } from './bedrock';

/**
 * Factory function to create LLM provider instances from configuration.
 *
 * This factory encapsulates provider instantiation logic, allowing new providers to be added
 * without modifying the Agent class. The factory uses a switch statement on type field
 * to determine which provider class to instantiate.
 *
 * @param config - Provider configuration containing type field and provider-specific settings
 * @param modelKey - Optional model key override. If provided, uses this instead of config.defaultModel
 * @returns An LLMProvider interface instance configured according to the provided config
 * @throws Error if the provider type is unknown or unsupported
 *
 * @example
 * // Create an Ollama provider
 * const ollamaProvider = createProvider({
 *   name: 'local-ollama',
 *   type: 'ollama',
 *   models: [{ name: 'Llama', key: 'llama3.2' }],
 *   defaultModel: 'llama3.2',
 *   host: 'http://localhost:11434'
 * });
 *
 * @example
 * // Create a Bedrock provider with specific model
 * const bedrockProvider = createProvider({
 *   name: 'bedrock',
 *   type: 'bedrock',
 *   models: [{ name: 'Claude 3.5', key: 'anthropic.claude-3-5-sonnet-20241022-v2:0' }],
 *   defaultModel: 'anthropic.claude-3-5-sonnet-20241022-v2:0',
 *   region: 'us-west-2'
 * }, 'anthropic.claude-3-5-sonnet-20241022-v2:0');
 */
export function createProvider(config: ProviderConfig, modelKey?: string): LLMProvider {
  const model = modelKey || config.defaultModel;

  // Switch statement pattern for mapping provider type to implementation.
  // Each case instantiates the appropriate provider class with extracted config.
  switch (config.type) {
    case 'ollama':
      return new OllamaProvider({
        model: model,
        host: (config as OllamaProviderConfig).host
      });
    case 'bedrock':
      return new BedrockProvider({
        model: model,
        region: (config as BedrockProviderConfig).region
      });
    default:
      throw new Error(`Unknown provider type: "${(config as any).type}". Valid providers: ollama, bedrock`);
  }
}

/**
 * Extract the default model name from a provider configuration.
 *
 * This utility function provides a centralized way to extract the default model name from any
 * provider configuration type. All provider configs now have a top-level defaultModel field.
 *
 * @param config - The provider configuration object
 * @returns The default model key string
 *
 * @example
 * const model = extractModelFromConfig({
 *   name: 'ollama',
 *   type: 'ollama',
 *   models: [{ name: 'Llama', key: 'llama3.2' }],
 *   defaultModel: 'llama3.2'
 * });
 * console.log(model); // 'llama3.2'
 */
export function extractModelFromConfig(config: ProviderConfig): string {
  return config.defaultModel;
}
