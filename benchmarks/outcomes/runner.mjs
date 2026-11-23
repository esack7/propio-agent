import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createCodingTrial, gradeCodingTrial } from "./coding.mjs";
import { startScriptedProvider } from "./scripted.mjs";

const cli = fileURLToPath(new URL("../../dist/index.js", import.meta.url));

function execute(workspace, home, prompt, timeoutMs, cliPath) {
  const child = spawn(
    process.execPath,
    [cliPath, "--json", "--permissions", "accept-edits", "--max-retries", "0"],
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
  return waitForExit(child, prompt, timeoutMs);
}

function exitResult(code, signal, timedOut) {
  if (timedOut) return { code, signal, error: "CLI timed out" };
  if (code !== 0)
    return {
      code,
      signal,
      error: `CLI exited ${code} (${signal ?? "no signal"})`,
    };
  return { code, signal };
}

function waitForExit(child, prompt, timeoutMs) {
  return new Promise((resolve) => {
    let outputBytes = 0;
    let timedOut = false;
    let settled = false;
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
      finish(exitResult(code, signal, timedOut)),
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

function trialConfiguration(explicit, provider) {
  if (explicit) return explicit;
  return {
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
}

async function recordGrade(row, trial, state, options) {
  await options.beforeGrade?.({ ...trial, ...state });
  const grade = await (options.gradeTrial ?? gradeCodingTrial)(
    trial.workspace,
    row.task,
  );
  row.outcome = grade.passed ? "passed" : "failed";
  if (grade.reason) row.reason = grade.reason;
}

async function cleanupTrial(provider, root, row) {
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

async function executeTrial(row, root, provider, options) {
  const home = join(root, "home");
  await mkdir(home);
  const trial = await createCodingTrial(root, row.task);
  const state = { home, root, index: row.trial - 1 };
  await configure(home, trialConfiguration(options.providerConfig, provider));
  await options.beforeRun?.({ ...trial, ...state });
  const result = await execute(
    trial.workspace,
    home,
    trial.prompt,
    options.timeoutMs ?? 15000,
    options.cliPath ?? cli,
  );
  Object.assign(row, result);
  if (result.error) {
    row.reason = result.error;
    return;
  }
  await recordGrade(row, trial, state, options);
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
    if (!options.providerConfig)
      provider = await startScriptedProvider(task, options.scriptedMode);
    await executeTrial(row, root, provider, options);
  } catch (error) {
    row.reason = `trial failed: ${error.message}`;
  } finally {
    await cleanupTrial(provider, root, row);
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
