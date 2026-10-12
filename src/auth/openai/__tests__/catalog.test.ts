import { jest } from "@jest/globals";
import { randomUUID } from "node:crypto";
import { discoverModels } from "../catalog.js";

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

it("preserves eligible server order, isolates accounts and generations, and returns independent copies", async () => {
  const request = jest.fn<typeof fetch>().mockImplementation(async () =>
    Response.json({
      models: [
        {
          slug: "second",
          display_name: "Second",
          visibility: "list",
          context_window: 999999,
        },
        { slug: "hidden", display_name: "Hidden", visibility: "hidden" },
        { slug: "first", display_name: "First", visibility: "list" },
      ],
    }),
  );
  globalThis.fetch = request;
  let generation = 1;
  const accountId = randomUUID();
  let tokenReads = 0;
  const auth = {
    getAccessToken: async () => {
      tokenReads++;
      return "token-sentinel";
    },
    status: async () => ({ accountId, generation }),
  };
  const models = await discoverModels(auth);
  expect(models).toEqual([
    { key: "second", name: "Second" },
    { key: "first", name: "First" },
  ]);
  models[0].name = "changed";
  expect((await discoverModels(auth))[0].name).toBe("Second");
  expect(request).toHaveBeenCalledTimes(1);
  expect(tokenReads).toBe(2);
  generation++;
  await discoverModels(auth);
  await discoverModels({
    ...auth,
    status: async () => ({ accountId: randomUUID(), generation }),
  });
  await discoverModels(auth, undefined, true);
  expect(request).toHaveBeenCalledTimes(4);
});

it("fails safely on invalid catalogs and cancellation instead of returning stale selections", async () => {
  const auth = {
    getAccessToken: async () => "secret-sentinel",
    status: async () => ({ accountId: randomUUID(), generation: 1 }),
  };
  globalThis.fetch = (async () =>
    new Response("invalid secret-sentinel", { status: 200 })) as typeof fetch;
  await expect(discoverModels(auth)).rejects.toThrow(
    "Invalid ChatGPT model catalog",
  );
  globalThis.fetch = (async () =>
    new Response("secret-sentinel", { status: 403 })) as typeof fetch;
  await expect(discoverModels(auth)).rejects.toThrow("HTTP 403");
  const aborted = AbortSignal.abort();
  await expect(discoverModels(auth, aborted)).rejects.toThrow();
});
