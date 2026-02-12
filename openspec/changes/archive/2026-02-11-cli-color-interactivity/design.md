## Context

The CLI (`src/index.ts`) currently uses plain `console.log` and `process.stdout.write` for all output. There is no `src/ui/` directory. The agent (`src/agent.ts`) emits tool execution status through an `onToken` callback rather than writing to stdout directly. The project is TypeScript targeting ES2020. A prerequisite ESM migration change will convert the project from CommonJS to ESM modules before this change is implemented.

## Goals / Non-Goals

**Goals:**

- Create a `src/ui/` module that centralizes all terminal formatting (colors, symbols, high-level formatters, spinners)
- Apply color-coded output to all CLI message types: user prompts, assistant responses, tool execution, errors, commands, and informational text
- Add spinner feedback during tool execution in the agent
- Respect `NO_COLOR` environment variable and degrade gracefully when terminal lacks color support

**Non-Goals:**

- Syntax highlighting for code blocks in assistant responses (Phase 3 / future)
- Markdown rendering of assistant output (Phase 3 / future)
- Config file for UI preferences (future)
- Interactive prompts with arrow-key selection (future)
- Multiple theme support (only One Atom Dark for now)

## Decisions

### 1. Use chalk 5.6.2 and ora 9.3.0 (latest ESM versions)

With the prerequisite ESM migration in place, the project can use the latest versions of both libraries directly.

**Chosen**: Pin chalk at 5.6.2 and ora at 9.3.0.

**Rationale**: Both libraries are ESM-only from chalk v5 and ora v6 onward. Since the project will be ESM after the prerequisite migration, there is no reason to use older CommonJS-compatible versions.

### 2. Module structure: four files under `src/ui/`

```
src/ui/
├── colors.ts       — Color palette constants + themed formatting functions
├── symbols.ts      — Unicode symbols with ASCII fallbacks
├── formatting.ts   — High-level formatters (formatUserMessage, formatToolExecution, etc.)
└── spinner.ts      — OperationSpinner wrapper around ora
```

**Rationale**: Keeps concerns separated. `colors.ts` is the foundation that other modules import. `formatting.ts` composes colors + symbols into ready-to-use message formatters for the CLI. `spinner.ts` wraps ora for consistent start/succeed/fail behavior. A single `src/ui/index.ts` barrel export is not needed since each consumer imports what it needs directly.

### 3. NO_COLOR support via chalk's built-in detection

Chalk 5 respects `NO_COLOR`, `FORCE_COLOR`, and detects terminal color level automatically. The `colors.ts` module will rely on chalk's built-in behavior rather than implementing custom detection. If `NO_COLOR=1` is set, chalk returns unstyled strings.

### 4. Spinner integration via new `onToolStart` / `onToolEnd` callbacks

Currently, tool execution status is emitted through the `onToken` callback as inline text (`[Executing tool: X]`, `[Tool result: ...]`). To support spinners, `streamChat` will accept two additional optional callbacks:

```typescript
onToolStart?: (toolName: string) => void;
onToolEnd?: (toolName: string, result: string) => void;
```

When these callbacks are provided, the agent will call them instead of emitting the bracketed text through `onToken`. When not provided, existing behavior is preserved (backwards-compatible). The CLI entry point (`index.ts`) will provide implementations that use `OperationSpinner`.

**Alternative considered**: Having the agent import UI modules directly. Rejected because agent.ts should remain UI-agnostic—it's a reusable module that shouldn't depend on terminal formatting.

### 5. Color scheme: One Atom Dark palette via chalk hex colors

Chalk 5 supports `chalk.hex()` for truecolor terminals. The color palette from the plan will be defined as chalk instances in `colors.ts`:

| Role          | Hex       | Chalk call             |
| ------------- | --------- | ---------------------- |
| User input    | `#56B6C2` | `chalk.hex('#56B6C2')` |
| Assistant     | `#ABB2BF` | `chalk.hex('#ABB2BF')` |
| Tool/Function | `#C678DD` | `chalk.hex('#C678DD')` |
| Success       | `#98C379` | `chalk.hex('#98C379')` |
| Error         | `#E06C75` | `chalk.hex('#E06C75')` |
| Warning       | `#D19A66` | `chalk.hex('#D19A66')` |
| Command       | `#E5C07B` | `chalk.hex('#E5C07B')` |
| Subtle/Muted  | `#5C6370` | `chalk.hex('#5C6370')` |
| Info          | `#61AFEF` | `chalk.hex('#61AFEF')` |

On terminals that don't support truecolor, chalk automatically downgrades to the nearest 256-color or basic ANSI color.

### 6. Symbol fallback for limited terminals

`symbols.ts` will export Unicode symbols (e.g., `❯`, `◆`, `✔`, `✖`) with ASCII fallbacks (e.g., `>`, `*`, `√`, `x`) selected based on whether the terminal supports Unicode. Detection will use a simple check on `process.platform` and `process.env.TERM`.

## Risks / Trade-offs

- **Depends on ESM migration landing first** → Mitigation: The ESM migration is a separate prerequisite change that must be completed before this work begins. chalk 5.6.2 and ora 9.3.0 are ESM-only.
- **Spinner conflicts with streaming output** → Mitigation: The spinner must be stopped before any `process.stdout.write` calls during token streaming. The `onToolStart`/`onToolEnd` callback design ensures the spinner lifecycle is managed by the CLI layer, not the agent.
- **Colored output in piped/redirected scenarios** → Mitigation: Chalk 5 auto-detects non-TTY stdout and disables colors. No additional handling needed.
