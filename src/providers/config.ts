/**
 * A model entry containing both human-readable name and technical key
 */
export interface Model {
  name: string;
  key: string;
}

/**
 * Base provider configuration with common fields
 */
export interface BaseProviderConfig {
  name: string;
  type: string;
  models: Model[];
  defaultModel: string;
}

/**
 * Ollama provider configuration with flat structure
 */
export interface OllamaProviderConfig extends BaseProviderConfig {
  type: "ollama";
  host?: string;
}

/**
 * Bedrock provider configuration with flat structure
 */
export interface BedrockProviderConfig extends BaseProviderConfig {
  type: "bedrock";
  region?: string;
}

/**
 * OpenRouter provider configuration with flat structure
 */
export interface OpenRouterProviderConfig extends BaseProviderConfig {
  type: "openrouter";
  apiKey?: string;
  httpReferer?: string;
  xTitle?: string;
}

/**
 * Configuration for a single LLM provider (discriminated union)
 */
export type ProviderConfig =
  | OllamaProviderConfig
  | BedrockProviderConfig
  | OpenRouterProviderConfig;

/**
 * Multi-provider configuration
 */
export interface ProvidersConfig {
  default: string;
  providers: ProviderConfig[];
}
