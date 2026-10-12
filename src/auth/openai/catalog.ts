import { z } from "zod";

const catalogSchema = z.object({
  models: z.array(
    z.object({
      slug: z.string().min(1),
      display_name: z.string().min(1),
      visibility: z.string(),
    }),
  ),
});
export interface SubscriptionModel {
  key: string;
  name: string;
}
const cache = new Map<
  string,
  { expires: number; models: SubscriptionModel[] }
>();

/** Scope to registration and grant generation. Catalog is not capacity evidence. */
export async function discoverModels(
  auth: {
    getAccessToken(signal?: AbortSignal): Promise<string>;
    status(): Promise<{ accountId?: string; generation?: number }>;
  },
  signal?: AbortSignal,
  force = false,
): Promise<SubscriptionModel[]> {
  const token = await auth.getAccessToken(signal);
  signal?.throwIfAborted();
  const status = await auth.status();
  if (!status.accountId)
    throw new Error(
      "Select a signed-in ChatGPT registration before model discovery.",
    );
  const key = `${status.accountId}:${status.generation}`;
  const saved = cache.get(key);
  if (!force && saved && saved.expires > Date.now())
    return saved.models.map((model) => ({ ...model }));
  const response = await fetch("https://api.openai.com/v1/models", {
    headers: { Authorization: `Bearer ${token}` },
    signal: signal
      ? AbortSignal.any([signal, AbortSignal.timeout(30000)])
      : AbortSignal.timeout(30000),
  });
  if (!response.ok)
    throw new Error(
      `ChatGPT model discovery failed (HTTP ${response.status}); check the selected account and plan permission. Manage usage: https://chatgpt.com/settings/usage`,
    );
  const parsed = catalogSchema.safeParse(
    await response.json().catch(() => null),
  );
  if (!parsed.success)
    throw new Error("Invalid ChatGPT model catalog; no model was selected.");
  const models = parsed.data.models
    .filter((model) => model.visibility === "list")
    .map((model) => ({ key: model.slug, name: model.display_name }));
  cache.set(key, { expires: Date.now() + 300000, models });
  return models.map((model) => ({ ...model }));
}
