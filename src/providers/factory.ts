import { LLMProvider } from './interface';
import { ProviderConfig } from './config';
import { OllamaProvider } from './ollama';
import { BedrockProvider } from './bedrock';

/**
 * Factory function to create LLM provider instances from configuration.
 *
 * This factory encapsulates provider instantiation logic, allowing new providers to be added
 * without modifying the Agent class. The factory uses a switch statement on provider type
 * to determine which provider class to instantiate.
 *
 * @param config - Provider configuration containing provider type and provider-specific settings
 * @returns An LLMProvider interface instance configured according to the provided config
 * @throws Error if the provider type is unknown or unsupported
 *
 * @example
 * // Create an Ollama provider
 * const ollamaProvider = createProvider({
 *   provider: 'ollama',
 *   ollama: {
 *     model: 'qwen3-coder:30b',
 *     host: 'http://localhost:11434'
 *   }
 * });
 *
 * @example
 * // Create a Bedrock provider
 * const bedrockProvider = createProvider({
 *   provider: 'bedrock',
 *   bedrock: {
 *     model: 'anthropic.claude-3-sonnet-20240229-v1:0',
 *     region: 'us-east-1'
 *   }
 * });
 */
export function createProvider(config: ProviderConfig): LLMProvider {
  // Switch statement pattern for mapping provider type to implementation.
  // Each case instantiates the appropriate provider class with extracted config.
  switch (config.provider) {
    case 'ollama':
      return new OllamaProvider({
        model: (config as any).ollama.model,
        host: (config as any).ollama.host
      });
    case 'bedrock':
      return new BedrockProvider({
        model: (config as any).bedrock.model,
        region: (config as any).bedrock.region
      });
    default:
      throw new Error(`Unknown provider type: "${(config as any).provider}". Valid providers: ollama, bedrock`);
  }
}

/**
 * Extract the model name from a provider configuration.
 *
 * This utility function provides a centralized way to extract the model name from any
 * provider configuration type. The model name is provider-specific but typically identifies
 * which LLM model to use (e.g., 'qwen3-coder:30b' for Ollama, 'anthropic.claude-3-...' for Bedrock).
 *
 * @param config - The provider configuration object containing provider type and settings
 * @returns The model name string if present in the configuration, undefined if not found or for unknown providers
 *
 * @example
 * const model = extractModelFromConfig({
 *   provider: 'ollama',
 *   ollama: { model: 'qwen3-coder:30b' }
 * });
 * console.log(model); // 'qwen3-coder:30b'
 *
 * @example
 * // Returns undefined for missing model
 * const model = extractModelFromConfig({
 *   provider: 'ollama',
 *   ollama: {}
 * });
 * console.log(model); // undefined
 */
export function extractModelFromConfig(config: ProviderConfig): string | undefined {
  switch (config.provider) {
    case 'ollama':
      return (config as any).ollama?.model;
    case 'bedrock':
      return (config as any).bedrock?.model;
    default:
      return undefined;
  }
}
