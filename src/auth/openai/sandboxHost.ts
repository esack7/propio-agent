import {
  cp,
  mkdtemp,
  readFile,
  realpath,
  writeFile,
  rm,
  lstat,
  chmod,
} from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, relative } from "node:path";
import { loadProvidersConfig, resolveProvider } from "@propio-ai/providers";
import { defaultOpenAiSecretDirectory } from "./auth.js";
import { authForAccount, subscriptionAccountId } from "./runtime.js";
import { startCredentialBroker } from "./broker.js";

class SandboxConfigurationError extends Error {}

function loadSandboxConfig(path: string) {
  try {
    return loadProvidersConfig(path);
  } catch (error) {
    // Only expose the default name, never raw JSON or other validation details.
    const missingDefault =
      error instanceof Error
        ? /^Default provider "(.*)" not found in providers list\./s.exec(
            error.message,
          )?.[1]
        : undefined;
    throw new SandboxConfigurationError(
      missingDefault !== undefined
        ? `Default provider ${JSON.stringify(missingDefault)} is missing from ~/.propio/providers.json. Correct its "default" field or add that provider.`
        : "Invalid host ~/.propio/providers.json. Check its JSON and provider settings.",
    );
  }
}

const SETTINGS_FILE = "settings.json";

/** Parts of ~/.propio that hold credentials and never enter the sandbox. */
const EXCLUDED_CONFIG_PARTS = ["poc", "auth/openai"] as const;

function isWithin(candidate: string, directory: string): boolean {
  const part = relative(directory, candidate);
  return (
    part === "" ||
    (part !== ".." && !part.startsWith("../") && !isAbsolute(part))
  );
}

/** A directory with any links in it resolved; as given if it does not exist. */
async function physical(directory: string): Promise<string> {
  return await realpath(directory).catch(() => directory);
}

/**
 * Every place credentials are kept: the excluded parts of the config
 * directory, and the secret directory outside it. Physical paths, so a link
 * cannot reach them by another name.
 */
async function credentialLocations(source: string): Promise<string[]> {
  const locations = [
    ...EXCLUDED_CONFIG_PARTS.map((part) => join(source, part)),
    defaultOpenAiSecretDirectory(),
  ];
  return [
    ...locations,
    ...(await Promise.all(locations.map((location) => physical(location)))),
  ];
}

/**
 * Links are left out of the view so that one cannot carry an arbitrary host
 * file into the container. A linked settings file is the exception that has
 * to be handled: natively its permission rules apply, and a sandbox run
 * without them would have no deny rules. So the link is followed, but never
 * into a place that holds credentials, and only the `permissions` object is
 * copied: it is the one part of the file the container reads. Anything that
 * does not hold up stops the sandbox before it starts.
 */
async function includeLinkedSettings(
  source: string,
  view: string,
): Promise<void> {
  const linked = join(source, SETTINGS_FILE);
  const isLink = await lstat(linked).then(
    (stats) => stats.isSymbolicLink(),
    () => false,
  );
  if (!isLink) return;
  const target = await realpath(linked).catch(() => {
    throw new SandboxConfigurationError(
      "~/.propio/settings.json is a symbolic link to a file that does not exist. " +
        "Fix the link or its target; the sandbox will not start without your permission rules.",
    );
  });
  // Checked before reading: the target must not even be opened.
  const locations = await credentialLocations(source);
  if (locations.some((location) => isWithin(target, location))) {
    throw new SandboxConfigurationError(
      "~/.propio/settings.json links into a directory that holds credentials, " +
        "which never enter the sandbox. Point it at your settings file instead.",
    );
  }
  let settings: unknown;
  try {
    settings = JSON.parse(await readFile(target, "utf8"));
  } catch {
    throw new SandboxConfigurationError(
      "~/.propio/settings.json is a symbolic link that could not be read as JSON. " +
        "Fix the link or its target; the sandbox will not start without your permission rules.",
    );
  }
  if (
    typeof settings !== "object" ||
    settings === null ||
    Array.isArray(settings)
  ) {
    throw new SandboxConfigurationError(
      "~/.propio/settings.json is a symbolic link to something that is not a settings object. " +
        "The sandbox will not start without your permission rules.",
    );
  }
  // The container checks this object itself when it loads its rules.
  const copied =
    "permissions" in settings
      ? { permissions: (settings as { permissions: unknown }).permissions }
      : {};
  await writeFile(
    join(view, SETTINGS_FILE),
    `${JSON.stringify(copied, null, 2)}\n`,
    { mode: 0o600 },
  );
}

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
            !EXCLUDED_CONFIG_PARTS.some(
              (excluded) =>
                part === excluded || part.startsWith(`${excluded}/`),
            )
          );
        },
      });
    await includeLinkedSettings(source, view);
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
    const config = existsSync(path) ? loadSandboxConfig(path) : undefined;
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

if (/\/sandboxHost\.(?:js|ts)$/.test(process.argv[1] ?? ""))
  run().catch((error: unknown) => {
    const message =
      error instanceof SandboxConfigurationError
        ? error.message
        : "Check host sign-in and configuration.";
    process.stderr.write(
      `Sandbox credential startup failed. ${message} No credentials were mounted.\n`,
    );
    process.exitCode = 1;
  });
