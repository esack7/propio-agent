import * as path from "path";
import * as readline from "readline";
import { fileURLToPath } from "url";
import { Agent } from "./agent.js";
import { parseCliArgs } from "./cli/args.js";
import { maybeRunSandboxDelegation } from "./sandboxDelegation.js";
import { getConfigPath } from "./providers/configLoader.js";
import {
  discoverAgentsMdFiles,
  loadAgentsMdContent,
  composeSystemPrompt,
} from "./agentsMd.js";
import { setColorEnabled } from "./ui/colors.js";
import { showToolMenu } from "./ui/toolMenu.js";
import { printStartupBanner } from "./ui/banner.js";
import { TerminalUi } from "./ui/terminal.js";

type AppMode =
  | "idle"
  | "running"
  | "awaitingInput"
  | "showingResults"
  | "error";

const HELP_TEXT = `Usage: propio-agent [options]

Options:
  --sandbox           Run inside the Docker sandbox wrapper
  --json              Emit only JSON response payloads on stdout
  --plain             Disable ANSI color styling and spinner animation
  --no-interactive    Disable prompts/spinners and read one prompt from stdin
  -h, --help          Show this help text
`;

function isCiEnvironment(): boolean {
  const ci = process.env.CI;
  if (!ci) {
    return false;
  }

  const normalized = ci.toLowerCase();
  return normalized !== "0" && normalized !== "false";
}

function isAbortError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  const message = error.message.toLowerCase();
  return message.includes("abort") || message.includes("cancel");
}

function previewToolResult(result: string, maxLength = 70): string {
  const compact = result.replace(/\s+/g, " ").trim();
  if (compact.length <= maxLength) {
    return compact;
  }
  return `${compact.substring(0, maxLength)}...`;
}

async function readStdinInput(): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    let content = "";
    process.stdin.setEncoding("utf-8");
    process.stdin.on("data", (chunk) => {
      content += chunk;
    });
    process.stdin.on("end", () => {
      resolve(content);
    });
    process.stdin.on("error", (error) => {
      reject(error);
    });
  });
}

async function promptOnce(
  rl: readline.Interface,
  promptText: string,
): Promise<string> {
  return await new Promise<string>((resolve) => {
    const handleClose = () => {
      resolve("/exit");
    };

    rl.once("close", handleClose);
    rl.question(promptText, (answer) => {
      rl.off("close", handleClose);
      resolve(answer);
    });
  });
}

async function streamAssistantResponse(
  agent: Agent,
  userInput: string,
  ui: TerminalUi,
  abortSignal: AbortSignal,
): Promise<string> {
  const mdStream = ui.createMarkdownStream();

  if (!ui.isJsonMode()) {
    ui.writeAssistant("Assistant: ");
  }

  const response = await agent.streamChat(
    userInput,
    (token) => {
      if (!ui.isJsonMode()) {
        mdStream.push(token);
      }
    },
    {
      abortSignal,
      onToolStart: (toolName) => {
        mdStream.flush();
        ui.status(`Executing ${toolName}...`);
      },
      onToolEnd: (toolName, result) => {
        const summary = previewToolResult(result);
        if (result.trimStart().startsWith("Error")) {
          ui.error(`${toolName} failed: ${summary}`);
          return;
        }
        ui.success(`${toolName} completed: ${summary}`);
      },
    },
  );

  mdStream.finish();

  if (!ui.isJsonMode()) {
    ui.newline();
  }

  return response;
}

async function runNonInteractiveSession(
  agent: Agent,
  ui: TerminalUi,
  setMode: (mode: AppMode) => void,
  setCurrentAbortController: (controller: AbortController | null) => void,
): Promise<number> {
  if (process.stdin.isTTY) {
    ui.error(
      "Non-interactive mode requires stdin input. Pipe a prompt or run without --no-interactive.",
    );
    return 1;
  }

  const stdinInput = (await readStdinInput()).trim();
  if (!stdinInput) {
    ui.error("No input provided on stdin.");
    return 1;
  }

  const abortController = new AbortController();
  setCurrentAbortController(abortController);
  setMode("running");

  try {
    const response = await streamAssistantResponse(
      agent,
      stdinInput,
      ui,
      abortController.signal,
    );
    setMode("showingResults");
    if (ui.isJsonMode()) {
      ui.writeJson({ response });
    }
    return 0;
  } catch (error) {
    if (abortController.signal.aborted || isAbortError(error)) {
      return 130;
    }

    const message = error instanceof Error ? error.message : "Unknown error";
    setMode("error");
    if (ui.isJsonMode()) {
      ui.writeJson({ error: message });
    } else {
      ui.error(`Error: ${message}`);
    }
    return 1;
  } finally {
    setCurrentAbortController(null);
  }
}

async function runInteractiveSession(
  agent: Agent,
  ui: TerminalUi,
  setMode: (mode: AppMode) => void,
  setCurrentAbortController: (controller: AbortController | null) => void,
  setActiveReadline: (rl: readline.Interface | null) => void,
  shouldExit: () => boolean,
): Promise<number> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: ui.getPromptOutputStream(),
  });
  setActiveReadline(rl);

  rl.on("SIGINT", () => {
    process.kill(process.pid, "SIGINT");
  });

  ui.info("AI Agent started. Type your message and press Enter.");
  ui.command(
    "Commands: /clear - clear context, /context - show context, /tools - manage tools, /exit - quit",
  );
  ui.command("(use --help for runtime flags)");
  ui.command("");

  const tools = agent.getTools();
  ui.info(
    `Loaded ${tools.length} tools: ${tools.map((t) => t.function.name).join(", ")}`,
  );
  ui.command("");

  while (!shouldExit()) {
    setMode("awaitingInput");
    const input = await promptOnce(rl, ui.prompt("You: "));
    const trimmedInput = input.trim();

    if (shouldExit()) {
      rl.close();
      setActiveReadline(null);
      return 130;
    }

    if (!trimmedInput) {
      continue;
    }

    if (trimmedInput === "/exit") {
      setMode("running");
      ui.info("Saving session context...");
      try {
        await agent.saveContext("Exiting application");
      } catch (error) {
        ui.error(
          `Failed to save session context: ${error instanceof Error ? error.message : "Unknown error"}`,
        );
      }
      ui.success("Goodbye!");
      rl.close();
      setActiveReadline(null);
      return 0;
    }

    if (trimmedInput === "/clear") {
      agent.clearContext();
      ui.success("Session context cleared.");
      ui.command("");
      continue;
    }

    if (trimmedInput === "/context") {
      const context = agent.getContext();
      if (context.length === 0) {
        ui.info("No session context.");
      } else {
        ui.info("Session Context:");
        context.forEach((message, index) => {
          ui.subtle(
            `${index + 1}. ${message.role.toUpperCase()}: ${message.content}`,
          );
        });
      }
      ui.command("");
      continue;
    }

    if (trimmedInput === "/tools") {
      await new Promise<void>((resolve) => {
        showToolMenu(rl, agent, resolve, ui);
      });
      continue;
    }

    setMode("running");
    const abortController = new AbortController();
    setCurrentAbortController(abortController);

    try {
      await streamAssistantResponse(
        agent,
        trimmedInput,
        ui,
        abortController.signal,
      );
      setMode("showingResults");
      ui.command("");
    } catch (error) {
      if (abortController.signal.aborted || isAbortError(error)) {
        rl.close();
        setActiveReadline(null);
        return 130;
      }

      setMode("error");
      ui.error(
        `Error: ${error instanceof Error ? error.message : "Unknown error"}`,
      );
      ui.command("");
    } finally {
      setCurrentAbortController(null);
    }
  }

  rl.close();
  setActiveReadline(null);
  return 130;
}

async function main(): Promise<number> {
  const rawArgs = process.argv.slice(2);
  const parsedArgs = parseCliArgs(rawArgs);

  const sandboxExitCode = await maybeRunSandboxDelegation(rawArgs);
  if (sandboxExitCode !== null) {
    return sandboxExitCode;
  }

  const ci = isCiEnvironment();
  const interactive =
    Boolean(process.stdin.isTTY) &&
    Boolean(process.stdout.isTTY) &&
    !ci &&
    !parsedArgs.flags.noInteractive &&
    !parsedArgs.flags.json;
  const plain = parsedArgs.flags.plain || !Boolean(process.stdout.isTTY) || ci;
  const jsonMode = parsedArgs.flags.json && !parsedArgs.flags.help;
  const colorEnabled = !plain && !jsonMode && Boolean(process.stdout.isTTY);

  setColorEnabled(colorEnabled);

  const ui = new TerminalUi({
    interactive,
    plain: plain || parsedArgs.flags.help,
    json: jsonMode,
  });

  if (parsedArgs.flags.help) {
    ui.command(HELP_TEXT.trimEnd());
    ui.cleanup();
    return 0;
  }

  let mode: AppMode = "idle";
  const setMode = (nextMode: AppMode) => {
    mode = nextMode;
  };

  let shouldExit = false;
  let currentAbortController: AbortController | null = null;
  let activeReadline: readline.Interface | null = null;
  const setCurrentAbortController = (controller: AbortController | null) => {
    currentAbortController = controller;
  };
  const setActiveReadline = (rl: readline.Interface | null) => {
    activeReadline = rl;
  };

  const handleSigint = () => {
    shouldExit = true;
    setMode("error");
    if (currentAbortController && !currentAbortController.signal.aborted) {
      currentAbortController.abort();
      ui.warn("Cancellation requested (SIGINT).");
      return;
    }
    ui.warn("Interrupted.");
    if (activeReadline) {
      activeReadline.close();
    }
  };

  process.on("SIGINT", handleSigint);

  try {
    if (!ui.isJsonMode()) {
      printStartupBanner(ui);
      ui.command("");
    }

    const configPath = getConfigPath();
    const agentsMdFiles = discoverAgentsMdFiles();
    const agentsMdContent = loadAgentsMdContent(agentsMdFiles);

    const defaultSystemPrompt = `You are a helpful AI coding assistant with access to tools. Use the tools available to you to complete user requests effectively.

When you need to perform actions like reading files, searching code, or executing commands, use the appropriate tool by making a function call. You will receive the tool results and can use that information to continue helping the user.

Always provide clear, concise responses and summarize what you did after completing the user's request.`;

    const systemPrompt = composeSystemPrompt(
      agentsMdContent,
      defaultSystemPrompt,
    );

    const agent = new Agent({
      providersConfig: configPath,
      systemPrompt,
      agentsMdContent,
    });

    if (interactive) {
      const code = await runInteractiveSession(
        agent,
        ui,
        setMode,
        setCurrentAbortController,
        setActiveReadline,
        () => shouldExit,
      );
      if (code === 130) {
        return shouldExit ? 130 : code;
      }
      return code;
    }

    const nonInteractiveCode = await runNonInteractiveSession(
      agent,
      ui,
      setMode,
      setCurrentAbortController,
    );
    if (shouldExit) {
      return 130;
    }
    return nonInteractiveCode;
  } finally {
    process.off("SIGINT", handleSigint);
    ui.done();
    ui.cleanup();
  }
}

const isDirectExecution =
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isDirectExecution) {
  main()
    .then((exitCode) => {
      process.exit(exitCode);
    })
    .catch((error) => {
      process.stderr.write(
        `${error instanceof Error ? error.message : String(error)}\n`,
      );
      process.exit(1);
    });
}
