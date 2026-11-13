import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { z } from "zod";
import {
  getPreset,
  parseRule,
  type OwnerScope,
  type PermissionSettings,
  type PermissionStore,
  type PermissionUpdateOptions,
} from "../policy/index.js";
import { isFileLockAvailable, withFileLock } from "./fileLock.js";
import { readJsonFileAsync, writeJsonFileAtomic } from "./jsonFile.js";

type PermissionSettingsChange = Parameters<PermissionStore["update"]>[1];

const ruleList = z.array(z.string()).default([]);

const permissionsSchema = z
  .object({
    preset: z.string().optional(),
    allow: ruleList,
    ask: ruleList,
    deny: ruleList,
  })
  .strict();

/** Where sandbox mode mounts its read-only view of the host's ~/.propio. */
const SANDBOX_CONFIG_DIRECTORY = "/app/.propio";

export interface SettingsLocation {
  readonly filePath: string;
  /** Set when rules cannot be saved here; says why and what to do instead. */
  readonly readOnlyReason?: string;
}

/**
 * The settings file whose rules apply. In sandbox mode that is the host's
 * file as mounted into the container, not the container user's home: reading
 * the latter would start every sandbox run with no rules, deny rules
 * included. The mount is a read-only copy, so nothing saved there would
 * reach the host.
 */
export function resolveSettingsLocation(
  sandboxConfigDirectory: string = SANDBOX_CONFIG_DIRECTORY,
): SettingsLocation {
  if (fs.existsSync(sandboxConfigDirectory)) {
    return {
      filePath: path.join(sandboxConfigDirectory, "settings.json"),
      readOnlyReason:
        "sandbox mode reads your settings from a read-only copy; edit " +
        "~/.propio/settings.json on the host and restart",
    };
  }
  return { filePath: path.join(os.homedir(), ".propio", "settings.json") };
}

/** A settings file that cannot be used, named with the field at fault. */
export class PermissionSettingsError extends Error {
  constructor(
    readonly filePath: string,
    detail: string,
    heading = "Invalid permissions in",
  ) {
    super(`${heading} ${filePath}: ${detail}`);
    this.name = "PermissionSettingsError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Permission rules in the `permissions` object of the user's settings file.
 * It serves one owner, the local user. Reads fail loudly on a file that
 * cannot be understood, because dropping it silently would drop deny rules.
 * Updates hold a lock across processes and rewrite the file atomically,
 * leaving every other key as it was.
 */
export class FilePermissionStore implements PermissionStore {
  private readonly filePath: string;
  private readonly owner: OwnerScope;
  private readonly readOnlyReason?: string;

  constructor(options: {
    owner: OwnerScope;
    /** Defaults to the settings file for this environment. */
    filePath?: string;
    readOnlyReason?: string;
  }) {
    const location: SettingsLocation =
      options.filePath === undefined
        ? resolveSettingsLocation()
        : { filePath: options.filePath };
    this.filePath = location.filePath;
    this.readOnlyReason = options.readOnlyReason ?? location.readOnlyReason;
    this.owner = options.owner;
  }

  /**
   * Why rules cannot be saved here, or undefined when they can. Callers use
   * it to offer saving only where it will work; `update` refuses regardless.
   */
  async savingUnavailableReason(): Promise<string | undefined> {
    if (this.readOnlyReason !== undefined) return this.readOnlyReason;
    return (await isFileLockAvailable())
      ? undefined
      : "this installation lacks the optional os-lock package, which saving " +
          `rules safely needs; edit ${this.filePath} by hand instead`;
  }

  async load(owner: OwnerScope): Promise<PermissionSettings> {
    this.assertOwner(owner);
    return this.permissionsOf(await this.readFile());
  }

  async update(
    owner: OwnerScope,
    change: PermissionSettingsChange,
    options: PermissionUpdateOptions = {},
  ): Promise<PermissionSettings> {
    this.assertOwner(owner);
    const unavailable = await this.savingUnavailableReason();
    if (unavailable !== undefined) {
      throw new PermissionSettingsError(
        this.filePath,
        `rules cannot be saved: ${unavailable}`,
        "Cannot save permissions to",
      );
    }
    return await withFileLock(`${this.filePath}.lock`, async () => {
      // Read inside the lock: the latest completed update is what changes.
      const file = await this.readFile();
      const next = this.validate(change(this.permissionsOf(file)));
      // The wait for the lock may have outlasted whoever asked: this is the
      // last moment the update can still be withdrawn.
      options.signal?.throwIfAborted();
      writeJsonFileAtomic(
        this.filePath,
        "settings",
        { ...file, permissions: next },
        { private: true },
      );
      return next;
    });
  }

  private assertOwner(owner: OwnerScope): void {
    if (owner !== this.owner) {
      throw new Error(
        `The settings file holds rules for "${this.owner}", not "${owner}"`,
      );
    }
  }

  private async readFile(): Promise<Record<string, unknown>> {
    let content: unknown;
    try {
      content = await readJsonFileAsync(this.filePath, {
        onMissing: () => ({}),
        readErrorPrefix: "cannot read the file",
        invalidJsonPrefix: "the file is not valid JSON",
      });
    } catch (error) {
      throw new PermissionSettingsError(
        this.filePath,
        error instanceof Error ? error.message : String(error),
      );
    }
    if (!isRecord(content)) {
      throw new PermissionSettingsError(
        this.filePath,
        "the file must contain a JSON object",
      );
    }
    return content;
  }

  private permissionsOf(file: Record<string, unknown>): PermissionSettings {
    // Only an absent key means "no rules". An explicit null is a mistake,
    // and reading it as empty would start with no deny rules.
    return this.validate("permissions" in file ? file.permissions : {});
  }

  private validate(value: unknown): PermissionSettings {
    const parsed = permissionsSchema.safeParse(value);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      const field = ["permissions", ...(issue?.path ?? [])].join(".");
      throw new PermissionSettingsError(
        this.filePath,
        `${field}: ${issue?.message ?? "invalid value"}`,
      );
    }
    this.checkMeaning(parsed.data);
    return parsed.data;
  }

  /**
   * Policy would reject these too, but without knowing which file and field
   * to point at.
   */
  private checkMeaning(settings: PermissionSettings): void {
    if (settings.preset !== undefined && !getPreset(settings.preset)) {
      throw new PermissionSettingsError(
        this.filePath,
        `permissions.preset: unknown preset "${settings.preset}"`,
      );
    }
    for (const list of ["allow", "ask", "deny"] as const) {
      settings[list].forEach((rule, index) => {
        try {
          parseRule(rule);
        } catch (error) {
          throw new PermissionSettingsError(
            this.filePath,
            `permissions.${list}.${index}: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        }
      });
    }
  }
}
