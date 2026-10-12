import { cp, mkdtemp, writeFile, rm, lstat, chmod } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, relative } from "node:path";
import { loadProvidersConfig, resolveProvider } from "@propio-ai/providers";
import { authForAccount, subscriptionAccountId } from "./runtime.js";
import { startCredentialBroker } from "./broker.js";

/** A config view excludes both renewable production secrets and legacy POC tokens. */
export async function createSandboxConfigView(source: string): Promise<string> {
  const view = await mkdtemp(join(homedir(), ".propio-sandbox-config-"));
  try {
    if (existsSync(source))
      await cp(source, view, {
        recursive: true,
        dereference: false,
        filter: async (path) => {
          const part = relative(source, path).replace(/\\/g, "/");
          return (
            !(await lstat(path)).isSymbolicLink() &&
            !["poc", "auth/openai"].some(
              (excluded) =>
                part === excluded || part.startsWith(`${excluded}/`),
            )
          );
        },
      });
    await chmod(view, 0o700);
    return view;
  } catch (error) {
    await rm(view, { recursive: true, force: true });
    throw error;
  }
}

async function run(): Promise<void> {
  const channel = process.argv[2];
  if (!channel) throw new Error("Sandbox channel directory is required.");
  const source = join(homedir(), ".propio");
  const view = await createSandboxConfigView(source);
  let broker: Awaited<ReturnType<typeof startCredentialBroker>> | undefined;
  const close = async () => {
    await broker?.close();
    await rm(view, { recursive: true, force: true });
    await rm(channel, { recursive: true, force: true });
  };
  try {
    const path = join(view, "providers.json");
    const config = existsSync(path) ? loadProvidersConfig(path) : undefined;
    const accountId = config?.default
      ? subscriptionAccountId(resolveProvider(config))
      : undefined;
    if (accountId) {
      if (process.platform !== "darwin")
        throw new Error(
          "Subscription sandbox is currently a macOS transport preview; this host platform needs transport verification.",
        );
      const auth = await authForAccount(accountId);
      await auth.getAccessToken();
      broker = await startCredentialBroker({
        accountId,
        label: auth.profile,
        getAccessToken: (signal) => auth.getAccessToken(signal),
      });
      await writeFile(
        join(channel, "broker.json"),
        JSON.stringify(broker.descriptor),
        { mode: 0o600 },
      );
    }
    await writeFile(join(channel, "config-path"), view, { mode: 0o600 });
    await writeFile(join(channel, "ready"), "ready", { mode: 0o600 });
    await waitForSandboxOwner();
  } finally {
    await close();
  }
}

export async function waitForSandboxOwner(): Promise<void> {
  const parent = process.ppid;
  await new Promise<void>((resolve) => {
    const timer = setInterval(() => {
      try {
        process.kill(parent, 0);
      } catch {
        finish();
        return;
      }
      if (process.ppid !== parent) finish();
    }, 1000);
    const finish = () => {
      clearInterval(timer);
      process.off("SIGTERM", finish);
      process.off("SIGINT", finish);
      resolve();
    };
    process.once("SIGTERM", finish);
    process.once("SIGINT", finish);
  });
}

if (process.argv[1]?.endsWith("/sandboxHost.js"))
  run().catch(() => {
    process.stderr.write(
      "Sandbox credential startup failed. Check host sign-in and configuration; no credentials were mounted.\n",
    );
    process.exitCode = 1;
  });
