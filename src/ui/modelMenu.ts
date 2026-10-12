import { recordPromptBudget } from "../auth/openai/budgets.js";
import { choosePromptBudget } from "../auth/openai/setup.js";
import type { Agent } from "../agent.js";
import {
  type Model,
  type ProviderConfig,
  type ProvidersConfig,
  getDefaultProviderModelSelection,
  updateDefaultProviderModelSelectionInFile,
  writeProvidersConfig,
} from "@propio-ai/providers";
import { loadProvidersConfig } from "../config/providersConfig.js";
import type { PromptComposer } from "./promptComposer.js";
import type { TerminalUi } from "./terminal.js";
import {
  discoverAccountModels,
  prepareProviderRuntime,
  subscriptionAccountId,
  accessLabel,
} from "../auth/openai/runtime.js";

function formatSelection(providerName: string, modelKey: string): string {
  return `${providerName}/${modelKey}`;
}

type ModelMenuUi = Pick<
  TerminalUi,
  "command" | "error" | "info" | "prompt" | "section" | "success"
>;

type ModelSelection = {
  provider: ProviderConfig;
  model: Model;
  applyMode: "session" | "persistent";
};

async function promptForNumber(
  composer: PromptComposer,
  promptText: string,
): Promise<number | null | "closed"> {
  const result = await composer.compose({
    mode: "menu",
    promptText,
  });

  if (result.status === "closed") {
    return "closed";
  }

  const trimmed = result.submission.displayText.trim();
  if (trimmed === "") {
    return null;
  }

  const parsed = Number.parseInt(trimmed, 10);
  return Number.isNaN(parsed) ? -1 : parsed;
}

function displayProviders(
  ui: Pick<TerminalUi, "command" | "section">,
  providers: ReadonlyArray<ProviderConfig>,
): void {
  const labelWidth = Math.max(
    8,
    ...providers.map((provider) => provider.name.length),
  );

  ui.section("Providers");
  for (const [index, provider] of providers.entries()) {
    const modelCount = `${provider.models.length} model${provider.models.length === 1 ? "" : "s"}`;
    ui.command(
      `  ${index + 1}. ${provider.name.padEnd(labelWidth)} - ${modelCount}${provider.type === "openai" ? (provider.auth?.mode === "chatgpt" ? " · ChatGPT plan" : " · API") : ""}`,
    );
  }
}

function displayModels(
  ui: Pick<TerminalUi, "command" | "section">,
  provider: ProviderConfig,
): void {
  ui.section(`Models: ${provider.name}`);
  for (const [index, model] of provider.models.entries()) {
    ui.command(`  ${index + 1}. ${model.name} - ${model.key}`);
  }
}

function loadConfigForMenu(
  ui: ModelMenuUi,
  configPath: string,
): ProvidersConfig | null {
  try {
    return loadProvidersConfig(configPath);
  } catch (error) {
    ui.error(
      `Failed to load providers config: ${error instanceof Error ? error.message : String(error)}`,
    );
    ui.command("");
    return null;
  }
}

function displayCurrentSelections(
  ui: ModelMenuUi,
  currentSelection: { providerName: string; modelKey: string },
  persistedSelection: { providerName: string; modelKey: string } | undefined,
): void {
  ui.section("Models");
  ui.info(
    `Current session: ${formatSelection(currentSelection.providerName, currentSelection.modelKey)}`,
  );
  ui.info(
    persistedSelection
      ? `Default for future sessions: ${formatSelection(persistedSelection.providerName, persistedSelection.modelKey)}`
      : "No saved default is available; this session's selection has not been persisted.",
  );
}

async function selectProvider(
  composer: PromptComposer,
  ui: Pick<TerminalUi, "command" | "error" | "prompt" | "section">,
  providers: ReadonlyArray<ProviderConfig>,
): Promise<ProviderConfig | null> {
  while (true) {
    displayProviders(ui, providers);

    const selection = await promptForNumber(
      composer,
      ui.prompt("Enter provider number or blank to cancel: "),
    );

    if (selection === "closed" || selection === null) {
      return null;
    }

    if (selection < 1 || selection > providers.length) {
      ui.error("Invalid input. Please enter a valid provider number.\n");
      continue;
    }

    return providers[selection - 1];
  }
}

async function selectModel(
  composer: PromptComposer,
  ui: Pick<TerminalUi, "command" | "error" | "info" | "prompt" | "section">,
  provider: ProviderConfig,
): Promise<Model | null> {
  if (provider.models.length === 1) {
    const [onlyModel] = provider.models;
    ui.info(
      `Only one model is configured for ${provider.name}: ${onlyModel.key}`,
    );
    return onlyModel;
  }

  while (true) {
    displayModels(ui, provider);

    const selection = await promptForNumber(
      composer,
      ui.prompt("Enter model number or blank to cancel: "),
    );

    if (selection === "closed" || selection === null) {
      return null;
    }

    if (selection < 1 || selection > provider.models.length) {
      ui.error("Invalid input. Please enter a valid model number.\n");
      continue;
    }

    return provider.models[selection - 1];
  }
}

async function selectApplyMode(
  composer: PromptComposer,
  ui: Pick<TerminalUi, "command" | "error" | "info" | "prompt" | "section">,
  providerName: string,
  modelKey: string,
  allowBudgetChange = false,
): Promise<"session" | "persistent" | "budget" | null> {
  while (true) {
    ui.section("Apply Selection");
    ui.info(`Selected: ${formatSelection(providerName, modelKey)}`);
    ui.command("  1. This session only");
    ui.command("  2. Make default for future sessions too");
    if (allowBudgetChange) ui.command("  3. Adjust prompt budget");

    const selection = await promptForNumber(
      composer,
      ui.prompt(
        allowBudgetChange
          ? "Enter 1, 2, 3, or blank to cancel: "
          : "Enter 1, 2, or blank to cancel: ",
      ),
    );

    if (selection === "closed" || selection === null) return null;
    const modes = allowBudgetChange
      ? (["session", "persistent", "budget"] as const)
      : (["session", "persistent"] as const);
    const mode = modes[selection - 1];
    if (mode) return mode;
    ui.error(
      `Invalid input. Please enter ${allowBudgetChange ? "1, 2, or 3" : "1 or 2"}.\n`,
    );
  }
}

async function selectModelMenuChoice(
  composer: PromptComposer,
  ui: ModelMenuUi,
  providers: ReadonlyArray<ProviderConfig>,
  configPath: string,
): Promise<ModelSelection | null> {
  const provider = await selectProvider(composer, ui, providers);
  if (!provider) {
    return null;
  }

  const eligibleProvider = await loadEligibleProvider(provider, ui);
  if (!eligibleProvider) return null;
  const model = await selectModel(composer, ui, eligibleProvider);
  if (!model) return null;
  if (!(await selectNewModelBudget(composer, ui, provider, model, configPath)))
    return null;

  let applyMode;
  do {
    applyMode = await selectApplyMode(
      composer,
      ui,
      provider.name,
      model.key,
      Boolean(subscriptionAccountId(provider)),
    );
    if (
      applyMode === "budget" &&
      !(await selectNewModelBudget(
        composer,
        ui,
        provider,
        model,
        configPath,
        true,
      ))
    )
      return null;
  } while (applyMode === "budget");
  if (!applyMode) {
    return null;
  }

  return { provider: eligibleProvider, model, applyMode };
}

function switchSessionModel(
  agent: Pick<Agent, "switchProvider">,
  ui: ModelMenuUi,
  providerName: string,
  modelKey: string,
): boolean {
  try {
    agent.switchProvider(providerName, modelKey);
    return true;
  } catch (error) {
    ui.error(
      `Failed to switch the current session model: ${error instanceof Error ? error.message : String(error)}`,
    );
    ui.command("");
    return false;
  }
}

function persistModelSelection(
  ui: ModelMenuUi,
  configPath: string,
  providerName: string,
  modelKey: string,
): void {
  try {
    updateDefaultProviderModelSelectionInFile(
      configPath,
      providerName,
      modelKey,
    );
    ui.success(
      `Updated the default to ${formatSelection(providerName, modelKey)} and switched the current session.`,
    );
  } catch (error) {
    ui.error(
      `Switched the current session to ${formatSelection(providerName, modelKey)}, but failed to update defaults: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export async function showModelMenu(
  composer: PromptComposer,
  agent: Pick<Agent, "getActiveModelSelection" | "switchProvider"> &
    Partial<
      Pick<
        Agent,
        | "getActiveAccessBinding"
        | "setPreparedProvidersConfig"
        | "getAvailableProvidersConfig"
      >
    >,
  ui: ModelMenuUi,
  configPath: string,
): Promise<void> {
  const config =
    agent.getAvailableProvidersConfig?.() ?? loadConfigForMenu(ui, configPath);
  if (!config) {
    return;
  }

  displayCurrentSelections(
    ui,
    agent.getActiveModelSelection(),
    savedDefault(configPath),
  );

  const selection = await selectModelMenuChoice(
    composer,
    ui,
    config.providers,
    configPath,
  );
  if (!selection) {
    ui.command("");
    return;
  }

  const { provider, model, applyMode } = selection;
  const prepared = await prepareSubscriptionSwitch(
    composer,
    agent,
    ui,
    config,
    provider,
    model,
  );
  if (!prepared) return;
  if (
    !applySessionSwitch(
      agent,
      ui,
      provider.name,
      model.key,
      prepared.transferTranscript,
    )
  )
    return;

  if (applyMode === "persistent") {
    if (subscriptionAccountId(provider))
      persistSubscriptionSelection(
        ui,
        configPath,
        prepared.config,
        provider.name,
        model.key,
      );
    else persistModelSelection(ui, configPath, provider.name, model.key);
  } else {
    ui.success(
      `Switched the current session to ${formatSelection(provider.name, model.key)}.`,
    );
  }

  ui.command("");
}

function savedDefault(configPath: string) {
  try {
    return getDefaultProviderModelSelection(loadProvidersConfig(configPath));
  } catch {
    return undefined;
  }
}

type ModelMenuAgent = Parameters<typeof showModelMenu>[1];
async function prepareSubscriptionSwitch(
  composer: PromptComposer,
  agent: ModelMenuAgent,
  ui: ModelMenuUi,
  config: ProvidersConfig,
  provider: ProviderConfig,
  model: Model,
): Promise<{ config: ProvidersConfig; transferTranscript: boolean } | null> {
  const id = subscriptionAccountId(provider);
  if (!id) return { config, transferTranscript: false };
  try {
    ui.info(await accessLabel(provider));
    const transfer = await chooseTranscriptTransfer(composer, agent, ui, id);
    if (transfer === null) return null;
    const resolved = {
      ...config,
      providers: config.providers.map((entry) =>
        entry.name === provider.name
          ? {
              ...provider,
              models: [
                ...(config.providers
                  .find((configured) => configured.name === provider.name)
                  ?.models.filter((entry) => entry.key !== model.key) ?? []),
                model,
              ],
              defaultModel: model.key,
            }
          : entry,
      ),
    };
    agent.setPreparedProvidersConfig?.(
      resolved,
      await prepareProviderRuntime(resolved),
    );
    return { config: resolved, transferTranscript: transfer };
  } catch (error) {
    ui.error(
      error instanceof Error ? error.message : "ChatGPT selection failed.",
    );
    return null;
  }
}
async function chooseTranscriptTransfer(
  composer: PromptComposer,
  agent: ModelMenuAgent,
  ui: ModelMenuUi,
  accountId: string,
): Promise<boolean | null> {
  if (accountId === agent.getActiveAccessBinding?.().accountId) return false;
  ui.info(
    "Changing ChatGPT registration starts a new conversation. Transcript transfer sends readable history to the destination account.",
  );
  const choice = await promptForNumber(
    composer,
    ui.prompt("1: New conversation, 2: Transfer transcript, blank: cancel: "),
  );
  return choice === 1 ? false : choice === 2 ? true : null;
}
function applySessionSwitch(
  agent: ModelMenuAgent,
  ui: ModelMenuUi,
  providerName: string,
  modelKey: string,
  transfer: boolean,
): boolean {
  if (!transfer) return switchSessionModel(agent, ui, providerName, modelKey);
  try {
    agent.switchProvider(providerName, modelKey, { transferTranscript: true });
    return true;
  } catch (error) {
    ui.error(error instanceof Error ? error.message : "Account switch failed.");
    return false;
  }
}
function persistSubscriptionSelection(
  ui: ModelMenuUi,
  path: string,
  config: ProvidersConfig,
  name: string,
  model: string,
): void {
  try {
    writeProvidersConfig(path, { ...config, default: name });
    ui.success(
      `Updated the default to ${formatSelection(name, model)} and switched the current session.`,
    );
  } catch (error) {
    ui.error(
      `Switched the session, but failed to update defaults: ${error instanceof Error ? error.message : "Configuration write failed."}`,
    );
  }
}

async function loadEligibleProvider(
  provider: ProviderConfig,
  ui: ModelMenuUi,
): Promise<ProviderConfig | null> {
  const id = subscriptionAccountId(provider);
  if (!id) return provider;
  try {
    const catalog = await discoverAccountModels(id, undefined, true);
    if (!catalog.length)
      throw new Error("No eligible models are visible for this account.");
    return {
      ...provider,
      models: catalog.map((entry) => ({
        ...entry,
        contextWindowTokens:
          provider.models.find((configured) => configured.key === entry.key)
            ?.contextWindowTokens ?? 128000,
      })),
    };
  } catch (error) {
    ui.error(error instanceof Error ? error.message : "Catalog unavailable.");
    return null;
  }
}
async function selectNewModelBudget(
  composer: PromptComposer,
  ui: ModelMenuUi,
  provider: ProviderConfig,
  model: Model,
  configPath: string,
  customize = false,
): Promise<boolean> {
  if (!subscriptionAccountId(provider)) return true;
  const saved = provider.models.find((entry) => entry.key === model.key);
  const budget = await choosePromptBudget(
    {
      info: (message) => ui.info(message),
      ask: async (prompt) => {
        const result = await composer.compose({
          mode: "menu",
          promptText: ui.prompt(prompt),
        });
        return result.status === "closed"
          ? null
          : result.submission.displayText.trim();
      },
    },
    model.key,
    customize ? model.contextWindowTokens : saved?.contextWindowTokens,
    customize,
  );
  if (!budget) return false;
  model.contextWindowTokens = budget.contextWindowTokens;
  await recordPromptBudget(
    configPath,
    subscriptionAccountId(provider)!,
    model,
    budget,
  );
  return true;
}
