#!/usr/bin/env node
import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";
import type { Agent as AgentType } from "./agent.js";
import { parseCliArgs } from "./cli/args.js";
import { getPackageVersion } from "./packageVersion.js";
import { maybeRunSandboxDelegation } from "./sandboxDelegation.js";
import {
  loadRuntimeConfig,
  type RuntimeConfig,
} from "./config/runtimeConfig.js";
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
import { createPasteCache } from "./ui/pasteCache.js";
import { printStartupBanner } from "./ui/banner.js";
import {
  streamAssistantTurn,
  type AssistantTurnResult,
  type AssistantTurnVisibilityOptions,
} from "./ui/assistantTurnRenderer.js";
import {
  buildSlashCommandHelpLines,
  isHelpCommand,
  getBashFooterText,
  getIdleFooterText,
  type FooterVisibilityOptions,
} from "./ui/slashCommands.js";
import { processBashCommand } from "./ui/processBashCommand.js";
import { createShellRunOptionsFromRuntimeConfig } from "./tools/runShellCommand.js";
import type { InputMode } from "./ui/inputModes.js";
import {
  createPlainSubmission,
  isSubmissionEmpty,
  type PromptSubmission,
} from "./ui/input/promptSubmission.js";
import { createSessionVisibilityState } from "./ui/sessionVisibility.js";
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
} from "./sessions/sessionHistory.js";
import { pruneStaleSessionStorage } from "./sessions/sessionStoragePrune.js";
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
import {
  createAbortStateController,
  resolveInteractiveTurnAbortExitCode,
  type AbortStateController,
} from "./ui/abortState.js";
import { createTurnCancelListener } from "./ui/turnCancelListener.js";

type VisibilityOptions = AssistantTurnVisibilityOptions;

const HELP_TEXT = `Usage: propio [options]

Options:
  --sandbox           Run inside the Docker sandbox wrapper
  --json              Emit only JSON response payloads on stdout
  --plain             Disable ANSI color styling and spinner animation
  --no-interactive    Disable prompts/spinners and read one prompt from stdin
  --show-status       Show high-level agent lifecycle status updates
  --show-reasoning-summary
                      Show a concise reasoning summary after each turn
  --show-trace        Enable --show-status and --show-reasoning-summary
  --show-context-stats
                      Print compact context stats after each turn
  --show-prompt-plan  Print prompt plan summary each time a request is built
  --debug-llm         Emit provider/stream/tool diagnostic events to stderr
  --debug-llm-file    Append provider/stream/tool diagnostic events to a file
  -h, --help          Show this help text
  -v, --version       Print package version and exit
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

export interface NonInteractiveSessionDeps {
  readonly stdinIsTTY?: boolean;
  readonly readInput?: () => Promise<string>;
}

function writeNonInteractiveSuccessResponse(
  result: AssistantTurnResult,
  ui: TerminalUi,
  visibility: VisibilityOptions,
): void {
  if (!ui.isJsonMode()) return;
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

function handleNonInteractiveStreamError(
  error: unknown,
  abortController: AbortController,
  ui: TerminalUi,
): number {
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
}

export async function runNonInteractiveSession(
  agent: AgentType,
  ui: TerminalUi,
  setCurrentAbortController: (controller: AbortController | null) => void,
  visibility: VisibilityOptions,
  deps: NonInteractiveSessionDeps = {},
): Promise<number> {
  const stdinIsTTY = deps.stdinIsTTY ?? process.stdin.isTTY;
  const readInput = deps.readInput ?? readStdinInput;

  if (stdinIsTTY) {
    ui.error(
      "Non-interactive mode requires stdin input. Pipe a prompt or run without --no-interactive.",
    );
    return 1;
  }

  const stdinInput = (await readInput()).trim();
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
      createPlainSubmission(stdinInput, "prompt"),
      ui,
      abortController.signal,
      () => visibility,
    );
    ui.setMode("showingResults");
    writeNonInteractiveSuccessResponse(result, ui, visibility);
    return 0;
  } catch (error) {
    return handleNonInteractiveStreamError(error, abortController, ui);
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
  inputStream: NodeJS.ReadStream;
  interactiveInput: boolean;
  setCurrentAbortController: (controller: AbortController | null) => void;
  cancelActiveTurn: AbortStateController["cancelActiveTurn"];
  shouldExit: () => boolean;
  getVisibility: () => VisibilityOptions;
}

export async function runInteractiveTurn(
  submission: PromptSubmission,
  context: InteractiveSubmissionContext,
  options: {
    beforeTurn?: () => Promise<void>;
    errorPrefix: string;
  },
): Promise<number | null> {
  const { agent, ui, setCurrentAbortController } = context;
  const visibility = context.getVisibility();
  const abortController = new AbortController();
  const turnStartedAtMs = Date.now();
  setCurrentAbortController(abortController);
  ui.setMode("running");

  const cancelListener = createTurnCancelListener({
    input: context.inputStream,
    interactiveInput: context.interactiveInput,
    onCancel: () => {
      context.cancelActiveTurn("escape");
    },
  });
  cancelListener.attach();

  try {
    if (options.beforeTurn) {
      await options.beforeTurn();
    }

    await streamAssistantTurn(
      agent,
      submission,
      ui,
      abortController.signal,
      () => context.getVisibility(),
    );

    if (abortController.signal.aborted) {
      return resolveInteractiveTurnAbortExitCode(
        abortController.signal,
        context.shouldExit,
      );
    }

    ui.setMode("showingResults");
    ui.command("");
    ui.turnComplete(Date.now() - turnStartedAtMs);
  } catch (error) {
    if (abortController.signal.aborted || isAbortError(error)) {
      return resolveInteractiveTurnAbortExitCode(
        abortController.signal,
        context.shouldExit,
      );
    }

    ui.setMode("error");
    ui.error(
      `${options.errorPrefix}${error instanceof Error ? error.message : "Unknown error"}`,
    );
    ui.command("");
    ui.turnFailed(Date.now() - turnStartedAtMs);
  } finally {
    cancelListener.detach();
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
  if (agent.getAgentMode() !== "execute") {
    ui.error("Switch to Execute mode to run skills (/mode execute).");
    ui.command("");
    return null;
  }
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

  return await runInteractiveTurn(
    createPlainSubmission("", "prompt"),
    context,
    {
      errorPrefix: "Failed to activate skill: ",
      beforeTurn: async () => {
        await agent.invokeSkill(skillName, rawSkillArgs, {
          source: "user",
        });
      },
    },
  );
}

function renderContextOverviewSubcommand(
  agent: AgentType,
  ui: TerminalUi,
): void {
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
}

function renderPromptPlanSubcommand(agent: AgentType, ui: TerminalUi): void {
  const snapshot = agent.getLastPromptPlan();
  if (!snapshot) {
    ui.info("No prompt plan yet (no requests have been built).");
  } else {
    renderStyledLines(ui, formatPromptPlan(snapshot));
  }
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
    renderContextOverviewSubcommand(agent, ui);
  } else if (subcommand === "prompt") {
    renderPromptPlanSubcommand(agent, ui);
  } else if (subcommand === "memory") {
    renderStyledLines(ui, formatMemoryView(agent.getConversationState()));
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

async function handleModeSubmission(
  trimmedInput: string,
  context: InteractiveSubmissionContext,
): Promise<number | null | undefined> {
  if (trimmedInput !== "/mode" && !trimmedInput.startsWith("/mode ")) {
    return undefined;
  }

  const { agent, ui } = context;
  const args = trimmedInput.slice("/mode".length).trim();

  if (!args) {
    const mode = agent.getAgentMode();
    ui.info(`Current mode: ${mode}`);
    ui.command("");
    return null;
  }

  if (args === "execute" || args === "plan" || args === "discover") {
    agent.setAgentMode(args);
    ui.success(`Switched to ${args} mode.`);
    ui.command("");
    return null;
  }

  ui.error(`Unknown /mode usage: "${args}"`);
  ui.command("Usage: /mode [execute | plan | discover]");
  ui.command("");
  return null;
}

function resolvePlanCommandContent(
  command: "save" | "approve",
  args: string,
  agent: AgentType,
): string {
  const inlineContent =
    args === command ? "" : args.slice(command.length).trimStart();
  if (inlineContent) {
    return inlineContent;
  }

  const latestDraft = agent.getLatestAssistantPlanDraft?.()?.trim();
  if (latestDraft) {
    return latestDraft;
  }

  const planPath = agent.getPlanFilePath?.();
  if (planPath) {
    try {
      const planContent = fs.readFileSync(planPath, "utf8").trim();
      if (planContent) {
        return planContent;
      }
    } catch {
      // Fall through to the missing-draft path.
    }
  }

  return "";
}

function reportMissingPlanDraft(ui: TerminalUi): void {
  ui.error(
    "No plan draft found to save. Ask the assistant to draft a `<proposed_plan>` block first, or use /plan save <content>.",
  );
  ui.command("");
}

function reportMissingPlanShowContent(ui: TerminalUi): void {
  ui.info(
    "No plan draft found. Ask the assistant to draft a `<proposed_plan>` block first, or use /plan save <content>.",
  );
  ui.command("");
}

function saveApprovedPlanFromCommand(
  agent: AgentType,
  ui: TerminalUi,
  content: string,
): void {
  try {
    const planPath = agent.saveApprovedPlan(content);
    ui.success(`Plan saved: ${planPath}`);
  } catch (error) {
    ui.error(
      error instanceof Error ? error.message : "Failed to save plan file.",
    );
  }
  ui.command("");
}

function showPlanDraftOrFile(agent: AgentType, ui: TerminalUi): void {
  const planPath = agent.getPlanFilePath();
  if (planPath) {
    try {
      const planContent = fs.readFileSync(planPath, "utf8");
      ui.command(`Saved plan: ${planPath}`);
      ui.command("");
      ui.info(planContent);
    } catch (error) {
      ui.error(
        `Failed to read saved plan file ${planPath}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    ui.command("");
    return;
  }

  const draft = agent.getLatestAssistantPlanDraft?.()?.trim();
  if (draft) {
    ui.command("Pending plan draft:");
    ui.command("");
    ui.info(draft);
    ui.command("");
    return;
  }

  reportMissingPlanShowContent(ui);
}

function handlePlanShowCommand(agent: AgentType, ui: TerminalUi): void {
  if (agent.getAgentMode() !== "plan") {
    ui.error("Switch to Plan mode to view the plan (/mode plan).");
    ui.command("");
    return;
  }

  showPlanDraftOrFile(agent, ui);
}

function handlePlanSaveOrApproveCommand(
  command: "save" | "approve",
  args: string,
  agent: AgentType,
  ui: TerminalUi,
): void {
  if (agent.getAgentMode() !== "plan") {
    ui.error("Switch to Plan mode to save a plan (/mode plan).");
    ui.command("");
    return;
  }

  const content = resolvePlanCommandContent(command, args, agent);
  if (!content) {
    reportMissingPlanDraft(ui);
    return;
  }

  saveApprovedPlanFromCommand(agent, ui, content);
}

async function handlePlanSubmission(
  trimmedInput: string,
  context: InteractiveSubmissionContext,
): Promise<number | null | undefined> {
  if (trimmedInput !== "/plan" && !trimmedInput.startsWith("/plan ")) {
    return undefined;
  }

  const { agent, ui } = context;
  const args = trimmedInput.slice("/plan".length).trim();

  if (args === "show") {
    handlePlanShowCommand(agent, ui);
    return null;
  }

  if (args === "save" || args.startsWith("save ")) {
    handlePlanSaveOrApproveCommand("save", args, agent, ui);
    return null;
  }

  if (args === "approve" || args.startsWith("approve ")) {
    handlePlanSaveOrApproveCommand("approve", args, agent, ui);
    return null;
  }

  ui.error(`Unknown /plan usage: "${args}"`);
  ui.command(
    "Usage: /plan save [content] | /plan approve [content] | /plan show",
  );
  ui.command("");
  return null;
}

async function handleChatSubmission(
  submission: PromptSubmission,
  context: InteractiveSubmissionContext,
): Promise<number | null | undefined> {
  context.ui.persistSubmittedInput(submission.displayText);
  return await runInteractiveTurn(submission, context, {
    errorPrefix: "Error: ",
  });
}

export async function handleInteractiveSubmission(
  submission: PromptSubmission,
  context: InteractiveSubmissionContext,
): Promise<number | null> {
  if (context.shouldExit()) {
    return 130;
  }

  if (isSubmissionEmpty(submission)) {
    return null;
  }

  const trimmedText = submission.text.trim();

  if (/^\/\w+/.test(trimmedText) && (submission.images?.length ?? 0) > 0) {
    context.ui.error("Images cannot be sent with slash commands.");
    return null;
  }

  const handlers: InteractiveInputHandler[] = [
    handleExitSubmission,
    handleHelpSubmission,
    handleClearSubmission,
    handleSkillsSubmission,
    handleSkillSubmission,
    handleModeSubmission,
    handlePlanSubmission,
    handleContextSubmission,
    handleSessionSubmission,
    handleToolsSubmission,
    handleMcpSubmission,
    handleModelSubmission,
  ];

  for (const handler of handlers) {
    const result = await handler(trimmedText, context);
    if (result !== undefined) {
      return result;
    }
  }

  const chatResult = await handleChatSubmission(submission, context);
  return chatResult ?? null;
}

function buildFooterVisibility(
  snapshot: { showToolCalls: boolean; showThinking: boolean },
  agent: AgentType,
): FooterVisibilityOptions {
  return {
    ...snapshot,
    agentMode: agent.getAgentMode?.() ?? "execute",
  };
}

// fallow-ignore-next-line complexity
export async function runInteractiveSession(
  agent: AgentType,
  ui: TerminalUi,
  configPath: string,
  abortState: AbortStateController,
  visibility: VisibilityOptions,
  runtimeConfig: RuntimeConfig,
): Promise<number> {
  const visibilityState = createSessionVisibilityState(visibility);
  const inputStream = process.stdin;
  const interactiveInput =
    Boolean(inputStream.isTTY) && Boolean(process.stdout.isTTY);
  const typeaheadProviders = [
    ...createDefaultTypeaheadProviders(process.cwd()),
    createSkillCommandTypeaheadProvider(() => agent.listUserInvocableSkills()),
  ];
  const getPromptFooters = (
    snapshot = visibilityState.getSnapshot(),
  ): { prompt: string; bash: string } => {
    const footerVisibility = buildFooterVisibility(snapshot, agent);
    return {
      prompt: getIdleFooterText(footerVisibility),
      bash: getBashFooterText(footerVisibility),
    };
  };

  const composer = createPromptComposer({
    input: inputStream,
    output: ui.getPromptOutputStream(),
    historyStore: createWorkspacePromptHistoryStore(),
    pasteCache: createPasteCache(),
    workspaceRoot: process.cwd(),
    typeaheadProviders,
    renderFooter: (footer) => {
      ui.idleFooter(footer);
    },
    refreshPromptFooters: () => getPromptFooters(),
    onToggleToolCalls: () => {
      visibilityState.toggleToolCalls();
      return composer.getState()?.inputMode === "bash"
        ? getPromptFooters().bash
        : getPromptFooters().prompt;
    },
    onToggleThinking: () => {
      visibilityState.toggleThinking();
      return composer.getState()?.inputMode === "bash"
        ? getPromptFooters().bash
        : getPromptFooters().prompt;
    },
    onCycleAgentMode: () => {
      agent.cycleAgentMode?.();
      return composer.getState()?.inputMode === "bash"
        ? getPromptFooters().bash
        : getPromptFooters().prompt;
    },
    renderState: (state) => {
      ui.setPromptState(state);
    },
  });
  abortState.setActiveComposer(composer);
  agent.setGlobalInstallApprovalCallback(async (request) => {
    return await composer.confirm({
      promptText: ui.prompt(
        `${request.reason}\n\nCommand: ${request.command}\n\nAllow this global install?`,
      ),
      defaultValue: false,
    });
  });

  try {
    ui.command("Type /help or ? to view available commands.");
    ui.command("Exit with /exit or Ctrl+C.");
    ui.command("");

    let shownReadyPromptMessage = false;
    let inputMode: InputMode = "prompt";
    const shellRunOptions =
      createShellRunOptionsFromRuntimeConfig(runtimeConfig);
    while (!abortState.shouldExit()) {
      ui.setMode("awaitingInput");
      if (!shownReadyPromptMessage) {
        ui.info("AI Agent started. Type your message.");
        shownReadyPromptMessage = true;
      }

      const visibilitySnapshot = buildFooterVisibility(
        visibilityState.getSnapshot(),
        agent,
      );
      const nextInput = await composer.compose({
        mode: "chat",
        inputMode,
        promptText: ui.chatPrompt(),
        bashPromptText: ui.bashPrompt(),
        footer:
          inputMode === "bash"
            ? getBashFooterText(visibilitySnapshot)
            : getIdleFooterText(visibilitySnapshot),
        bashFooter: getBashFooterText(visibilitySnapshot),
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
      const { submission } = nextInput;
      inputMode = submission.inputMode;
      const trimmedText = submission.text.trim();

      if (submission.inputMode === "bash") {
        const bashAbort = new AbortController();
        const bashCancelListener = createTurnCancelListener({
          input: inputStream,
          interactiveInput,
          onCancel: () => bashAbort.abort("escape"),
        });
        bashCancelListener.attach();
        try {
          await processBashCommand(trimmedText, ui, {
            cwd: process.cwd(),
            abortSignal: bashAbort.signal,
            agentMode: agent.getAgentMode?.() ?? "execute",
            ...shellRunOptions,
          });
        } finally {
          bashCancelListener.detach();
          inputMode = "prompt";
        }
        continue;
      }

      const exitCode = await handleInteractiveSubmission(submission, {
        agent,
        ui,
        composer,
        configPath,
        inputStream,
        interactiveInput,
        setCurrentAbortController: abortState.setCurrentAbortController,
        cancelActiveTurn: abortState.cancelActiveTurn,
        shouldExit: abortState.shouldExit,
        getVisibility: () => visibilityState.getSnapshot(),
      });
      if (exitCode !== null) {
        return exitCode;
      }
    }

    return 130;
  } finally {
    composer.close();
    abortState.setActiveComposer(null);
  }
}

function handleStaleMarkers(
  sessionsDir: string,
  ui: TerminalUi,
  diagnosticLogger: { onEvent: (event: AgentDiagnosticEvent) => void },
): void {
  const staleMarkers = findStaleMarkers(sessionsDir);
  for (const { sessionId, marker, ageMs } of staleMarkers) {
    const ageHours = Math.round(ageMs / (60 * 60 * 1000));
    const ageText =
      ageHours < 24 ? `${ageHours}h ago` : `${Math.round(ageHours / 24)}d ago`;
    if (!ui.isJsonMode()) {
      ui.warn(
        `Detected an incomplete session from ${ageText} (${marker.providerName}/${marker.modelKey}, turn ${marker.turnIndex}). Work since the last /exit was not saved.`,
      );
    }
    diagnosticLogger.onEvent({
      type: "mid_turn_crash_detected",
      provider: marker.providerName,
      model: marker.modelKey,
      turnIndex: marker.turnIndex,
      ageMs,
    });
    clearInProgressMarker(sessionsDir, sessionId);
  }
}

type ParsedCliArgs = ReturnType<typeof parseCliArgs>;

interface CliRuntimeOptions {
  interactive: boolean;
  plain: boolean;
  jsonMode: boolean;
  debugLlmToStderr: boolean;
  debugLlmFilePath?: string;
  diagnosticsEnabled: boolean;
  colorEnabled: boolean;
  visibility: VisibilityOptions;
}

function shouldUseInteractiveMode(
  parsedArgs: ParsedCliArgs,
  ci: boolean,
): boolean {
  return (
    Boolean(process.stdin.isTTY) &&
    Boolean(process.stdout.isTTY) &&
    !ci &&
    !parsedArgs.flags.noInteractive &&
    !parsedArgs.flags.json
  );
}

function shouldUsePlainOutput(parsedArgs: ParsedCliArgs, ci: boolean): boolean {
  return parsedArgs.flags.plain || !Boolean(process.stdout.isTTY) || ci;
}

function buildVisibilityOptions(
  flags: ParsedCliArgs["flags"],
): VisibilityOptions {
  const showTrace = flags.showTrace;
  return {
    showToolCalls: true,
    showThinking: true,
    showStatus: flags.showStatus || showTrace,
    showReasoningSummary: flags.showReasoningSummary || showTrace,
    showContextStats: flags.showContextStats,
    showPromptPlan: flags.showPromptPlan,
  };
}

function deriveCliRuntimeOptions(
  parsedArgs: ParsedCliArgs,
  ci: boolean,
): CliRuntimeOptions {
  const interactive = shouldUseInteractiveMode(parsedArgs, ci);
  const plain = shouldUsePlainOutput(parsedArgs, ci);
  const jsonMode = parsedArgs.flags.json && !parsedArgs.flags.help;
  const debugLlmToStderr = isLlmDebugEnabled(parsedArgs.flags.debugLlm);
  const debugLlmFilePath = parsedArgs.flags.debugLlmFile;

  return {
    interactive,
    plain,
    jsonMode,
    debugLlmToStderr,
    debugLlmFilePath,
    diagnosticsEnabled: debugLlmToStderr || Boolean(debugLlmFilePath),
    colorEnabled: !plain && !jsonMode && Boolean(process.stdout.isTTY),
    visibility: buildVisibilityOptions(parsedArgs.flags),
  };
}

function reportParseErrors(
  ui: TerminalUi,
  parseErrors: readonly string[],
): boolean {
  if (parseErrors.length === 0) {
    return false;
  }

  for (const error of parseErrors) {
    ui.error(error);
  }
  return true;
}

async function createInitializedAgent(
  parsedArgs: ParsedCliArgs,
  runtimeConfig: RuntimeConfig,
  diagnosticsEnabled: boolean,
  diagnosticLogger: { onEvent: (event: AgentDiagnosticEvent) => void },
): Promise<{ agent: AgentType; configPath: string }> {
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

  const agent = new agentModule.Agent({
    providersConfig,
    mcpConfig,
    mcpConfigPath,
    agentsMdContent,
    diagnosticsEnabled,
    onDiagnosticEvent: diagnosticLogger.onEvent,
    runtimeConfig,
  });
  await agent.initialize();

  if (parsedArgs.flags.mode) {
    agent.setAgentMode(parsedArgs.flags.mode);
  }

  return { agent, configPath };
}

async function runInteractiveMode(options: {
  agent: AgentType;
  ui: TerminalUi;
  configPath: string;
  abortState: AbortStateController;
  visibility: VisibilityOptions;
  runtimeConfig: RuntimeConfig;
}): Promise<number> {
  return await runInteractiveSession(
    options.agent,
    options.ui,
    options.configPath,
    options.abortState,
    options.visibility,
    options.runtimeConfig,
  );
}

async function handlePipeMode(options: {
  agent: AgentType;
  ui: TerminalUi;
  abortState: AbortStateController;
  visibility: VisibilityOptions;
}): Promise<number> {
  const exitCode = await runNonInteractiveSession(
    options.agent,
    options.ui,
    options.abortState.setCurrentAbortController,
    options.visibility,
  );
  return options.abortState.shouldExit() ? 130 : exitCode;
}

async function runConfiguredSession(options: {
  parsedArgs: ParsedCliArgs;
  runtime: CliRuntimeOptions;
  ui: TerminalUi;
  diagnosticLogger: { onEvent: (event: AgentDiagnosticEvent) => void };
  abortState: AbortStateController;
}): Promise<number> {
  if (!options.ui.isJsonMode()) {
    printStartupBanner(options.ui, getPackageVersion());
    options.ui.command("");
  }

  const sessionsDir = getDefaultSessionsDir();
  handleStaleMarkers(sessionsDir, options.ui, options.diagnosticLogger);
  const runtimeConfig = loadRuntimeConfig({
    cliOverrides: {
      maxIterations: options.parsedArgs.flags.maxIterations,
      maxRetries: options.parsedArgs.flags.maxRetries,
      bashDefaultTimeoutMs: options.parsedArgs.flags.bashTimeoutMs,
      streamIdleTimeoutMs: options.parsedArgs.flags.streamIdleTimeoutMs,
    },
  });
  pruneStaleSessionStorage(sessionsDir, runtimeConfig.artifactRetentionDays);

  const { agent, configPath } = await createInitializedAgent(
    options.parsedArgs,
    runtimeConfig,
    options.runtime.diagnosticsEnabled,
    options.diagnosticLogger,
  );

  try {
    return options.runtime.interactive
      ? await runInteractiveMode({
          agent,
          ui: options.ui,
          configPath,
          abortState: options.abortState,
          visibility: options.runtime.visibility,
          runtimeConfig,
        })
      : await handlePipeMode({
          agent,
          ui: options.ui,
          abortState: options.abortState,
          visibility: options.runtime.visibility,
        });
  } finally {
    await agent.close();
  }
}

async function main(): Promise<number> {
  const rawArgs = process.argv.slice(2);
  const parsedArgs = parseCliArgs(rawArgs);

  if (parsedArgs.flags.version) {
    process.stdout.write(`${getPackageVersion()}\n`);
    return 0;
  }

  const sandboxExitCode = await maybeRunSandboxDelegation(rawArgs);
  if (sandboxExitCode !== null) {
    return sandboxExitCode;
  }

  const ci = isCiEnvironment();
  const runtime = deriveCliRuntimeOptions(parsedArgs, ci);
  if (parsedArgs.flags.help) {
    process.stdout.write(HELP_TEXT);
    return 0;
  }

  setColorEnabled(runtime.colorEnabled);

  const { TerminalUi } = await import("./ui/terminal.js");
  const ui = new TerminalUi({
    interactive: runtime.interactive,
    plain: runtime.plain || parsedArgs.flags.help,
    json: runtime.jsonMode,
  });

  if (reportParseErrors(ui, parsedArgs.parseErrors)) {
    ui.cleanup();
    return 1;
  }

  const abortState = createAbortStateController(ui);
  const diagnosticLogger = createDiagnosticLogger({
    stderrEnabled: runtime.debugLlmToStderr,
    filePath: runtime.debugLlmFilePath,
  });
  process.on("SIGINT", abortState.handleSigint);

  try {
    return await runConfiguredSession({
      parsedArgs,
      runtime,
      ui,
      diagnosticLogger,
      abortState,
    });
  } finally {
    diagnosticLogger.cleanup();
    process.off("SIGINT", abortState.handleSigint);
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
