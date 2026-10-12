import { importPocAccount } from "./migration.js";
import { parseArgs } from "node:util";
import { createInterface } from "node:readline/promises";
import { OpenAiAuth } from "./auth.js";
import { openSystemBrowser, safeManualAuthorizationUrl } from "./browser.js";
import { guidedOpenAiSetup, PLAN_NOTICE } from "./setup.js";
import { getConfigPath } from "../../config/providersConfig.js";

const AUTH_HELP = `Usage: propio auth <login|accounts|status|enable-plan|logout|import-poc> openai [--account <label>] [--storage os|protected-file] [--no-browser] [--json]
       propio setup openai
Sign-in never changes provider defaults. Use setup or /model to choose billing and a model.
${PLAN_NOTICE}\n`;

export async function runOpenAiAuthCommand(
  args: readonly string[],
): Promise<number> {
  if (process.env.IS_SANDBOX === "true")
    throw new Error(
      "Manage subscription accounts on the host, then restart the sandbox.",
    );
  const parsed = parseArgs({
    args: [...args],
    allowPositionals: true,
    options: {
      account: { type: "string", default: "default" },
      "poc-account": { type: "string", default: "default" },
      storage: { type: "string" },
      "no-browser": { type: "boolean" },
      json: { type: "boolean" },
      help: { type: "boolean" },
    },
  });
  if (parsed.values.help) {
    process.stdout.write(AUTH_HELP);
    return 0;
  }
  const [command, provider] = parsed.positionals;
  if (provider !== "openai" || parsed.positionals.length !== 2)
    throw new Error(AUTH_HELP);
  if (
    parsed.values.storage &&
    !["os", "protected-file"].includes(parsed.values.storage)
  )
    throw new Error("--storage must be os or protected-file.");
  const auth = new OpenAiAuth({
    profile: parsed.values.account,
    storage: parsed.values.storage as "os" | "protected-file" | undefined,
  });
  const controller = new AbortController();
  const abort = () => controller.abort();
  process.once("SIGINT", abort);
  try {
    const result =
      command === "import-poc"
        ? await importPocAccount({
            account: parsed.values.account,
            sourceAccount: parsed.values["poc-account"],
            storage: parsed.values.storage as
              "os" | "protected-file" | undefined,
          })
        : await dispatch(
            command,
            auth,
            Boolean(parsed.values["no-browser"]),
            controller.signal,
          );
    process.stdout.write(
      `${parsed.values.json ? JSON.stringify(result) : typeof result === "string" ? result : JSON.stringify(result, null, 2)}\n`,
    );
    return 0;
  } finally {
    process.off("SIGINT", abort);
  }
}

async function dispatch(
  command: string,
  auth: OpenAiAuth,
  manual: boolean,
  signal: AbortSignal,
): Promise<unknown> {
  if (["login", "enable-plan"].includes(command)) {
    await auth.login({
      enablePlan: command === "enable-plan",
      signal,
      openBrowser: manual
        ? async (url) => {
            process.stdout.write(
              `Continue with ChatGPT: ${safeManualAuthorizationUrl(url)}\n`,
            );
          }
        : openSystemBrowser,
    });
    return (await auth.status()).planUsageEnabled
      ? PLAN_NOTICE
      : "Identity sign-in saved. Plan permission is disabled; use auth enable-plan openai before inference.";
  }
  if (command === "accounts") return auth.accounts();
  if (command === "status") return auth.status();
  if (command === "logout") {
    const result = await auth.logout(signal);
    return {
      ...result,
      message: result.remoteRevocationConfirmed
        ? "Signed out locally; remote revocation confirmed."
        : "Signed out locally; remote revocation unconfirmed. Review the registration in ChatGPT Settings.",
    };
  }
  throw new Error(AUTH_HELP);
}

export async function runOpenAiSetup(): Promise<{
  config: import("@propio-ai/providers").ProvidersConfig;
} | null> {
  if (process.env.IS_SANDBOX === "true")
    throw new Error(
      "Set up subscription access on the host, then restart the sandbox.",
    );
  if (!process.stdin.isTTY)
    throw new Error(
      "Setup needs an interactive terminal. Run propio setup openai in a terminal; auth status/accounts support --json.",
    );
  const input = createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  try {
    return await guidedOpenAiSetup(
      {
        ask: (prompt) => input.question(prompt),
        info: (message) => process.stdout.write(`${message}\n`),
      },
      getConfigPath(),
    );
  } finally {
    input.close();
  }
}
