import { jest } from "@jest/globals";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
  subscriptionAccountId: (provider: ProviderConfig) =>
    provider.type === "openai" && provider.auth?.mode === "chatgpt"
      ? provider.auth.accountId
      : undefined,
}));
const { showModelMenu } = await import("../modelMenu.js");
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
  await rm(directory, { recursive: true, force: true });
});
async function saveConfig() {
  await writeFile(configPath, JSON.stringify(config));
}
async function metadata() {
  return JSON.parse(
    await readFile(
      join(directory, "auth", "openai", `${accountId}.budget.json`),
      "utf8",
    ),
  );
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

it("setup uses documented limits without a capacity question and records provenance", async () => {
  const { result, ask } = await setup(["2", "1", "1", "1"]);
  expect(result?.provider.models[0].contextWindowTokens).toBe(922000);
  expect(result?.persistent).toBe(false);
  expect(ask.mock.calls.map(([prompt]) => prompt).join("\n")).not.toContain(
    "enter verified tokens",
  );
  expect(loadProvidersConfig(configPath)).toEqual(config);
  expect(await metadata()).toMatchObject({
    source: "official-documentation",
    capacity: {
      sourceUrl: "https://developers.openai.com/api/docs/models/gpt-6.1-sol",
      checkedAt: "2026-10-11",
      maxOutputTokens: 128000,
    },
  });
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
  expect(await metadata()).toMatchObject({
    source: "saved-config",
    contextWindowTokens: 200000,
  });
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
  expect(await metadata()).toMatchObject({
    source: "user-supplied-capacity",
    contextWindowTokens: 300000,
  });
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
  expect(await metadata()).toMatchObject({ source: "official-documentation" });
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
  expect(await metadata()).toMatchObject({
    source: "user-selected-conservative",
    contextWindowTokens: 128000,
  });
});

it("cancelled model adjustment leaves the session and saved defaults unchanged", async () => {
  const agent = menuAgent();
  const composer = new MockPromptComposer(["1", "3", ""]);
  await showModelMenu(composer, agent, createMockMenuUi(output), configPath);
  expect(agent.switchProvider).not.toHaveBeenCalled();
  expect(agent.setPreparedProvidersConfig).not.toHaveBeenCalled();
  expect(loadProvidersConfig(configPath)).toEqual(config);
});
