import { acquireSessionWriter } from "../../sessionWriter.ts";
import { writeFileSync } from "node:fs";
const [directory, sessionId, marker] = process.argv.slice(2);
try {
  const release = await acquireSessionWriter(directory, sessionId);
  writeFileSync(marker, sessionId);
  process.send?.("acquired");
  process.on("message", async () => {
    await release();
    process.exit(0);
  });
} catch (error) {
  process.send?.({ conflict: error.message });
  process.exitCode = 2;
}
