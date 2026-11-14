import { clonePromptState, type PromptState } from "./promptState.js";
import type { ToolCallDisplay } from "./toolCallDisplay.js";

export type ReplAppMode =
  "idle" | "running" | "awaitingInput" | "showingResults" | "error";

export type TranscriptEntry =
  | { kind: "tool_display"; text: string }
  | { kind: "user_message"; text: string }
  | { kind: "assistant_start" }
  | { kind: "assistant_token"; text: string }
  | { kind: "thinking_start" }
  | { kind: "thinking_token"; text: string }
  | { kind: "info"; text: string }
  | { kind: "command"; text: string }
  | { kind: "subtle"; text: string }
  | { kind: "warn"; text: string }
  | { kind: "success"; text: string }
  | { kind: "error"; text: string }
  | { kind: "section"; text: string }
  | { kind: "indent"; text: string }
  | {
      kind: "reasoning_summary";
      summary: string;
      source: "agent" | "provider";
    }
  | { kind: "turn_complete"; durationMs: number }
  | { kind: "turn_failed"; durationMs: number }
  | { kind: "bash_command"; text: string }
  | { kind: "bash_stdout"; text: string }
  | { kind: "bash_stderr"; text: string }
  | { kind: "json"; value: unknown };

export type EphemeralStatus =
  | { kind: "status"; text: string; phase?: string }
  | { kind: "progress"; current: number; total: number; label?: string };

export interface OverlayState {
  kind: "help" | "tools" | "custom";
  entries: readonly TranscriptEntry[];
}

export interface ReplUiState {
  transcript: readonly TranscriptEntry[];
  prompt: PromptState | null;
  status: EphemeralStatus | null;
  footer: string | null;
  mode: ReplAppMode;
  overlay: OverlayState | null;
  toolCallDisplays: ReadonlyMap<string, ToolCallDisplay>;
  toolCallDisplaysVersion: number;
}

export type ReplUiAction =
  | { type: "appendTranscriptEntry"; entry: TranscriptEntry }
  | { type: "setPrompt"; prompt: PromptState | null }
  | { type: "setStatus"; status: EphemeralStatus | null }
  | { type: "setFooter"; footer: string | null }
  | { type: "setMode"; mode: ReplAppMode }
  | { type: "openOverlay"; overlay: OverlayState }
  | { type: "closeOverlay" }
  | { type: "clearEphemeralSurfaces" }
  | { type: "upsertToolCallDisplay"; view: ToolCallDisplay };

function cloneOverlayState(overlay: OverlayState | null): OverlayState | null {
  if (!overlay) {
    return null;
  }

  return {
    kind: overlay.kind,
    entries: overlay.entries.map((entry) => ({ ...entry })),
  };
}

function cloneState(state: ReplUiState): ReplUiState {
  return {
    transcript: state.transcript.map((entry) => ({ ...entry })),
    prompt: state.prompt ? clonePromptState(state.prompt) : null,
    status: state.status ? { ...state.status } : null,
    footer: state.footer,
    mode: state.mode,
    overlay: cloneOverlayState(state.overlay),
    toolCallDisplays: new Map(state.toolCallDisplays),
    toolCallDisplaysVersion: state.toolCallDisplaysVersion,
  };
}

export class ReplUiStore {
  private state: ReplUiState;
  private readonly listeners = new Set<() => void>();

  constructor(initialState: Partial<ReplUiState> = {}) {
    this.state = {
      transcript: initialState.transcript
        ? initialState.transcript.map((entry) => ({ ...entry }))
        : [],
      prompt: initialState.prompt
        ? clonePromptState(initialState.prompt)
        : null,
      status: initialState.status ? { ...initialState.status } : null,
      footer: initialState.footer ?? null,
      mode: initialState.mode ?? "idle",
      overlay: cloneOverlayState(initialState.overlay ?? null),
      toolCallDisplays: new Map(),
      toolCallDisplaysVersion: 0,
    };
  }

  getState(): ReplUiState {
    return cloneState(this.state);
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  dispatch(action: ReplUiAction): void {
    if (!this.applyAction(action)) {
      return;
    }

    for (const listener of this.listeners) {
      listener();
    }
  }

  private applyAction(action: ReplUiAction): boolean {
    if (action.type === "upsertToolCallDisplay") {
      return this.applyUpsertToolCallDisplay(action.view);
    }

    this.applyStateAction(action);
    return true;
  }

  private applyStateAction(
    action: Exclude<ReplUiAction, { type: "upsertToolCallDisplay" }>,
  ): void {
    switch (action.type) {
      case "appendTranscriptEntry":
        this.dispatchAppendTranscriptEntry(action.entry);
        break;
      case "setPrompt":
        this.dispatchSetPrompt(action.prompt);
        break;
      case "setStatus":
        this.dispatchSetStatus(action.status);
        break;
      case "setFooter":
        this.dispatchSetFooter(action.footer);
        break;
      case "setMode":
        this.dispatchSetMode(action.mode);
        break;
      case "openOverlay":
        this.dispatchOpenOverlay(action.overlay);
        break;
      case "closeOverlay":
        this.dispatchCloseOverlay();
        break;
      case "clearEphemeralSurfaces":
        this.dispatchClearEphemeralSurfaces();
        break;
    }
  }

  private dispatchAppendTranscriptEntry(entry: TranscriptEntry): void {
    this.state = {
      ...this.state,
      status: null,
      transcript: [...this.state.transcript, { ...entry }],
    };
  }

  private dispatchSetPrompt(prompt: PromptState | null): void {
    this.state = {
      ...this.state,
      prompt: prompt ? clonePromptState(prompt) : null,
    };
  }

  private dispatchSetStatus(status: EphemeralStatus | null): void {
    this.state = {
      ...this.state,
      status: status ? { ...status } : null,
    };
  }

  private dispatchSetFooter(footer: string | null): void {
    this.state = {
      ...this.state,
      status: null,
      footer,
    };
  }

  private dispatchSetMode(mode: ReplAppMode): void {
    this.state = {
      ...this.state,
      mode,
    };
  }

  private dispatchOpenOverlay(overlay: OverlayState): void {
    this.state = {
      ...this.state,
      status: null,
      overlay: cloneOverlayState(overlay),
    };
  }

  private dispatchCloseOverlay(): void {
    this.state = {
      ...this.state,
      overlay: null,
    };
  }

  private dispatchClearEphemeralSurfaces(): void {
    this.state = {
      ...this.state,
      status: null,
      toolCallDisplays: new Map(),
      toolCallDisplaysVersion: this.state.toolCallDisplaysVersion + 1,
    };
  }

  private applyUpsertToolCallDisplay(view: ToolCallDisplay): boolean {
    const existing = this.state.toolCallDisplays.get(view.id);
    if (existing && JSON.stringify(existing) === JSON.stringify(view))
      return false;
    const newViews = new Map(this.state.toolCallDisplays);
    if (view.status === "running") newViews.set(view.id, structuredClone(view));
    else newViews.delete(view.id);
    this.state = {
      ...this.state,
      toolCallDisplays: newViews,
      toolCallDisplaysVersion: this.state.toolCallDisplaysVersion + 1,
    };
    return true;
  }

  appendTranscriptEntry(entry: TranscriptEntry): void {
    this.dispatch({ type: "appendTranscriptEntry", entry });
  }

  setPrompt(prompt: PromptState | null): void {
    this.dispatch({ type: "setPrompt", prompt });
  }

  setStatus(status: EphemeralStatus | null): void {
    this.dispatch({ type: "setStatus", status });
  }

  setFooter(footer: string | null): void {
    this.dispatch({ type: "setFooter", footer });
  }

  setMode(mode: ReplAppMode): void {
    this.dispatch({ type: "setMode", mode });
  }

  openOverlay(overlay: OverlayState): void {
    this.dispatch({ type: "openOverlay", overlay });
  }

  closeOverlay(): void {
    this.dispatch({ type: "closeOverlay" });
  }

  clearEphemeralSurfaces(): void {
    this.dispatch({ type: "clearEphemeralSurfaces" });
  }

  upsertToolCallDisplay(view: ToolCallDisplay): void {
    this.dispatch({ type: "upsertToolCallDisplay", view });
  }
}
