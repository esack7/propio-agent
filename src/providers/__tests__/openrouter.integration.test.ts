/**
 * OpenRouter integration tests (real API).
 * Run when OPENROUTER_API_KEY is set or an OpenRouter provider with apiKey exists in .propio/providers.json. Skipped otherwise.
 */
import * as path from "path";
import * as fs from "fs";
import { createProvider } from "../factory";
import { OpenRouterProvider } from "../openrouter";
import { OpenRouterProviderConfig } from "../config";
import { ProviderAuthenticationError } from "../types";
import { Agent } from "../../agent";
import { ProvidersConfig } from "../config";

function getOpenRouterApiKey(): string | undefined {
  if (process.env.OPENROUTER_API_KEY) return process.env.OPENROUTER_API_KEY;
  const configPath = path.join(process.cwd(), ".propio", "providers.json");
  try {
    if (!fs.existsSync(configPath)) return undefined;
    const config = JSON.parse(fs.readFileSync(configPath, "utf-8"));
    const openRouter = config.providers?.find(
      (p: any) => p.type === "openrouter",
    );
    return openRouter?.apiKey;
  } catch {
    return undefined;
  }
}

const apiKey = getOpenRouterApiKey();
const itIntegration = apiKey ? it : it.skip;

const openRouterProviderConfig: OpenRouterProviderConfig = {
  name: "openrouter",
  type: "openrouter",
  models: [
    { name: "GPT-3.5 Turbo", key: "openai/gpt-3.5-turbo" },
    { name: "DeepSeek Chat", key: "deepseek/deepseek-chat" },
  ],
  defaultModel: "openai/gpt-3.5-turbo",
  ...(apiKey ? { apiKey } : {}),
};

describe("OpenRouter integration (real API)", () => {
  if (!apiKey) {
    it("skipped when OPENROUTER_API_KEY is not set", () => {});
    return;
  }

  describe("9.1 Factory creates OpenRouterProvider", () => {
    itIntegration("should create OpenRouterProvider via factory", () => {
      const provider = createProvider(openRouterProviderConfig);
      expect(provider).toBeInstanceOf(OpenRouterProvider);
      expect(provider.name).toBe("openrouter");
    });
  });

  describe("9.2 Non-streaming chat with real API", () => {
    itIntegration(
      "should complete non-streaming chat with openai/gpt-3.5-turbo",
      async () => {
        const provider = createProvider(openRouterProviderConfig);
        const response = await provider.chat({
          model: "openai/gpt-3.5-turbo",
          messages: [{ role: "user", content: "Reply with exactly: OK" }],
        });
        expect(response.message.role).toBe("assistant");
        expect(typeof response.message.content).toBe("string");
        expect(response.message.content.length).toBeGreaterThan(0);
        expect([
          "end_turn",
          "tool_use",
          "max_tokens",
          "stop_sequence",
        ]).toContain(response.stopReason);
      },
      15000,
    );
  });

  describe("9.3 Streaming chat with real API", () => {
    itIntegration(
      "should stream chat and yield incremental chunks",
      async () => {
        const provider = createProvider(openRouterProviderConfig);
        const chunks: string[] = [];
        for await (const chunk of provider.streamChat({
          model: "openai/gpt-3.5-turbo",
          messages: [{ role: "user", content: 'Say "Hi" in one word.' }],
        })) {
          if (chunk.delta) chunks.push(chunk.delta);
        }
        const fullText = chunks.join("");
        expect(fullText.length).toBeGreaterThan(0);
      },
      15000,
    );
  });

  describe("9.4 Tool calling with real API", () => {
    itIntegration(
      "should handle tool calling with openai/gpt-3.5-turbo",
      async () => {
        const provider = createProvider(openRouterProviderConfig);
        const response = await provider.chat({
          model: "openai/gpt-3.5-turbo",
          messages: [
            {
              role: "user",
              content: "What is 2+2? Use no tools, just answer in one number.",
            },
          ],
          tools: [
            {
              type: "function",
              function: {
                name: "add",
                description: "Add two numbers",
                parameters: {
                  type: "object",
                  properties: { a: { type: "number" }, b: { type: "number" } },
                  required: ["a", "b"],
                },
              },
            },
          ],
        });
        expect(response.message.role).toBe("assistant");
        expect(
          response.message.content !== undefined ||
            (response.message.toolCalls &&
              response.message.toolCalls.length > 0),
        ).toBe(true);
      },
      15000,
    );
  });

  describe("9.5 Invalid API key", () => {
    itIntegration(
      "should throw ProviderAuthenticationError for invalid API key",
      async () => {
        const badConfig: OpenRouterProviderConfig = {
          ...openRouterProviderConfig,
          name: "openrouter-bad",
          apiKey: "sk-invalid-key-does-not-exist",
        };
        const provider = createProvider(badConfig);
        await expect(
          provider.chat({
            model: "openai/gpt-3.5-turbo",
            messages: [{ role: "user", content: "Hi" }],
          }),
        ).rejects.toThrow(ProviderAuthenticationError);
      },
      10000,
    );
  });

  describe("9.6 Runtime provider switching", () => {
    itIntegration(
      "should switch between OpenRouter and another OpenRouter config and preserve context",
      async () => {
        const config: ProvidersConfig = {
          default: "openrouter-primary",
          providers: [
            {
              name: "openrouter-primary",
              type: "openrouter",
              models: [{ name: "GPT-3.5", key: "openai/gpt-3.5-turbo" }],
              defaultModel: "openai/gpt-3.5-turbo",
              apiKey: apiKey!,
            },
            {
              name: "openrouter-alt",
              type: "openrouter",
              models: [{ name: "DeepSeek", key: "deepseek/deepseek-chat" }],
              defaultModel: "deepseek/deepseek-chat",
              apiKey: apiKey!,
            },
          ],
        };
        const agent = new Agent({ providersConfig: config });
        await agent.chat("Remember the number 42.");
        const contextSize = agent.getContext().length;
        expect(contextSize).toBeGreaterThan(0);

        (agent as any).switchProvider("openrouter-alt");
        const contextAfterSwitch = agent.getContext();
        expect(contextAfterSwitch.length).toBe(contextSize);

        const response = await agent.chat(
          "What number did I ask you to remember? Reply with just the number.",
        );
        expect(response).toBeDefined();
        expect(agent.getContext().length).toBeGreaterThan(contextSize);
      },
      20000,
    );
  });
});
