import { withFileLock } from "../../../config/fileLock.ts";
import { writeSnapshot } from "../../sessionHistory.ts";
import * as path from "node:path";
import { Agent } from "../../../agent.ts";
import { createProtocolEvent } from "../../../agent-core/protocol.ts";
const [directory, sessionId] = process.argv.slice(2);
const agent = new Agent({
  sessionsDir: directory,
  providersConfig: {
    default: "fixture",
    providers: [
      {
        name: "fixture",
        type: "ollama",
        host: "http://127.0.0.1:1",
        models: [
          { name: "fixture", key: "fixture", contextWindowTokens: 32000 },
        ],
        defaultModel: "fixture",
      },
    ],
  },
  mcpConfig: { mcpServers: {} },
});
const snapshot = JSON.parse(agent.exportSession());
snapshot.metadata.sessionId = sessionId;
agent.importSession(JSON.stringify(snapshot));
process.send?.("ready");
process.once("message", async () => {
  try {
    await agent.initialize();
    const log = agent.getSessionEventLog();
    log.append(
      createProtocolEvent((log.lastSequence ?? 0) + 1, {
        type: "assistant_text",
        delta: "writer acquired",
      }),
    );
    process.send?.("acquired");
    process.on("message", async (message) => {
      if (message === "save") {
        await withFileLock(path.join(directory, "index.lock"), async () => {
          writeSnapshot(directory, agent.exportSession());
        });
        process.send?.("saved");
        return;
      }
      await agent.close();
      process.exit(0);
    });
  } catch (error) {
    process.send?.({ conflict: error.message });
    process.exitCode = 2;
    process.disconnect();
  }
});
