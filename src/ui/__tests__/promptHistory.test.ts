import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { createPromptHistoryStore } from "../promptHistory.js";

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

  it("preserves submitted text content while trimming eligibility", () => {
    const filePath = path.join(tempRoot, "prompt-history.json");
    const store = createPromptHistoryStore({ filePath });

    store.record("  /context  ");

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

  it("moves duplicate entries to the newest position", () => {
    const filePath = path.join(tempRoot, "prompt-history.json");
    const store = createPromptHistoryStore({ filePath });

    store.record("one");
    store.record("two");
    store.record("one");

    expect(store.load()).toEqual(["one", "two"]);
  });

  it("caps history at 200 entries", () => {
    const filePath = path.join(tempRoot, "prompt-history.json");
    const store = createPromptHistoryStore({ filePath });

    for (let index = 0; index < 201; index += 1) {
      store.record(`prompt-${index}`);
    }

    const history = store.load();

    expect(history).toHaveLength(200);
    expect(history[0]).toBe("prompt-200");
    expect(history[199]).toBe("prompt-1");
  });

  it("creates parent directories when saving", () => {
    const filePath = path.join(
      tempRoot,
      "nested",
      "dir",
      "prompt-history.json",
    );
    const store = createPromptHistoryStore({ filePath });

    store.record("hello");

    expect(fs.existsSync(path.dirname(filePath))).toBe(true);
    expect(fs.existsSync(filePath)).toBe(true);
    expect(store.load()).toEqual(["hello"]);
  });
});
