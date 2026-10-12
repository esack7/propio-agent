import { readBrokerDescriptor, getBrokerToken } from "./broker.js";
import type {
  ProviderConfig,
  ProvidersConfig,
  ProviderRuntimeOptions,
} from "@propio-ai/providers";
import { OpenAiAuth } from "./auth.js";
import { discoverModels } from "./catalog.js";

export function subscriptionAccountId(
  config: ProviderConfig,
): string | undefined {
  return config.type === "openai" && config.auth?.mode === "chatgpt"
    ? config.auth.accountId
    : undefined;
}

export async function authForAccount(accountId: string): Promise<OpenAiAuth> {
  const registrations = await new OpenAiAuth({}).accounts();
  const registration = registrations.find(
    (entry) => entry.accountId === accountId,
  );
  if (!registration)
    throw new Error(
      "ChatGPT registration is missing. Run propio auth accounts openai, then sign in and set up the selected account.",
    );
  return new OpenAiAuth({ profile: registration.label, accountId });
}

/** No asynchronous work or filesystem discovery occurs in Agent/provider constructors. */
export async function prepareProviderRuntime(
  config: ProvidersConfig,
): Promise<ProviderRuntimeOptions> {
  if (!config.providers.some(subscriptionAccountId)) return {};
  const broker = await readBrokerDescriptor();
  return {
    openAiCredentialSource: (id) => ({
      getAccessToken: async (signal) =>
        broker
          ? getBrokerToken(broker, id, signal)
          : process.env.IS_SANDBOX === "true"
            ? Promise.reject(
                new Error(
                  "Restart the sandbox with this subscription account selected on the host.",
                ),
              )
            : (await authForAccount(id)).getAccessToken(signal),
    }),
  };
}

export async function preflightSubscription(
  config: ProviderConfig,
  model: string,
): Promise<void> {
  const id = subscriptionAccountId(config);
  if (!id) return;
  const catalog = await discoverAccountModels(id);
  if (!catalog.some((entry) => entry.key === model))
    throw new Error(
      `ChatGPT model ${model} is no longer visible for this account. Choose an eligible model using /model or propio setup openai.`,
    );
}

export async function accessLabel(config: ProviderConfig): Promise<string> {
  const id = subscriptionAccountId(config);
  if (!id) return config.type === "openai" ? "OpenAI API" : config.name;
  const broker = await readBrokerDescriptor();
  const label =
    broker?.accountId === id
      ? broker.label
      : (await authForAccount(id)).profile;
  return `Using ChatGPT plan · ${label}. Conversations and summaries use this account. Manage usage: https://chatgpt.com/settings/usage`;
}

export async function discoverAccountModels(
  id: string,
  signal?: AbortSignal,
  force = false,
) {
  const broker = await readBrokerDescriptor();
  if (!broker && process.env.IS_SANDBOX === "true")
    throw new Error(
      "Restart this sandbox with the selected subscription account as the host default.",
    );
  const auth = broker
    ? {
        getAccessToken: (signal?: AbortSignal) =>
          getBrokerToken(broker, id, signal),
        status: async () => ({ accountId: id, generation: 0 }),
      }
    : await authForAccount(id);
  return discoverModels(auth, signal, force);
}
