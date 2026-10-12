import { DEFAULT_SUMMARY_POLICY } from "../../../context/types.js";
import {
  mkdtemp,
  writeFile,
  rm,
  readdir,
  mkdir,
  chmod,
  symlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { Agent } from "../../../agent.js";
import { type ProvidersConfig, createProvider } from "@propio-ai/providers";
import { SummaryManager } from "../../../context/summaryManager.js";
import { createSandboxConfigView } from "../sandboxHost.js";
import { startCredentialBroker } from "../broker.js";
import { stripProviderContinuation } from "../continuation.js";
import { redactTraceValue } from "../../../trace/redaction.js";
import { createProtectedFileBackend } from "../secrets.js";
import {
  makeTurn,
  makeAssistantEntry,
} from "../../../context/__tests__/testHelpers.js";

let directory: string;
const originalFetch = globalThis.fetch;

it("runs a real client-side MCP function through the ordinary Agent tool loop", async () => {
  const script = join(directory, "mcp-server.mjs");
  await writeFile(
    script,
    `
    import { Server } from ${JSON.stringify(import.meta.resolve("@modelcontextprotocol/sdk/server/index.js"))};
    import { StdioServerTransport } from ${JSON.stringify(import.meta.resolve("@modelcontextprotocol/sdk/server/stdio.js"))};
    import { ListToolsRequestSchema, CallToolRequestSchema } from ${JSON.stringify(import.meta.resolve("@modelcontextprotocol/sdk/types.js"))};
    const server = new Server({name:'subscription-test',version:'1'}, {capabilities:{tools:{}}});
    server.setRequestHandler(ListToolsRequestSchema, async () => ({tools:[{name:'echo',description:'Harmless echo',inputSchema:{type:'object',properties:{},additionalProperties:false}}]}));
    server.setRequestHandler(CallToolRequestSchema, async () => ({content:[{type:'text',text:'MCP-boundary-evidence'}]}));
    await server.connect(new StdioServerTransport());
  `,
  );
  globalThis.fetch = jest
    .fn()
    .mockResolvedValueOnce(
      sse([
        {
          type: "response.output_item.done",
          output_index: 0,
          item: {
            type: "function_call",
            call_id: "mcp-1",
            namespace: "functions",
            name: "mcp__local__echo",
            arguments: "{}",
          },
        },
        { type: "response.completed" },
      ]),
    )
    .mockResolvedValueOnce(completed());
  const agent = new Agent({
    providersConfig: config,
    providerRuntimeOptions: runtime,
    cwd: directory,
    homeDir: directory,
    sessionsDir: join(directory, "sessions"),
    mcpConfig: {
      mcpServers: { local: { command: process.execPath, args: [script] } },
    },
  });
  try {
    await agent.initialize();
    await agent.streamChat({ text: "Run the harmless MCP echo." }, () => {});
    const replay = JSON.parse((fetch as jest.Mock).mock.calls[1][1].body);
    expect(
      replay.input.some((entry: { output?: string }) =>
        entry.output?.includes("MCP-boundary-evidence"),
      ),
    ).toBe(true);
  } finally {
    await agent.close();
  }
}, 15000);
const id = randomUUID();
const config: ProvidersConfig = {
  default: "plan",
  providers: ["plan", "other"].map((name) => ({
    name,
    type: "openai",
    auth: { mode: "chatgpt", accountId: name === "plan" ? id : randomUUID() },
    defaultModel: "test-model",
    models: [
      { key: "test-model", name: "Test model", contextWindowTokens: 128000 },
    ],
  })),
};
const runtime = {
  openAiCredentialSource: (accountId: string) => ({
    getAccessToken: async () => `sentinel-${accountId}`,
  }),
};
function sse(events: unknown[]): Response {
  return new Response(
    events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""),
  );
}
function completed(text = "done") {
  return sse([
    { type: "response.output_text.delta", delta: text },
    { type: "response.completed" },
  ]);
}
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "propio-subscription-workflow-"));
});
afterEach(async () => {
  globalThis.fetch = originalFetch;
  await rm(directory, { recursive: true, force: true });
});

it("runs a real built-in read tool through Agent, replays its result and preserves safe sessions", async () => {
  const path = join(directory, "fixture.txt");
  await writeFile(path, "workspace-read-evidence");
  globalThis.fetch = jest
    .fn()
    .mockResolvedValueOnce(
      sse([
        {
          type: "response.output_item.done",
          output_index: 0,
          item: {
            type: "function_call",
            call_id: "read-1",
            namespace: "functions",
            name: "read",
            arguments: JSON.stringify({ path }),
          },
        },
        { type: "response.completed" },
      ]),
    )
    .mockResolvedValueOnce(completed());
  const agent = new Agent({
    providersConfig: config,
    providerRuntimeOptions: runtime,
    cwd: directory,
    homeDir: directory,
    sessionsDir: join(directory, "sessions"),
    mcpConfig: { mcpServers: {} },
  });
  try {
    expect(
      await agent.streamChat({ text: "Read the fixture." }, () => {}),
    ).toBe("done");
    const replay = JSON.parse((fetch as jest.Mock).mock.calls[1][1].body);
    expect(
      replay.input.some((entry: { output?: string }) =>
        entry.output?.includes("workspace-read-evidence"),
      ),
    ).toBe(true);
    const session = agent.exportSession();
    expect(JSON.parse(session).metadata).toMatchObject({
      accessMode: "chatgpt",
      accountId: id,
    });
    expect(session).not.toContain(`sentinel-${id}`);
    agent.switchProvider("other");
    expect(agent.getContext()).toEqual([]);
    expect(() => agent.importSession(session)).toThrow(
      "another ChatGPT registration",
    );
    agent.switchProvider("plan");
    agent.importSession(session);
    expect(agent.getContext().length).toBeGreaterThan(0);
  } finally {
    await agent.close();
  }
});

it("refuses a failed stream before dispatching a pending built-in write", async () => {
  const path = join(directory, "must-not-exist.txt");
  globalThis.fetch = jest.fn().mockResolvedValue(
    sse([
      {
        type: "response.output_item.done",
        output_index: 0,
        item: {
          type: "function_call",
          call_id: "write-1",
          namespace: "functions",
          name: "write",
          arguments: JSON.stringify({ path, content: "unsafe" }),
        },
      },
      {
        type: "response.failed",
        response: {
          error: { code: "subscription_sharing_usage_limit_exceeded" },
        },
      },
    ]),
  );
  const agent = new Agent({
    providersConfig: config,
    providerRuntimeOptions: runtime,
    cwd: directory,
    homeDir: directory,
    sessionsDir: join(directory, "sessions"),
    mcpConfig: { mcpServers: {} },
  });
  try {
    await expect(
      agent.streamChat({ text: "Write a file." }, () => {}),
    ).rejects.toThrow("usage");
    expect(await readdir(directory)).not.toContain("must-not-exist.txt");
  } finally {
    await agent.close();
  }
});

it("summaries require confirmed completion on the same injected account", async () => {
  const provider = createProvider(
    config.providers[0],
    undefined,
    undefined,
    false,
    undefined,
    runtime,
  );
  const turns = [
    makeTurn({
      id: "turn-1",
      userMessage: "question",
      entries: [makeAssistantEntry("answer")],
    }),
  ];
  globalThis.fetch = jest
    .fn()
    .mockResolvedValueOnce(completed("verified summary"))
    .mockResolvedValueOnce(
      sse([{ type: "response.output_text.delta", delta: "partial summary" }]),
    );
  const summary = await new SummaryManager().generateSummary(
    provider,
    "test-model",
    turns,
    undefined,
    DEFAULT_SUMMARY_POLICY,
  );
  expect(summary.summary.content).toContain("verified summary");
  expect((fetch as jest.Mock).mock.calls[0][1].headers.Authorization).toBe(
    `Bearer sentinel-${id}`,
  );
  await expect(
    new SummaryManager().generateSummary(
      provider,
      "test-model",
      turns,
      undefined,
      DEFAULT_SUMMARY_POLICY,
    ),
  ).rejects.toThrow("response.completed");
});

it("strips opaque continuation on explicit account transfer and redacts auth URLs and hints", () => {
  const value = {
    content: "readable",
    reasoningContent: "encrypted",
    toolCalls: [{ thoughtSignature: "opaque" }],
  };
  expect(stripProviderContinuation(value)).toEqual({
    content: "readable",
    toolCalls: [{}],
  });
  expect(value.reasoningContent).toBe("encrypted");
  const redacted = JSON.stringify(
    redactTraceValue({
      idTokenHint: "sentinel",
      message:
        "https://auth.openai.com/api/accounts/authorize?id_token_hint=sentinel",
    }),
  );
  expect(redacted).not.toContain("sentinel");
});

it("uses a scoped lifetime broker returning only access tokens and sanitized failures", async () => {
  let count = 0;
  const broker = await startCredentialBroker({
    accountId: id,
    label: "personal",
    getAccessToken: async () => {
      count++;
      if (count > 2) throw new Error("secret-error");
      return `access-${count}`;
    },
  });
  const url = `http://127.0.0.1:${broker.descriptor.port}`;
  const headers = { Authorization: `Bearer ${broker.descriptor.capability}` };
  try {
    expect((await fetch(`${url}/token`)).status).toBe(401);
    expect((await fetch(`${url}/accounts`, { headers })).status).toBe(400);
    expect(await (await fetch(`${url}/token`, { headers })).json()).toEqual({
      accessToken: "access-1",
    });
    expect(await (await fetch(`${url}/token`, { headers })).json()).toEqual({
      accessToken: "access-2",
    });
    expect(
      await (await fetch(`${url}/token`, { headers })).text(),
    ).not.toContain("secret-error");
  } finally {
    await broker.close();
  }
  await expect(fetch(`${url}/token`, { headers })).rejects.toThrow();
});

it("excludes production and POC credentials from the sandbox configuration view", async () => {
  for (const part of ["auth/openai", "poc/openai-subscription"]) {
    await mkdir(join(directory, part), { recursive: true });
    await writeFile(join(directory, part, "token.json"), "secret-sentinel");
  }
  await writeFile(join(directory, "providers.json"), "api-config");
  await symlink(
    join(directory, "auth", "openai"),
    join(directory, "secret-alias"),
  );
  const view = await createSandboxConfigView(directory);
  try {
    expect(await readdir(view)).not.toContain("poc");
    expect(await readdir(view)).not.toContain("secret-alias");
    expect(await readdir(join(view, "auth"))).not.toContain("openai");
  } finally {
    await rm(view, { recursive: true, force: true });
  }
});

it("rejects unsafe permissions and symlink secret destinations", async () => {
  const backend = createProtectedFileBackend(join(directory, "secrets"));
  await backend.write(id, "safe-value");
  const path = join(directory, "secrets", `${id}.json`);
  await chmod(path, 0o644);
  await expect(backend.read(id)).rejects.toThrow("Unsafe");
  await rm(path);
  await symlink(join(directory, "foreign"), path);
  await expect(backend.write(id, "new-value")).rejects.toThrow("Unsafe");
});

it("pins a pending background summary to the original account and discards it after a switch", async () => {
  const agent = new Agent({
    providersConfig: config,
    providerRuntimeOptions: runtime,
    cwd: directory,
    homeDir: directory,
    sessionsDir: join(directory, "sessions"),
    mcpConfig: { mcpServers: {} },
  });
  const internals = agent as unknown as {
    runSummaryRefresh(reason: "synchronous_shrink"): Promise<void>;
    summaryPolicy: typeof DEFAULT_SUMMARY_POLICY;
  };
  internals.summaryPolicy = {
    ...DEFAULT_SUMMARY_POLICY,
    rawRecentTurns: 0,
    refreshIntervalTurns: 999,
    contextPressureThreshold: 2,
  };
  globalThis.fetch = jest
    .fn()
    .mockImplementation(async () => completed("answer"));
  try {
    await agent.streamChat({ text: "First question" }, () => {});
    await agent.streamChat({ text: "Second question" }, () => {});
    let complete!: (response: Response) => void;
    let started!: () => void;
    const start = new Promise<void>((resolve) => {
      started = resolve;
    });
    globalThis.fetch = jest.fn().mockImplementation(async () => {
      started();
      return new Promise<Response>((resolve) => {
        complete = resolve;
      });
    });
    const summary = internals.runSummaryRefresh("synchronous_shrink");
    await start;
    agent.switchProvider("other");
    complete(completed("old account summary"));
    await summary;
    expect((fetch as jest.Mock).mock.calls[0][1].headers.Authorization).toBe(
      `Bearer sentinel-${id}`,
    );
    expect(agent.getConversationState().rollingSummary).toBeUndefined();
  } finally {
    await agent.close();
  }
});

it("cancels only the selected account's local requests when signing out", async () => {
  let started!: () => void;
  const ready = new Promise<void>((resolve) => {
    started = resolve;
  });
  let cancelled = false;
  let requestSignal: AbortSignal | undefined;
  globalThis.fetch = jest.fn().mockImplementation(async (_url, init) => {
    requestSignal = init.signal;
    started();
    return new Response(
      new ReadableStream({
        cancel() {
          cancelled = true;
        },
      }),
    );
  });
  const agent = new Agent({
    providersConfig: config,
    providerRuntimeOptions: runtime,
    cwd: directory,
    homeDir: directory,
    sessionsDir: join(directory, "sessions"),
    mcpConfig: { mcpServers: {} },
  });
  try {
    const turn = agent.streamChat({ text: "Wait for a response" }, () => {});
    const outcome = turn.catch(() => "cancelled");
    await ready;
    agent.cancelSubscriptionRequests(randomUUID());
    expect(requestSignal?.aborted).toBe(false);
    // Let the response reader attach before cancellation.
    await new Promise((resolve) => setTimeout(resolve, 10));
    agent.cancelSubscriptionRequests(id);
    await outcome;
    expect(requestSignal?.aborted).toBe(true);
    expect(cancelled).toBe(true);
  } finally {
    await agent.close();
  }
});
