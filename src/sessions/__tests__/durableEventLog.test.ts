import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DurableEventLog } from "../durableEventLog.js";
import { createProtocolEvent } from "../../agent-core/protocol.js";

let directory: string;
beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), "durable-events-"));
});
afterEach(() => {
  fs.rmSync(directory, { recursive: true, force: true });
});
const event = (seq: number) =>
  createProtocolEvent(seq, { type: "assistant_text", delta: `text-${seq}` });

it("reopens a durable cursor and recovers only the complete prefix of a torn append", () => {
  const filename = path.join(directory, "events.jsonl");
  const first = new DurableEventLog(filename);
  first.append(event(12));
  first.append(event(13));
  fs.appendFileSync(filename, '{"seq":14');
  const next = new DurableEventLog(filename);
  expect(next.lastSequence).toBe(13);
  expect(next.coverageWarning).toMatch(/interrupted/);
  expect(next.after(12)).toEqual([event(13)]);
  next.append(event(14));
  expect(new DurableEventLog(filename).after(13)).toEqual([event(14)]);
});

it("rejects interior corruption without modifying recoverable bytes", () => {
  const filename = path.join(directory, "events.jsonl");
  const content = `${JSON.stringify(event(1))}\ninvalid\n${JSON.stringify(event(3))}\n`;
  fs.writeFileSync(filename, content);
  expect(() => new DurableEventLog(filename)).toThrow(/line 2/);
  expect(fs.readFileSync(filename, "utf8")).toBe(content);
});

it("does no historical reads as the initialized log grows", () => {
  const filename = path.join(directory, "events.jsonl");
  const log = new DurableEventLog(filename);
  for (let seq = 1; seq <= 1000; seq++) log.append(event(seq));
  const historicalBytes = fs.statSync(filename).size;
  // Same-size corruption is invisible only if initialized history is never reread.
  fs.writeFileSync(filename, "x".repeat(historicalBytes));
  let newBytes = 0;
  for (let seq = 1001; seq <= 2000; seq++) {
    const record = event(seq);
    log.append(record);
    newBytes += Buffer.byteLength(`${JSON.stringify(record)}\n`);
    expect(log.lastSequence).toBe(seq);
  }
  expect(fs.statSync(filename).size - historicalBytes).toBe(newBytes);
});

it("a fresh process reads strictly after the cursor and continues the durable sequence", () => {
  const filename = path.join(directory, "events.jsonl");
  const log = new DurableEventLog(filename);
  log.append(event(21));
  log.append(
    createProtocolEvent(22, {
      type: "turn_failed",
      error: new TypeError("fixture failure"),
    }),
  );
  const output = execFileSync(
    process.execPath,
    [
      "--import",
      "tsx",
      fileURLToPath(new URL("./fixtures/eventLogChild.mjs", import.meta.url)),
      filename,
      "21",
      JSON.stringify(event(23)),
    ],
    { encoding: "utf8" },
  );
  const result = JSON.parse(output);
  expect(result.records).toEqual(
    log.after(21).filter((record) => record.seq === 22),
  );
  expect(result.records[0].event.error).toMatchObject({
    name: "TypeError",
    message: "fixture failure",
  });
  expect(result.lastSequence).toBe(23);
  expect(new DurableEventLog(filename).after(22)).toEqual([event(23)]);
});

it("preserves JSON prompt summaries and normalization losses across reopen", () => {
  const filename = path.join(directory, "summary-events.jsonl");
  const log = new DurableEventLog(filename);
  const summary = createProtocolEvent(1, {
    type: "prompt_plan_built",
    snapshot: {
      provider: "fixture",
      model: "fixture",
      iteration: 1,
      contextWindowTokens: 1000,
      availableInputBudget: 900,
      plan: {
        messages: [{ content: "private prompt" }],
        estimatedPromptTokens: 42,
        includedTurnIds: ["one"],
        omittedTurnIds: ["two"],
        retryLevel: 0,
        usedRollingSummary: false,
      },
    },
  });
  const lossy = createProtocolEvent(2, { type: "fixture", value: 5n });
  log.append(summary);
  log.append(lossy);
  const records = new DurableEventLog(filename).after(0);
  expect(records).toEqual(JSON.parse(JSON.stringify([summary, lossy])));
  expect(records[0].event).toMatchObject({
    type: "prompt_plan_built",
    snapshot: { estimatedPromptTokens: 42, includedTurns: 1, omittedTurns: 1 },
  });
  expect(JSON.stringify(records[0])).not.toContain("private prompt");
  expect(records[1]).toMatchObject({ replacedValues: 1 });
});
