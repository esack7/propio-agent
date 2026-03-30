/**
 * A model entry containing both human-readable name and technical key.
 * Optional contextWindowTokens overrides the provider's built-in lookup
 * for testing or cost-control purposes.
 */
export interface Model {
  name: string;
  key: string;
  contextWindowTokens?: number;
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
 * xAI (Grok) provider configuration using the OpenAI-compatible API at api.x.ai
 */
export interface XaiProviderConfig extends BaseProviderConfig {
  type: "xai";
  apiKey?: string;
}

/**
 * Gemini provider configuration using Google's OpenAI-compatible API.
 */
export interface GeminiProviderConfig extends BaseProviderConfig {
  type: "gemini";
  apiKey?: string;
}

/**
 * Configuration for a single LLM provider (discriminated union)
 */
export type ProviderConfig =
  | OllamaProviderConfig
  | BedrockProviderConfig
  | OpenRouterProviderConfig
  | GeminiProviderConfig
  | XaiProviderConfig;

/**
 * Multi-provider configuration
 */
export interface ProvidersConfig {
  default: string;
  providers: ProviderConfig[];
}
