import { jest } from "@jest/globals";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { ProviderConfig, ProvidersConfig } from "@propio-ai/providers";
import { createMockMenuUi, MockPromptComposer } from "./menuTestHelpers.js";

const accountId = randomUUID();
let catalogKey = "gpt-6.1-sol";
const catalog = async () => [{ key: catalogKey, name: catalogKey }];
jest.unstable_mockModule("../../auth/openai/catalog.js", () => ({
  discoverModels: catalog,
}));
jest.unstable_mockModule("../../auth/openai/auth.js", () => ({
  OpenAiAuth: class {
    profile = "personal";
    async accounts() {
      return [{ accountId, label: this.profile, state: "connected" }];
    }
    async status() {
      return { accountId, connected: true, planUsageEnabled: true };
    }
  },
}));
jest.unstable_mockModule("../../auth/openai/runtime.js", () => ({
  discoverAccountModels: catalog,
  prepareProviderRuntime: async () => ({}),
  accessLabel: async () => "Using ChatGPT plan · personal",
  preflightSubscription: async () => {},
  subscriptionAccountId: (provider: ProviderConfig) =>
    provider.type === "openai" && provider.auth?.mode === "chatgpt"
      ? provider.auth.accountId
      : undefined,
}));
const { showModelMenu } = await import("../modelMenu.js");
const { showAccountMenu } = await import("../accountMenu.js");
const { guidedOpenAiSetup } = await import("../../auth/openai/setup.js");
const { loadProvidersConfig } = await import("../../config/providersConfig.js");

let directory: string;
let configPath: string;
let config: ProvidersConfig;
let output: string[];
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "propio-subscription-budgets-"));
  configPath = join(directory, "providers.json");
  catalogKey = "gpt-6.1-sol";
  output = [];
  config = {
    default: "openai-personal",
    providers: [
      {
        name: "openai-personal",
        type: "openai",
        auth: { mode: "chatgpt", accountId },
        defaultModel: "previous-model",
        models: [
          {
            key: "previous-model",
            name: "Previous",
            contextWindowTokens: 128000,
          },
        ],
      },
    ],
  };
  await saveConfig();
});
afterEach(async () => {
  expect(await readdir(directory)).toEqual(["providers.json"]);
  await rm(directory, { recursive: true, force: true });
});
async function saveConfig() {
  await writeFile(configPath, JSON.stringify(config));
}
function menuAgent() {
  return {
    getActiveModelSelection: () => ({
      providerName: "openai-personal",
      modelKey: "previous-model",
    }),
    getActiveAccessBinding: () => ({
      accountId,
      accessMode: "chatgpt" as const,
    }),
    switchProvider: jest.fn(),
    setPreparedProvidersConfig: jest.fn(),
    cancelSubscriptionRequests: jest.fn(),
  };
}
async function setup(responses: string[]) {
  const ask = jest
    .fn<(prompt: string) => Promise<string | null>>()
    .mockImplementation(async () => responses.shift() ?? null);
  const result = await guidedOpenAiSetup(
    { ask, info: (message) => output.push(message) },
    configPath,
  );
  return { result, ask };
}

it("setup uses documented limits without a capacity question or budget sidecar", async () => {
  const { result, ask } = await setup(["2", "1", "1", "1"]);
  expect(result?.provider.models[0].contextWindowTokens).toBe(922000);
  expect(result?.persistent).toBe(false);
  expect(ask.mock.calls.map(([prompt]) => prompt).join("\n")).not.toContain(
    "enter verified tokens",
  );
  expect(loadProvidersConfig(configPath)).toEqual(config);
  expect(output.join("\n")).toContain("documented model limits");
});

it("setup preserves the saved budget for the selected registration and model", async () => {
  config.providers[0].models.push({
    key: catalogKey,
    name: catalogKey,
    contextWindowTokens: 200000,
  });
  await saveConfig();
  const { result } = await setup(["2", "1", "1", "2"]);
  expect(result?.provider.models[0].contextWindowTokens).toBe(200000);
  expect(output.join("\n")).toContain("saved selection");
});

it("setup does not reuse a different registration's saved budget", async () => {
  config.providers[0].name = "other";
  if (config.providers[0].type === "openai")
    config.providers[0].auth = { mode: "chatgpt", accountId: randomUUID() };
  config.providers[0].models[0].key = catalogKey;
  config.providers[0].defaultModel = catalogKey;
  config.default = "other";
  await saveConfig();
  const { result } = await setup(["2", "1", "1", "1"]);
  expect(result?.provider.models[0].contextWindowTokens).toBe(922000);
});

it("setup can adjust and persist a budget before applying the selection", async () => {
  const { result } = await setup(["2", "1", "1", "3", "300000", "2"]);
  expect(result?.persistent).toBe(true);
  expect(
    loadProvidersConfig(configPath).providers[0].models[0].contextWindowTokens,
  ).toBe(300000);
});

it("cancelled setup adjustment leaves saved defaults unchanged", async () => {
  const { result } = await setup(["2", "1", "1", "3", ""]);
  expect(result).toBeNull();
  expect(loadProvidersConfig(configPath)).toEqual(config);
});

it("model menu applies a newly discovered model automatically for this session", async () => {
  const agent = menuAgent();
  const composer = new MockPromptComposer(["1", "1"]);
  await showModelMenu(composer, agent, createMockMenuUi(output), configPath);
  expect(agent.switchProvider).toHaveBeenCalledWith(
    "openai-personal",
    catalogKey,
  );
  expect(
    agent.setPreparedProvidersConfig.mock.calls[0][0].providers[0].models.at(-1)
      .contextWindowTokens,
  ).toBe(922000);
  expect(composer.prompts).toHaveLength(2);
  expect(loadProvidersConfig(configPath)).toEqual(config);
});

it("model menu preserves a saved budget and can explicitly reset it to documented limits", async () => {
  config.providers[0].models.push({
    key: catalogKey,
    name: catalogKey,
    contextWindowTokens: 128000,
  });
  await saveConfig();
  const agent = menuAgent();
  const composer = new MockPromptComposer(["1", "3", "documented", "2"]);
  await showModelMenu(composer, agent, createMockMenuUi(output), configPath);
  expect(output.join("\n")).toContain("128,000 tokens (saved selection)");
  expect(
    loadProvidersConfig(configPath).providers[0].models.find(
      (model) => model.key === catalogKey,
    )?.contextWindowTokens,
  ).toBe(922000);
});

it("unknown model still requires an explicit conservative or verified budget", async () => {
  catalogKey = "future-model";
  const agent = menuAgent();
  const composer = new MockPromptComposer(["1", "conservative", "1"]);
  await showModelMenu(composer, agent, createMockMenuUi(output), configPath);
  expect(agent.switchProvider).toHaveBeenCalledWith(
    "openai-personal",
    catalogKey,
  );
  expect(
    agent.setPreparedProvidersConfig.mock.calls[0][0].providers[0].models.at(-1)
      .contextWindowTokens,
  ).toBe(128000);
});

it("cancelled model adjustment leaves the session and saved defaults unchanged", async () => {
  const agent = menuAgent();
  const composer = new MockPromptComposer(["1", "3", ""]);
  await showModelMenu(composer, agent, createMockMenuUi(output), configPath);
  expect(agent.switchProvider).not.toHaveBeenCalled();
  expect(agent.setPreparedProvidersConfig).not.toHaveBeenCalled();
  expect(loadProvidersConfig(configPath)).toEqual(config);
});

function apiProvider(name = "api"): ProviderConfig {
  return {
    name,
    type: "openai",
    defaultModel: "api-model",
    models: [{ name: "API", key: "api-model", contextWindowTokens: 128000 }],
  };
}

it.each(["", "1", "2"])(
  "asks before switching from ChatGPT to API (%s)",
  async (choice) => {
    config.providers.push(apiProvider());
    await saveConfig();
    const agent = menuAgent();
    const composer = new MockPromptComposer(["2", "1", choice]);
    await showModelMenu(composer, agent, createMockMenuUi(output), configPath);
    expect(composer.prompts.at(-1)).toContain("Transfer transcript");
    if (!choice) {
      expect(agent.switchProvider).not.toHaveBeenCalled();
      expect(agent.setPreparedProvidersConfig).not.toHaveBeenCalled();
    } else if (choice === "2") {
      expect(agent.switchProvider).toHaveBeenCalledWith("api", "api-model", {
        transferTranscript: true,
      });
    } else
      expect(agent.switchProvider).toHaveBeenCalledWith("api", "api-model");
    expect(loadProvidersConfig(configPath)).toEqual(config);
  },
);

it("reloads disk providers and persists only the chosen subscription model", async () => {
  const sessionOnly = apiProvider("session-only");
  const stale = structuredClone(config);
  const agent = {
    ...menuAgent(),
    getAvailableProvidersConfig: () => ({
      ...stale,
      providers: [...stale.providers, sessionOnly],
    }),
  };
  config.providers.push(apiProvider("added-on-disk"));
  await saveConfig();
  const composer = new MockPromptComposer(["1", "2"]);
  await showModelMenu(composer, agent, createMockMenuUi(output), configPath);
  expect(output.join("\n")).toContain("added-on-disk");
  expect(output.join("\n")).toContain("session-only");
  const saved = loadProvidersConfig(configPath);
  expect(saved.providers.map((entry) => entry.name)).toEqual([
    "added-on-disk",
    "openai-personal",
  ]);
  expect(
    saved.providers.find((entry) => entry.name === "openai-personal")?.models,
  ).toHaveLength(2);
});

it("preserves providers added while a model menu is open", async () => {
  const agent = menuAgent();
  const composer = new MockPromptComposer(["1", "2"]);
  const original = composer.compose.bind(composer);
  composer.compose = async (request) => {
    if (request.promptText.includes("Enter 1, 2, 3")) {
      config.providers.push(apiProvider("concurrent-addition"));
      await saveConfig();
    }
    return original(request);
  };
  await showModelMenu(composer, agent, createMockMenuUi(output), configPath);
  expect(
    loadProvidersConfig(configPath).providers.some(
      (entry) => entry.name === "concurrent-addition",
    ),
  ).toBe(true);
});

it("repeats API setup for an older entry without auth", async () => {
  config = {
    default: "openai-api",
    providers: [
      {
        ...apiProvider("openai-api"),
        type: "openai",
        apiKey: "existing-api-key",
      },
    ],
  };
  await saveConfig();
  const { result } = await setup(["1", "updated-api", "200000", "2"]);
  expect(result?.persistent).toBe(true);
  expect(loadProvidersConfig(configPath).providers[0].defaultModel).toBe(
    "updated-api",
  );
  expect(loadProvidersConfig(configPath).providers[0]).toMatchObject({
    apiKey: "existing-api-key",
  });
});

it.each(["", "1", "2"])(
  "account setup confirms a different registration before applying or saving (%s)",
  async (choice) => {
    const agent = {
      ...menuAgent(),
      getActiveAccessBinding: () => ({ accountId: "other-account" }),
    };
    const composer = new MockPromptComposer([
      "setup",
      "2",
      "1",
      "1",
      "2",
      choice,
    ]);
    await showAccountMenu(
      composer,
      agent,
      createMockMenuUi(output),
      configPath,
    );
    expect(composer.prompts.at(-1)).toContain("Transfer transcript");
    if (!choice) {
      expect(agent.switchProvider).not.toHaveBeenCalled();
      expect(loadProvidersConfig(configPath)).toEqual(config);
    } else {
      expect(agent.switchProvider).toHaveBeenCalledWith(
        "openai-personal",
        catalogKey,
        { transferTranscript: choice === "2" },
      );
    }
  },
);
