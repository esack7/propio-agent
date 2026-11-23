import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createCodingTrial, gradeCodingTrial } from "./coding.mjs";
import { startScriptedProvider } from "./scripted.mjs";

const cli = fileURLToPath(new URL("../../dist/index.js", import.meta.url));

function execute(workspace, home, prompt, timeoutMs, cliPath) {
  return new Promise((resolve) => {
    let outputBytes = 0;
    let timedOut = false;
    let settled = false;
    const child = spawn(
      process.execPath,
      [
        cliPath,
        "--json",
        "--permissions",
        "accept-edits",
        "--max-retries",
        "0",
      ],
      {
        cwd: workspace,
        env: {
          HOME: home,
          USERPROFILE: home,
          PATH: dirname(process.execPath),
          TMPDIR: home,
          NO_COLOR: "1",
        },
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    for (const stream of [child.stdout, child.stderr]) {
      stream.on("data", (chunk) => {
        outputBytes += chunk.length;
        if (outputBytes > 1024 * 1024) child.kill("SIGKILL");
      });
    }
    child.on("error", (error) =>
      finish({ error: `launch failed: ${error.message}` }),
    );
    child.on("close", (code, signal) =>
      finish({
        code,
        signal,
        ...(timedOut
          ? { error: "CLI timed out" }
          : code !== 0
            ? { error: `CLI exited ${code} (${signal ?? "no signal"})` }
            : {}),
      }),
    );
    child.stdin.on("error", () => {});
    child.stdin.end(prompt);
  });
}

async function configure(home, configuration) {
  await mkdir(join(home, ".propio"));
  await writeFile(
    join(home, ".propio/providers.json"),
    JSON.stringify(configuration),
  );
}

async function runTrial(task, index, options) {
  const row = {
    task,
    trial: index + 1,
    configuration: options.providerConfig ? "explicit-provider" : "scripted",
    outcome: "error",
  };
  let root;
  let provider;
  try {
    root = await mkdtemp(join(options.parent ?? tmpdir(), "propio-eval-"));
    const home = join(root, "home");
    await mkdir(home);
    const trial = await createCodingTrial(root, task);
    if (!options.providerConfig)
      provider = await startScriptedProvider(task, options.scriptedMode);
    const configuration = options.providerConfig ?? {
      default: "scripted",
      providers: [
        {
          name: "scripted",
          type: "ollama",
          host: provider.host,
          models: [
            {
              name: "Scripted harness",
              key: "scripted",
              contextWindowTokens: 32768,
            },
          ],
          defaultModel: "scripted",
        },
      ],
    };
    await configure(home, configuration);
    await options.beforeRun?.({ ...trial, home, root, index });
    const result = await execute(
      trial.workspace,
      home,
      trial.prompt,
      options.timeoutMs ?? 15000,
      options.cliPath ?? cli,
    );
    Object.assign(row, result);
    if (result.error) row.reason = result.error;
    else {
      await options.beforeGrade?.({ ...trial, home, root, index });
      const grade = await (options.gradeTrial ?? gradeCodingTrial)(
        trial.workspace,
        task,
      );
      row.outcome = grade.passed ? "passed" : "failed";
      if (grade.reason) row.reason = grade.reason;
    }
  } catch (error) {
    row.reason = `trial failed: ${error.message}`;
  } finally {
    for (const cleanup of [
      () => provider?.close(),
      () => root && rm(root, { recursive: true, force: true }),
    ]) {
      try {
        await cleanup();
      } catch (error) {
        row.cleanupError = error.message;
        row.outcome = "error";
      }
    }
  }
  return row;
}

export async function runTrials(options = {}) {
  const rows = [];
  for (const [index, task] of (
    options.tasks ?? ["fix-media-type", "extend-locales"]
  ).entries()) {
    rows.push(await runTrial(task, index, options));
  }
  return rows;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.length && (args.length !== 2 || args[0] !== "--provider-config")) {
    throw new Error(
      "Usage: node benchmarks/outcomes/runner.mjs [--provider-config PATH]",
    );
  }
  const providerConfig = args.length
    ? JSON.parse(await readFile(args[1], "utf8"))
    : undefined;
  const rows = await runTrials({ providerConfig });
  console.log(JSON.stringify(rows, null, 2));
  if (rows.some((row) => row.outcome !== "passed")) process.exitCode = 1;
}
