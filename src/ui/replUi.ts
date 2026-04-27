import type { PromptState } from "./promptState.js";

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
  | { kind: "json"; value: unknown };

export type EphemeralStatus =
  | { kind: "status"; text: string; phase?: string }
  | { kind: "progress"; current: number; total: number; label?: string };

export interface ToolActivityState {
  text: string;
  level: "info" | "error";
}

export interface OverlayState {
  kind: "help" | "tools" | "custom";
  entries: readonly TranscriptEntry[];
}

export interface ReplUiState {
  transcript: readonly TranscriptEntry[];
  prompt: PromptState | null;
  status: EphemeralStatus | null;
  activity: ToolActivityState | null;
  footer: string | null;
  mode: ReplAppMode;
  overlay: OverlayState | null;
}

export type ReplUiAction =
  | { type: "appendTranscriptEntry"; entry: TranscriptEntry }
  | { type: "setPrompt"; prompt: PromptState | null }
  | { type: "setStatus"; status: EphemeralStatus | null }
  | { type: "setActivity"; activity: ToolActivityState | null }
  | { type: "setFooter"; footer: string | null }
  | { type: "setMode"; mode: ReplAppMode }
  | { type: "openOverlay"; overlay: OverlayState }
  | { type: "closeOverlay" }
  | { type: "clearEphemeralSurfaces" };

function clonePromptState(state: PromptState): PromptState {
  return {
    ...state,
    history: state.history ? [...state.history] : undefined,
    historySearch: state.historySearch ? { ...state.historySearch } : undefined,
    typeahead: state.typeahead
      ? {
          ...state.typeahead,
          matches: [...state.typeahead.matches],
        }
      : undefined,
  };
}

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
    activity: state.activity ? { ...state.activity } : null,
    footer: state.footer,
    mode: state.mode,
    overlay: cloneOverlayState(state.overlay),
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
      activity: initialState.activity ? { ...initialState.activity } : null,
      footer: initialState.footer ?? null,
      mode: initialState.mode ?? "idle",
      overlay: cloneOverlayState(initialState.overlay ?? null),
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
          activity: null,
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
      case "setActivity":
        this.state = {
          ...this.state,
          activity: action.activity ? { ...action.activity } : null,
        };
        break;
      case "setFooter":
        this.state = {
          ...this.state,
          status: null,
          activity: null,
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
          activity: null,
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
          activity: null,
        };
        break;
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

  setActivity(activity: ToolActivityState | null): void {
    this.dispatch({ type: "setActivity", activity });
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
}
