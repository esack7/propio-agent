import {
  Model,
  ProviderConfig,
  OllamaProviderConfig,
  BedrockProviderConfig,
  OpenRouterProviderConfig,
  ProvidersConfig,
} from "../config";

describe("Configuration Types (New Structure)", () => {
  describe("Model interface", () => {
    it("should have name and key fields", () => {
      const model: Model = {
        name: "Llama 3.2 3B",
        key: "llama3.2:3b",
      };
      expect(model.name).toBe("Llama 3.2 3B");
      expect(model.key).toBe("llama3.2:3b");
    });
  });

  describe("OllamaProviderConfig", () => {
    it("should define ollama provider with flat structure", () => {
      const config: OllamaProviderConfig = {
        name: "local-ollama",
        type: "ollama",
        models: [
          { name: "Llama 3.2 3B", key: "llama3.2:3b" },
          { name: "Llama 3.2 90B", key: "llama3.2:90b" },
        ],
        defaultModel: "llama3.2:3b",
        host: "http://localhost:11434",
      };
      expect(config.name).toBe("local-ollama");
      expect(config.type).toBe("ollama");
      expect(config.host).toBe("http://localhost:11434");
      expect(config.defaultModel).toBe("llama3.2:3b");
      expect(config.models).toHaveLength(2);
      expect(config.models[0].key).toBe("llama3.2:3b");
    });

    it("should have optional host field", () => {
      const config: OllamaProviderConfig = {
        name: "local-ollama",
        type: "ollama",
        models: [{ name: "Llama 3.2", key: "llama3.2" }],
        defaultModel: "llama3.2",
      };
      expect(config.host).toBeUndefined();
    });
  });

  describe("BedrockProviderConfig", () => {
    it("should define bedrock provider with flat structure", () => {
      const config: BedrockProviderConfig = {
        name: "bedrock-provider",
        type: "bedrock",
        models: [
          {
            name: "Claude 3.5 Sonnet",
            key: "anthropic.claude-3-5-sonnet-20241022-v2:0",
          },
        ],
        defaultModel: "anthropic.claude-3-5-sonnet-20241022-v2:0",
        region: "us-west-2",
      };
      expect(config.name).toBe("bedrock-provider");
      expect(config.type).toBe("bedrock");
      expect(config.region).toBe("us-west-2");
      expect(config.defaultModel).toBe(
        "anthropic.claude-3-5-sonnet-20241022-v2:0",
      );
      expect(config.models).toHaveLength(1);
    });

    it("should have optional region field", () => {
      const config: BedrockProviderConfig = {
        name: "bedrock-provider",
        type: "bedrock",
        models: [
          {
            name: "Claude 3.5 Sonnet",
            key: "anthropic.claude-3-5-sonnet-20241022-v2:0",
          },
        ],
        defaultModel: "anthropic.claude-3-5-sonnet-20241022-v2:0",
      };
      expect(config.region).toBeUndefined();
    });
  });

  describe("ProviderConfig union type", () => {
    it("should accept OllamaProviderConfig", () => {
      const config: ProviderConfig = {
        name: "ollama",
        type: "ollama",
        models: [{ name: "Model", key: "model" }],
        defaultModel: "model",
      };
      expect(config.type).toBe("ollama");
    });

    it("should accept BedrockProviderConfig", () => {
      const config: ProviderConfig = {
        name: "bedrock",
        type: "bedrock",
        models: [{ name: "Model", key: "model" }],
        defaultModel: "model",
      };
      expect(config.type).toBe("bedrock");
    });

    it("should accept OpenRouterProviderConfig", () => {
      const config: ProviderConfig = {
        name: "openrouter",
        type: "openrouter",
        models: [{ name: "GPT-3.5", key: "openai/gpt-3.5-turbo" }],
        defaultModel: "openai/gpt-3.5-turbo",
        apiKey: "sk-key",
      };
      expect(config.type).toBe("openrouter");
    });
  });

  describe("OpenRouterProviderConfig", () => {
    it("should define openrouter provider with optional apiKey, httpReferer, xTitle", () => {
      const config: OpenRouterProviderConfig = {
        name: "openrouter",
        type: "openrouter",
        models: [{ name: "GPT-3.5", key: "openai/gpt-3.5-turbo" }],
        defaultModel: "openai/gpt-3.5-turbo",
        apiKey: "sk-key",
        httpReferer: "https://app.com",
        xTitle: "My App",
      };
      expect(config.type).toBe("openrouter");
      expect(config.apiKey).toBe("sk-key");
      expect(config.httpReferer).toBe("https://app.com");
      expect(config.xTitle).toBe("My App");
    });
  });

  describe("ProvidersConfig", () => {
    it("should contain multiple providers and default", () => {
      const config: ProvidersConfig = {
        default: "local-ollama",
        providers: [
          {
            name: "local-ollama",
            type: "ollama",
            models: [{ name: "Llama 3.2", key: "llama3.2" }],
            defaultModel: "llama3.2",
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
      expect(config.default).toBe("local-ollama");
      expect(config.providers).toHaveLength(2);
      expect(config.providers[0].type).toBe("ollama");
      expect(config.providers[1].type).toBe("bedrock");
    });

    it("should support single provider in config", () => {
      const config: ProvidersConfig = {
        default: "ollama",
        providers: [
          {
            name: "ollama",
            type: "ollama",
            models: [{ name: "Model", key: "model" }],
            defaultModel: "model",
          },
        ],
      };
      expect(config.providers).toHaveLength(1);
    });
  });
});
