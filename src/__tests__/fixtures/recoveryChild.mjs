import * as fs from "node:fs";
import * as path from "node:path";
import { Agent } from "../../agent.ts";
import { JsonlTraceJournal, RunTraceRecorder } from "../../trace/index.ts";
import {
  readSnapshot,
  resolveLatestRecoveryCheckpoint,
} from "../../sessions/sessionHistory.ts";

const [mode, sessionsDir] = process.argv.slice(2);
const callsPath = path.join(sessionsDir, "tool-calls.txt");
const providerRequestsPath = path.join(sessionsDir, "resumed-requests.json");
const failuresPath = path.join(sessionsDir, "checkpoint-failures.txt");
const config = {
  default: "local",
  providers: [
    {
      name: "local",
      type: "ollama",
      host: "http://localhost:11434",
      defaultModel: "fixture",
      models: [
        { name: "Fixture", key: "fixture", contextWindowTokens: 128000 },
      ],
    },
  ],
};

const agent = new Agent({
  providersConfig: config,
  sessionsDir,
  onRecoveryCheckpointFailure: (error) => {
    fs.appendFileSync(failuresPath, `${error.message}\n`);
  },
  createTraceRun: (identity) => {
    const journal = new JsonlTraceJournal(
      path.join(
        sessionsDir,
        "traces",
        identity.sessionId,
        `${identity.runId}.jsonl`,
      ),
    );
    return {
      recorder: new RunTraceRecorder(identity, journal),
      close: () => journal.close(),
    };
  },
});

const toolCalls = ["first", "second", "third"].map((key, index) => ({
  id: `call-${index + 1}`,
  function: { name: "fixture_tool", arguments: { key } },
}));
agent.provider = {
  name: "fixture",
  getCapabilities: () => ({ contextWindowTokens: 128000 }),
  async *streamChat(request) {
    if (mode === "resume") {
      fs.writeFileSync(providerRequestsPath, JSON.stringify(request.messages));
      yield { delta: "Recovered." };
    } else if (mode === "failure") {
      if (!fs.existsSync(callsPath)) {
        yield { type: "tool_calls", toolCalls: [toolCalls[0]] };
      } else {
        yield { delta: "Completed despite checkpoint failure." };
      }
    } else {
      yield { type: "tool_calls", toolCalls };
    }
  },
};
agent.addTool({
  name: "fixture_tool",
  description: "Deterministic recovery fixture",
  getSchema: () => ({
    type: "function",
    function: {
      name: "fixture_tool",
      description: "Deterministic recovery fixture",
      parameters: { type: "object", properties: {} },
    },
  }),
  execute: async ({ key }) => {
    fs.appendFileSync(callsPath, `${key}\n`);
    if (key === "second") {
      process.stdout.write("SECOND_STARTED\n");
      await new Promise(() => {});
    }
    return `${key} completed`;
  },
});

if (mode === "failure") {
  agent.exportSession = () => {
    throw new Error("checkpoint storage unavailable");
  };
}

if (mode === "resume") {
  const entry = resolveLatestRecoveryCheckpoint(sessionsDir);
  if (!entry?.recoveryCheckpoint)
    throw new Error("Recovery checkpoint missing");
  agent.importSession(readSnapshot(sessionsDir, entry.snapshotFile));
}

await agent.streamChat(
  {
    text: mode === "resume" ? "Continue without replaying tools" : "Run tools",
    displayText:
      mode === "resume" ? "Continue without replaying tools" : "Run tools",
    inputMode: "prompt",
  },
  () => {},
);
process.stdout.write("DONE\n");
