import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { ProvidersConfig, ProviderConfig } from "./config.js";

export interface ProviderModelSelection {
  readonly providerName: string;
  readonly modelKey: string;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isNonEmptyStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every((item) => isNonEmptyString(item))
  );
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Get the absolute path to the configuration file in the user's home directory
 *
 * @returns Absolute path to ~/.propio/providers.json
 */
export function getConfigPath(): string {
  // In Docker environments (sandbox mode), check /app/.propio first
  const dockerConfigPath = "/app/.propio/providers.json";
  if (fs.existsSync(dockerConfigPath)) {
    return dockerConfigPath;
  }

  // Fall back to home directory for native mode
  return path.join(os.homedir(), ".propio", "providers.json");
}

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
      throw new Error(
        `Configuration file not found: ${filePath}\n` +
          `Please create ~/.propio/providers.json with your provider settings.\n` +
          `See README for configuration examples.`,
      );
    }
    throw new Error(`Failed to read configuration file: ${error.message}`);
  }

  let config: any;
  try {
    config = JSON.parse(fileContent);
  } catch (error: any) {
    throw new Error(`Invalid JSON in configuration file: ${error.message}`);
  }

  return validateProvidersConfig(config);
}

export async function loadProvidersConfigAsync(
  filePath: string,
): Promise<ProvidersConfig> {
  let fileContent: string;

  try {
    fileContent = await fs.promises.readFile(filePath, "utf-8");
  } catch (error: any) {
    if (error.code === "ENOENT") {
      throw new Error(
        `Configuration file not found: ${filePath}\n` +
          `Please create ~/.propio/providers.json with your provider settings.\n` +
          `See README for configuration examples.`,
      );
    }
    throw new Error(`Failed to read configuration file: ${error.message}`);
  }

  let config: any;
  try {
    config = JSON.parse(fileContent);
  } catch (error: any) {
    throw new Error(`Invalid JSON in configuration file: ${error.message}`);
  }

  return validateProvidersConfig(config);
}

function validateProvidersConfig(config: any): ProvidersConfig {
  if (!isPlainObject(config)) {
    throw new Error("Configuration root must be a JSON object");
  }
  const candidate = config as any;

  // Validate required fields exist
  if (!candidate.providers) {
    throw new Error('Configuration must include a "providers" array');
  }
  if (candidate.default === undefined) {
    throw new Error(
      'Configuration must include a "default" field specifying default provider',
    );
  }

  // Validate that default references an existing provider
  const defaultProviderExists = candidate.providers.some(
    (p: any) => p.name === candidate.default,
  );
  if (!defaultProviderExists) {
    const availableProviders = candidate.providers
      .map((p: any) => p.name)
      .join(", ");
    throw new Error(
      `Default provider "${candidate.default}" not found in providers list. Available: ${availableProviders}`,
    );
  }

  // Validate each provider
  const seenNames = new Set<string>();
  for (const provider of candidate.providers) {
    validateProviderConfig(provider, seenNames);
  }

  return candidate as unknown as ProvidersConfig;
}

function writeProvidersConfig(filePath: string, config: ProvidersConfig): void {
  const directory = path.dirname(filePath);
  fs.mkdirSync(directory, { recursive: true });

  const tempFilePath = path.join(
    directory,
    `.providers.${process.pid}.${Date.now()}.tmp`,
  );

  try {
    fs.writeFileSync(tempFilePath, `${JSON.stringify(config, null, 2)}\n`, {
      encoding: "utf8",
    });
    fs.renameSync(tempFilePath, filePath);
  } catch (error) {
    try {
      fs.rmSync(tempFilePath, { force: true });
    } catch {
      // Best-effort cleanup only.
    }
    throw error;
  }
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

  if (provider.type === "openrouter") {
    validateOpenRouterProviderConfig(provider);
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

function validateOpenRouterProviderConfig(provider: any): void {
  if (provider.provider !== undefined) {
    if (!isPlainObject(provider.provider)) {
      throw new Error(
        `Provider "${provider.name}" OpenRouter "provider" field must be an object`,
      );
    }

    if (
      provider.provider.allowFallbacks !== undefined &&
      typeof provider.provider.allowFallbacks !== "boolean"
    ) {
      throw new Error(
        `Provider "${provider.name}" OpenRouter "provider.allowFallbacks" must be a boolean`,
      );
    }

    if (
      provider.provider.requireParameters !== undefined &&
      typeof provider.provider.requireParameters !== "boolean"
    ) {
      throw new Error(
        `Provider "${provider.name}" OpenRouter "provider.requireParameters" must be a boolean`,
      );
    }

    if (provider.provider.order !== undefined) {
      if (!isNonEmptyStringArray(provider.provider.order)) {
        throw new Error(
          `Provider "${provider.name}" OpenRouter "provider.order" must be a non-empty array of non-empty strings`,
        );
      }
    }
  }

  if (provider.fallbackModels !== undefined) {
    if (!isNonEmptyStringArray(provider.fallbackModels)) {
      throw new Error(
        `Provider "${provider.name}" OpenRouter "fallbackModels" must be a non-empty array of non-empty strings`,
      );
    }
  }

  if (
    provider.debugEchoUpstreamBody !== undefined &&
    typeof provider.debugEchoUpstreamBody !== "boolean"
  ) {
    throw new Error(
      `Provider "${provider.name}" OpenRouter "debugEchoUpstreamBody" must be a boolean`,
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

export function getDefaultProviderModelSelection(
  config: ProvidersConfig,
): ProviderModelSelection {
  const provider = resolveProvider(config);
  return {
    providerName: provider.name,
    modelKey: provider.defaultModel,
  };
}

export function updateDefaultProviderModelSelection(
  config: ProvidersConfig,
  providerName: string,
  modelKey?: string,
): ProvidersConfig {
  const provider = resolveProvider(config, providerName);
  const resolvedModelKey = resolveModelKey(provider, modelKey);

  const updatedConfig = {
    ...config,
    default: provider.name,
    providers: config.providers.map((entry) =>
      entry.name === provider.name
        ? { ...entry, defaultModel: resolvedModelKey }
        : entry,
    ),
  };

  return validateProvidersConfig(updatedConfig);
}

export function updateDefaultProviderModelSelectionInFile(
  filePath: string,
  providerName: string,
  modelKey?: string,
): ProvidersConfig {
  const config = loadProvidersConfig(filePath);
  const updatedConfig = updateDefaultProviderModelSelection(
    config,
    providerName,
    modelKey,
  );
  writeProvidersConfig(filePath, updatedConfig);
  return updatedConfig;
}
