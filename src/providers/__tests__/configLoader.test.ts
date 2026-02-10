import * as fs from "fs";
import * as path from "path";
import {
  loadProvidersConfig,
  resolveProvider,
  resolveModelKey,
} from "../configLoader";
import { ProvidersConfig, ProviderConfig } from "../config";

describe("Configuration Loader", () => {
  const tempDir = "/tmp/config-loader-tests";

  beforeAll(() => {
    if (!fs.existsSync(tempDir)) {
      fs.mkdirSync(tempDir, { recursive: true });
    }
  });

  afterAll(() => {
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true });
    }
  });

  describe("loadProvidersConfig()", () => {
    it("should load valid JSON file and return ProvidersConfig", () => {
      const configPath = path.join(tempDir, "valid-config.json");
      const config: ProvidersConfig = {
        default: "ollama",
        providers: [
          {
            name: "ollama",
            type: "ollama",
            models: [{ name: "Llama", key: "llama3.2" }],
            defaultModel: "llama3.2",
          },
        ],
      };
      fs.writeFileSync(configPath, JSON.stringify(config, null, 2));

      const loaded = loadProvidersConfig(configPath);
      expect(loaded.default).toBe("ollama");
      expect(loaded.providers).toHaveLength(1);
      expect(loaded.providers[0].name).toBe("ollama");
    });

    it("should throw error for missing file", () => {
      const configPath = path.join(tempDir, "missing-file.json");
      expect(() => loadProvidersConfig(configPath)).toThrow(
        /not found|ENOENT/i,
      );
    });

    it("should throw error for invalid JSON", () => {
      const configPath = path.join(tempDir, "invalid-json.json");
      fs.writeFileSync(configPath, "{ invalid json }");

      expect(() => loadProvidersConfig(configPath)).toThrow(
        /JSON|parse|invalid/i,
      );
    });

    it("should throw error when providers array is missing", () => {
      const configPath = path.join(tempDir, "no-providers.json");
      const config = { default: "ollama" };
      fs.writeFileSync(configPath, JSON.stringify(config));

      expect(() => loadProvidersConfig(configPath)).toThrow(
        /providers|required|missing/i,
      );
    });

    it("should throw error when default field is missing", () => {
      const configPath = path.join(tempDir, "no-default.json");
      const config = {
        providers: [
          {
            name: "ollama",
            type: "ollama",
            models: [{ name: "Llama", key: "llama3.2" }],
            defaultModel: "llama3.2",
          },
        ],
      };
      fs.writeFileSync(configPath, JSON.stringify(config));

      expect(() => loadProvidersConfig(configPath)).toThrow(
        /default|required|missing/i,
      );
    });

    it("should validate that default references existing provider", () => {
      const configPath = path.join(tempDir, "invalid-default-ref.json");
      const config: ProvidersConfig = {
        default: "nonexistent",
        providers: [
          {
            name: "ollama",
            type: "ollama",
            models: [{ name: "Llama", key: "llama3.2" }],
            defaultModel: "llama3.2",
          },
        ],
      };
      fs.writeFileSync(configPath, JSON.stringify(config));

      expect(() => loadProvidersConfig(configPath)).toThrow(
        /default.*provider|provider.*not found|unknown provider/i,
      );
    });

    it("should validate defaultModel references valid model key", () => {
      const configPath = path.join(tempDir, "invalid-model-ref.json");
      const config: ProvidersConfig = {
        default: "ollama",
        providers: [
          {
            name: "ollama",
            type: "ollama",
            models: [{ name: "Llama", key: "llama3.2" }],
            defaultModel: "nonexistent-model",
          },
        ],
      };
      fs.writeFileSync(configPath, JSON.stringify(config));

      expect(() => loadProvidersConfig(configPath)).toThrow(
        /defaultModel|model.*not found|unknown model/i,
      );
    });

    it("should validate required provider fields", () => {
      const configPath = path.join(tempDir, "missing-provider-fields.json");
      const config: any = {
        default: "ollama",
        providers: [
          {
            name: "ollama",
            type: "ollama",
            // missing models and defaultModel
          },
        ],
      };
      fs.writeFileSync(configPath, JSON.stringify(config));

      expect(() => loadProvidersConfig(configPath)).toThrow(
        /missing|required|fields/i,
      );
    });

    it("should validate models array structure", () => {
      const configPath = path.join(tempDir, "invalid-model-structure.json");
      const config: any = {
        default: "ollama",
        providers: [
          {
            name: "ollama",
            type: "ollama",
            models: [{ name: "Llama" }], // missing key
            defaultModel: "llama3.2",
          },
        ],
      };
      fs.writeFileSync(configPath, JSON.stringify(config));

      expect(() => loadProvidersConfig(configPath)).toThrow(
        /model|name|key|missing|required/i,
      );
    });

    it("should validate unique provider names", () => {
      const configPath = path.join(tempDir, "duplicate-names.json");
      const config: any = {
        default: "ollama",
        providers: [
          {
            name: "ollama",
            type: "ollama",
            models: [{ name: "Llama", key: "llama3.2" }],
            defaultModel: "llama3.2",
          },
          {
            name: "ollama", // duplicate
            type: "bedrock",
            models: [{ name: "Claude", key: "claude" }],
            defaultModel: "claude",
          },
        ],
      };
      fs.writeFileSync(configPath, JSON.stringify(config));

      expect(() => loadProvidersConfig(configPath)).toThrow(
        /duplicate|unique|provider name/i,
      );
    });

    it("should validate unique model keys within provider", () => {
      const configPath = path.join(tempDir, "duplicate-model-keys.json");
      const config: any = {
        default: "ollama",
        providers: [
          {
            name: "ollama",
            type: "ollama",
            models: [
              { name: "Llama 3.2", key: "llama3.2" },
              { name: "Llama 3.2 Duplicate", key: "llama3.2" }, // duplicate key
            ],
            defaultModel: "llama3.2",
          },
        ],
      };
      fs.writeFileSync(configPath, JSON.stringify(config));

      expect(() => loadProvidersConfig(configPath)).toThrow(
        /duplicate|unique|model.*key/i,
      );
    });

    it("should load config with multiple providers", () => {
      const configPath = path.join(tempDir, "multi-provider.json");
      const config: ProvidersConfig = {
        default: "ollama",
        providers: [
          {
            name: "ollama",
            type: "ollama",
            models: [
              { name: "Llama 3.2", key: "llama3.2:3b" },
              { name: "Llama 3.2 Large", key: "llama3.2:90b" },
            ],
            defaultModel: "llama3.2:3b",
            host: "http://localhost:11434",
          },
          {
            name: "bedrock",
            type: "bedrock",
            models: [
              {
                name: "Claude 3.5",
                key: "anthropic.claude-3-5-sonnet-20241022-v2:0",
              },
            ],
            defaultModel: "anthropic.claude-3-5-sonnet-20241022-v2:0",
            region: "us-west-2",
          },
        ],
      };
      fs.writeFileSync(configPath, JSON.stringify(config, null, 2));

      const loaded = loadProvidersConfig(configPath);
      expect(loaded.default).toBe("ollama");
      expect(loaded.providers).toHaveLength(2);
      expect(loaded.providers[0].type).toBe("ollama");
      expect(loaded.providers[1].type).toBe("bedrock");
    });
  });

  describe("resolveProvider()", () => {
    const testConfig: ProvidersConfig = {
      default: "ollama",
      providers: [
        {
          name: "ollama",
          type: "ollama",
          models: [{ name: "Llama", key: "llama3.2" }],
          defaultModel: "llama3.2",
        },
        {
          name: "bedrock",
          type: "bedrock",
          models: [{ name: "Claude", key: "claude" }],
          defaultModel: "claude",
        },
      ],
    };

    it("should resolve provider by name", () => {
      const provider = resolveProvider(testConfig, "ollama");
      expect(provider.name).toBe("ollama");
      expect(provider.type).toBe("ollama");
    });

    it("should resolve default provider when no name provided", () => {
      const provider = resolveProvider(testConfig);
      expect(provider.name).toBe("ollama");
    });

    it("should throw error for unknown provider name", () => {
      expect(() => resolveProvider(testConfig, "unknown")).toThrow(
        /unknown|not found|available/i,
      );
    });

    it("should list available providers in error message", () => {
      try {
        resolveProvider(testConfig, "unknown");
        fail("Expected error to be thrown");
      } catch (error: any) {
        expect(error.message).toMatch(/ollama/);
        expect(error.message).toMatch(/bedrock/);
      }
    });
  });

  describe("resolveModelKey()", () => {
    const testProvider = {
      name: "ollama",
      type: "ollama" as const,
      models: [
        { name: "Llama 3.2 3B", key: "llama3.2:3b" },
        { name: "Llama 3.2 90B", key: "llama3.2:90b" },
      ],
      defaultModel: "llama3.2:3b",
    };

    it("should return provided model key when valid", () => {
      const key = resolveModelKey(testProvider, "llama3.2:90b");
      expect(key).toBe("llama3.2:90b");
    });

    it("should return default model when no key provided", () => {
      const key = resolveModelKey(testProvider);
      expect(key).toBe("llama3.2:3b");
    });

    it("should throw error for invalid model key", () => {
      expect(() => resolveModelKey(testProvider, "nonexistent")).toThrow(
        /invalid|unknown|not found|available/i,
      );
    });

    it("should list available model keys in error message", () => {
      try {
        resolveModelKey(testProvider, "nonexistent");
        fail("Expected error to be thrown");
      } catch (error: any) {
        expect(error.message).toMatch(/llama3.2:3b/);
        expect(error.message).toMatch(/llama3.2:90b/);
      }
    });
  });
});
