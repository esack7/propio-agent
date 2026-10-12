import { homedir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { SecretBackend } from "./secrets.js";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { createRemoteJWKSet, customFetch, jwtVerify } from "jose";
import { z } from "zod";
import {
  ChatGptCredentialStore,
  type ChatGptAccount,
  type ChatGptStore,
} from "./store.js";
import { startChatGptCallback } from "./callback.js";

const ISSUER = "https://auth.openai.com";
const TOKEN_ENDPOINT = `${ISSUER}/api/accounts/oauth/token`;
const RESOURCE = "https://api.openai.com/v1";
const SCOPES =
  "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct";
const tokensSchema = z.object({
  access_token: z.string().min(1),
  refresh_token: z.string().min(1),
  id_token: z.string().optional(),
  token_type: z.literal("Bearer"),
  expires_in: z.number().positive().max(86400),
  scope: z.string(),
});
const discoverySchema = z.object({
  issuer: z.literal(ISSUER),
  jwks_uri: z.string().url(),
  revocation_endpoint: z.string().url(),
});

class ChatGptAuthError extends Error {
  constructor(
    message: string,
    readonly code?: string,
  ) {
    super(message);
    this.name = "ChatGptAuthError";
  }
}

function authEndpoint(value: string): string {
  const url = new URL(value);
  if (url.origin !== ISSUER || url.username || url.password || url.hash)
    throw new ChatGptAuthError(
      "OpenAI discovery returned an unexpected credential endpoint.",
    );
  return url.href;
}

export class OpenAiAuth {
  private readonly store: ChatGptCredentialStore;
  private readonly request: typeof fetch;

  constructor(options: {
    directory?: string;
    secretDirectory?: string;
    storage?: "os" | "protected-file";
    backend?: SecretBackend;
    accountId?: string;
    profile?: string;
    fetch?: typeof fetch;
  }) {
    this.store = new ChatGptCredentialStore({
      directory:
        options.directory ?? join(homedir(), ".propio", "auth", "openai"),
      secretDirectory:
        options.secretDirectory ??
        join(homedir(), ".local", "share", "propio", "openai-secrets"),
      profile: options.profile,
      storage: options.storage,
      backend: options.backend,
    });
    this.expectedAccountId = options.accountId;
    this.profile = options.profile ?? "default";
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(this.profile))
      throw new Error(
        "Use a short profile label containing letters, numbers, underscores, or hyphens.",
      );
    this.request = options.fetch ?? fetch;
  }
  readonly profile: string;
  private readonly expectedAccountId?: string;

  private selectedAccount(
    state: ChatGptStore | undefined,
  ): ChatGptAccount | undefined {
    if (
      !state ||
      !Object.prototype.hasOwnProperty.call(state.accounts, this.profile)
    )
      return undefined;
    const account = state.accounts[this.profile];
    if (this.expectedAccountId && account.accountId !== this.expectedAccountId)
      throw new ChatGptAuthError(
        "The selected registration changed. Select the account again.",
      );
    return account;
  }

  private planEnabled(account: ChatGptAccount): boolean {
    return (
      account.scopes.includes("chatgpt.tokens.use.direct") &&
      account.scopes.includes("resource.invoke")
    );
  }

  private requireAccount(state: ChatGptStore): ChatGptAccount {
    const account = this.selectedAccount(state);
    if (!account?.accessToken || !account.refreshToken)
      throw new ChatGptAuthError(
        "Run `propio auth login openai --account <label>` first.",
      );
    return account;
  }

  private authorizationUrl(options: {
    saved: ChatGptAccount | undefined;
    hostId: string;
    redirectUri: string;
    state: string;
    nonce: string;
    verifier: string;
    enablePlan?: boolean;
  }): string {
    const url = new URL(`${ISSUER}/api/accounts/authorize`);
    url.search = new URLSearchParams({
      client_id: options.saved?.clientId ?? "dynamic_agent_client",
      ext_agent_host_id: options.hostId,
      response_type: "code",
      redirect_uri: options.redirectUri,
      scope: SCOPES,
      resource: RESOURCE,
      state: options.state,
      nonce: options.nonce,
      code_challenge_method: "S256",
      code_challenge: createHash("sha256")
        .update(options.verifier)
        .digest("base64url"),
    }).toString();
    if (!options.saved) url.searchParams.set("agent_name_hint", "Propio");
    if (options.saved?.idToken)
      url.searchParams.set("id_token_hint", options.saved.idToken);
    if (options.saved?.email)
      url.searchParams.set("login_hint", options.saved.email);
    if (options.enablePlan) url.searchParams.set("prompt", "consent");
    return url.href;
  }

  private async fetchJson(
    url: string,
    options: RequestInit = {},
  ): Promise<unknown> {
    const timeout = AbortSignal.timeout(15000);
    const signal = options.signal
      ? AbortSignal.any([options.signal, timeout])
      : timeout;
    const response = await this.request(url, { ...options, signal });
    const data: unknown = await response.json().catch(() => ({}));
    if (!response.ok) {
      const code = safeAuthCode(data);
      throw new ChatGptAuthError(
        `ChatGPT authentication request failed (HTTP ${response.status}${code ? `, ${code}` : ""}).`,
        code,
      );
    }
    return data;
  }

  private async discovery(signal?: AbortSignal) {
    const parsed = discoverySchema.safeParse(
      await this.fetchJson(`${ISSUER}/.well-known/openid-configuration`, {
        signal,
      }),
    );
    if (!parsed.success)
      throw new ChatGptAuthError("Invalid OpenAI authentication discovery.");
    const data = parsed.data;
    authEndpoint(data.jwks_uri);
    authEndpoint(data.revocation_endpoint);
    return data;
  }

  private async exchange(body: URLSearchParams, signal?: AbortSignal) {
    const data = await this.fetchJson(TOKEN_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
      signal,
    });
    const parsed = tokensSchema.safeParse(data);
    if (!parsed.success)
      throw new ChatGptAuthError("ChatGPT returned an invalid token response.");
    return parsed.data;
  }

  async status() {
    const state = await this.store.read();
    const account = this.selectedAccount(state);
    const identity = account
      ? {
          accountId: account.accountId,
          storage: account.storage,
          generation: account.generation,
          state: account.state,
          expiresAt: account.expiresAt
            ? new Date(account.expiresAt).toISOString()
            : undefined,
        }
      : {};
    const connected = Boolean(
      account && account.state === "connected" && account.accessToken,
    );
    return {
      ...identity,
      profile: this.profile,
      connected,
      planUsageEnabled: Boolean(
        connected && account && this.planEnabled(account),
      ),
      savedProfiles: (await this.store.accounts()).map((entry) => entry.label),
    };
  }

  async login(options: {
    openBrowser: (url: string) => Promise<void>;
    enablePlan?: boolean;
    signal?: AbortSignal;
  }): Promise<void> {
    await this.store.withLock(async () => {
      const state: ChatGptStore = (await this.store.read()) ?? {
        version: 1,
        hostId: `urn:uuid:${randomUUID()}`,
        accounts: {},
      };
      await this.store.write(state); // Persist the host before the first browser flow.
      const saved = this.selectedAccount(state);
      const pendingState = randomBytes(32).toString("base64url");
      const nonce = randomBytes(32).toString("base64url");
      const verifier = randomBytes(32).toString("base64url");
      const callback = await startChatGptCallback({
        state: pendingState,
        clientId: saved?.clientId,
        signal: options.signal,
      });
      try {
        await options.openBrowser(
          this.authorizationUrl({
            saved,
            hostId: state.hostId,
            redirectUri: callback.redirectUri,
            state: pendingState,
            nonce,
            verifier,
            enablePlan: options.enablePlan,
          }),
        );
        const registration = await callback.result;
        if (!saved) {
          state.accounts[this.profile] = this.store.newAccount(
            registration.clientId,
            state.hostId,
          );
          await this.store.write(state); // Reuse registration even if code exchange fails.
        }
        const tokens = await this.exchange(
          new URLSearchParams({
            grant_type: "authorization_code",
            client_id: registration.clientId,
            code: registration.code,
            code_verifier: verifier,
            redirect_uri: callback.redirectUri,
            resource: RESOURCE,
          }),
          options.signal,
        );
        if (!tokens.id_token)
          throw new ChatGptAuthError("ChatGPT did not return an ID token.");
        const payload = await this.verifyIdentity(
          tokens.id_token,
          registration.clientId,
          nonce,
          saved,
          options.signal,
        );
        state.accounts[this.profile] = {
          ...state.accounts[this.profile],
          state: "connected",
          clientId: registration.clientId,
          subject: payload.sub,
          email: typeof payload.email === "string" ? payload.email : undefined,
          idToken: tokens.id_token,
          ...this.tokenFields(tokens),
        };
        await this.store.write(state);
      } finally {
        callback.close();
      }
    }, options.signal);
  }

  private async verifyIdentity(
    idToken: string,
    clientId: string,
    nonce: string | undefined,
    saved: ChatGptAccount | undefined,
    signal?: AbortSignal,
  ) {
    const discovery = await this.discovery(signal);
    const keys = createRemoteJWKSet(new URL(discovery.jwks_uri), {
      [customFetch]: this.request,
    });
    const { payload } = await jwtVerify(idToken, keys, {
      issuer: ISSUER,
      audience: clientId,
      algorithms: ["RS256", "ES256"],
      requiredClaims: ["sub", "exp", "iat"],
    });
    if (
      (nonce !== undefined && payload.nonce !== nonce) ||
      !payload.sub ||
      (saved?.subject && saved.subject !== payload.sub)
    ) {
      throw new ChatGptAuthError(
        "The verified ChatGPT identity does not match the pending sign-in.",
      );
    }
    return payload;
  }

  private tokenFields(tokens: z.infer<typeof tokensSchema>) {
    return {
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token,
      expiresAt: Date.now() + tokens.expires_in * 1000,
      scopes: tokens.scope.split(/\s+/).filter(Boolean),
    };
  }

  async getAccessToken(
    signal?: AbortSignal,
    forceRefresh = false,
  ): Promise<string> {
    return this.store.withLock(async () => {
      const state = await this.store.read();
      if (!state)
        throw new ChatGptAuthError(
          "Run `propio auth login openai --account <label>` first.",
        );
      const selected = this.selectedAccount(state);
      if (
        selected &&
        ["refreshing", "recovery-required", "migration-pending"].includes(
          selected.state,
        )
      )
        throw new ChatGptAuthError(
          "Renewal persistence is uncertain. Sign in again before inference.",
        );
      const account = this.requireAccount(state);
      if (!this.planEnabled(account)) {
        throw new ChatGptAuthError(
          "ChatGPT plan usage is disabled. Run propio auth enable-plan openai --account <label> or choose API access explicitly.",
        );
      }
      if (forceRefresh || (account.expiresAt ?? 0) <= Date.now() + 60000) {
        await this.refreshAccount(state, account, signal);
      }
      if (!this.planEnabled(account)) {
        throw new ChatGptAuthError(
          "ChatGPT plan permission was removed. Run propio auth enable-plan openai --account <label>.",
        );
      }
      return account.accessToken!;
    }, signal);
  }

  private async refreshAccount(
    state: ChatGptStore,
    account: ChatGptAccount,
    signal?: AbortSignal,
  ): Promise<void> {
    await this.store.writeMetadata({ ...account, state: "refreshing" });
    let rotated = false;
    try {
      const tokens = await this.exchange(
        new URLSearchParams({
          grant_type: "refresh_token",
          client_id: account.clientId,
          refresh_token: account.refreshToken!,
          resource: RESOURCE,
        }),
        signal,
      );
      rotated = true;
      if (tokens.id_token)
        await this.verifyIdentity(
          tokens.id_token,
          account.clientId,
          undefined,
          account,
          signal,
        );
      Object.assign(account, this.tokenFields(tokens), {
        state: "connected",
        idToken: tokens.id_token ?? account.idToken,
      });
      await this.store.write(state);
    } catch (error) {
      await this.handleRefreshFailure(state, account, error, rotated);
    }
  }

  private async handleRefreshFailure(
    state: ChatGptStore,
    account: ChatGptAccount,
    error: unknown,
    rotated: boolean,
  ): Promise<never> {
    const terminalCodes = [
      "invalid_grant",
      "invalid_refresh_token",
      "token_expired",
      "refresh_token_expired",
      "refresh_token_invalidated",
      "refresh_token_reused",
    ];
    if (
      error instanceof ChatGptAuthError &&
      error.code &&
      terminalCodes.includes(error.code)
    ) {
      state.accounts[this.profile] = this.withoutTokens(account);
      await this.store.writeMetadata(state.accounts[this.profile]);
      await this.store.write(state);
      throw new ChatGptAuthError(
        "ChatGPT credentials expired or were revoked. Run login again.",
        error.code,
      );
    }
    if (rotated || !(error instanceof ChatGptAuthError && error.code)) {
      await this.store
        .writeMetadata({ ...account, state: "recovery-required" })
        .catch(() => {});
      throw new ChatGptAuthError(
        "Rotated credentials could not be durably saved. Sign in again; no inference was submitted.",
      );
    }
    await this.store.writeMetadata(account);
    throw error;
  }

  private withoutTokens(account: ChatGptAccount): ChatGptAccount {
    const {
      accessToken: _a,
      refreshToken: _r,
      idToken: _i,
      expiresAt: _e,
      ...metadata
    } = account;
    return { ...metadata, state: "signed-out", scopes: [] };
  }

  async accounts() {
    return (await this.store.accounts()).map(
      ({ accountId, label, state, storage }) => ({
        accountId,
        label,
        state,
        storage,
      }),
    );
  }

  async logout(
    signal?: AbortSignal,
  ): Promise<{ remoteRevocationConfirmed: boolean }> {
    return this.store.withLock(async () => {
      const state = await this.store.read();
      const account = this.selectedAccount(state);
      if (!state || !account) return { remoteRevocationConfirmed: true };
      await this.store.writeMetadata(this.withoutTokens(account));
      let remoteRevocationConfirmed = !account.refreshToken;
      if (account.refreshToken) {
        try {
          const { revocation_endpoint } = await this.discovery(signal);
          remoteRevocationConfirmed = await this.revoke(
            revocation_endpoint,
            account,
            signal,
          );
        } catch {
          /* Still clear local tokens and report unconfirmed revocation. */
        }
      }
      state.accounts[this.profile] = this.withoutTokens(account);
      await this.store.write(state);
      return { remoteRevocationConfirmed };
    }, signal);
  }

  private async revoke(
    endpoint: string,
    account: ChatGptAccount,
    signal?: AbortSignal,
  ): Promise<boolean> {
    const bounded = AbortSignal.any([
      AbortSignal.timeout(15000),
      ...(signal ? [signal] : []),
    ]);
    for (let attempt = 0; attempt < 3; attempt++) {
      bounded.throwIfAborted();
      try {
        const response = await this.request(endpoint, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            token: account.refreshToken!,
            token_type_hint: "refresh_token",
            client_id: account.clientId,
          }),
          signal: bounded,
        });
        await response.body?.cancel();
        if (response.status === 200) return true;
        if (response.status !== 429 && response.status < 500) return false;
      } catch {
        bounded.throwIfAborted();
      }
      if (attempt < 2)
        await delay(100 * (attempt + 1), undefined, { signal: bounded });
    }
    return false;
  }
}

function safeAuthCode(value: unknown): string | undefined {
  if (!value || typeof value !== "object" || !("error" in value))
    return undefined;
  return typeof value.error === "string" && /^[a-z_]{1,80}$/.test(value.error)
    ? value.error
    : undefined;
}
