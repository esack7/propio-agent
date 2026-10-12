import { jest } from "@jest/globals";
import { randomUUID } from "node:crypto";
import type { ProvidersConfig } from "@propio-ai/providers";

const accountId = randomUUID();
const accounts = jest.fn(async () => [{ accountId, label: "personal" }]);
const token = jest.fn(async () => "test-token");
const broker = jest.fn(async () => undefined);
const catalog = jest.fn(async () => []);
jest.unstable_mockModule("../auth.js", () => ({
  OpenAiAuth: class {
    profile: string;
    constructor(options: { profile?: string }) {
      this.profile = options.profile ?? "default";
    }
    accounts = accounts;
    getAccessToken = token;
  },
}));
jest.unstable_mockModule("../broker.js", () => ({
  readBrokerDescriptor: broker,
  getBrokerToken: jest.fn(),
}));
jest.unstable_mockModule("../catalog.js", () => ({ discoverModels: catalog }));
const { prepareProviderStartup } = await import("../runtime.js");
const config: ProvidersConfig = {
  default: "plan",
  providers: [
    {
      name: "plan",
      type: "openai",
      auth: { mode: "chatgpt", accountId },
      defaultModel: "saved-model",
      models: [
        { name: "Saved", key: "saved-model", contextWindowTokens: 128000 },
      ],
    },
  ],
};
beforeEach(() => {
  jest.clearAllMocks();
});

it("loads the saved subscription selection offline with one account/broker lookup", async () => {
  const { providerRuntimeOptions, label } =
    await prepareProviderStartup(config);
  expect(label).toContain("personal");
  expect(broker).toHaveBeenCalledTimes(1);
  expect(accounts).toHaveBeenCalledTimes(1);
  expect(catalog).not.toHaveBeenCalled();
  expect(token).not.toHaveBeenCalled();
  expect(
    await providerRuntimeOptions.openAiCredentialSource!(
      accountId,
    ).getAccessToken(),
  ).toBe("test-token");
  expect(accounts).toHaveBeenCalledTimes(1);
});

it("reports invalid defaults through the provider resolver before auth work", async () => {
  await expect(
    prepareProviderStartup({ ...config, default: "missing" }),
  ).rejects.toThrow("missing");
  expect(broker).not.toHaveBeenCalled();
  expect(accounts).not.toHaveBeenCalled();
});

it("reports an omitted default without guessing billing or crashing on undefined", async () => {
  await expect(
    prepareProviderStartup({ ...config, default: undefined }),
  ).rejects.toThrow("Unknown provider");
  expect(broker).not.toHaveBeenCalled();
});
