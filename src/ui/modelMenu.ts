import type { Agent } from "../agent.js";
import type {
  Model,
  ProviderConfig,
  ProvidersConfig,
} from "../providers/config.js";
import {
  getDefaultProviderModelSelection,
  loadProvidersConfig,
  updateDefaultProviderModelSelectionInFile,
} from "../providers/configLoader.js";
import type { PromptComposer } from "./promptComposer.js";
import type { TerminalUi } from "./terminal.js";

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
      `  ${index + 1}. ${provider.name.padEnd(labelWidth)} - ${modelCount}`,
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
  persistedSelection: { providerName: string; modelKey: string },
): void {
  ui.section("Models");
  ui.info(
    `Current session: ${formatSelection(currentSelection.providerName, currentSelection.modelKey)}`,
  );
  ui.info(
    `Default for future sessions: ${formatSelection(persistedSelection.providerName, persistedSelection.modelKey)}`,
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
): Promise<"session" | "persistent" | null> {
  while (true) {
    ui.section("Apply Selection");
    ui.info(`Selected: ${formatSelection(providerName, modelKey)}`);
    ui.command("  1. This session only");
    ui.command("  2. Make default for future sessions too");

    const selection = await promptForNumber(
      composer,
      ui.prompt("Enter 1, 2, or blank to cancel: "),
    );

    if (selection === "closed" || selection === null) {
      return null;
    }

    if (selection === 1) {
      return "session";
    }
    if (selection === 2) {
      return "persistent";
    }

    ui.error("Invalid input. Please enter 1 or 2.\n");
  }
}

async function selectModelMenuChoice(
  composer: PromptComposer,
  ui: ModelMenuUi,
  providers: ReadonlyArray<ProviderConfig>,
): Promise<ModelSelection | null> {
  const provider = await selectProvider(composer, ui, providers);
  if (!provider) {
    return null;
  }

  const model = await selectModel(composer, ui, provider);
  if (!model) {
    return null;
  }

  const applyMode = await selectApplyMode(
    composer,
    ui,
    provider.name,
    model.key,
  );
  if (!applyMode) {
    return null;
  }

  return { provider, model, applyMode };
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
  agent: Pick<Agent, "getActiveModelSelection" | "switchProvider">,
  ui: ModelMenuUi,
  configPath: string,
): Promise<void> {
  const config = loadConfigForMenu(ui, configPath);
  if (!config) {
    return;
  }

  displayCurrentSelections(
    ui,
    agent.getActiveModelSelection(),
    getDefaultProviderModelSelection(config),
  );

  const selection = await selectModelMenuChoice(composer, ui, config.providers);
  if (!selection) {
    ui.command("");
    return;
  }

  const { provider, model, applyMode } = selection;
  if (!switchSessionModel(agent, ui, provider.name, model.key)) {
    return;
  }

  if (applyMode === "persistent") {
    persistModelSelection(ui, configPath, provider.name, model.key);
  } else {
    ui.success(
      `Switched the current session to ${formatSelection(provider.name, model.key)}.`,
    );
  }

  ui.command("");
}
