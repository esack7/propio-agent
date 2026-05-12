#!/usr/bin/env node
import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";
import type { Agent as AgentType } from "./agent.js";
import { parseCliArgs } from "./cli/args.js";
import { maybeRunSandboxDelegation } from "./sandboxDelegation.js";
import { loadRuntimeConfig } from "./config/runtimeConfig.js";
import {
  getConfigPath,
  loadProvidersConfigAsync,
} from "./providers/configLoader.js";
import {
  discoverAgentsMdFilesAsync,
  loadAgentsMdContentAsync,
} from "./agentsMd.js";
import { setColorEnabled } from "./ui/textColors.js";
import { showToolMenu } from "./ui/toolMenu.js";
import { showModelMenu } from "./ui/modelMenu.js";
import { showSkillsMenu } from "./ui/skillMenu.js";
import {
  createPromptComposer,
  type PromptComposer,
} from "./ui/promptComposer.js";
import { createPromptHistoryStore } from "./ui/promptHistory.js";
import { printStartupBanner } from "./ui/banner.js";
import {
  streamAssistantTurn,
  type AssistantTurnVisibilityOptions,
} from "./ui/assistantTurnRenderer.js";
import {
  buildSlashCommandHelpLines,
  isHelpCommand,
  getIdleFooterText,
} from "./ui/slashCommands.js";
import {
  createDefaultTypeaheadProviders,
  createSkillCommandTypeaheadProvider,
} from "./ui/typeahead.js";
import { AgentDiagnosticEvent } from "./diagnostics.js";
import {
  formatContextOverview,
  formatPromptPlan,
  formatMemoryView,
  type ContextOverviewLine,
  type PromptPlanLine,
  type MemoryLine,
} from "./ui/contextInspector.js";
import {
  getDefaultSessionsDir,
  findStaleMarkers,
  clearInProgressMarker,
  readIndex,
  rebuildIndex,
} from "./sessions/sessionHistory.js";
import {
  saveSessionOnExit,
  handleSessionCommand as handleSessionCmd,
  hasSessionContent,
} from "./sessions/sessionCommands.js";
import type { TerminalUi } from "./ui/terminal.js";
import { handleMcpCommand } from "./ui/mcpMenu.js";
import { getMcpConfigPath, loadMcpConfigAsync } from "./mcp/config.js";
import {
  isLlmDebugEnabled,
  formatDiagnosticLogLine,
  renderStyledLines,
} from "./indexHelpers.js";

type VisibilityOptions = AssistantTurnVisibilityOptions;

const HELP_TEXT = `Usage: propio [options]

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
      const line = formatDiagnosticLogLine(timestamp, event);
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

async function runNonInteractiveSession(
  agent: AgentType,
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

function saveSessionSnapshot(agent: AgentType, ui: TerminalUi): void {
  saveSessionOnExit(agent, getDefaultSessionsDir(), ui);
}

function createWorkspacePromptHistoryStore() {
  return createPromptHistoryStore({
    filePath: path.join(getDefaultSessionsDir(), "prompt-history.json"),
  });
}

async function handleSessionCommand(
  input: string,
  agent: AgentType,
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

interface InteractiveSubmissionContext {
  agent: AgentType;
  ui: TerminalUi;
  composer: PromptComposer;
  configPath: string;
  setCurrentAbortController: (controller: AbortController | null) => void;
  shouldExit: () => boolean;
  visibility: VisibilityOptions;
}

async function runInteractiveTurn(
  input: string,
  context: InteractiveSubmissionContext,
  options: {
    beforeTurn?: () => Promise<void>;
    errorPrefix: string;
  },
): Promise<number | null> {
  const { agent, ui, setCurrentAbortController, visibility } = context;
  const abortController = new AbortController();
  const turnStartedAtMs = Date.now();
  setCurrentAbortController(abortController);
  ui.setMode("running");

  try {
    if (options.beforeTurn) {
      await options.beforeTurn();
    }

    await streamAssistantTurn(
      agent,
      input,
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
      `${options.errorPrefix}${error instanceof Error ? error.message : "Unknown error"}`,
    );
    ui.command("");
    ui.turnComplete(Date.now() - turnStartedAtMs);
  } finally {
    setCurrentAbortController(null);
  }

  return null;
}

type InteractiveInputHandler = (
  trimmedInput: string,
  context: InteractiveSubmissionContext,
) => Promise<number | null | undefined>;

async function handleExitSubmission(
  trimmedInput: string,
  context: InteractiveSubmissionContext,
): Promise<number | null | undefined> {
  if (trimmedInput !== "/exit") {
    return undefined;
  }

  saveSessionSnapshot(context.agent, context.ui);
  context.ui.success("Goodbye!");
  return 0;
}

async function handleHelpSubmission(
  trimmedInput: string,
  context: InteractiveSubmissionContext,
): Promise<number | null | undefined> {
  if (!isHelpCommand(trimmedInput)) {
    return undefined;
  }

  printSlashCommandHelp(context.ui);
  return null;
}

async function handleClearSubmission(
  trimmedInput: string,
  context: InteractiveSubmissionContext,
): Promise<number | null | undefined> {
  if (trimmedInput !== "/clear") {
    return undefined;
  }

  context.agent.clearContext();
  context.ui.success("Session context cleared.");
  context.ui.command("");
  return null;
}

async function handleSkillsSubmission(
  trimmedInput: string,
  context: InteractiveSubmissionContext,
): Promise<number | null | undefined> {
  if (trimmedInput !== "/skills") {
    return undefined;
  }

  showSkillsMenu(context.agent, context.ui);
  return null;
}

async function handleSkillSubmission(
  trimmedInput: string,
  context: InteractiveSubmissionContext,
): Promise<number | null | undefined> {
  if (trimmedInput !== "/skill" && !trimmedInput.startsWith("/skill ")) {
    return undefined;
  }

  const { agent, ui } = context;
  const args = trimmedInput.slice("/skill".length).trim();
  if (!args) {
    ui.error("Usage: /skill <name> [arguments]");
    ui.command("");
    return null;
  }

  const firstSpace = args.search(/\s/);
  const skillName = firstSpace === -1 ? args : args.slice(0, firstSpace).trim();
  const rawSkillArgs =
    firstSpace === -1 ? "" : args.slice(firstSpace).trimStart();

  return await runInteractiveTurn("", context, {
    errorPrefix: "Failed to activate skill: ",
    beforeTurn: async () => {
      await agent.invokeSkill(skillName, rawSkillArgs, {
        source: "user",
      });
    },
  });
}

async function handleContextSubmission(
  trimmedInput: string,
  context: InteractiveSubmissionContext,
): Promise<number | null | undefined> {
  if (trimmedInput !== "/context" && !trimmedInput.startsWith("/context ")) {
    return undefined;
  }

  const { agent, ui } = context;
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
  return null;
}

async function handleSessionSubmission(
  trimmedInput: string,
  context: InteractiveSubmissionContext,
): Promise<number | null | undefined> {
  if (trimmedInput !== "/session" && !trimmedInput.startsWith("/session ")) {
    return undefined;
  }

  await handleSessionCommand(
    trimmedInput,
    context.agent,
    context.composer,
    context.ui,
  );
  return context.shouldExit() ? 130 : null;
}

async function handleToolsSubmission(
  trimmedInput: string,
  context: InteractiveSubmissionContext,
): Promise<number | null | undefined> {
  if (trimmedInput !== "/tools") {
    return undefined;
  }

  await showToolMenu(context.composer, context.agent, context.ui);
  return context.shouldExit() ? 130 : null;
}

async function handleMcpSubmission(
  trimmedInput: string,
  context: InteractiveSubmissionContext,
): Promise<number | null | undefined> {
  if (trimmedInput !== "/mcp" && !trimmedInput.startsWith("/mcp ")) {
    return undefined;
  }

  await handleMcpCommand(trimmedInput, context.agent, context.ui);
  return context.shouldExit() ? 130 : null;
}

async function handleModelSubmission(
  trimmedInput: string,
  context: InteractiveSubmissionContext,
): Promise<number | null | undefined> {
  const { agent, composer, configPath, ui } = context;

  if (trimmedInput === "/model") {
    await showModelMenu(composer, agent, ui, configPath);
    return context.shouldExit() ? 130 : null;
  }

  if (trimmedInput.startsWith("/model ")) {
    const args = trimmedInput.slice("/model".length).trim();
    ui.error(`Unknown /model usage: "${args}"`);
    ui.command("Usage: /model");
    ui.command("");
    return null;
  }

  return undefined;
}

async function handleChatSubmission(
  trimmedInput: string,
  context: InteractiveSubmissionContext,
): Promise<number | null | undefined> {
  context.ui.persistSubmittedInput(trimmedInput);
  return await runInteractiveTurn(trimmedInput, context, {
    errorPrefix: "Error: ",
  });
}

async function handleInteractiveSubmission(
  trimmedInput: string,
  context: InteractiveSubmissionContext,
): Promise<number | null> {
  if (context.shouldExit()) {
    return 130;
  }

  if (!trimmedInput) {
    return null;
  }

  const handlers: InteractiveInputHandler[] = [
    handleExitSubmission,
    handleHelpSubmission,
    handleClearSubmission,
    handleSkillsSubmission,
    handleSkillSubmission,
    handleContextSubmission,
    handleSessionSubmission,
    handleToolsSubmission,
    handleMcpSubmission,
    handleModelSubmission,
    handleChatSubmission,
  ];

  for (const handler of handlers) {
    const result = await handler(trimmedInput, context);
    if (result !== undefined) {
      return result;
    }
  }

  return null;
}

async function runInteractiveSession(
  agent: AgentType,
  ui: TerminalUi,
  configPath: string,
  setCurrentAbortController: (controller: AbortController | null) => void,
  setActiveComposer: (composer: PromptComposer | null) => void,
  shouldExit: () => boolean,
  visibility: VisibilityOptions,
): Promise<number> {
  const typeaheadProviders = [
    ...createDefaultTypeaheadProviders(process.cwd()),
    createSkillCommandTypeaheadProvider(() => agent.listUserInvocableSkills()),
  ];
  const composer = createPromptComposer({
    output: ui.getPromptOutputStream(),
    historyStore: createWorkspacePromptHistoryStore(),
    workspaceRoot: process.cwd(),
    typeaheadProviders,
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

      const exitCode = await handleInteractiveSubmission(trimmedInput, {
        agent,
        ui,
        composer,
        configPath,
        setCurrentAbortController,
        shouldExit,
        visibility,
      });
      if (exitCode !== null) {
        return exitCode;
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

  if (parsedArgs.flags.help) {
    process.stdout.write(HELP_TEXT);
    return 0;
  }

  setColorEnabled(colorEnabled);

  const { TerminalUi } = await import("./ui/terminal.js");
  const ui = new TerminalUi({
    interactive,
    plain: plain || parsedArgs.flags.help,
    json: jsonMode,
  });

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
  let agent: AgentType | null = null;

  try {
    if (!ui.isJsonMode()) {
      printStartupBanner(ui);
      ui.command("");
    }

    // Detect stale in-progress markers from crashed sessions (Phase 7)
    const sessionsDir = getDefaultSessionsDir();
    const staleMarkers = findStaleMarkers(sessionsDir);
    for (const { sessionId, marker, ageMs } of staleMarkers) {
      const ageHours = Math.round(ageMs / (60 * 60 * 1000));
      const ageText =
        ageHours < 24
          ? `${ageHours}h ago`
          : `${Math.round(ageHours / 24)}d ago`;

      if (!ui.isJsonMode()) {
        ui.warn(
          `Detected an incomplete session from ${ageText} (${marker.providerName}/${marker.modelKey}, turn ${marker.turnIndex}). Work since the last /exit was not saved.`,
        );
      }

      // Emit diagnostic for this crash detection
      diagnosticLogger.onEvent({
        type: "mid_turn_crash_detected",
        provider: marker.providerName,
        model: marker.modelKey,
        turnIndex: marker.turnIndex,
        ageMs,
      });

      // Clean up the stale marker
      clearInProgressMarker(sessionsDir, sessionId);
    }

    // Artifact retention: prune artifact dirs not anchored to any saved snapshot
    const runtimeConfig = loadRuntimeConfig();
    const artifactsRoot = path.join(sessionsDir, "artifacts");
    if (fs.existsSync(artifactsRoot)) {
      const index = readIndex(sessionsDir) ?? rebuildIndex(sessionsDir);
      const anchoredIds = new Set(
        index.entries.map((e) => e.runtimeSessionId).filter(Boolean) ?? [],
      );
      const retentionMs =
        runtimeConfig.artifactRetentionDays * 24 * 60 * 60 * 1000;

      for (const dirName of fs.readdirSync(artifactsRoot)) {
        const dirPath = path.join(artifactsRoot, dirName);
        try {
          if (!fs.statSync(dirPath).isDirectory()) continue;
          if (anchoredIds.has(dirName)) continue;

          const mtime = fs.statSync(dirPath).mtimeMs;
          if (Date.now() - mtime > retentionMs) {
            fs.rmSync(dirPath, { recursive: true, force: true });
          }
        } catch {
          continue;
        }
      }
    }

    const configPath = getConfigPath();
    const mcpConfigPath = getMcpConfigPath();
    const [agentModule, providersConfig, mcpConfig, agentsMdContent] =
      await Promise.all([
        import("./agent.js"),
        loadProvidersConfigAsync(configPath),
        loadMcpConfigAsync(mcpConfigPath),
        discoverAgentsMdFilesAsync().then((agentsMdFiles) =>
          loadAgentsMdContentAsync(agentsMdFiles),
        ),
      ]);

    const defaultSystemPrompt = `You are a helpful AI coding assistant with access to tools. Use the tools available to you to complete user requests effectively.

When you need to perform actions like reading files, searching code, or executing commands, use the appropriate tool by making a function call. You will receive the tool results and can use that information to continue helping the user.

Always provide clear, concise responses and summarize what you did after completing the user's request.`;

    const agentRuntimeConfig = loadRuntimeConfig({
      cliOverrides: {
        maxIterations: parsedArgs.flags.maxIterations,
        maxRetries: parsedArgs.flags.maxRetries,
        bashDefaultTimeoutMs: parsedArgs.flags.bashTimeoutMs,
        streamIdleTimeoutMs: parsedArgs.flags.streamIdleTimeoutMs,
      },
    });

    agent = new agentModule.Agent({
      providersConfig,
      mcpConfig,
      mcpConfigPath,
      systemPrompt: defaultSystemPrompt,
      agentsMdContent,
      diagnosticsEnabled,
      onDiagnosticEvent: diagnosticLogger.onEvent,
      runtimeConfig: agentRuntimeConfig,
    });
    await agent.initialize();

    if (interactive) {
      const code = await runInteractiveSession(
        agent,
        ui,
        configPath,
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
    if (agent) {
      await agent.close();
    }
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
