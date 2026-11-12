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

/** Where rules live is the application's concern; policy only asks for them. */
export interface PermissionStore {
  load(owner: OwnerScope): Promise<PermissionSettings>;
  save(owner: OwnerScope, settings: PermissionSettings): Promise<void>;
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

  async save(owner: OwnerScope, settings: PermissionSettings): Promise<void> {
    this.settings.set(owner, copySettings(settings));
  }
}
