import { existsSync } from "node:fs";
import {
  loadProvidersConfig,
  writeProvidersConfig,
  type OpenAiProviderConfig,
  type ProviderConfig,
  type ProvidersConfig,
} from "@propio-ai/providers";
import { OpenAiAuth } from "./auth.js";
import { discoverModels } from "./catalog.js";
import { openSystemBrowser } from "./browser.js";
import { resolvePromptBudget, type PromptBudget } from "./budgets.js";

export interface SetupUi {
  ask(prompt: string): Promise<string | null>;
  info(message: string): void;
}
export const PLAN_NOTICE =
  "Using ChatGPT plan. Conversations and background summaries consume the selected account's plan allowance or permitted credits. Manage usage: https://chatgpt.com/settings/usage. API billing requires an explicit selection.";

async function choose(
  ui: SetupUi,
  prompt: string,
  choices: readonly string[],
): Promise<number | null> {
  choices.forEach((choice, index) => ui.info(`${index + 1}. ${choice}`));
  while (true) {
    const answer = await ui.ask(`${prompt} (blank cancels): `);
    if (!answer?.trim()) return null;
    const index = Number(answer) - 1;
    if (Number.isInteger(index) && index >= 0 && index < choices.length)
      return index;
    ui.info("Choose a listed number.");
  }
}

async function subscriptionEntry(
  ui: SetupUi,
  configPath: string,
): Promise<OpenAiProviderConfig | null> {
  const auth = await chooseSetupAccount(ui);
  if (!auth) return null;
  const label = auth.profile;
  const status = await auth.status();
  ui.info(PLAN_NOTICE);
  const models = await discoverModels(auth, undefined, true);
  const selected = await choose(
    ui,
    "Model",
    models.map((model) => `${model.name} · ${model.key}`),
  );
  if (selected === null) return null;
  const key = models[selected].key;
  const existing = existsSync(configPath)
    ? loadProvidersConfig(configPath)
    : undefined;
  const saved = existing?.providers
    .find(
      (entry) =>
        entry.type === "openai" &&
        entry.auth?.mode === "chatgpt" &&
        entry.auth.accountId === status.accountId &&
        entry.models.some((model) => model.key === key),
    )
    ?.models.find((model) => model.key === key);
  const budget = await choosePromptBudget(ui, key, saved?.contextWindowTokens);
  if (!budget) return null;
  const contextWindowTokens = budget.contextWindowTokens;
  const model = { ...models[selected], contextWindowTokens };
  const provider: OpenAiProviderConfig = {
    name: `openai-${label}`,
    type: "openai",
    auth: { mode: "chatgpt", accountId: status.accountId! },
    models: [model],
    defaultModel: model.key,
  };
  return provider;
}

async function apiEntry(ui: SetupUi): Promise<OpenAiProviderConfig | null> {
  ui.info(
    "OpenAI API billing. Set OPENAI_API_KEY in your environment; setup does not collect or print your key.",
  );
  const key = await ui.ask("API model key (blank cancels): ");
  if (!key) return null;
  const budget = Number(
    await ui.ask("Model context capacity in tokens (blank cancels): "),
  );
  if (!budget) return null;
  if (!Number.isSafeInteger(budget) || budget < 1024)
    throw new Error("Context capacity must be an integer of at least 1024.");
  return {
    name: "openai-api",
    type: "openai",
    auth: { mode: "api-key" },
    models: [{ key, name: key, contextWindowTokens: budget }],
    defaultModel: key,
  };
}

export async function guidedOpenAiSetup(
  ui: SetupUi,
  configPath: string,
  confirmSelection?: (provider: OpenAiProviderConfig) => Promise<boolean>,
): Promise<{
  config: ProvidersConfig;
  provider: OpenAiProviderConfig;
  persistent: boolean;
} | null> {
  const access = await choose(ui, "OpenAI access", [
    "API key · API billing",
    "Continue with ChatGPT · ChatGPT plan",
  ]);
  if (access === null) return null;
  const provider =
    access === 0 ? await apiEntry(ui) : await subscriptionEntry(ui, configPath);
  if (!provider) return null;
  const scope = await chooseSetupScope(ui, provider);
  if (scope === null) return null;
  if (confirmSelection && !(await confirmSelection(provider))) return null;
  const existing = existsSync(configPath)
    ? loadProvidersConfig(configPath)
    : undefined;
  if (
    existing?.providers.some(
      (entry) =>
        entry.name === provider.name && !sameOpenAiAccess(entry, provider),
    )
  )
    throw new Error(
      "A provider with this name already exists with different access. Choose another account label.",
    );
  const configuredProvider: OpenAiProviderConfig = {
    ...existing?.providers.find((entry) => entry.name === provider.name),
    ...provider,
  };
  const providers = [
    ...(existing?.providers.filter((entry) => entry.name !== provider.name) ??
      []),
    configuredProvider,
  ];
  const config = { providers, default: provider.name };
  let persistent = false;
  if (scope === 1) {
    try {
      writeProvidersConfig(configPath, config);
      persistent = true;
    } catch {
      ui.info(
        "Could not save the default. This selection is available for this session; the saved default is unchanged.",
      );
    }
  }
  return { config, provider: configuredProvider, persistent };
}

function sameOpenAiAccess(
  entry: ProviderConfig,
  destination: OpenAiProviderConfig,
): boolean {
  if (entry.type !== "openai") return false;
  const current = entry.auth ?? { mode: "api-key" };
  const next = destination.auth ?? { mode: "api-key" };
  if (current.mode !== next.mode) return false;
  return (
    current.mode !== "chatgpt" ||
    (next.mode === "chatgpt" && current.accountId === next.accountId)
  );
}

async function chooseSetupAccount(ui: SetupUi): Promise<OpenAiAuth | null> {
  const accounts = await new OpenAiAuth({}).accounts();
  const choice = await choose(ui, "Account", [
    ...accounts.map((account) => `${account.label} (${account.state})`),
    "Add account · Continue with ChatGPT",
  ]);
  if (choice === null) return null;
  const label =
    choice < accounts.length
      ? accounts[choice].label
      : await ui.ask("New account label (blank cancels): ");
  if (!label) return null;
  const auth = await createSetupAuth(ui, label, choice < accounts.length);
  if (!auth) return null;
  if (!(await auth.status()).connected)
    await auth.login({ openBrowser: openSystemBrowser });
  if (!(await auth.status()).planUsageEnabled)
    throw new Error(
      `Plan usage is disabled for ${label}. Run propio auth enable-plan openai --account ${label}.`,
    );
  return auth;
}
export async function choosePromptBudget(
  ui: SetupUi,
  modelKey = "",
  saved?: number,
  customize = false,
): Promise<PromptBudget | null> {
  const resolved = resolvePromptBudget(modelKey, saved);
  if (resolved) displayPromptBudget(ui, resolved);
  else ui.info("Catalog capacity is unknown for this model.");
  if (resolved && !customize) return resolved;
  const budget = (
    await ui.ask(
      `Working context budget: enter verified tokens${resolved?.capacity ? ", 'documented' for the automatic budget" : ""}, or 'conservative' for 128000 (blank cancels): `,
    )
  )?.trim();
  if (!budget) return null;
  if (budget === "documented" && resolved?.capacity)
    return resolvePromptBudget(modelKey)!;
  return parsePromptBudget(budget, resolved);
}

function displayPromptBudget(ui: SetupUi, budget: PromptBudget): void {
  ui.info(
    `Working context budget: ${budget.contextWindowTokens.toLocaleString("en-US")} tokens (${budget.source === "saved-config" ? "saved selection" : "documented model limits"}).`,
  );
  if (budget.capacity)
    ui.info(
      `Documented context: ${budget.capacity.contextWindowTokens.toLocaleString("en-US")} tokens; output/reasoning allowance: ${budget.capacity.maxOutputTokens.toLocaleString("en-US")} tokens. Automatic budgets reserve that output allowance; subscription limits may differ.`,
    );
}

function parsePromptBudget(
  budget: string,
  resolved?: PromptBudget,
): PromptBudget {
  const capacity = budget === "conservative" ? 128000 : Number(budget);
  if (!Number.isSafeInteger(capacity) || capacity < 1024)
    throw new Error("Prompt budget must be an integer of at least 1024.");
  return {
    contextWindowTokens: capacity,
    source:
      budget === "conservative"
        ? "user-selected-conservative"
        : "user-supplied-capacity",
    capacity: resolved?.capacity,
  };
}

async function chooseSetupScope(
  ui: SetupUi,
  provider: OpenAiProviderConfig,
): Promise<number | null> {
  const accountId =
    provider.auth?.mode === "chatgpt" ? provider.auth.accountId : undefined;
  while (true) {
    const scope = await choose(ui, "Use selection", [
      "This session only",
      "Save for future sessions and make default",
      ...(accountId ? ["Adjust prompt budget"] : []),
    ]);
    if (scope !== 2) return scope;
    const model = provider.models[0];
    const budget = await choosePromptBudget(
      ui,
      model.key,
      model.contextWindowTokens,
      true,
    );
    if (!budget) return null;
    model.contextWindowTokens = budget.contextWindowTokens;
  }
}

async function createSetupAuth(
  ui: SetupUi,
  label: string,
  existing: boolean,
): Promise<OpenAiAuth | null> {
  if (existing) return new OpenAiAuth({ profile: label });
  const storage = await choose(ui, "Credential storage", [
    "OS secret store (recommended)",
    "Explicit protected-file storage on Unix",
  ]);
  if (storage === null) return null;
  return new OpenAiAuth({
    profile: label,
    storage: storage === 0 ? "os" : "protected-file",
  });
}
