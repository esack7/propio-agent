import type { Agent } from "../agent.js";
import type { PromptComposer } from "./promptComposer.js";
import type { TerminalUi } from "./terminal.js";
import { OpenAiAuth } from "../auth/openai/auth.js";
import { openSystemBrowser } from "../auth/openai/browser.js";
import { guidedOpenAiSetup } from "../auth/openai/setup.js";
import { chooseTranscriptTransfer } from "./subscriptionSwitch.js";
import {
  prepareProviderRuntime,
  preflightSubscription,
  accessLabel,
} from "../auth/openai/runtime.js";

export async function showAccountMenu(
  composer: PromptComposer,
  agent: Pick<
    Agent,
    | "setPreparedProvidersConfig"
    | "switchProvider"
    | "cancelSubscriptionRequests"
    | "getActiveAccessBinding"
  >,
  ui: Pick<TerminalUi, "info" | "error" | "prompt" | "success">,
  configPath: string,
): Promise<void> {
  if (process.env.IS_SANDBOX === "true") {
    ui.error(
      "Manage subscription accounts on the host, then restart the sandbox to change its scoped account.",
    );
    return;
  }
  const ask = async (prompt: string): Promise<string | null> => {
    const result = await composer.compose({
      mode: "menu",
      promptText: ui.prompt(prompt),
    });
    return result.status === "closed"
      ? null
      : result.submission.displayText.trim();
  };
  try {
    const accounts = await new OpenAiAuth({}).accounts();
    accounts.forEach((entry) =>
      ui.info(`${entry.label} · ${entry.state} · ${entry.storage}`),
    );
    const action = await ask(
      "Account: setup, login, enable-plan, logout, or blank to cancel: ",
    );
    if (!action) return;
    await performAccountAction(action, ask, agent, ui, configPath);
  } catch (error) {
    ui.error(
      error instanceof Error ? error.message : "Account operation failed.",
    );
  }
}

type AccountUi = Parameters<typeof showAccountMenu>[2];
async function performAccountAction(
  action: string,
  ask: (prompt: string) => Promise<string | null>,
  agent: Parameters<typeof showAccountMenu>[1],
  ui: AccountUi,
  configPath: string,
): Promise<void> {
  if (action === "setup") {
    let transferTranscript = false;
    const setup = await guidedOpenAiSetup(
      { ask, info: (message) => ui.info(message) },
      configPath,
      async (provider) => {
        const transfer = await chooseTranscriptTransfer(
          ask,
          (message) => ui.info(message),
          agent.getActiveAccessBinding().accountId,
          provider,
        );
        transferTranscript = transfer === true;
        return transfer !== null;
      },
    );
    if (!setup) return;
    const runtime = await prepareProviderRuntime(setup.config);
    await preflightSubscription(setup.provider, setup.provider.defaultModel);
    agent.setPreparedProvidersConfig(setup.config, runtime);
    agent.switchProvider(setup.provider.name, setup.provider.defaultModel, {
      transferTranscript,
    });
    ui.info(await accessLabel(setup.provider));
    return;
  }
  const label = await ask("Account label (blank cancels): ");
  if (!label) return;
  const auth = new OpenAiAuth({ profile: label });
  if (action === "login" || action === "enable-plan") {
    await auth.login({
      openBrowser: openSystemBrowser,
      enablePlan: action === "enable-plan",
    });
    ui.success(
      "Sign-in saved. Use /model or /account setup to select this account explicitly.",
    );
  } else if (action === "logout") {
    const { accountId } = await auth.status();
    if (accountId) agent.cancelSubscriptionRequests(accountId);
    const result = await auth.logout();
    ui.info(
      result.remoteRevocationConfirmed
        ? "Signed out; revocation confirmed."
        : "Signed out locally; remote revocation unconfirmed. Review ChatGPT Settings.",
    );
  } else ui.error("Choose setup, login, enable-plan or logout.");
}
