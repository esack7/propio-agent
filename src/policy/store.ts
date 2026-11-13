/** Opaque identity of whoever the rules belong to. A CLI passes a constant. */
export type OwnerScope = string;

/** The persisted form, as written in a settings file. */
export interface PermissionSettings {
  readonly preset?: string;
  readonly allow: readonly string[];
  readonly ask: readonly string[];
  readonly deny: readonly string[];
}

export const EMPTY_PERMISSION_SETTINGS: PermissionSettings = Object.freeze({
  allow: Object.freeze([]),
  ask: Object.freeze([]),
  deny: Object.freeze([]),
});

/**
 * Computes new settings from the owner's current stored settings. It must be
 * pure: a store may call it more than once, for example to retry a write.
 */
export type PermissionSettingsChange = (
  current: PermissionSettings,
) => PermissionSettings;

export interface PermissionUpdateOptions {
  /**
   * Whoever asked for the update may withdraw it. A store must check this
   * at the last moment before it commits, after any wait for a lock, and
   * reject with the signal's reason without storing anything.
   */
  readonly signal?: AbortSignal;
}

/** Where rules live is the application's concern; policy only asks for them. */
export interface PermissionStore {
  /** Resolves to the settings as of the latest update that has completed. */
  load(owner: OwnerScope): Promise<PermissionSettings>;
  /**
   * Apply `change` to the owner's current stored settings and store the
   * result atomically: no other update for the same owner may land between
   * the read and the write, so concurrent edits never drop each other's rules.
   * Resolves to the settings now stored.
   */
  update(
    owner: OwnerScope,
    change: PermissionSettingsChange,
    options?: PermissionUpdateOptions,
  ): Promise<PermissionSettings>;
}

function copySettings(settings: PermissionSettings): PermissionSettings {
  return {
    ...(settings.preset === undefined ? {} : { preset: settings.preset }),
    allow: [...settings.allow],
    ask: [...settings.ask],
    deny: [...settings.deny],
  };
}

/** Keeps each owner's settings apart; nothing outlives the instance. */
export class InMemoryPermissionStore implements PermissionStore {
  private readonly settings = new Map<OwnerScope, PermissionSettings>();

  constructor(initial: Readonly<Record<OwnerScope, PermissionSettings>> = {}) {
    for (const [owner, settings] of Object.entries(initial)) {
      this.settings.set(owner, copySettings(settings));
    }
  }

  async load(owner: OwnerScope): Promise<PermissionSettings> {
    return copySettings(this.settings.get(owner) ?? EMPTY_PERMISSION_SETTINGS);
  }

  async update(
    owner: OwnerScope,
    change: PermissionSettingsChange,
    options: PermissionUpdateOptions = {},
  ): Promise<PermissionSettings> {
    options.signal?.throwIfAborted();
    // Read, change, and write with nothing awaited in between.
    const current = this.settings.get(owner) ?? EMPTY_PERMISSION_SETTINGS;
    const next = copySettings(change(copySettings(current)));
    this.settings.set(owner, next);
    return copySettings(next);
  }
}
