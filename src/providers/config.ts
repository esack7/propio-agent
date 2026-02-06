/**
 * Configuration for LLM providers
 */
export type ProviderConfig = OllamaProviderConfig | BedrockProviderConfig;

/**
 * Ollama provider configuration
 */
export interface OllamaProviderConfig {
  provider: 'ollama';
  ollama: {
    model: string;
    host?: string;
  };
}

/**
 * Bedrock provider configuration
 */
export interface BedrockProviderConfig {
  provider: 'bedrock';
  bedrock: {
    model: string;
    region?: string;
  };
}
