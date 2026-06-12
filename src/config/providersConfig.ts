import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  loadProvidersConfig as loadProvidersConfigFromFile,
  loadProvidersConfigAsync as loadProvidersConfigAsyncFromFile,
  type ProvidersConfig,
} from "@propio-ai/providers";

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

function providersConfigMissingMessage(filePath: string): string {
  return (
    `Configuration file not found: ${filePath}\n` +
    `Please create ~/.propio/providers.json with your provider settings.\n` +
    `See README for configuration examples.`
  );
}

/**
 * Load and validate a ProvidersConfig with Propio's missing-config guidance
 */
export function loadProvidersConfig(filePath: string): ProvidersConfig {
  return loadProvidersConfigFromFile(filePath, {
    missingMessage: providersConfigMissingMessage(filePath),
  });
}

export async function loadProvidersConfigAsync(
  filePath: string,
): Promise<ProvidersConfig> {
  return loadProvidersConfigAsyncFromFile(filePath, {
    missingMessage: providersConfigMissingMessage(filePath),
  });
}
