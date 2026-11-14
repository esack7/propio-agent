import { afterEach, beforeEach, describe, expect, it } from "@jest/globals";
import {
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  utimes,
  writeFile,
} from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createExecutableTool,
  createLocalTools,
  executeNodeShell,
  type ExecutableTool,
  type ToolDisplay,
  type ToolExecutionResult,
} from "../index.js";
import {
  DISPLAY_LIMITS,
  displayResultLabel,
  displayUseLabel,
  genericDisplay,
  outputTail,
  utf8Length,
} from "../display.js";
import type { PresentedTool } from "../interface.js";
import { diffLines } from "../lineDiff.js";
import { createLocalToolDefinitions } from "../localTools.js";
import { ToolRegistry } from "../registry.js";
import { SkillTool } from "../skill.js";

let workspace: string;
let registry: ToolRegistry;
beforeEach(async () => {
  workspace = await mkdtemp(join(tmpdir(), "propio-tool-display-"));
  registry = new ToolRegistry();
  for (const { tool } of createLocalToolDefinitions({
    workspaceRoot: workspace,
    shellExecutor: executeNodeShell,
  })) {
    registry.register(tool, true);
  }
});
afterEach(async () => {
  await rm(workspace, { recursive: true, force: true });
});

const file = (name: string) => join(workspace, name);

function expectPlainJson(display: ToolDisplay): void {
  expect(JSON.parse(JSON.stringify(display))).toEqual(display);
}

/** Describe, run, and describe again, as the runtime does. */
async function describedRun(name: string, args: Record<string, unknown>) {
  const before = await registry.describeCall(name, args);
  const result = await registry.executeWithStatus(name, args);
  const after = registry.describeResult(name, args, result, before);
  expectPlainJson(before);
  expectPlainJson(after);
  return { before, result, after };
}

describe("what each built-in tool describes", () => {
  it("edit: the hunks before the call, and the same hunks after it", async () => {
    await writeFile(file("a.txt"), "one\ntwo\nthree\n");
    const args = { path: "a.txt", old_string: "two", new_string: "2\n2.5" };

    const { before, result, after } = await describedRun("edit", args);

    expect(result.status).toBe("success");
    expect(before.title).toBe("Editing a.txt");
    expect(before.body).toMatchObject({
      kind: "diff",
      path: "a.txt",
      operation: "replace",
      added: 2,
      removed: 1,
      truncated: false,
    });
    expect(before.body.kind === "diff" && before.body.hunks).toEqual(
      diffLines("one\ntwo\nthree\n", "one\n2\n2.5\nthree\n").hunks,
    );
    expect(after).toEqual(before);
    expect(after.error).toBeUndefined();
    // The preview is the diff of the file before and after the real edit.
    expect(await readFile(file("a.txt"), "utf8")).toBe("one\n2\n2.5\nthree\n");
    expect(displayUseLabel(after)).toBe("a.txt");
    expect(displayResultLabel(after)).toBe("Changed (+2 -1)");
  });

  it("edit with replace_all: every replacement is in the preview", async () => {
    await writeFile(file("a.txt"), "x\ny\nx\n");
    const { before, after } = await describedRun("edit", {
      path: "a.txt",
      old_string: "x",
      new_string: "z",
      replace_all: true,
    });
    expect(before.body).toMatchObject({ added: 2, removed: 2 });
    expect(after).toEqual(before);
  });

  it("edit that cannot be made: says why before, and fails after", async () => {
    await writeFile(file("a.txt"), "one\n");
    const { before, result, after } = await describedRun("edit", {
      path: "a.txt",
      old_string: "absent",
      new_string: "x",
    });
    expect(before.body).toMatchObject({
      kind: "diff",
      hunks: [],
      unavailable: "String not found in file: absent",
    });
    expect(result.status).toBe("error");
    expect(after.error).toContain("String not found");
    expect(displayResultLabel(after)).toContain("String not found");
  });

  it("write: a new file is all additions; an existing one is a diff", async () => {
    const created = await describedRun("write", {
      path: "new.txt",
      content: "a\nb\n",
    });
    expect(created.before.title).toBe("Writing new.txt");
    expect(created.before.body).toMatchObject({
      kind: "diff",
      operation: "create",
      added: 2,
      removed: 0,
    });
    expect(created.before.body).not.toHaveProperty("baseHash");
    expect(created.after).toEqual(created.before);
    expect(displayResultLabel(created.after)).toBe("Created (+2 -0)");

    const replaced = await describedRun("write", {
      path: "new.txt",
      content: "a\nc\n",
    });
    expect(replaced.before.body).toMatchObject({
      operation: "replace",
      added: 1,
      removed: 1,
    });
    expect(replaced.after).toEqual(replaced.before);
  });

  it("bash: the command before; exit status, lines, and tails after", async () => {
    const ok = await describedRun("bash", {
      command: "printf 'a\\nb\\n'; echo warn >&2",
    });
    expect(ok.before).toEqual({
      title: "Running printf 'a\\nb\\n'; echo warn >&2",
      body: {
        kind: "command",
        command: "printf 'a\\nb\\n'; echo warn >&2",
        truncated: false,
      },
    });
    expect(ok.after.body).toMatchObject({
      kind: "command",
      exitCode: 0,
      classification: "succeeded",
      stdoutTail: "a\nb",
      stderrTail: "warn",
      stdoutLines: 2,
      stderrLines: 1,
      truncated: false,
    });
    expect(displayUseLabel(ok.after)).toBe("printf 'a\\nb\\n'; echo warn >&2");
    expect(displayResultLabel(ok.after)).toBe("Exit 0 (2 lines)");

    const failed = await describedRun("bash", {
      command: "echo broke >&2; exit 3",
      cwd: workspace,
    });
    expect(failed.after.body).toMatchObject({
      exitCode: 3,
      classification: "nonzero_exit",
      cwd: workspace,
    });
    // A command that ran and exited nonzero is a result, not a failed call.
    expect(failed.after.error).toBeUndefined();
    expect(displayResultLabel(failed.after)).toBe("Exit 3: broke");
  });

  it("bash: a cancelled command is a failure with what it had written", async () => {
    const args = { command: "echo started; sleep 30" };
    const before = await registry.describeCall("bash", args);
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 300);
    const result = await registry.executeWithStatus("bash", args, {
      signal: controller.signal,
    });
    const after = registry.describeResult("bash", args, result, before);
    expect(result.status).toBe("error");
    expect(after.error).toBe("Cancelled before it finished");
    expect(after.body).toMatchObject({
      classification: "cancelled",
      stdoutTail: "started",
    });
    expectPlainJson(after);
  });

  it("read: the path and range before, the line count after", async () => {
    await writeFile(file("a.txt"), "1\n2\n3\n4\n");
    const whole = await describedRun("read", { path: "a.txt" });
    expect(whole.before).toEqual({
      title: "Reading a.txt",
      body: { kind: "file_read", path: "a.txt" },
    });
    expect(whole.after.body).toMatchObject({ lines: 5 });
    expect(displayResultLabel(whole.after)).toBe("Read 5 lines");

    const ranged = await describedRun("read", {
      path: "a.txt",
      startLine: 2,
      lineCount: 2,
    });
    expect(ranged.after.body).toEqual({
      kind: "file_read",
      path: "a.txt",
      range: { start: 2, count: 2 },
      lines: 2,
    });

    const missing = await describedRun("read", { path: "nope.txt" });
    expect(missing.after.error).toBe(
      "Error executing read: File not found: nope.txt",
    );
    expect(missing.after.body).not.toHaveProperty("lines");
  });

  it("grep, find, and ls: what was asked, then counts and a sample", async () => {
    await writeFile(file("a.txt"), "foo\nbar\nfoo\n");
    await writeFile(file("b.txt"), "foo\n");

    const grep = await describedRun("grep", {
      path: workspace,
      pattern: "foo",
    });
    expect(grep.before.title).toBe(`Searching ${workspace} for "foo"`);
    expect(grep.after.body).toMatchObject({
      kind: "search",
      mode: "content",
      pattern: "foo",
      scope: workspace,
      matches: 3,
      files: 2,
    });
    expect(
      grep.after.body.kind === "search" && grep.after.body.sample,
    ).toHaveLength(3);
    expect(displayUseLabel(grep.after)).toBe(`"foo" in ${workspace}`);
    expect(displayResultLabel(grep.after)).toBe("Found 3 matches in 2 files");

    const none = await describedRun("grep", {
      path: workspace,
      pattern: "zzz",
    });
    expect(none.after.body).toMatchObject({ matches: 0, files: 0, sample: [] });
    expect(displayResultLabel(none.after)).toBe("No matches");

    const find = await describedRun("find", {
      path: workspace,
      pattern: "*.txt",
    });
    expect(find.after.body).toMatchObject({ mode: "files", matches: 2 });
    expect(displayUseLabel(find.after)).toBe(`*.txt in ${workspace}`);
    expect(displayResultLabel(find.after)).toBe("Found 2 files");

    const ls = await describedRun("ls", { path: workspace });
    expect(ls.before.title).toBe(`Listing ${workspace}`);
    expect(ls.after.body).toMatchObject({ mode: "list", matches: 2 });
    expect(displayUseLabel(ls.after)).toBe(workspace);
    expect(displayResultLabel(ls.after)).toBe("2 items");
  });

  it("skill: a generic description with the skill named in the title", async () => {
    const skill = new SkillTool({ invokeSkill: async () => "" });
    const args = { name: "review", arguments: "now" };
    const before = skill.describeCall(args);
    expect(before).toEqual({
      title: "Invoking skill review",
      body: {
        kind: "generic",
        fields: [
          { key: "name", value: "review" },
          { key: "arguments", value: "now" },
        ],
        truncated: false,
      },
    });
    const after = skill.describeResult(args, {
      status: "success",
      content: await skill.execute(args),
    });
    expect(after.body).toMatchObject({
      resultPreview: "Activated skill review with arguments.",
    });
  });

  it("copes with arguments of the wrong type", async () => {
    for (const name of [
      "read",
      "write",
      "edit",
      "bash",
      "grep",
      "find",
      "ls",
    ]) {
      const before = await registry.describeCall(name, {
        path: 7,
        command: null,
        pattern: {},
      });
      expectPlainJson(before);
      expect(before.title.length).toBeGreaterThan(0);
    }
  });
});

describe("a tool that describes nothing", () => {
  const remote = (invoke: () => Promise<ToolExecutionResult>) =>
    createExecutableTool({
      schema: {
        type: "function",
        function: {
          name: "mcp__demo__lookup",
          description: "Remote",
          parameters: { type: "object", properties: {} },
        },
      },
      invoke,
    });

  it("gets one field per argument, then a preview of its result", async () => {
    registry.register(
      remote(async () => ({ status: "success", content: "found  it\n" })),
      true,
    );
    const args = { id: 7, filter: { open: true }, note: "x" };
    const { before, after } = await describedRun("mcp__demo__lookup", args);
    expect(before).toEqual({
      title: "mcp__demo__lookup",
      body: {
        kind: "generic",
        fields: [
          { key: "id", value: "7" },
          { key: "filter", value: '{"open":true}' },
          { key: "note", value: "x" },
        ],
        truncated: false,
      },
    });
    expect(after.body).toMatchObject({ resultPreview: "found  it\n" });
    expect(displayUseLabel(after)).toBeNull();
    expect(displayResultLabel(after)).toBe("found it");
  });

  it("reports a failure as the error, not as a result", async () => {
    registry.register(
      remote(async () => ({ status: "error", content: "remote said no" })),
      true,
    );
    const { after } = await describedRun("mcp__demo__lookup", {});
    expect(after.error).toBe("remote said no");
    expect(after.body).not.toHaveProperty("resultPreview");
  });

  it("is used when a tool's own description throws", async () => {
    const broken: PresentedTool = {
      ...remote(async () => ({ status: "success", content: "ok" })),
      describeCall: () => {
        throw new Error("no description");
      },
      describeResult: () => {
        throw new Error("no description");
      },
    };
    registry.register(broken, true);
    const { before, result, after } = await describedRun("mcp__demo__lookup", {
      a: 1,
    });
    expect(before.body.kind).toBe("generic");
    expect(result.status).toBe("success");
    expect(after.body).toMatchObject({ kind: "generic", resultPreview: "ok" });
  });
});

describe("payload limits", () => {
  it("cuts a long diff and says so", async () => {
    const lines = (word: string) =>
      Array.from({ length: 600 }, (_, i) => `${word} ${i}`).join("\n");
    await writeFile(file("big.txt"), lines("old"));
    const before = await registry.describeCall("write", {
      path: "big.txt",
      content: lines("new"),
    });
    expect(before.body).toMatchObject({
      kind: "diff",
      truncated: true,
      added: 600,
      removed: 600,
    });
    expect(
      before.body.kind === "diff" &&
        before.body.hunks.flatMap((hunk) => hunk.lines),
    ).toHaveLength(DISPLAY_LIMITS.diffLines);
  });

  it("keeps the end of long output, within lines and bytes", () => {
    const many = Array.from({ length: 1000 }, (_, i) => `line ${i}`).join("\n");
    const byLines = outputTail(`${many}\n`);
    expect(byLines.truncated).toBe(true);
    expect(byLines.lines).toBe(1000);
    expect(byLines.tail.split("\n")).toHaveLength(DISPLAY_LIMITS.tailLines);
    expect(byLines.tail.endsWith("line 999")).toBe(true);

    const wide = outputTail("x".repeat(DISPLAY_LIMITS.tailBytes * 3));
    expect(wide.truncated).toBe(true);
    expect(wide.tail).toHaveLength(DISPLAY_LIMITS.tailBytes);

    expect(outputTail("a\n\nb\n")).toEqual({
      tail: "a\n\nb",
      lines: 2,
      truncated: false,
    });
  });

  it("cuts a diff with a very long line to the byte budget", async () => {
    const before = await registry.describeCall("write", {
      path: "one-line.json",
      content: `{"value":"${"v".repeat(2 * 1024 * 1024)}"}`,
    });
    expect(before.body).toMatchObject({ kind: "diff", truncated: true });
    expect(utf8Length(JSON.stringify(before))).toBeLessThan(
      DISPLAY_LIMITS.diffBytes + 1024,
    );
  });

  it("shows a write that only removes the final line break", async () => {
    await writeFile(file("a.txt"), "one\ntwo\n");
    const { before, after } = await describedRun("write", {
      path: "a.txt",
      content: "one\ntwo",
    });
    expect(before.body).toMatchObject({ added: 1, removed: 1 });
    expect(after).toEqual(before);
    expect(displayResultLabel(after)).toBe("Changed (+1 -1)");
  });

  it("counts the output tail in UTF-8 bytes and never splits a character", () => {
    const emoji = outputTail("😀".repeat(7000));
    expect(emoji.truncated).toBe(true);
    expect(utf8Length(emoji.tail)).toBeLessThanOrEqual(
      DISPLAY_LIMITS.tailBytes,
    );
    expect(emoji.tail).toBe("😀".repeat(DISPLAY_LIMITS.tailBytes / 4));

    const lines = outputTail(Array(3000).fill("€€€€€€€€").join("\n"));
    expect(lines.truncated).toBe(true);
    expect(utf8Length(lines.tail)).toBeLessThanOrEqual(
      DISPLAY_LIMITS.tailBytes,
    );
  });

  it("trims trailing line breaks in linear time", () => {
    const started = Date.now();
    const tail = outputTail(`${"\n".repeat(50_000)}last line`);
    expect(Date.now() - started).toBeLessThan(500);
    expect(tail.tail.endsWith("\nlast line")).toBe(true);
    expect(tail.tail.split("\n")).toHaveLength(DISPLAY_LIMITS.tailLines);
    expect(tail.lines).toBe(1);
    expect(outputTail(`ok${"\n".repeat(50_000)}`).tail).toBe("ok");
  });

  it("cuts long generic values, long results, and many fields", () => {
    const long = "v".repeat(DISPLAY_LIMITS.genericValueChars + 10);
    const cutValue = genericDisplay("t", { a: long });
    expect(cutValue.body).toMatchObject({ truncated: true });
    expect(
      cutValue.body.kind === "generic" && cutValue.body.fields[0].value,
    ).toHaveLength(DISPLAY_LIMITS.genericValueChars);

    const cutResult = genericDisplay("t", {}, { content: long, failed: false });
    expect(cutResult.body).toMatchObject({ truncated: true });

    const manyArgs = Object.fromEntries(
      Array.from({ length: 100 }, (_, i) => [`k${i}`, i]),
    );
    const cutFields = genericDisplay("t", manyArgs);
    expect(cutFields.body).toMatchObject({ truncated: true });
    expect(
      cutFields.body.kind === "generic" && cutFields.body.fields,
    ).toHaveLength(DISPLAY_LIMITS.genericFields);
  });

  it("describes arguments that JSON cannot encode", () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    const display = genericDisplay("t", {
      circular,
      big: 10n,
      missing: undefined,
    });
    expectPlainJson(display);
  });
});

describe("describing a call changes nothing", () => {
  it("leaves the file's content and modification time alone", async () => {
    await writeFile(file("a.txt"), "one\ntwo\n");
    const past = new Date("2020-01-01T00:00:00Z");
    await utimes(file("a.txt"), past, past);

    await registry.describeCall("edit", {
      path: "a.txt",
      old_string: "two",
      new_string: "2",
    });
    await registry.describeCall("write", { path: "a.txt", content: "new" });
    await registry.describeCall("write", {
      path: "made/new.txt",
      content: "x",
    });

    expect(await readFile(file("a.txt"), "utf8")).toBe("one\ntwo\n");
    expect((await stat(file("a.txt"))).mtime).toEqual(past);
    expect(await readdir(workspace)).toEqual(["a.txt"]);
  });

  it("does not read a file the caller says may not be previewed", async () => {
    await writeFile(file("secret.txt"), "token=abc\n");
    const asked: string[] = [];
    for (const [name, args] of [
      ["edit", { path: "secret.txt", old_string: "abc", new_string: "x" }],
      ["write", { path: "secret.txt", content: "token=x\n" }],
    ] as const) {
      const before = await registry.describeCall(name, args, {
        canPreviewRead: (rawPath) => {
          asked.push(rawPath);
          return false;
        },
      });
      expect(before.body).toEqual({
        kind: "diff",
        path: "secret.txt",
        operation: "replace",
        hunks: [],
        added: 0,
        removed: 0,
        truncated: false,
        unavailable: "Not read before approval",
      });
      expect(JSON.stringify(before)).not.toContain("abc");
    }
    expect(asked).toEqual(["secret.txt", "secret.txt"]);
  });

  it("shows no hunks for a binary, oversized, or directory target", async () => {
    await writeFile(file("bin"), Buffer.from([1, 0, 2]));
    await writeFile(file("huge.txt"), "x".repeat(1024 * 1024 + 1));
    for (const path of ["bin", "huge.txt", "."]) {
      const before = await registry.describeCall("write", {
        path,
        content: "x",
      });
      expect(before.body).toMatchObject({ kind: "diff", hunks: [] });
      expect(before.body).toHaveProperty("unavailable");
    }
  });

  it("drops the hunks when the file changed before the call ran", async () => {
    await writeFile(file("a.txt"), "one\ntwo\n");
    const args = { path: "a.txt", old_string: "two", new_string: "2" };
    const before = await registry.describeCall("edit", args);
    await writeFile(file("a.txt"), "zero\none\ntwo\n");
    const result = await registry.executeWithStatus("edit", args);
    const after = registry.describeResult("edit", args, result, before);

    expect(result.status).toBe("success");
    expect(after.body).toEqual({
      kind: "diff",
      path: "a.txt",
      operation: "replace",
      hunks: [],
      added: 0,
      removed: 0,
      truncated: false,
      stale: true,
    });
    expect(displayResultLabel(after)).toBe("Changed");
  });
});

describe("the boundary", () => {
  const directory = join(dirname(fileURLToPath(import.meta.url)), "..");
  const source = (name: string) => readFileSync(join(directory, name), "utf8");
  const IMPORT =
    /(?:\bfrom\s+|\bimport\s*\(\s*|\bimport\s+|\brequire\s*\(\s*)["']([^"']+)["']/g;
  const specifiers = (text: string) =>
    [...text.matchAll(IMPORT)].map((match) => match[1]);

  it.each([
    ["display.ts", /^\.\/types\.js$/],
    ["lineDiff.ts", /^\.\/display\.js$/],
  ])("%s imports only its pure neighbour", (name, allowed) => {
    const text = source(name);
    for (const specifier of specifiers(text)) {
      expect(specifier).toMatch(allowed);
    }
    if (name === "display.ts") {
      expect(text).not.toMatch(/^import\s+(?!type\b)/m);
    }
  });

  it.each(["display.ts", "lineDiff.ts"])(
    "%s touches no process, file, network, or clock, and holds no state",
    (name) => {
      const code = source(name)
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/\/\/.*$/gm, "");
      for (const forbidden of [
        /\bprocess\s*[.[]/,
        /\bglobalThis\b/,
        /\brequire\s*\(/,
        /\bfetch\s*\(/,
        /\bDate\b/,
        /\bMath\.random\b/,
        /\bsetTimeout\b|\bsetInterval\b/,
        /["']node:/,
        /^(?:export\s+)?let\s/m,
        /^(?:export\s+)?const\s+\w+\s*=\s*new\s+(?:Map|Set|WeakMap)\b/m,
      ]) {
        expect(code).not.toMatch(forbidden);
      }
    },
  );

  it("keeps the execution contract free of presentation", () => {
    const execution = source("execution.ts");
    expect(execution).not.toMatch(/display|describe(?:Call|Result)/i);
    expect(specifiers(execution).join()).not.toMatch(/display|interface/);

    // A tool that only executes is a complete ExecutableTool.
    const plain: ExecutableTool = {
      name: "plain",
      description: "",
      getSchema: () => ({
        type: "function",
        function: { name: "plain", description: "", parameters: {} },
      }),
      execute: async () => "",
    };
    // @ts-expect-error describing a call is not part of the contract
    void plain.describeCall;
    // @ts-expect-error nor is describing a result
    void plain.describeResult;
  });

  it("hands the headless factory tools that cannot describe themselves", () => {
    for (const { tool } of createLocalTools({
      workspaceRoot: workspace,
      shellExecutor: executeNodeShell,
    })) {
      expect(tool).not.toHaveProperty("describeCall");
      expect(tool).not.toHaveProperty("describeResult");
    }
  });

  it("imports nothing from the terminal in tools or agent-core", async () => {
    for (const folder of ["tools", "agent-core"]) {
      const root = join(directory, "..", folder);
      for (const name of await readdir(root)) {
        if (!name.endsWith(".ts")) continue;
        for (const specifier of specifiers(
          readFileSync(join(root, name), "utf8"),
        )) {
          expect(`${folder}/${name}: ${specifier}`).not.toMatch(
            /: \.\.\/(?:ui|cli)\//,
          );
        }
      }
    }
  });
});
