import * as fs from "node:fs";
import * as path from "node:path";
import { parseArgs } from "node:util";
import { exportTraceReadResult, verifyTraceExport } from "../trace/index.js";
import {
  discoverTraceRuns,
  readDiscoveredTrace,
  selectTraceRun,
  traceRunObservedAt,
} from "./traceDiscovery.js";
import {
  renderTraceLines,
  summarizeTraceRun,
  traceListLines,
  traceShowLines,
  traceTimeline,
  type TraceRunSummary,
} from "./tracePresentation.js";

const TRACE_HELP = `Usage:
  propio trace list [--session <id>] [--limit <1-1000>] [--json]
  propio trace show <run> [--session <id>] [--json]
  propio trace export <run> --output <new-directory> [--session <id>] [--full] [--json]
  propio trace verify <bundle-directory> [--json]

Offline commands use the current workspace's journals. Run IDs are exact.
Export defaults to standard redacted metadata; --full includes captured private material.
Show and list never read captured material. Missing measurements remain unknown.
`;

type Command = "list" | "show" | "export" | "verify";
interface Arguments {
  command: Command;
  target?: string;
  session?: string;
  output?: string;
  limit: number;
  json: boolean;
  full: boolean;
}
const COMMAND_OPTIONS: Record<Command, readonly string[]> = {
  list: ["json", "session", "limit"],
  show: ["json", "session"],
  export: ["json", "session", "output", "full"],
  verify: ["json"],
};

function parseLimit(value = "20"): number {
  if (!/^[1-9]\d{0,3}$/.test(value) || Number(value) > 1000)
    throw new Error("--limit must be an integer between 1 and 1000");
  return Number(value);
}

function validateTarget(
  command: Command,
  positionals: string[],
  output?: string,
): void {
  const expected = command === "list" ? 0 : 1;
  if (positionals.length !== expected)
    throw new Error(
      `trace ${command} requires ${expected} positional argument(s)`,
    );
  if (command === "export" && !output)
    throw new Error("trace export requires --output <new-directory>");
}

function parseArguments(args: readonly string[]): Arguments {
  const [name, ...rest] = args;
  if (!Object.prototype.hasOwnProperty.call(COMMAND_OPTIONS, name))
    throw new Error("Unknown trace command; use propio trace --help");
  const command = name as Command;
  const { values, positionals, tokens } = parseArgs({
    args: rest,
    allowPositionals: true,
    strict: true,
    tokens: true,
    options: {
      json: { type: "boolean" },
      full: { type: "boolean" },
      session: { type: "string" },
      output: { type: "string" },
      limit: { type: "string" },
    },
  });
  const seen = new Set<string>();
  for (const token of tokens) {
    if (token.kind !== "option") continue;
    if (!COMMAND_OPTIONS[command].includes(token.name))
      throw new Error(`Unknown option for trace ${command}: --${token.name}`);
    if (seen.has(token.name))
      throw new Error(`Repeated option: --${token.name}`);
    seen.add(token.name);
  }
  validateTarget(command, positionals, values.output);
  return {
    command,
    target: positionals[0],
    session: values.session,
    output: values.output,
    limit: parseLimit(values.limit),
    json: values.json ?? false,
    full: values.full ?? false,
  };
}

interface CommandResult {
  data: object;
  lines: string[];
  exit: number;
}
function list(root: string, args: Arguments): CommandResult {
  const { runs, warnings } = discoverTraceRuns(root, args.session);
  const summaries: TraceRunSummary[] = [];
  const candidates = runs.map((run) => {
    try {
      return { run, observedAt: traceRunObservedAt(run) };
    } catch {
      warnings.push(
        `Cannot read journal header: ${run.sessionId}/${run.runId}`,
      );
      return { run, observedAt: null };
    }
  });
  candidates.sort((a, b) => {
    const time =
      (b.observedAt ? Date.parse(b.observedAt) : -Infinity) -
      (a.observedAt ? Date.parse(a.observedAt) : -Infinity);
    const left = `${a.run.sessionId}/${a.run.runId}`,
      right = `${b.run.sessionId}/${b.run.runId}`;
    return (
      (Number.isNaN(time) ? 0 : time) ||
      (left < right ? -1 : left > right ? 1 : 0)
    );
  });
  for (const { run } of candidates.slice(0, args.limit)) {
    try {
      const snapshot = readDiscoveredTrace(run);
      summaries.push(summarizeTraceRun(run.sessionId, run.runId, snapshot));
      warnings.push(
        ...snapshot.warnings.map((w) => `${run.sessionId}/${run.runId}: ${w}`),
      );
    } catch {
      warnings.push(`Cannot read journal: ${run.sessionId}/${run.runId}`);
    }
  }
  const selected = summaries.slice(0, args.limit);
  return {
    data: {
      runs: selected,
      total: runs.length,
      omitted: runs.length - selected.length,
      inspectionScope: "listed_runs",
      complete: warnings.length === 0,
      warnings,
    },
    lines: traceListLines(selected, warnings),
    exit: 0,
  };
}

function execute(root: string, args: Arguments): CommandResult {
  if (args.command === "list") return list(root, args);
  if (args.command === "verify") {
    const findings = verifyTraceExport(path.resolve(args.target!));
    return {
      data: { valid: findings.length === 0, findings },
      lines: findings.length
        ? findings.map((f) => `Invalid: ${f}`)
        : ["Trace export verified."],
      exit: findings.length ? 1 : 0,
    };
  }
  const run = selectTraceRun(root, args.target!, args.session);
  const snapshot = readDiscoveredTrace(run);
  const summary = summarizeTraceRun(run.sessionId, run.runId, snapshot);
  if (args.command === "show") {
    const timeline = traceTimeline(snapshot);
    return {
      data: { run: summary, inspection: snapshot.inspection, timeline },
      lines: traceShowLines(summary, snapshot, timeline),
      exit: 0,
    };
  }
  // Fail before creating a destination when identity or envelope validation omitted records.
  if (snapshot.omittedRecordCount > 0)
    throw new Error("Cannot export a journal containing invalid event records");
  const destination = path.resolve(args.output!);
  fs.mkdirSync(destination, { mode: 0o700 }); // Exclusive reservation: never reuse an existing directory or symlink.
  const manifest = exportTraceReadResult(
    { events: snapshot.events, warnings: snapshot.readWarnings },
    run.journalPath,
    destination,
    {
      captureLevel: args.full ? "full" : "standard",
    },
  );
  return {
    data: { destination, manifest, warnings: snapshot.warnings },
    lines: [
      `Exported ${manifest.captureLevel} trace to ${destination}`,
      ...snapshot.warnings.map((w) => `Warning: ${w}`),
    ],
    exit: 0,
  };
}

/** Application command boundary: no provider/auth configuration or agent construction. */
export function runTraceCommand(
  args: readonly string[],
  options: {
    sessionsDir: string;
    stdout: (text: string) => void;
    stderr: (text: string) => void;
    width?: number;
  },
): number {
  const width = options.width;
  if (
    args.length === 0 ||
    (args.length === 1 && ["--help", "-h", "help"].includes(args[0])) ||
    (Object.prototype.hasOwnProperty.call(COMMAND_OPTIONS, args[0]) &&
      args.slice(1).some((arg) => arg === "--help" || arg === "-h"))
  ) {
    options.stdout(TRACE_HELP);
    return 0;
  }
  try {
    const parsed = parseArguments(args);
    const result = execute(path.join(options.sessionsDir, "traces"), parsed);
    options.stdout(
      parsed.json
        ? `${JSON.stringify({ version: 1, command: parsed.command, ...result.data })}\n`
        : renderTraceLines(result.lines, width),
    );
    return result.exit;
  } catch (error) {
    options.stderr(
      renderTraceLines(
        [
          `Trace error: ${error instanceof Error ? error.message : String(error)}`,
        ],
        width,
      ),
    );
    return 1;
  }
}
