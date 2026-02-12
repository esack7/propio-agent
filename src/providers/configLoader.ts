import * as fs from "fs";
import { ProvidersConfig, ProviderConfig } from "./config.js";

/**
 * Load and validate a ProvidersConfig from a JSON file
 *
 * @param filePath - Path to the providers.json file
 * @returns ProvidersConfig object with all validation completed
 * @throws Error if file not found, invalid JSON, validation fails, or references are invalid
 */
export function loadProvidersConfig(filePath: string): ProvidersConfig {
  let fileContent: string;

  try {
    fileContent = fs.readFileSync(filePath, "utf-8");
  } catch (error: any) {
    if (error.code === "ENOENT") {
      throw new Error(`Configuration file not found: ${filePath}`);
    }
    throw new Error(`Failed to read configuration file: ${error.message}`);
  }

  let config: any;
  try {
    config = JSON.parse(fileContent);
  } catch (error: any) {
    throw new Error(`Invalid JSON in configuration file: ${error.message}`);
  }

  // Validate required fields exist
  if (!config.providers) {
    throw new Error('Configuration must include a "providers" array');
  }
  if (config.default === undefined) {
    throw new Error(
      'Configuration must include a "default" field specifying default provider',
    );
  }

  // Validate that default references an existing provider
  const defaultProviderExists = config.providers.some(
    (p: any) => p.name === config.default,
  );
  if (!defaultProviderExists) {
    const availableProviders = config.providers
      .map((p: any) => p.name)
      .join(", ");
    throw new Error(
      `Default provider "${config.default}" not found in providers list. Available: ${availableProviders}`,
    );
  }

  // Validate each provider
  const seenNames = new Set<string>();
  for (const provider of config.providers) {
    validateProviderConfig(provider, seenNames);
  }

  return config as ProvidersConfig;
}

/**
 * Validate a single provider configuration
 */
function validateProviderConfig(provider: any, seenNames: Set<string>): void {
  // Check required fields
  const requiredFields = ["name", "type", "models", "defaultModel"];
  const missingFields = requiredFields.filter((field) => !provider[field]);
  if (missingFields.length > 0) {
    throw new Error(
      `Provider is missing required fields: ${missingFields.join(", ")}`,
    );
  }

  // Check unique provider names
  if (seenNames.has(provider.name)) {
    throw new Error(
      `Duplicate provider name: "${provider.name}". Provider names must be unique.`,
    );
  }
  seenNames.add(provider.name);

  // Validate models array
  if (!Array.isArray(provider.models) || provider.models.length === 0) {
    throw new Error(
      `Provider "${provider.name}" must have at least one model in the models array`,
    );
  }

  // Validate each model has required fields
  const seenModelKeys = new Set<string>();
  for (const model of provider.models) {
    if (!model.name || !model.key) {
      throw new Error(
        `Provider "${provider.name}" has model missing required fields: each model must have "name" and "key"`,
      );
    }

    // Check unique model keys within provider
    if (seenModelKeys.has(model.key)) {
      throw new Error(
        `Provider "${provider.name}" has duplicate model key: "${model.key}". Model keys must be unique within a provider.`,
      );
    }
    seenModelKeys.add(model.key);
  }

  // Validate defaultModel references valid model key
  const defaultModelExists = provider.models.some(
    (m: any) => m.key === provider.defaultModel,
  );
  if (!defaultModelExists) {
    const availableModels = provider.models.map((m: any) => m.key).join(", ");
    throw new Error(
      `Provider "${provider.name}" defaultModel "${provider.defaultModel}" not found in models list. Available: ${availableModels}`,
    );
  }
}

/**
 * Resolve a provider from ProvidersConfig by name
 *
 * @param config - The providers configuration
 * @param providerName - Optional provider name. If not provided, uses config.default
 * @returns The resolved ProviderConfig
 * @throws Error if provider not found
 */
export function resolveProvider(
  config: ProvidersConfig,
  providerName?: string,
): ProviderConfig {
  const name = providerName || config.default;

  const provider = config.providers.find((p) => p.name === name);
  if (!provider) {
    const availableProviders = config.providers.map((p) => p.name).join(", ");
    throw new Error(
      `Unknown provider: "${name}". Available providers: ${availableProviders}`,
    );
  }

  return provider;
}

/**
 * Resolve a model key from a ProviderConfig
 *
 * @param provider - The provider configuration
 * @param modelKey - Optional model key. If not provided, uses provider.defaultModel
 * @returns The resolved model key
 * @throws Error if model key not found
 */
export function resolveModelKey(
  provider: ProviderConfig,
  modelKey?: string,
): string {
  const key = modelKey || provider.defaultModel;

  const model = provider.models.find((m) => m.key === key);
  if (!model) {
    const availableModels = provider.models.map((m) => m.key).join(", ");
    throw new Error(
      `Invalid model key: "${key}" for provider "${provider.name}". Available models: ${availableModels}`,
    );
  }

  return key;
}
