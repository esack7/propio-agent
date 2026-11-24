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
  withLock<T>(
    key: McpCredentialKey,
    operation: () => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T>;
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
  /** Grant refresh deadline, independent of connection cancellation; default 30 seconds. */
  readonly refreshTimeoutMs?: number;
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
    signal?: AbortSignal,
  ): Promise<T> {
    const id = this.key(key);
    const pending = (this.locks.get(id) ?? Promise.resolve())
      .catch(() => {})
      .then(() => {
        if (signal?.aborted) throw new McpLoginRequiredError();
        return operation();
      });
    this.locks.set(id, pending);
    try {
      if (!signal) return await pending;
      return await new Promise<T>((resolve, reject) => {
        const abort = () => reject(new McpLoginRequiredError());
        if (signal.aborted) abort();
        else signal.addEventListener("abort", abort, { once: true });
        pending
          .then(resolve, reject)
          .finally(() => signal.removeEventListener("abort", abort));
      });
    } finally {
      if (this.locks.get(id) === pending) this.locks.delete(id);
    }
  }
}
export class McpLoginRequiredError extends Error {
  constructor(
    message = "MCP authorization required; sign in explicitly with /mcp login <server>",
  ) {
    super(message);
  }
}
export class McpAuthorizationError extends McpLoginRequiredError {}

function assertSecureOAuthUrl(url: URL): void {
  const loopback =
    ["localhost", "[::1]"].includes(url.hostname) ||
    /^127\.\d+\.\d+\.\d+$/.test(url.hostname);
  if (
    url.username ||
    url.password ||
    url.hash ||
    !(url.protocol === "https:" || (url.protocol === "http:" && loopback))
  )
    throw new McpLoginRequiredError();
}
const safeFetch: typeof fetch = async (input, init) => {
  assertSecureOAuthUrl(
    new URL(input instanceof Request ? input.url : String(input)),
  );
  return fetch(input, { ...init, redirect: "error" });
};

function insufficientScope(response: Response): boolean {
  return (
    response.status === 403 &&
    extractWWWAuthenticateParams(response).error === "insufficient_scope"
  );
}

/** One adapter per connection. Only the injected store coordinates across managers. */
export class ScopedMcpOAuth {
  readonly key: McpCredentialKey;
  readonly provider: OAuthClientProvider;
  private requiredScope?: string;
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
    challenge: ReturnType<typeof extractWWWAuthenticateParams> = {},
  ): OAuthClientProvider {
    let verifier: string | undefined;
    const state = randomUUID();
    const value: {
      -readonly [K in keyof McpCredentialRecord]: McpCredentialRecord[K];
    } = structuredClone(record);
    // Ephemeral callback ports require a matching registration on every explicit login.
    if (interaction) value.client = undefined;
    const commit = async () => {
      if (interaction && signal?.aborted) throw new McpLoginRequiredError();
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
      clientMetadata: interaction
        ? {
            ...this.options.clientMetadata,
            redirect_uris: [interaction.redirectUrl],
          }
        : this.options.clientMetadata,
      state: () => state,
      clientInformation: () => {
        if (!interaction && !value.client) throw new McpLoginRequiredError();
        return value.client;
      },
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
        // SDK discovery falls back to the resource origin on metadata failure.
        // That is not evidence that an existing issuer binding changed.
        if (wasBound && !discovery.resourceMetadata)
          throw new McpLoginRequiredError();
        if (
          !value.discovery ||
          new URL(value.discovery.authorizationServerUrl).href !==
            new URL(discovery.authorizationServerUrl).href
        ) {
          value.tokens = undefined;
          value.client = undefined;
          value.discovery = discovery;
          if (wasBound && !interaction) await commit();
        }
        value.discovery = discovery;
      },
      invalidateCredentials: async (scope) => {
        // A single-use authorization code must never be retried, and a failed
        // login must not overwrite the previously usable grant.
        if (interaction) throw new McpLoginRequiredError();
        if (scope === "all" || scope === "tokens") value.tokens = undefined;
        if (scope === "all" || scope === "client") value.client = undefined;
        await commit();
      },
      redirectToAuthorization: async (url) => {
        if (!interaction || !signal) throw new McpLoginRequiredError();
        assertSecureOAuthUrl(url);
        const callback = await interaction.authorize(url, signal);
        if (signal.aborted || callback.state !== state || !callback.code)
          throw new McpLoginRequiredError();
        await this.options.store.withLock(
          this.key,
          () =>
            auth(provider, {
              serverUrl: this.key.resource,
              ...challenge,
              authorizationCode: callback.code,
              fetchFn,
            }),
          signal,
        );
      },
    };
    // Commit the complete SDK transaction once; a logout wins against late responses.
    const originalSave = provider.saveTokens;
    provider.saveTokens = async (tokens) => {
      await originalSave(tokens);
      await commit();
    };
    return provider;
  }
  async login(
    interaction: McpOAuthInteraction,
    signal: AbortSignal,
  ): Promise<void> {
    if (signal.aborted) throw new McpLoginRequiredError();
    const response = await safeFetch(this.key.resource, { signal });
    const challenge = extractWWWAuthenticateParams(response);
    await response.body?.cancel();
    const record = await this.options.store.load(this.key);
    if (!challenge.resourceMetadataUrl && record.discovery?.resourceMetadataUrl)
      challenge.resourceMetadataUrl = new URL(
        record.discovery.resourceMetadataUrl,
      );
    const provider = this.makeProvider(
      { ...record, client: undefined, tokens: undefined },
      interaction,
      signal,
      challenge,
    );
    await auth(provider, {
      serverUrl: this.key.resource,
      ...challenge,
      scope: challenge.scope ?? this.requiredScope,
      fetchFn: (input, init) => safeFetch(input, { ...init, signal }),
    });
  }

  private async rejectAuthorization(response: Response): Promise<never> {
    if (insufficientScope(response))
      this.requiredScope = extractWWWAuthenticateParams(response).scope;
    await response.body?.cancel();
    throw new McpLoginRequiredError();
  }
  readonly fetch: typeof fetch = async (input, init) => {
    const response = await safeFetch(input, init);
    const challenge = extractWWWAuthenticateParams(response);
    const upscope = insufficientScope(response);
    if (response.status !== 401 && !upscope) return response;
    if (upscope) return this.rejectAuthorization(response);
    await response.body?.cancel();
    await this.options.store.withLock(this.key, async () => {
      const record = await this.options.store.load(this.key);
      const rejected = new Headers(init?.headers).get("authorization");
      if (record.tokens && rejected !== `Bearer ${record.tokens.access_token}`)
        return;
      if (!record.tokens?.refresh_token) throw new McpLoginRequiredError();
      const refreshSignal = AbortSignal.timeout(
        this.options.refreshTimeoutMs ?? 30_000,
      );
      const provider = this.makeProvider(record, undefined, refreshSignal);
      await auth(provider, {
        serverUrl: this.key.resource,
        ...challenge,
        fetchFn: (input, options) =>
          safeFetch(input, { ...options, signal: refreshSignal }),
      });
    });
    const tokens = await this.provider.tokens();
    if (!tokens) throw new McpLoginRequiredError();
    const headers = new Headers(init?.headers);
    headers.set("authorization", `Bearer ${tokens.access_token}`);
    const retried = await safeFetch(input, { ...init, headers });
    if (retried.status === 401 || insufficientScope(retried)) {
      return this.rejectAuthorization(retried);
    }
    return retried;
  };
}
