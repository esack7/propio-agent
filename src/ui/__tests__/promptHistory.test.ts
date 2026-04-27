import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { createPromptHistoryStore } from "../promptHistory.js";

function flush(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

async function waitFor(
  predicate: () => boolean,
  timeoutMs = 1000,
): Promise<void> {
  const startedAt = Date.now();

  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error("Timed out waiting for prompt history persistence");
    }

    await flush();
  }
}

describe("createPromptHistoryStore", () => {
  let tempRoot: string;

  beforeEach(() => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "propio-history-test-"));
  });

  afterEach(() => {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  it("returns empty history when the file is missing", () => {
    const store = createPromptHistoryStore({
      filePath: path.join(tempRoot, "missing", "prompt-history.json"),
    });

    expect(store.load()).toEqual([]);
  });

  it("returns empty history for malformed JSON", () => {
    const filePath = path.join(tempRoot, "prompt-history.json");
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, "{ invalid json }", "utf8");

    const store = createPromptHistoryStore({ filePath });

    expect(store.load()).toEqual([]);
  });

  it("loads valid history newest-first", () => {
    const filePath = path.join(tempRoot, "prompt-history.json");
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(
      filePath,
      JSON.stringify({
        version: 1,
        entries: ["newest", "older", "oldest"],
      }),
      "utf8",
    );

    const store = createPromptHistoryStore({ filePath });

    expect(store.load()).toEqual(["newest", "older", "oldest"]);
  });

  it("preserves submitted text content while trimming eligibility", async () => {
    const filePath = path.join(tempRoot, "prompt-history.json");
    const store = createPromptHistoryStore({ filePath });

    store.record("  /context  ");
    await waitFor(() => fs.existsSync(filePath));

    expect(store.load()).toEqual(["  /context  "]);
    expect(JSON.parse(fs.readFileSync(filePath, "utf8"))).toEqual({
      version: 1,
      entries: ["  /context  "],
    });
  });

  it("skips blank input and control commands", () => {
    const filePath = path.join(tempRoot, "prompt-history.json");
    const store = createPromptHistoryStore({ filePath });

    store.record("   ");
    store.record("/clear");
    store.record("/exit");
    store.record("/quit");

    expect(store.load()).toEqual([]);
    expect(fs.existsSync(filePath)).toBe(false);
  });

  it("moves duplicate entries to the newest position", async () => {
    const filePath = path.join(tempRoot, "prompt-history.json");
    const store = createPromptHistoryStore({ filePath });

    store.record("one");
    store.record("two");
    store.record("one");
    await flush();

    expect(store.load()).toEqual(["one", "two"]);
  });

  it("caps history at 200 entries", async () => {
    const filePath = path.join(tempRoot, "prompt-history.json");
    const store = createPromptHistoryStore({ filePath });

    for (let index = 0; index < 201; index += 1) {
      store.record(`prompt-${index}`);
    }
    await flush();

    const history = store.load();

    expect(history).toHaveLength(200);
    expect(history[0]).toBe("prompt-200");
    expect(history[199]).toBe("prompt-1");
  });

  it("creates parent directories when saving", async () => {
    const filePath = path.join(
      tempRoot,
      "nested",
      "dir",
      "prompt-history.json",
    );
    const store = createPromptHistoryStore({ filePath });

    store.record("hello");
    await waitFor(() => fs.existsSync(filePath));

    expect(fs.existsSync(path.dirname(filePath))).toBe(true);
    expect(fs.existsSync(filePath)).toBe(true);
    expect(store.load()).toEqual(["hello"]);
  });
});
