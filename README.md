# @propio-ai/agent

A TypeScript CLI agent that supports multiple LLM providers (Ollama, Amazon Bedrock, OpenRouter, OpenAI, Meta, Gemini, xAI, Cloudflare Workers AI, and Anthropic) through a unified interface, with tool calling, an agentic loop, and optional Docker sandbox isolation. Install it as `@propio-ai/agent`, then run the `propio` command.

## Table of Contents

- [Prerequisites](#prerequisites)
- [Setup](#setup)
- [Running the Agent](#running-the-agent)
- [Configuration](#configuration)
- [Usage](#usage)
- [Tools](#tools)
- [Project Structure](#project-structure)
- [Architecture](#architecture)
- [Development](#development)
- [Sandbox Mode](#sandbox-mode)
- [Troubleshooting](#troubleshooting)

---

## Prerequisites

- Node.js 20+ with npm
- Docker and Docker Compose _(sandbox mode only)_
- [Ollama](https://ollama.ai/) _(Ollama provider only)_

---

## Setup

### Install

Install the published CLI package:

```bash
npm install -g @propio-ai/agent
```

Or run it ad hoc with npm:

```bash
npx @propio-ai/agent --help
```

For local development in this repository:

```bash
npm install
```

Run `npm start` from the directory you want to use as the workspace root. After a global install, run the `propio` command from any directory; it reads provider settings from `~/.propio/providers.json`.

### Configure providers

Create the config directory and provider file:

```bash
mkdir -p ~/.propio
```

Then create `~/.propio/providers.json`. See the [Configuration](#configuration) section for the full schema and per-provider examples.

### Configure MCP servers

External MCP servers are configured separately from providers in `~/.propio/mcp.json`.

```bash
mkdir -p ~/.propio
```

Then add MCP servers to `~/.propio/mcp.json`. See the [MCP](#mcp) section below for the v1 config shape and the Playwright example.

### Migrating from an older version

If you previously used a project-local `.propio/providers.json`:

```bash
mkdir -p ~/.propio
cp .propio/providers.json ~/.propio/providers.json
rm -rf .propio  # optional cleanup
```

---

## Running the Agent

### Native mode

Runs with full filesystem access — recommended for development on trusted codebases.

```bash
npm run build
npm start
```

For a faster dev loop without a build step:

```bash
npm run dev
```

### Sandbox mode

Runs the agent inside Docker, restricting filesystem access to the current working directory. Recommended when working on untrusted codebases.

```bash
# From the agent project directory
bin/propio-sandbox

# Or, after a global install, via the installed command
propio --sandbox
```

For system-wide access from any directory, create a symlink:

```bash
ln -s /path/to/propio/bin/propio-sandbox ~/bin/propio-sandbox
```

The sandbox wrapper automatically rebuilds the Docker image when the installed `@propio-ai/agent` package version differs from the version baked into the existing sandbox image.

When developing locally, rebuild the Docker image after same-version source changes:

```bash
docker compose build
```

### VS Code Dev Container

1. Open the project in VS Code.
2. Click **Reopen in Container** (or use **Dev Containers: Reopen in Container** from the Command Palette).
3. Run `npm run dev` inside the container.

---

## Configuration

Agent configuration lives in `~/.propio/providers.json` and is shared across all projects.

| Platform   | Path                                   |
| ---------- | -------------------------------------- |
| Unix/macOS | `~/.propio/providers.json`             |
| Windows    | `%USERPROFILE%\.propio\providers.json` |

MCP server configuration lives in `~/.propio/mcp.json`:

| Platform   | Path                             |
| ---------- | -------------------------------- |
| Unix/macOS | `~/.propio/mcp.json`             |
| Windows    | `%USERPROFILE%\.propio\mcp.json` |

### Schema

```json
{
  "default": "<provider-name>",
  "providers": [
    {
      "name": "string — unique identifier for this entry",
      "type": "ollama | bedrock | openrouter | openai | meta | gemini | xai | cloudflare | anthropic",
      "models": [
        {
          "name": "Human label",
          "key": "provider-model-id",
          "contextWindowTokens": 128000
        }
      ],
      "defaultModel": "provider-model-id"
    }
  ]
}
```

Every model entry must include `contextWindowTokens`. Provider implementations do not keep built-in model capability tables, so adding a model to an existing provider only requires updating `~/.propio/providers.json`.

### Ollama

```json
{
  "name": "local-ollama",
  "type": "ollama",
  "host": "http://localhost:11434",
  "models": [
    {
      "name": "Qwen3 Coder 30b",
      "key": "qwen3-coder:30b",
      "contextWindowTokens": 8192
    },
    {
      "name": "Llama 3.1 8b",
      "key": "llama3.1:8b",
      "contextWindowTokens": 131072
    }
  ],
  "defaultModel": "qwen3-coder:30b"
}
```

Pull a model before use:

```bash
ollama pull llama3.1:8b
ollama serve
```

> **Tip:** Not all Ollama models support tool calling well. If you see XML-like output (`<function=...>`) instead of real tool calls, switch to `llama3.1:8b` or `mistral:7b-instruct-v0.3`. See [Troubleshooting](#troubleshooting).

### Amazon Bedrock

```json
{
  "name": "bedrock",
  "type": "bedrock",
  "region": "us-east-1",
  "models": [
    {
      "name": "Claude Sonnet 4.5",
      "key": "global.anthropic.claude-sonnet-4-5-20250929-v1:0",
      "contextWindowTokens": 200000
    }
  ],
  "defaultModel": "global.anthropic.claude-sonnet-4-5-20250929-v1:0"
}
```

> **Important:** Claude 4.x models require **inference profile IDs** (e.g. `global.anthropic.claude-sonnet-4-5-...`). Direct model IDs will fail with an "on-demand throughput isn't supported" error. To list available profiles:
>
> ```bash
> aws bedrock list-inference-profiles --region us-east-1
> ```

### OpenRouter

Provides access to 300+ models through a single API key.

```json
{
  "name": "openrouter",
  "type": "openrouter",
  "models": [
    {
      "name": "GPT-4o",
      "key": "openai/gpt-4o",
      "contextWindowTokens": 128000
    },
    {
      "name": "DeepSeek Chat",
      "key": "deepseek/deepseek-chat",
      "contextWindowTokens": 128000
    }
  ],
  "defaultModel": "openai/gpt-4o",
  "apiKey": "sk-or-v1-...",
  "httpReferer": "https://myapp.com",
  "xTitle": "My App",
  "provider": {
    "allowFallbacks": true,
    "order": ["openai", "anthropic"],
    "requireParameters": false
  },
  "fallbackModels": ["openai/gpt-4o-mini", "openai/gpt-4.1-mini"],
  "debugEchoUpstreamBody": false
}
```

The `apiKey` can also be set via the `OPENROUTER_API_KEY` environment variable. `httpReferer` and `xTitle` are optional and used for OpenRouter leaderboard tracking. `xTitle` is still the config field name, and the provider sends it as `X-OpenRouter-Title`.

OpenRouter-specific routing fields:

- `provider.allowFallbacks` maps to OpenRouter `provider.allow_fallbacks`
- `provider.order` maps to OpenRouter `provider.order` and should list upstream provider identifiers
- `provider.requireParameters` maps to OpenRouter `provider.require_parameters`
- `fallbackModels` maps to OpenRouter `models`
- `debugEchoUpstreamBody` sends `debug.echo_upstream_body` when CLI debug logging is enabled

When OpenRouter returns a `429` or `503` for a tool-enabled request, the provider retries once without tools, shows a visible retry status, and emits a `provider_retry` diagnostic. The retry only disables tools for that single request; it does not change the provider's default tool behavior.

### OpenAI

The first-party OpenAI provider uses the Responses API. Model support is configuration-driven, so current and future OpenAI model IDs can be added without a CLI update.

```json
{
  "name": "openai",
  "type": "openai",
  "models": [
    {
      "name": "GPT-5.6 Sol",
      "key": "gpt-5.6-sol",
      "contextWindowTokens": 1050000
    }
  ],
  "defaultModel": "gpt-5.6-sol",
  "apiKey": "sk-..."
}
```

The `apiKey` can also be set via the `OPENAI_API_KEY` environment variable. Check [OpenAI's model catalog](https://developers.openai.com/api/docs/models) for current model IDs and context limits before changing configuration.

### Gemini

```json
{
  "name": "gemini",
  "type": "gemini",
  "models": [
    {
      "name": "Gemini 3.1 Pro Preview",
      "key": "gemini-3.1-pro-preview",
      "contextWindowTokens": 1048576
    },
    {
      "name": "Gemini 3 Flash Preview",
      "key": "gemini-3-flash-preview",
      "contextWindowTokens": 1048576
    },
    {
      "name": "Gemini 3.1 Flash-Lite Preview",
      "key": "gemini-3.1-flash-lite-preview",
      "contextWindowTokens": 1048576
    }
  ],
  "defaultModel": "gemini-3.1-pro-preview",
  "apiKey": "AIza..."
}
```

The `apiKey` can also be set via the `GEMINI_API_KEY` environment variable, with `GOOGLE_API_KEY` as a fallback. These models use Gemini's OpenAI-compatible chat-completions endpoint and support multimodal input.

### xAI

```json
{
  "name": "xai",
  "type": "xai",
  "models": [
    {
      "name": "Grok 4.3",
      "key": "grok-4.3",
      "contextWindowTokens": 1000000
    }
  ],
  "defaultModel": "grok-4.3",
  "apiKey": "xai-..."
}
```

The `apiKey` can also be set via the `XAI_API_KEY` environment variable.

### Cloudflare Workers AI

```json
{
  "name": "cloudflare",
  "type": "cloudflare",
  "models": [
    {
      "name": "Kimi K2.6",
      "key": "cf/moonshotai/kimi-k2.6",
      "contextWindowTokens": 262144
    }
  ],
  "defaultModel": "cf/moonshotai/kimi-k2.6",
  "apiKey": "cf-...",
  "accountId": "your-account-id"
}
```

The `accountId` can also be set via the `CLOUDFLARE_ACCOUNT_ID` environment variable. The API token can be set via `CLOUDFLARE_API_TOKEN`, with `CLOUDFLARE_AUTH_TOKEN` and `CLOUDFLARE_API_KEY` as fallbacks. Model keys prefixed with `cf/` in config are normalized to `@cf/...` when sent to the Cloudflare API.

### Anthropic (Claude API)

Calls the Claude API directly through the official `@anthropic-ai/sdk`. Unlike running Claude via Bedrock, this provider supports **extended thinking** (visible reasoning tokens replayed across tool-call rounds).

```json
{
  "name": "anthropic",
  "type": "anthropic",
  "models": [
    {
      "name": "Claude Sonnet 4.5",
      "key": "claude-sonnet-4-5",
      "contextWindowTokens": 200000
    },
    {
      "name": "Claude Opus 4.5",
      "key": "claude-opus-4-5",
      "contextWindowTokens": 200000
    }
  ],
  "defaultModel": "claude-sonnet-4-5",
  "apiKey": "sk-ant-..."
}
```

The `apiKey` can also be set via the `ANTHROPIC_API_KEY` environment variable. HTTP 529 (overloaded) responses are mapped to a retryable capacity error; rate limits, context-length errors, and model-not-found errors are surfaced as typed provider errors.

### Meta Model API

Meta uses the Responses API with streamed, stateless requests. The initial documented model is Muse Spark 1.1, while any future Meta model ID can be configured through the same model list without a CLI update.

```json
{
  "name": "meta",
  "type": "meta",
  "models": [
    {
      "name": "Muse Spark 1.1",
      "key": "muse-spark-1.1",
      "contextWindowTokens": 1048576
    }
  ],
  "defaultModel": "muse-spark-1.1",
  "apiKey": "your-meta-model-api-key"
}
```

The `apiKey` can also be set via the `META_API_KEY` environment variable. Inline `apiKey` takes precedence when both are present.

When Muse Spark provides a reasoning summary or `commentary`, interactive
sessions show it in the separate Thinking presentation before or between tool
calls; final answer text remains separate. `--show-reasoning-summary` (or
`--show-trace`) retains the complete provider summary for the completed turn
and labels its source as `provider`. Plain and non-interactive output keeps
live thinking out of the answer stream, while JSON includes the retained
summary only when that flag is set. Encrypted reasoning continuation data is
never displayed.

## MCP

`propio` loads MCP servers from `~/.propio/mcp.json` and exposes them through `/mcp`. Built-in tools still live under `/tools`.

### V1 config

Only stdio servers are supported in v1:

```json
{
  "mcpServers": {
    "playwright": {
      "command": "npx",
      "args": ["@playwright/mcp@latest"],
      "enabled": true
    }
  }
}
```

The common headless variant adds `--headless` to `args`:

```json
{
  "mcpServers": {
    "playwright": {
      "command": "npx",
      "args": ["@playwright/mcp@latest", "--headless"],
      "enabled": true
    }
  }
}
```

### MCP commands

| Command           | Description                                     |
| ----------------- | ----------------------------------------------- |
| `/mcp`            | Show MCP server status                          |
| `/mcp list`       | List configured MCP servers                     |
| `/mcp get <name>` | Show one MCP server, including discovered tools |
| `/mcp tools`      | List discovered MCP tools                       |
| `/mcp reconnect`  | Reconnect one MCP server                        |
| `/mcp enable`     | Enable one MCP server                           |
| `/mcp disable`    | Disable one MCP server                          |

`/tools` continues to manage only built-in tools. MCP tools are discovered and shown through `/mcp`, but they are still exposed to the model as normal tools during a turn when the server is connected.

---

## Usage

Start the agent and type messages at the prompt. Session context is maintained across turns, with structured context inspection and workspace-scoped session snapshots available from the CLI.

### CLI flags

| Flag                       | Description                                          |
| -------------------------- | ---------------------------------------------------- |
| `--help`, `-h`             | Show CLI help                                        |
| `--version`, `-v`          | Print package version and exit                       |
| `--sandbox`                | Run in Docker sandbox mode                           |
| `--json`                   | Read one prompt from stdin, print JSON to stdout     |
| `--plain`                  | Disable ANSI colors and spinner                      |
| `--no-interactive`         | Disable prompts/spinners, read one prompt from stdin |
| `--show-status`            | Show high-level agent status updates                 |
| `--show-reasoning-summary` | Show the turn reasoning summary after each response  |
| `--show-trace`             | Enable status and reasoning summary output           |
| `--show-context-stats`     | Print compact context stats after each turn          |
| `--show-prompt-plan`       | Print a compact prompt-plan summary for each request |
| `--debug-llm`              | Emit provider diagnostics to stderr                  |
| `--debug-llm-file <path>`  | Append provider diagnostics to a file                |

```bash
# One-shot non-interactive
echo "Summarize this repository." | propio --no-interactive

# Machine-readable JSON output
echo "List top-level files." | propio --json

# Persist diagnostics
propio --debug-llm-file /tmp/propio-debug.log
```

### Session commands

| Command              | Description                                            |
| -------------------- | ------------------------------------------------------ |
| `/help`              | Show slash-command help                                |
| `/clear`             | Clear session context                                  |
| `/model`             | Switch the current provider/model or update defaults   |
| `/context`           | Show structured context overview                       |
| `/context prompt`    | Show the latest prompt plan                            |
| `/context memory`    | Show rolling summary and pinned memory                 |
| `/tools`             | Enable or disable tools at runtime                     |
| `/session list`      | List saved session snapshots for the current workspace |
| `/session load`      | Load the latest saved session snapshot                 |
| `/session load <id>` | Load a specific saved session snapshot                 |
| `/exit`              | Save a session snapshot and quit                       |

Session snapshots are stored under `~/.propio/sessions/` and are scoped by workspace, so different repositories keep separate histories automatically.

Meta continuation state stored in session snapshots may include plaintext assistant commentary. Protect saved sessions as conversation content.

### Pasting image file paths (chat)

In interactive chat mode, you can drag or paste **local image file paths** into the prompt:

- Supported formats: PNG, JPEG, GIF, WebP (max 8 MiB per file).
- Paths may use `~/` (expanded to your home directory).
- The prompt shows an `[Image #N]` pill; the model receives `[Attached image: filename]` plus the image bytes (as a data URL).
- **Bash mode** (`!` prefix): paths are inserted as literal text (no image read).
- **BMP** is not supported — convert to PNG or JPEG first.
- **Slash commands** cannot include images; remove image pills before running `/help`, `/clear`, etc.

**Clipboard (macOS):** In chat mode, Cmd+V with an image on the clipboard (no text) inserts an `[Image #N]` pill when your terminal supports bracketed paste. TIFF-only clipboards are not supported in MVP. If AppleScript is insufficient in your environment, install optional [pngpaste](https://github.com/jcsalterego/pngpaste) via Homebrew (`brew install pngpaste`).

**Large paste history:** Submissions longer than 1024 characters are stored as `paste:<hash>` (or `!paste:<hash>` in bash mode) and restored from `~/.propio/paste-cache/` when you use Up/Down history or accept a reverse-history-search match. The cache is content-addressed and may retain sensitive pasted content indefinitely until you remove it manually (`rm -rf ~/.propio/paste-cache/`).

### How images reach the model

1. **Prompt pills** — `[Image #N]` in the buffer is what you see; on submit it expands to `[Attached image: filename]` in the text sent to the agent, with image bytes attached separately as `images` on the user turn.
2. **Providers** — **Bedrock**, **OpenAI**, **Meta**, **Gemini**, **Ollama**, and **Anthropic** send multimodal user messages (`content` plus `images` as data URLs or bytes). **OpenRouter** and **xAI** currently forward text only (`images` are accepted in the prompt and stored in sessions but not sent upstream). The live transcript shows pills (`displayText`), not expanded bodies or base64.
3. **Session files** — Saved sessions under `~/.propio/sessions/` store expanded marker text in `userMessage.content` and attachments in `userMessage.images`. Image-heavy sessions can grow large; pasted images may contain sensitive data.
4. **One-shot / piped stdin** — Non-interactive runs (`echo "hi" | propio`) do not accept pasted or dropped images; use the interactive TTY prompt for image input.

---

## Tools

The agent has a built-in tool registry and an agentic loop: it calls tools, processes results, and can chain additional tool calls before returning a final response.

### Built-in tools

| Tool    | Category   | Default  | Description                     |
| ------- | ---------- | -------- | ------------------------------- |
| `read`  | Filesystem | enabled  | Read file contents              |
| `write` | Filesystem | enabled  | Write content to a file         |
| `edit`  | Filesystem | enabled  | Replace exact strings in a file |
| `bash`  | Execution  | enabled  | Execute shell commands ⚠️       |
| `grep`  | Search     | disabled | Search file contents            |
| `find`  | Search     | disabled | Find files by glob pattern      |
| `ls`    | Filesystem | disabled | List directory contents         |

`grep`, `find`, and `ls` are **disabled by default**. `bash` is enabled by default because it is part of the core tool surface, but it can execute arbitrary commands, so use it carefully. Enable or disable tools at runtime with `/tools`, or programmatically:

```typescript
agent.enableTool("grep");
agent.enableTool("find");
agent.enableTool("ls");
```

The filesystem tools validate paths by rejecting malformed input and resolving relative paths from the current working directory. To confine filesystem access to the workspace, run the agent in sandbox mode.

---

## Project Structure

```
propio/
├── bin/
│   └── propio-sandbox          # Shell wrapper for Docker sandbox mode
├── src/
│   ├── index.ts                # CLI entry point
│   ├── agent.ts                # Agent class and agentic loop
│   ├── agentsMd.ts             # AGENTS.md loader
│   ├── context/                # Structured context, prompt planning, memory, persistence
│   ├── diagnostics.ts          # LLM diagnostics helpers
│   ├── sandboxDelegation.ts    # Sandbox delegation logic
│   ├── sessions/               # Session snapshot storage and slash-command handlers
│   ├── cli/
│   │   └── args.ts             # CLI argument parsing
│   ├── config/
│   │   └── providersConfig.ts  # Config path resolution + Propio-flavored loaders
│   ├── tools/
│   │   ├── interface.ts        # Tool interface
│   │   ├── types.ts            # Tool types
│   │   ├── registry.ts         # Tool registry
│   │   ├── factory.ts          # Default tool registry factory
│   │   ├── fileSystem.ts       # Filesystem tools
│   │   ├── search.ts           # Search tools
│   │   ├── bash.ts             # Bash execution tool
│   │   └── __tests__/
│   └── ui/
│       ├── banner.ts           # Startup banner
│       ├── colors.ts           # Color helpers
│       ├── contextInspector.ts # Structured context and prompt-plan views
│       ├── formatting.ts       # Output formatting
│       ├── markdownRenderer.ts # Terminal markdown rendering
│       ├── spinner.ts          # Ora spinner wrapper
│       ├── symbols.ts          # UI symbols
│       ├── terminal.ts         # Terminal utilities
│       └── toolMenu.ts         # Interactive tool enable/disable menu
├── Dockerfile
├── docker-compose.yml
├── jest.config.js
├── tsconfig.json
└── package.json
```

---

## Architecture

### Provider abstraction

The provider layer lives in the standalone [`@propio-ai/providers`](https://github.com/esack7/propio-providers) package. All LLM backends implement its `LLMProvider` interface, which exposes a single `streamChat()` method. The `Agent` class communicates only through this interface, making providers interchangeable at runtime.

Shared types from the package — `ChatMessage`, `ChatTool`, `ChatRequest`, `ChatResponse`, etc. — provide a provider-agnostic layer. Each provider implementation translates between these types and its own native API format.

Provider-specific errors (`ProviderError`, `ProviderAuthenticationError`, `ProviderRateLimitError`, `ProviderModelNotFoundError`) are also exported by the package and are thrown consistently across providers.

### Agentic loop

The `Agent` class (`src/agent.ts`) drives a tool-calling loop:

1. Send user message to the active provider.
2. If the provider returns tool calls, execute them via the tool registry.
3. Append tool results to the conversation and repeat.
4. Return the final text response to the caller.

### Context management

Structured session state is managed under `src/context/`.

- `ContextManager` owns turn-based conversation state
- `PromptBuilder` assembles provider payloads with budgeting and retry levels
- raw tool outputs are stored as artifacts and only inlined when needed
- older conversation can be represented by a rolling summary plus pinned memory
- session state can be serialized and restored structurally

The CLI exposes this state through `/context`, `/context prompt`, `/context memory`, `--show-context-stats`, and `--show-prompt-plan`.

### Reusable context API

The provisional `@propio-ai/agent/context` entry point exposes context management
without CLI startup, configuration loading, workspace discovery, or filesystem
writes. It requires Node.js 20+ and uses the common provider message contracts.

```typescript
import { ConversationManager } from "@propio-ai/agent/context";

const context = new ConversationManager();
context.beginUserTurn("Explain this text.");
const plan = context.buildPromptPlan("Be concise.", undefined, {
  contextWindowTokens: 32000,
  supplementalContext: ["Text supplied by the application."],
});
// Pass plan.messages to your provider.
```

From the package directory, run `npm run example:context` for a complete in-memory
consumer, including serialization. Build first when running from a source checkout;
the published package includes the example and compiled context API.
This API is an initial boundary inside the
agent package; a separate context package and production consumer are future work.

- `ConversationManager` owns turns, in-memory artifacts, pinned memory and summaries.
  The CLI's `ContextManager` adapter owns skill records and synthetic mention cleanup.
  Rendered supplemental contributions follow pinned memory in caller-supplied order.
- Pass a `tokenEstimator` to the manager, `PromptBuilder`, or `SummaryManager`.
  Implement `estimateText`, `estimateMessages`, and `estimateCharacters`.
  The default retains `ceil(characters / 4)`; image bytes/data-URL lengths and
  provider-specific framing are only approximations. Estimates are advisory,
  and required current-turn content can exceed a prompt budget.
  All estimators measure rendered turn messages and summary blocks. Compared with
  the previous CLI budgeting, counting tool-result formatting and truncation
  notices can retain fewer older turns near the limit. The rendered summary
  replaces the previous fixed wrapper estimate, which can also change selection.
- Pass an optional synchronous `artifactLookup(id)` to the manager to resolve
  caller-owned content; returning `undefined` falls back to its in-memory store.
  Artifact external paths are opaque metadata. The caller owns output-file
  storage, scratchpad allocation, and any filesystem access.
- `SummaryManager.generateSummary` accepts either a provider's `streamChat`
  contract or an async callback receiving the model, messages and abort signal.
  Consumers choose providers and models and schedule summary refreshes.
- `serializeContext` / `parseContext` encode and validate a core document at
  version 1. They perform no file access. Applications keep their own state
  envelopes; these functions do not encode CLI skills or mode/plan metadata.
  CLI sessions continue using the application codec: versions 1–4 load and
  version 4 is written, preserving images and opaque reasoning continuation.

The context API assumes sequential mutation. Browser portability, simultaneous
session writers and cross-process locking are not guaranteed.

### Reusable skills API (provisional)

Node.js consumers can import `@propio-ai/agent/skills` without starting the CLI,
reading Propio configuration, or scanning directories. This subpath stages the
skills boundary inside the agent package; it is not yet a separate skills package.

```typescript
import { loadSkills, parseSkillDocument } from "@propio-ai/agent/skills";

const { registry, diagnostics } = loadSkills({
  workspaceRoot: "/work/project",
  roots: [
    { source: "project", skillRoot: "/work/project/custom-skills" },
    { source: "user", skillRoot: "/work/shared-skills" },
  ],
});
registry.recordFileTouch(["src/app.ts"]);
const available = registry.listModelInvocable();

// Parsing supplied text performs no filesystem access.
const parsed = parseSkillDocument(
  "---\ndescription: Example\n---\nInstructions",
  {
    skillFile: "/work/project/custom-skills/example/SKILL.md",
    source: "project",
  },
);
```

`workspaceRoot`, discovery `skillRoot` paths and parser `skillFile` paths must be
absolute. Discovery reads `SKILL.md` inside immediate child directories, including
symlinked directories, ignoring `dist`, `node_modules`, `.git` and `coverage`.
Repeated normalized root paths are scanned once, retaining the last source and
position. Frontmatter and body extraction share the same whitespace-tolerant fences.
Missing roots are empty; filesystem read errors propagate. Roots are copied when
loading; `registry.refresh()` rescans those roots and `materialize()` reads the
current body. There are no watchers or writes. This is a Node filesystem adapter,
not a browser or sandbox API.

Skills within each root sort by normalized name and file path. Root order controls
precedence, independently of source labels. Later unscoped
entries with the same normalized name win; duplicates also produce diagnostics.
Path-scoped entries activate on matching workspace-relative file touches, retaining
the deepest-matching-root rule. Equal-depth matching entries retain the first
match; an unscoped entry later in the list overrides an earlier scoped entry.
The CLI supplies project then user `.propio/skills` roots, preserving its existing
behavior. Registry order remains stable across activation and refresh.

Metadata such as `allowedTools`, `context: fork`, `agent`, `model` and `effort`
describes requests, not granted capabilities. Loading or materializing never
executes instructions or shell substitutions. Unknown fields produce diagnostics;
consumers must decide whether to reject or enforce execution requests. The CLI
continues rejecting fork execution and warning when model/effort requests are not
applied. `materialize()` substitutes arguments but does not enforce invocation
eligibility or execution policy. Invocation records and scopes remain available
as typed metadata for the consuming runtime.

The standalone catalog example exercises the same API:

```bash
npm run example:skills -- /work/project '[{"source":"project","skillRoot":"/work/project/custom-skills"}]'
```

The subpath follows the agent package version and remains provisional until a real
second production consumer validates the boundary. It uses YAML and minimatch,
imports no agent internals, and retains Node.js 20+ requirements. Future standalone
extraction and publication require separate repository and release decisions.

### Reusable MCP API (provisional)

`@propio-ai/agent/mcp` exposes `McpConnectionManager`, configuration validation,
stable tool naming, and public connection/tool/result types. It requires Node.js
20+. Importing the entry point does not start the CLI, read configuration, scan
folders, or launch servers. The CLI uses this same manager through its local
configuration and executable-tool adapter.

```typescript
import { McpConnectionManager } from "@propio-ai/agent/mcp";

const mcp = new McpConnectionManager({
  config: { mcpServers: { example: { command: "my-mcp-server", args: [] } } },
  clientIdentity: { name: "my-application", version: "1.0.0" },
  connectTimeoutMs: 10_000,
  callTimeoutMs: 60_000,
  cleanupTimeoutMs: 500,
  // Optional: persistConfig: async (config) => applicationStore.save(config),
});
try {
  await mcp.initialize();
  for (const tool of mcp.listTools()) {
    console.log(tool.name, tool.inputSchema);
  }
  // await mcp.executeToolWithStatus("mcp__example__tool", { ... });
} finally {
  await mcp.close();
}
```

- Configuration and client identity are required. Configuration is validated and
  copied. No library operation reads or writes `~/.propio/mcp.json`; omitting
  `persistConfig` makes enable/disable changes in memory only. Persistence receives
  a detached configuration snapshot and a `{ serverName, enabled }` change record,
  and completes before runtime changes. A persistence callback
  rejection leaves runtime configuration and connections unchanged; the callback
  owns storage atomicity. If shutdown occurs during a successful write, the toggle
  resolves with the disabled shutdown state; the saved preference is retained and
  no connection is restarted. Enable/disable writes
  are serialized; applications own cross-process coordination.
- Only **stdio connections and tool listing/calling** are supported. HTTP, SSE,
  resources APIs, prompts APIs, and automatic tool-list updates are not supported.
  Reconnect explicitly to refresh tools. Commands inherit the SDK's default
  environment and process working directory; callers should supply absolute
  commands/arguments when location matters. This API provides no sandbox.
- Tool descriptors include the complete input JSON schema. Names retain the
  `mcp__server__tool` normalization and 64-character hash-bounded format. Conflicting
  normalized server names fail validation; conflicting tool names fail discovery.
  Supplied configurations now receive the same validation as file-loaded ones;
  omitted `mcpServers` means an empty catalog. Repeated identical remote names
  (including overlapping discovery pages) retain the first descriptor.
- Results are `{ status, content }`, with `status` equal to `success`, `error`,
  `tool_not_found`, or `tool_disabled`, and **content always a string**. Text and
  embedded resource text are retained; images/audio become MIME/size descriptions,
  resource links and binary resources become URI descriptions, and structured
  content is appended as formatted JSON. Raw media/SDK response objects are not
  exposed. Empty successful results retain the CLI success message; remote and
  transport errors retain its error text format.
- The connection deadline covers handshake and all discovery pages. The tool-call
  deadline defaults to the SDK's existing 60 seconds. Cleanup allows 500 ms before
  forcefully terminating the original direct child and then waits up to another
  cleanup interval. An isolated, tested compatibility shim captures the pinned
  SDK's child-process handle because its public PID/close API cannot distinguish
  process exit from closure of pipes inherited by helpers. Descendant process
  trees are not managed. `close()` is terminal; create a new manager to restart after shutdown.
  Individual failures remain visible in server summaries without aborting other
  servers' startup.

Run `npm run example:mcp` for an empty in-memory catalog, or pass a stdio command
and its arguments to discover real tools. The example is a standalone API consumer,
not a second production application. This provisional entry point follows the
agent package's versioning; incompatible API changes require explicit migration
notes. A separate MCP repository, production second consumer, and publication
remain future release milestones.

### Reusable tools API (provisional)

`@propio-ai/agent/tools` exposes an execution-only contract, registry, seven local
tools and an explicit Node shell adapter. Import and construction do not load CLI
configuration, scan the workspace, start a shell or create output files. Node.js
20+ is required. This stages phase 4 inside the agent package; standalone package
publication and a second production consumer remain separate milestones.

```typescript
import {
  createLocalTools,
  executeNodeShell,
  ToolRegistry,
} from "@propio-ai/agent/tools";

const registry = new ToolRegistry({
  approve: ({ name }) => name !== "bash", // caller-owned execution policy
});
for (const { tool, enabledByDefault } of createLocalTools({
  workspaceRoot: "/work/project",
  shellExecutor: executeNodeShell,
})) {
  registry.register(tool, enabledByDefault);
}
const result = await registry.executeWithStatus(
  "read",
  { path: "README.md" },
  {
    signal: new AbortController().signal,
  },
);
```

The factory requires an absolute `workspaceRoot` and a `shellExecutor`. Relative
filesystem paths and shell working directories resolve against that root. A
custom `resolvePath` can validate or map paths and must return absolute paths.
Local implementations retain the existing read/write/edit/search/list semantics:
atomic replacement writes, exact-match edits, text/binary checks and search
ordering. `read`, `write`, `edit` and `bash` start enabled; `grep`, `find` and `ls`
start disabled. Skill invocation, mode policy, scratchpad guidance, display
adapters and session-output storage remain runtime integrations. The CLI uses the
same implementations and execution registry with its existing settings. The CLI
workspace is captured at registry construction; later process-directory changes
do not retarget these tools.

`ExecutableTool` requires a provider-compatible schema and string execution result;
an optional `executeWithStatus` preserves structured integration errors. There is
no renderer in this contract. `createExecutableTool({ schema, invoke })` adapts a
caller-owned integration to it. For example, a consumer of the public MCP API can
build a schema from a `McpToolDescriptor` and delegate `invoke` to
`manager.executeToolWithStatus(descriptor.name, args)`. Neither reusable API needs
agent internals or imports the other. MCP cancellation remains governed by the
MCP manager's deadlines and shutdown; the adapter does not add remote cancellation.

Registry approval runs before execution, fails closed on exceptions and receives
a detached copy of arguments. Execution uses the reviewed snapshot, even if the
caller or approval callback mutates its copy. When approval is configured, arguments
must be structured-cloneable; non-cloneable values fail closed with a clear error.
There is no fallback to mutable references. Availability and cancellation are
checked again after approval. The four existing statuses remain unchanged:
`success`, `tool_not_found`, `tool_disabled` (including policy denial), and `error`
(including cancellation). Shell nonzero exit codes remain in the JSON content,
matching CLI behavior; they do not by themselves change the registry status.

Cancellation is cooperative. Pre-cancelled calls do not execute. Shell calls pass
the signal to the executor; the Node adapter terminates the direct shell process.
Filesystem tools check before starting, writes/edits also check before atomic
replacement begins, and grep checks between files. In-flight I/O, glob traversal,
completed writes, and an approval callback that ignores its signal cannot be
forcibly cancelled. Cancellation cannot roll back changes. The CLI now forwards
its cancellation signal to local tools as well as stopping its wait.

`processOutput({ name, result })` is an optional registry callback returning
`{ content, externalStorage? }`. Consumers choose storage, size thresholds and
preview formatting; the library never discovers session paths. The callback receives completed error
results too: inspect `result.status` before replacing failure text. Omitted
`externalStorage` preserves tool-supplied metadata. Full read/search
results are retained unless a consumer processes them. If this callback throws,
the original result is retained with `outputPersistenceError`, so a completed
write is not mistaken for a failed execution to retry. Shell output is already
bounded by the executor's buffer limit; persistence cannot recover discarded
bytes. `outputInlineLimit` retains the existing read byte-range cap and shell
buffer sizing; it does not cap full-file reads or grep results.

The default Node executor uses `/bin/sh`, inherits `process.env` with supplied
overrides. Forwarding the CLI turn signal selects the cancellable spawn backend.
Both backends enforce per-stream byte limits; the spawn backend now decodes UTF-8
across chunk boundaries and preserves the execFile empty-stderr failure message.
At a byte cap, an incomplete UTF-8 suffix is discarded rather than corrupted. Consumers can inject
a different executor for stronger lifecycle or isolation guarantees. The built-in
global-install classifier continues to deny matched commands unless the supplied
`shell.globalInstallGate` approves them or explicitly allows them without a prompt.
It is a heuristic, not comprehensive shell policy or process isolation. Workspace
resolution is not a sandbox: absolute paths, traversal and symlinks can access
outside the workspace; shell commands can access whatever the host permits.
Process-tree termination and cross-process filesystem coordination are not
provided. Use application/OS isolation where required.

Run `npm run example:tools` after building for a standalone consumer that performs
local read/write and adapts an integration without terminal rendering. Public
schemas use the shared providers contracts; implementation dependencies include
Node filesystem/process APIs and fast-glob. The subpath follows the agent package
version and remains provisional until a real second consumer validates it.

### Tool registry

`src/tools/registry.ts` maintains the set of available tools and their enabled/disabled state. Tools can be toggled at runtime via `/tools` or the `agent.enableTool()` / `agent.disableTool()` APIs.

---

## Development

### Pre-commit checks

Before committing TypeScript changes on a feature branch, run the full validation set below. A green test run alone is not enough; formatting and Fallow must also be clean on your branch delta.

```bash
npm run build
npm test
npm run format:check
npx fallow audit
```

All four commands should exit `0`.

| Check      | Command                | Required outcome                              |
| ---------- | ---------------------- | --------------------------------------------- |
| Type-check | `npm run build`        | Compiles with no errors                       |
| Tests      | `npm test`             | All suites pass                               |
| Formatting | `npm run format:check` | No Prettier drift (fix with `npm run format`) |
| Structure  | `npx fallow audit`     | See [Fallow audit](#fallow-audit)             |

Run `npx fallow audit` after substantial edits, refactors, or agent-generated changes. It complements tests and type-checking; it does not replace them.

### Fallow audit

[Fallow](https://docs.fallow.tools/) audits **files changed on your branch vs `main`**, not the entire repository on every run. That keeps the gate focused on what you are about to commit.

**Target state before commit:**

```text
✓ No issues in <N> changed files
```

In practice that means:

- **Exit code `0`** for `npx fallow audit`
- **Complexity:** no functions above threshold in the changed-file gate (summary should show `complexity 0`, not `complexity N (warn, …)`)
- **Duplication:** no clone groups reported as failing the gate (summary should not list `✗ … clone groups` under Duplication)
- **Dead code:** `0` dead files / dead exports in the metrics line

If Fallow reports complexity or duplication failures, fix them in the changed code (extract helpers, dedupe tests, split large functions) rather than relying on a passing test suite alone.

**What is out of scope for the default gate**

Fallow may note `audit gate excluded … inherited findings` for complexity or duplication that already exists on `main` in files you only touched lightly. Those inherited items do not block the default pre-commit audit. To enforce the full repo instead of the branch delta:

```bash
npx fallow audit --gate all
```

Use `--gate all` when doing a broader cleanup; for day-to-day feature work, the default branch-delta audit is the bar to clear before commit.

**Suppressions**

Prefer refactoring over `// fallow-ignore-next-line` comments. When a suppression is unavoidable, keep it on the specific line and document why in the PR if the reason is not obvious from the code.

---

## Sandbox Mode

The sandbox runs the agent in Docker with filesystem isolation:

- **Read-write**: The current working directory is mounted at `/workspace`.
- **Read-only**: `~/.propio/` is mounted at `/app/.propio` (provider configs and credentials).
- **Blocked**: All other host paths.

### Environment variable passthrough

`bin/propio-sandbox` automatically forwards these variables when set in your shell:

| Variable                                                          | Provider   |
| ----------------------------------------------------------------- | ---------- |
| `OLLAMA_HOST`                                                     | Ollama     |
| `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_SESSION_TOKEN` | Bedrock    |
| `AWS_PROFILE`, `AWS_DEFAULT_REGION`, `AWS_REGION`                 | Bedrock    |
| `GEMINI_API_KEY`, `GOOGLE_API_KEY`                                | Gemini     |
| `OPENROUTER_API_KEY`                                              | OpenRouter |
| `OPENAI_API_KEY`                                                  | OpenAI     |
| `XAI_API_KEY`                                                     | xAI        |
| `ANTHROPIC_API_KEY`                                               | Anthropic  |
| `META_API_KEY`                                                    | Meta       |

> **Note:** When using `docker compose run --rm agent` directly, variables are not forwarded automatically — pass them with `-e VAR_NAME`.

---

## Troubleshooting

### Ollama tool calling: XML output instead of tool calls

**Symptom:**

```
<function=grep>
<parameter=pattern>some query</parameter>
```

**Fix:** Switch to a model with better tool calling support:

```bash
ollama pull llama3.1:8b
# Update defaultModel in ~/.propio/providers.json
```

Models with confirmed good tool calling: `llama3.1:8b`, `llama3.1:70b`, `mistral:7b-instruct-v0.3`, `deepseek-coder-v2:16b`, `qwen2.5:14b`.

---

### OpenRouter upstream 429/503 with tools

**Symptom:**

OpenRouter returns `429` or `503` on the first tool-enabled turn, especially when a provider is overloaded or temporarily unavailable.

**Behavior:**

The provider now retries once without tools, surfaces a status message in the UI, and logs a `provider_retry` diagnostic when debug logging is enabled.

**What to check:**

- Confirm the provider config has the right `provider` routing hints and `fallbackModels` if you want OpenRouter to try alternate upstreams.
- If you need to debug the upstream request body, set `debugEchoUpstreamBody: true` and run with `--debug-llm` or `--debug-llm-file <path>`.
- If the retry still fails, the final error will include the upstream provider name and nested error text when OpenRouter provides it.

---

### Docker errors

| Error                                             | Fix                                                           |
| ------------------------------------------------- | ------------------------------------------------------------- |
| `docker: command not found`                       | Install [Docker Desktop](https://docs.docker.com/get-docker/) |
| `Cannot connect to Docker daemon`                 | Start Docker Desktop or the Docker service                    |
| `no such file or directory: ./docker-compose.yml` | Run from the agent project directory                          |
| `image not found`                                 | Run `docker compose build`                                    |

---

### Ollama unreachable from sandbox

The sandbox uses `host.docker.internal` to reach the host. On Linux this may not resolve — use your host's IP instead:

```bash
hostname -I
# Set OLLAMA_HOST=http://<your-ip>:11434 before running bin/propio-sandbox
```

Alternatively, add `--network=host` to the docker run command.

---

### AWS Bedrock auth fails in sandbox

Ensure credentials are exported in your shell before running `bin/propio-sandbox`:

```bash
export AWS_ACCESS_KEY_ID=...
export AWS_SECRET_ACCESS_KEY=...
bin/propio-sandbox
```

Or run `aws configure` and export `AWS_PROFILE`.

### Reusable agent core API (provisional)

`@propio-ai/agent/agent-core` exposes `AgentRuntime`, a headless model/tool loop.
The CLI's `Agent` uses this same runtime. Importing or constructing it performs no
configuration discovery, session access, directory scans, process startup, or
terminal rendering. It requires Node.js 20+ and uses the public provider,
context, and executable-tool contracts.

```typescript
import { AgentRuntime } from "@propio-ai/agent/agent-core";
import { ConversationManager } from "@propio-ai/agent/context";
import { ToolRegistry } from "@propio-ai/agent/tools";

// provider is an LLMProvider explicitly supplied by your application.
const runtime = new AgentRuntime({
  provider,
  model: "your-model-key",
  context: new ConversationManager(),
  tools: new ToolRegistry(),
  systemPrompt: "Answer questions about the supplied records.",
  policy: {
    maxIterations: 50,
    useNoProgressDetector: true,
    streamIdleTimeoutMs: 90000,
    outputTokenRecoveryLimit: 3,
  },
});
const controller = new AbortController();
const result = await runtime.streamChat(
  { text: "Explain these records." },
  (text) => process.stdout.write(text),
  { abortSignal: controller.signal, onEvent: (event) => recordEvent(event) },
);
// Call controller.abort() while a turn is running to cancel it.
```

Run `npm run example:agent-core` after building for a complete in-memory record
lookup application. It uses all three public entry points, executes a tool,
returns an answer, and demonstrates cancellation without provider credentials.
The example validates standalone consumption; a second production application,
a separate `@propio-ai/agent-core` repository, and publication remain separate
milestones. This API follows the agent package's version and remains provisional;
incompatible changes require explicit migration notes.

- Input is `{ text, images? }`. Images are provider-ready strings or byte arrays.
  Prompt-buffer text and input mode remain in the UI's `UiPromptSubmission` type.
  Internal UI type consumers must update the old `PromptSubmission` import name;
  runtime consumers use `PromptSubmission` from the public agent-core entry point.
- `streamChat` resolves to the final assistant response, preserving the existing
  CLI return contract. The token callback includes intermediate assistant text
  and existing tool-round separators. Typed events include `turn_started`,
  `assistant_text`, status/thinking updates, prompt plans, tool start/results,
  reasoning summaries, and exactly one normal completion or failure event.
  Pre-cancelled and overlapping calls reject before emitting events or changing
  context. `turn_failed` retains the original error; the CLI formats errors locally.
  Opaque provider continuation is retained in context, never included in thinking
  or token events. Consumers should treat context and prompt snapshots as private.
- Tool result events carry raw result text, arguments and execution status so
  consumers can choose their own rendering. Compatibility preview fields are plain
  text; `useLabel` is null. The CLI adds its existing tool labels and formatting,
  excludes runtime-only lifecycle events, and preserves its original event shapes.
- Supply a `ToolRegistry` or another `AgentToolExecutor`. The context implements
  the explicit `AgentContextStore` contract; `ConversationManager` satisfies it. The runtime filters
  schemas and denies execution outside `policy.allowedTools()` on each iteration.
  Execution/approval callbacks, workspace access and process isolation belong to
  the supplied executor. Thrown executor errors become failed tool results;
  cancellation interrupts the turn. The runtime itself provides no sandbox.
- Context-length recovery retains the existing levels 0–3 and bounded synchronous
  shrink attempts. `integrations.shrinkContext` can provide summarization; no
  summarizer or provider configuration is loaded implicitly. Repeated tool loops
  retain the existing final request without tools. Output-token recovery uses the
  supplied limit. Provider-owned retries and retry-without-tools policy are unchanged.
- Optional integrations prepare input, supply instructions and prompt plans, adapt
  provider messages, observe assistant/tool results, process artifacts, and manage
  application lifecycle work. The CLI supplies attachments, skills, mode prompts,
  summary scheduling, session markers, scratchpads and output persistence through
  these adapters. An instruction adapter returning `undefined` explicitly removes
  supplemental instructions; the raw option is used only when no adapter exists.
  Failure cleanup runs only once the start phase is entered, including partial
  startup failure, and never cleans up a previous turn after preparation fails.
  Session serialization and plan-file UX remain in `Agent`. Deprecated
  `onToolStart`/`onToolEnd` callbacks remain CLI-only; public runtime consumers use
  `onEvent`. Prompt snapshots are cloned only when an event listener is present.
  With no adapters, the supplied context keeps artifacts in memory; executor
  external-storage metadata is preserved. No files are allocated automatically.
- One turn may run per runtime instance. Applications must also avoid concurrent
  mutation of a shared context across instances. A runtime can handle sequential
  turns and guards against overlapping calls. The CLI creates one per turn to
  capture its current provider/model and owns a separate Agent-level overlap guard. Cancellation races provider/tool
  waits, forwards the signal to both, and ignores late results. Cleanup of a
  provider iterator on any early exit is best-effort: cancellation, idle timeout,
  and throwing consumer callbacks cannot wait indefinitely for `return()`.
  Normal stream exhaustion still awaits provider cleanup. This does not terminate uncooperative external
  work or roll back side effects. Integration callbacks must complete promptly;
  they own any external cleanup and must not mutate context after cancellation.
  Event and integration callbacks are trusted application code; exceptions fail
  the turn and may replace the original error during cleanup.
- By default, cancellation discards an empty incomplete current turn. Set
  `policy.discardInterruptedTurn` to customize this choice. The CLI keeps its
  existing Escape-only discard policy. Turns with committed entries are retained.

Compatibility fixes accompanying the boundary: cancellation in a tool-start
callback prevents dispatch, idle-timeout cleanup no longer blocks on a stalled
iterator, overlapping turns are rejected, and external artifact metadata from
public executors survives recording. An executor exception now becomes a failed
tool result and the model can continue, instead of failing the CLI turn immediately.
Existing CLI session formats, product
prompts, provider selection, and reasoning-continuation behavior are unchanged.

Quality gates use the repository-pinned Fallow 3.3.0 (`npm ci`), including
`npm run fallow:audit -- --base origin/main` and `npm run fallow:check` from an
unbuilt checkout. Newer Fallow releases can report additional inherited findings;
upgrading the auditor is a separate maintenance change. The `src/agent-core`
directory matches its export subpath so the pinned auditor resolves the source
without generated build files.
