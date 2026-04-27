import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";
import { Agent } from "./agent.js";
import { parseCliArgs } from "./cli/args.js";
import { maybeRunSandboxDelegation } from "./sandboxDelegation.js";
import { getConfigPath } from "./providers/configLoader.js";
import { discoverAgentsMdFiles, loadAgentsMdContent } from "./agentsMd.js";
import { setColorEnabled } from "./ui/colors.js";
import { showToolMenu } from "./ui/toolMenu.js";
import {
  createPromptComposer,
  type PromptComposer,
} from "./ui/promptComposer.js";
import { createPromptHistoryStore } from "./ui/promptHistory.js";
import { printStartupBanner } from "./ui/banner.js";
import { TerminalUi } from "./ui/terminal.js";
import {
  streamAssistantTurn,
  type AssistantTurnVisibilityOptions,
} from "./ui/assistantTurnRenderer.js";
import {
  buildSlashCommandHelpLines,
  isHelpCommand,
  getIdleFooterText,
} from "./ui/slashCommands.js";
import { AgentDiagnosticEvent } from "./diagnostics.js";
import {
  formatContextOverview,
  formatPromptPlan,
  formatMemoryView,
  type ContextOverviewLine,
  type PromptPlanLine,
  type MemoryLine,
} from "./ui/contextInspector.js";
import { getDefaultSessionsDir } from "./sessions/sessionHistory.js";
import {
  saveSessionOnExit,
  handleSessionCommand as handleSessionCmd,
  hasSessionContent,
} from "./sessions/sessionCommands.js";

type VisibilityOptions = AssistantTurnVisibilityOptions;

const HELP_TEXT = `Usage: propio-agent [options]

Options:
  --sandbox           Run inside the Docker sandbox wrapper
  --json              Emit only JSON response payloads on stdout
  --plain             Disable ANSI color styling and spinner animation
  --no-interactive    Disable prompts/spinners and read one prompt from stdin
  --show-activity     Show normalized tool activity events (started/finished/failed)
  --show-status       Show high-level agent lifecycle status updates
  --show-reasoning-summary
                      Show a concise reasoning summary after each turn
  --show-trace        Enable --show-activity, --show-status, and --show-reasoning-summary
  --show-context-stats
                      Print compact context stats after each turn
  --show-prompt-plan  Print prompt plan summary each time a request is built
  --debug-llm         Emit provider/stream/tool diagnostic events to stderr
  --debug-llm-file    Append provider/stream/tool diagnostic events to a file
  -h, --help          Show this help text
`;

function isLlmDebugEnabled(parsedFlag: boolean): boolean {
  if (parsedFlag) {
    return true;
  }
  const envValue = process.env.PROPIO_DEBUG_LLM;
  if (!envValue) {
    return false;
  }
  const normalized = envValue.toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes";
}

function createDiagnosticLogger(options: {
  stderr?: NodeJS.WriteStream;
  stderrEnabled: boolean;
  filePath?: string;
}): {
  onEvent: (event: AgentDiagnosticEvent) => void;
  cleanup: () => void;
} {
  const stderr = options.stderr ?? process.stderr;
  const sinks: NodeJS.WritableStream[] = [];

  if (options.stderrEnabled) {
    sinks.push(stderr);
  }

  let fileStream: fs.WriteStream | null = null;
  if (options.filePath) {
    const directory = path.dirname(options.filePath);
    fs.mkdirSync(directory, { recursive: true });
    fileStream = fs.createWriteStream(options.filePath, {
      flags: "a",
      encoding: "utf8",
    });
    sinks.push(fileStream);
  }

  return {
    onEvent: (event) => {
      const timestamp = new Date().toISOString();
      const line = `[llm-debug ${timestamp}] ${JSON.stringify(event)}\n`;
      for (const sink of sinks) {
        sink.write(line);
      }
    },
    cleanup: () => {
      if (fileStream) {
        fileStream.end();
      }
    },
  };
}

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

function printSlashCommandHelp(
  ui: Pick<TerminalUi, "command" | "info" | "subtle" | "section">,
): void {
  renderStyledLines(ui, buildSlashCommandHelpLines());
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

function renderStyledLines(
  ui: Pick<TerminalUi, "command" | "info" | "subtle" | "section">,
  lines: ReadonlyArray<{ text: string; style: "info" | "subtle" | "section" }>,
): void {
  for (const line of lines) {
    switch (line.style) {
      case "section":
        ui.section(line.text);
        break;
      case "info":
        ui.info(line.text);
        break;
      case "subtle":
        ui.subtle(line.text);
        break;
    }
  }
}

async function runNonInteractiveSession(
  agent: Agent,
  ui: TerminalUi,
  setCurrentAbortController: (controller: AbortController | null) => void,
  visibility: VisibilityOptions,
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
  ui.setMode("running");

  try {
    const result = await streamAssistantTurn(
      agent,
      stdinInput,
      ui,
      abortController.signal,
      visibility,
    );
    ui.setMode("showingResults");
    if (ui.isJsonMode()) {
      ui.writeJson({
        response: result.response,
        ...(visibility.showReasoningSummary && result.reasoningSummary
          ? {
              reasoningSummary: result.reasoningSummary.summary,
              reasoningSummarySource: result.reasoningSummary.source,
            }
          : {}),
      });
    }
    return 0;
  } catch (error) {
    if (abortController.signal.aborted || isAbortError(error)) {
      return 130;
    }

    const message = error instanceof Error ? error.message : "Unknown error";
    ui.setMode("error");
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

function saveSessionSnapshot(agent: Agent, ui: TerminalUi): void {
  saveSessionOnExit(agent, getDefaultSessionsDir(), ui);
}

function createWorkspacePromptHistoryStore() {
  return createPromptHistoryStore({
    filePath: path.join(getDefaultSessionsDir(), "prompt-history.json"),
  });
}

async function handleSessionCommand(
  input: string,
  agent: Agent,
  composer: PromptComposer,
  ui: TerminalUi,
): Promise<void> {
  await handleSessionCmd(input, agent, getDefaultSessionsDir(), {
    info: (msg) => ui.info(msg),
    error: (msg) => ui.error(msg),
    success: (msg) => ui.success(msg),
    command: (msg) => ui.command(msg),
    promptConfirm: async (msg) => {
      return await composer.confirm({
        promptText: ui.prompt(msg),
        defaultValue: false,
      });
    },
  });
}

async function runInteractiveSession(
  agent: Agent,
  ui: TerminalUi,
  setCurrentAbortController: (controller: AbortController | null) => void,
  setActiveComposer: (composer: PromptComposer | null) => void,
  shouldExit: () => boolean,
  visibility: VisibilityOptions,
): Promise<number> {
  const composer = createPromptComposer({
    output: ui.getPromptOutputStream(),
    historyStore: createWorkspacePromptHistoryStore(),
    workspaceRoot: process.cwd(),
    renderFooter: (footer) => {
      ui.idleFooter(footer);
    },
    renderState: (state) => {
      ui.setPromptState(state);
    },
  });
  setActiveComposer(composer);

  try {
    ui.command("Type /help or ? to view available slash commands.");
    ui.command("Exit with /exit or Ctrl+C.");
    ui.command("");

    let shownReadyPromptMessage = false;
    while (!shouldExit()) {
      ui.setMode("awaitingInput");
      if (!shownReadyPromptMessage) {
        ui.info("AI Agent started. Type your message and press Enter.");
        shownReadyPromptMessage = true;
      }

      const nextInput = await composer.compose({
        mode: "chat",
        promptText: ui.chatPrompt(),
        footer: getIdleFooterText(),
      });

      if (nextInput.status === "closed") {
        ui.closeOverlay();
        if (composer.getCloseReason() === "interrupted") {
          return 130;
        }

        saveSessionSnapshot(agent, ui);
        ui.success("Goodbye!");
        return 0;
      }

      ui.closeOverlay();
      const trimmedInput = nextInput.text.trim();

      if (shouldExit()) {
        return 130;
      }

      if (!trimmedInput) {
        continue;
      }

      if (trimmedInput === "/exit") {
        saveSessionSnapshot(agent, ui);
        ui.success("Goodbye!");
        return 0;
      }

      if (isHelpCommand(trimmedInput)) {
        printSlashCommandHelp(ui);
        continue;
      }

      if (trimmedInput === "/clear") {
        agent.clearContext();
        ui.success("Session context cleared.");
        ui.command("");
        continue;
      }

      if (trimmedInput === "/context" || trimmedInput.startsWith("/context ")) {
        const subcommand = trimmedInput.slice("/context".length).trim();

        if (subcommand === "") {
          const state = agent.getConversationState();
          const hasContent =
            state.turns.length > 0 ||
            state.preamble.length > 0 ||
            state.artifacts.length > 0 ||
            state.pinnedMemory.length > 0 ||
            state.rollingSummary != null;
          if (!hasContent) {
            ui.info("No session context.");
          } else {
            renderStyledLines(ui, formatContextOverview(state));
          }
        } else if (subcommand === "prompt") {
          const snapshot = agent.getLastPromptPlan();
          if (!snapshot) {
            ui.info("No prompt plan yet (no requests have been built).");
          } else {
            renderStyledLines(ui, formatPromptPlan(snapshot));
          }
        } else if (subcommand === "memory") {
          const state = agent.getConversationState();
          renderStyledLines(ui, formatMemoryView(state));
        } else {
          ui.error(`Unknown /context subcommand: "${subcommand}"`);
          ui.command("Usage: /context [prompt | memory]");
        }

        ui.command("");
        continue;
      }

      if (trimmedInput === "/session" || trimmedInput.startsWith("/session ")) {
        await handleSessionCommand(trimmedInput, agent, composer, ui);
        if (shouldExit()) {
          return 130;
        }
        continue;
      }

      if (trimmedInput === "/tools") {
        await showToolMenu(composer, agent, ui);
        if (shouldExit()) {
          return 130;
        }
        continue;
      }

      ui.persistSubmittedInput(trimmedInput);
      ui.setMode("running");
      const abortController = new AbortController();
      setCurrentAbortController(abortController);
      const turnStartedAtMs = Date.now();

      try {
        await streamAssistantTurn(
          agent,
          trimmedInput,
          ui,
          abortController.signal,
          visibility,
        );
        ui.setMode("showingResults");
        ui.command("");
        ui.turnComplete(Date.now() - turnStartedAtMs);
      } catch (error) {
        if (abortController.signal.aborted || isAbortError(error)) {
          return 130;
        }

        ui.setMode("error");
        ui.error(
          `Error: ${error instanceof Error ? error.message : "Unknown error"}`,
        );
        ui.command("");
        ui.turnComplete(Date.now() - turnStartedAtMs);
      } finally {
        setCurrentAbortController(null);
      }
    }

    return 130;
  } finally {
    composer.close();
    setActiveComposer(null);
  }
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
  const debugLlmToStderr = isLlmDebugEnabled(parsedArgs.flags.debugLlm);
  const debugLlmFilePath = parsedArgs.flags.debugLlmFile;
  const diagnosticsEnabled = debugLlmToStderr || Boolean(debugLlmFilePath);
  const colorEnabled = !plain && !jsonMode && Boolean(process.stdout.isTTY);
  const showTrace = parsedArgs.flags.showTrace;
  const visibility: VisibilityOptions = {
    showActivity: parsedArgs.flags.showActivity || showTrace,
    showStatus: parsedArgs.flags.showStatus || showTrace,
    showReasoningSummary: parsedArgs.flags.showReasoningSummary || showTrace,
    showContextStats: parsedArgs.flags.showContextStats,
    showPromptPlan: parsedArgs.flags.showPromptPlan,
  };

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

  if (parsedArgs.parseErrors.length > 0) {
    for (const error of parsedArgs.parseErrors) {
      ui.error(error);
    }
    ui.cleanup();
    return 1;
  }

  let shouldExit = false;
  let currentAbortController: AbortController | null = null;
  let activeComposer: PromptComposer | null = null;
  const setCurrentAbortController = (controller: AbortController | null) => {
    currentAbortController = controller;
  };
  const setActiveComposer = (composer: PromptComposer | null) => {
    activeComposer = composer;
  };

  const handleSigint = () => {
    shouldExit = true;
    ui.setMode("error");
    activeComposer?.close();
    if (currentAbortController && !currentAbortController.signal.aborted) {
      currentAbortController.abort();
      ui.warn("Cancellation requested (SIGINT).");
      return;
    }
    ui.warn("Interrupted.");
  };

  process.on("SIGINT", handleSigint);
  const diagnosticLogger = createDiagnosticLogger({
    stderrEnabled: debugLlmToStderr,
    filePath: debugLlmFilePath,
  });

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

    const agent = new Agent({
      providersConfig: configPath,
      systemPrompt: defaultSystemPrompt,
      agentsMdContent,
      diagnosticsEnabled,
      onDiagnosticEvent: diagnosticLogger.onEvent,
    });

    if (interactive) {
      const code = await runInteractiveSession(
        agent,
        ui,
        setCurrentAbortController,
        setActiveComposer,
        () => shouldExit,
        visibility,
      );
      if (code === 130) {
        return shouldExit ? 130 : code;
      }
      return code;
    }

    const nonInteractiveCode = await runNonInteractiveSession(
      agent,
      ui,
      setCurrentAbortController,
      visibility,
    );
    if (shouldExit) {
      return 130;
    }
    return nonInteractiveCode;
  } finally {
    diagnosticLogger.cleanup();
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
