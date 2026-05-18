import { clonePromptState, type PromptState } from "./promptState.js";
import type { ToolCallView } from "./toolCallView.js";

export type ReplAppMode =
  | "idle"
  | "running"
  | "awaitingInput"
  | "showingResults"
  | "error";

export type TranscriptEntry =
  | { kind: "user_message"; text: string }
  | { kind: "assistant_start" }
  | { kind: "assistant_token"; text: string }
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
  toolCallViews: ReadonlyMap<string, ToolCallView>;
  toolCallViewsVersion: number;
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
  | { type: "upsertToolCallView"; view: ToolCallView };

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
    toolCallViews: new Map(state.toolCallViews),
    toolCallViewsVersion: state.toolCallViewsVersion,
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
      toolCallViews: new Map(),
      toolCallViewsVersion: 0,
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
    switch (action.type) {
      case "appendTranscriptEntry":
        this.state = {
          ...this.state,
          status: null,
          transcript: [...this.state.transcript, { ...action.entry }],
        };
        break;
      case "setPrompt":
        this.state = {
          ...this.state,
          prompt: action.prompt ? clonePromptState(action.prompt) : null,
        };
        break;
      case "setStatus":
        this.state = {
          ...this.state,
          status: action.status ? { ...action.status } : null,
        };
        break;
      case "setFooter":
        this.state = {
          ...this.state,
          status: null,
          footer: action.footer,
        };
        break;
      case "setMode":
        this.state = {
          ...this.state,
          mode: action.mode,
        };
        break;
      case "openOverlay":
        this.state = {
          ...this.state,
          status: null,
          overlay: cloneOverlayState(action.overlay),
        };
        break;
      case "closeOverlay":
        this.state = {
          ...this.state,
          overlay: null,
        };
        break;
      case "clearEphemeralSurfaces":
        this.state = {
          ...this.state,
          status: null,
          toolCallViews: new Map(),
          toolCallViewsVersion: this.state.toolCallViewsVersion + 1,
        };
        break;
      case "upsertToolCallView": {
        let base = this.state.toolCallViews;
        const existing = base.get(action.view.id);
        if (
          existing &&
          existing.status === action.view.status &&
          existing.useLabel === action.view.useLabel &&
          existing.resultLabel === action.view.resultLabel
        ) {
          break;
        }
        if (
          action.view.status === "running" &&
          base.size > 0 &&
          [...base.values()].every((v) => v.status !== "running")
        ) {
          base = new Map();
        }
        const newViews = new Map(base);
        newViews.set(action.view.id, action.view);
        this.state = {
          ...this.state,
          toolCallViews: newViews,
          toolCallViewsVersion: this.state.toolCallViewsVersion + 1,
        };
        break;
      }
    }

    for (const listener of this.listeners) {
      listener();
    }
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

  upsertToolCallView(view: ToolCallView): void {
    this.dispatch({ type: "upsertToolCallView", view });
  }

}
