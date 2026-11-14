import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentVisibilityEvent } from "../agent.js";
import type { ApprovalChannel } from "../permissions/approvalChannel.js";
import type { ApprovalRequest } from "../policy/index.js";
import type { ToolDisplay } from "../tools/index.js";
import {
  createTestAgent,
  ToolCallMockProvider,
  userSubmission,
} from "./testHelpers.js";

type ToolEvent = Extract<
  AgentVisibilityEvent,
  { type: "tool_started" | "tool_finished" | "tool_failed" }
>;

describe("display payloads through the agent (a8)", () => {
  let workspace: string;
  let outside: string;
  let cwdSpy: jest.SpiedFunction<typeof process.cwd>;

  beforeEach(() => {
    const root = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), "propio-agent-display-")),
    );
    workspace = path.join(root, "workspace");
    outside = path.join(root, "outside.txt");
    fs.mkdirSync(workspace);
    fs.writeFileSync(path.join(workspace, "notes.txt"), "one\ntwo\nthree\n");
    fs.writeFileSync(outside, "private one\nprivate two\n");
    cwdSpy = jest.spyOn(process, "cwd").mockReturnValue(workspace);
  });

  afterEach(() => {
    cwdSpy.mockRestore();
    fs.rmSync(path.dirname(workspace), { recursive: true, force: true });
  });

  /** Runs one tool call under ask mode, recording what happened in order. */
  async function run(
    toolName: string,
    args: Record<string, unknown>,
    decision: "allow_once" | "deny" = "allow_once",
  ) {
    const order: Array<
      ToolEvent | { type: "approval"; request: ApprovalRequest }
    > = [];
    const approvalChannel: ApprovalChannel = {
      request: async (request) => {
        order.push({ type: "approval", request });
        return { requestId: request.id, decision };
      },
    };
    const agent = createTestAgent(new ToolCallMockProvider(toolName, args), {
      permissions: { approvalChannel },
    });
    await agent.streamChat(userSubmission("Go"), () => {}, {
      onEvent: (event) => {
        if (
          event.type === "tool_started" ||
          event.type === "tool_finished" ||
          event.type === "tool_failed"
        ) {
          order.push(event);
        }
      },
    });
    const toolEvents = order.filter(
      (entry): entry is ToolEvent => entry.type !== "approval",
    );
    return { order, started: toolEvents[0], ended: toolEvents[1] };
  }

  const hunkLines = (display: ToolDisplay) =>
    display.body.kind === "diff"
      ? display.body.hunks.flatMap((hunk) =>
          hunk.lines.map((line) => `${line.op}${line.text}`),
        )
      : undefined;

  it("carries an edit's changed lines before approval and after it runs", async () => {
    const { order, started, ended } = await run("edit", {
      path: "notes.txt",
      old_string: "two",
      new_string: "2",
    });

    // The description exists before anyone is asked.
    expect(order.map((entry) => entry.type)).toEqual([
      "tool_started",
      "approval",
      "tool_finished",
    ]);
    expect(hunkLines(started.display)).toEqual([
      " one",
      "-two",
      "+2",
      " three",
    ]);
    expect(ended.display).toEqual(started.display);
    expect(fs.readFileSync(path.join(workspace, "notes.txt"), "utf8")).toBe(
      "one\n2\nthree\n",
    );

    // What the terminal draws today is read off the same description.
    expect(started).toMatchObject({
      activityLabel: "Editing notes.txt",
      useLabel: "notes.txt",
    });
    expect(ended).toMatchObject({
      type: "tool_finished",
      activityLabel: "Editing notes.txt",
      resultPreview: "Changed (+1 -1)",
      durationMs: expect.any(Number),
    });
    expect(JSON.parse(JSON.stringify(ended))).toEqual(ended);
  });

  it("keeps the description and changes nothing when the call is denied", async () => {
    const { started, ended } = await run(
      "write",
      { path: "notes.txt", content: "replaced\n" },
      "deny",
    );

    expect(hunkLines(started.display)).toEqual([
      "-one",
      "-two",
      "-three",
      "+replaced",
    ]);
    expect(ended).toMatchObject({
      type: "tool_failed",
      display: { title: "Writing notes.txt", error: expect.any(String) },
    });
    expect(hunkLines(ended.display)).toEqual(hunkLines(started.display));
    expect(fs.readFileSync(path.join(workspace, "notes.txt"), "utf8")).toBe(
      "one\ntwo\nthree\n",
    );
  });

  it("does not read a file outside the workspace to preview a change to it", async () => {
    const { started, ended } = await run("edit", {
      path: outside,
      old_string: "private one",
      new_string: "x",
    });

    expect(started.display.body).toMatchObject({
      kind: "diff",
      path: outside,
      hunks: [],
      unavailable: "Not read before approval",
    });
    expect(JSON.stringify(started)).not.toContain("private two");
    // Approved, the edit still runs; there is simply no preview to keep.
    expect(ended.type).toBe("tool_finished");
    expect(ended.display.body).toMatchObject({ kind: "diff", hunks: [] });
    expect(fs.readFileSync(outside, "utf8")).toBe("x\nprivate two\n");
  });

  it("does not record the preview's policy check as the last decision", async () => {
    const agent = createTestAgent(
      new ToolCallMockProvider("edit", {
        path: "notes.txt",
        old_string: "two",
        new_string: "2",
      }),
      { permissions: { preset: "bypass" } },
    );
    await agent.streamChat(userSubmission("Go"), () => {});
    const permissions = (
      agent as unknown as {
        toolPermissions: {
          overview(): Promise<{ lastDecision?: { toolName: string } }>;
        };
      }
    ).toolPermissions;
    // The preview asked whether `read` would be allowed; that is not a
    // decision about a call and must not replace the one that was made.
    expect((await permissions.overview()).lastDecision).toMatchObject({
      toolName: "edit",
    });
  });

  it("describes a command with its exit status and a read with its line count", async () => {
    const bash = await run("bash", { command: "echo hi; exit 2" });
    expect(bash.started).toMatchObject({
      activityLabel: "Running echo hi; exit 2",
      useLabel: "echo hi; exit 2",
      display: { body: { kind: "command", command: "echo hi; exit 2" } },
    });
    expect(bash.ended).toMatchObject({
      type: "tool_finished",
      // The shell runner adds its own line to stderr on a nonzero exit.
      resultPreview: expect.stringMatching(/^Exit 2\b/),
      display: {
        body: { exitCode: 2, classification: "nonzero_exit", stdoutTail: "hi" },
      },
    });

    const read = await run("read", { path: "notes.txt" });
    // A read inside the workspace is not asked about.
    expect(read.order.map((entry) => entry.type)).toEqual([
      "tool_started",
      "tool_finished",
    ]);
    expect(read.ended).toMatchObject({
      resultPreview: "Read 4 lines",
      display: { body: { kind: "file_read", path: "notes.txt", lines: 4 } },
    });
  });
});
