import * as os from "os";
import * as path from "path";
import { z } from "zod";
import {
  getPreset,
  parseRule,
  type OwnerScope,
  type PermissionSettings,
  type PermissionStore,
} from "../policy/index.js";
import { withFileLock } from "./fileLock.js";
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

function getDefaultSettingsPath(): string {
  return path.join(os.homedir(), ".propio", "settings.json");
}

/** A settings file that cannot be used, named with the field at fault. */
export class PermissionSettingsError extends Error {
  constructor(
    readonly filePath: string,
    detail: string,
  ) {
    super(`Invalid permissions in ${filePath}: ${detail}`);
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

  constructor(options: { filePath?: string; owner: OwnerScope }) {
    this.filePath = options.filePath ?? getDefaultSettingsPath();
    this.owner = options.owner;
  }

  async load(owner: OwnerScope): Promise<PermissionSettings> {
    this.assertOwner(owner);
    return this.permissionsOf(await this.readFile());
  }

  async update(
    owner: OwnerScope,
    change: PermissionSettingsChange,
  ): Promise<PermissionSettings> {
    this.assertOwner(owner);
    return await withFileLock(`${this.filePath}.lock`, async () => {
      // Read inside the lock: the latest completed update is what changes.
      const file = await this.readFile();
      const next = this.validate(change(this.permissionsOf(file)));
      writeJsonFileAtomic(this.filePath, "settings", {
        ...file,
        permissions: next,
      });
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
    return this.validate(file.permissions ?? {});
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
