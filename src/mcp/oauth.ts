import { randomUUID } from "node:crypto";
import {
  auth,
  extractWWWAuthenticateParams,
  type OAuthClientProvider,
  type OAuthDiscoveryState,
} from "@modelcontextprotocol/sdk/client/auth.js";
import type {
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";

export interface McpCredentialKey {
  readonly owner: string;
  readonly serverName: string;
  readonly resource: string;
}
export interface McpCredentialRecord {
  readonly revision: number;
  readonly discovery?: OAuthDiscoveryState;
  readonly client?: OAuthClientInformationMixed;
  readonly tokens?: OAuthTokens;
}
/** Atomic compare-and-set and grant locks must be shared by all consumers of a store.
 * Clearing increments the revision, including when the record is already empty.
 * Locks serialize authorization, but must never block clear/compareAndSet.
 */
export interface McpCredentialStore {
  load(key: McpCredentialKey): Promise<McpCredentialRecord>;
  compareAndSet(
    key: McpCredentialKey,
    revision: number,
    value: Omit<McpCredentialRecord, "revision">,
  ): Promise<boolean>;
  clear(key: McpCredentialKey): Promise<void>;
  withLock<T>(key: McpCredentialKey, operation: () => Promise<T>): Promise<T>;
}
export interface McpOAuthInteraction {
  readonly redirectUrl: string;
  /** Owns browser/callback cleanup; must honor signal and return the callback state. */
  authorize(
    url: URL,
    signal: AbortSignal,
  ): Promise<{ code: string; state: string }>;
}
export interface McpOAuthOptions {
  readonly owner: string;
  readonly store: McpCredentialStore;
  readonly clientMetadata: OAuthClientMetadata;
}

export class InMemoryMcpCredentialStore implements McpCredentialStore {
  private readonly records = new Map<string, McpCredentialRecord>();
  private readonly locks = new Map<string, Promise<unknown>>();
  private key(key: McpCredentialKey): string {
    return JSON.stringify([key.owner, key.serverName, key.resource]);
  }
  async load(key: McpCredentialKey): Promise<McpCredentialRecord> {
    return structuredClone(this.records.get(this.key(key)) ?? { revision: 0 });
  }
  async compareAndSet(
    key: McpCredentialKey,
    revision: number,
    value: Omit<McpCredentialRecord, "revision">,
  ): Promise<boolean> {
    if ((this.records.get(this.key(key))?.revision ?? 0) !== revision)
      return false;
    this.records.set(
      this.key(key),
      structuredClone({ ...value, revision: revision + 1 }),
    );
    return true;
  }
  async clear(key: McpCredentialKey): Promise<void> {
    const current = this.records.get(this.key(key));
    this.records.set(this.key(key), { revision: (current?.revision ?? 0) + 1 });
  }
  async withLock<T>(
    key: McpCredentialKey,
    operation: () => Promise<T>,
  ): Promise<T> {
    const id = this.key(key);
    const pending = (this.locks.get(id) ?? Promise.resolve())
      .catch(() => {})
      .then(operation);
    this.locks.set(id, pending);
    try {
      return await pending;
    } finally {
      if (this.locks.get(id) === pending) this.locks.delete(id);
    }
  }
}
export class McpLoginRequiredError extends Error {
  constructor() {
    super("MCP authorization required; sign in explicitly");
  }
}
const safeFetch: typeof fetch = (input, init) =>
  fetch(input, { ...init, redirect: "error" });

/** One adapter per connection. Only the injected store coordinates across managers. */
export class ScopedMcpOAuth {
  readonly key: McpCredentialKey;
  readonly provider: OAuthClientProvider;
  constructor(
    private readonly options: McpOAuthOptions,
    serverName: string,
    resource: string,
  ) {
    this.key = { owner: options.owner, serverName, resource };
    this.provider = this.makeProvider({ revision: 0 });
    this.provider.tokens = async () =>
      (await options.store.load(this.key)).tokens;
  }
  private makeProvider(
    record: McpCredentialRecord,
    interaction?: McpOAuthInteraction,
    signal?: AbortSignal,
  ): OAuthClientProvider {
    let verifier: string | undefined;
    const state = randomUUID();
    const value: {
      -readonly [K in keyof McpCredentialRecord]: McpCredentialRecord[K];
    } = structuredClone(record);
    const commit = async () => {
      if (signal?.aborted) throw new McpLoginRequiredError();
      const { revision, ...grant } = value;
      if (!(await this.options.store.compareAndSet(this.key, revision, grant)))
        throw new McpLoginRequiredError();
      value.revision++;
    };
    const fetchFn: typeof fetch = (input, init) =>
      safeFetch(input, { ...init, signal });
    const provider: OAuthClientProvider = {
      redirectUrl:
        interaction?.redirectUrl ??
        this.options.clientMetadata.redirect_uris?.[0] ??
        "http://127.0.0.1/unused",
      clientMetadata: this.options.clientMetadata,
      state: () => state,
      clientInformation: () => value.client,
      saveClientInformation: (client) => {
        value.client = client;
      },
      tokens: () => value.tokens,
      saveTokens: (tokens) => {
        value.tokens = tokens;
      },
      saveCodeVerifier: (code) => {
        verifier = code;
      },
      codeVerifier: () => {
        if (!verifier) throw new McpLoginRequiredError();
        return verifier;
      },
      saveDiscoveryState: async (discovery) => {
        const wasBound = value.discovery !== undefined;
        if (
          value.discovery?.authorizationServerUrl !==
          discovery.authorizationServerUrl
        ) {
          value.tokens = undefined;
          value.client = undefined;
          value.discovery = discovery;
          if (wasBound) await commit();
        }
        value.discovery = discovery;
      },
      invalidateCredentials: async (scope) => {
        if (scope === "all" || scope === "tokens") value.tokens = undefined;
        if (scope === "all" || scope === "client") value.client = undefined;
        await commit();
      },
      redirectToAuthorization: async (url) => {
        if (!interaction || !signal) throw new McpLoginRequiredError();
        const callback = await interaction.authorize(url, signal);
        if (signal.aborted || callback.state !== state || !callback.code)
          throw new McpLoginRequiredError();
        await auth(provider, {
          serverUrl: this.key.resource,
          authorizationCode: callback.code,
          fetchFn,
        });
      },
    };
    // Commit the complete SDK transaction once; a logout wins against late responses.
    const originalSave = provider.saveTokens;
    provider.saveTokens = async (tokens) => {
      if (signal?.aborted) throw new McpLoginRequiredError();
      await originalSave(tokens);
      await commit();
    };
    return provider;
  }
  async login(
    interaction: McpOAuthInteraction,
    signal: AbortSignal,
  ): Promise<void> {
    await this.options.store.withLock(this.key, async () => {
      const record = await this.options.store.load(this.key);
      if (signal.aborted) throw new McpLoginRequiredError();
      const provider = this.makeProvider(record, interaction, signal);
      await auth(provider, {
        serverUrl: this.key.resource,
        fetchFn: (input, init) => safeFetch(input, { ...init, signal }),
      });
    });
  }
  readonly fetch: typeof fetch = async (input, init) => {
    const response = await safeFetch(input, init);
    const challenge = extractWWWAuthenticateParams(response);
    const upscope =
      response.status === 403 && challenge.error === "insufficient_scope";
    if (response.status !== 401 && !upscope) return response;
    await response.body?.cancel();
    await this.options.store.withLock(this.key, async () => {
      const record = await this.options.store.load(this.key);
      const rejected = new Headers(init?.headers).get("authorization");
      if (
        !upscope &&
        record.tokens &&
        rejected !== `Bearer ${record.tokens.access_token}`
      )
        return;
      if (!record.tokens?.refresh_token) throw new McpLoginRequiredError();
      const provider = this.makeProvider(
        record,
        undefined,
        init?.signal ?? undefined,
      );
      await auth(provider, {
        serverUrl: this.key.resource,
        ...challenge,
        fetchFn: (input, options) =>
          safeFetch(input, { ...options, signal: init?.signal }),
      });
    });
    const tokens = await this.provider.tokens();
    if (!tokens) throw new McpLoginRequiredError();
    const headers = new Headers(init?.headers);
    headers.set("authorization", `Bearer ${tokens.access_token}`);
    const retried = await safeFetch(input, { ...init, headers });
    if (
      retried.status === 401 ||
      (retried.status === 403 &&
        extractWWWAuthenticateParams(retried).error === "insufficient_scope")
    ) {
      await retried.body?.cancel();
      throw new McpLoginRequiredError();
    }
    return retried;
  };
}
