# propio

A TypeScript CLI agent that supports multiple LLM providers (Ollama, Amazon Bedrock, OpenRouter, Gemini, and xAI) through a unified interface, with tool calling, an agentic loop, and optional Docker sandbox isolation.

## Table of Contents

- [Prerequisites](#prerequisites)
- [Setup](#setup)
- [Running the Agent](#running-the-agent)
- [Configuration](#configuration)
- [Usage](#usage)
- [Tools](#tools)
- [Project Structure](#project-structure)
- [Architecture](#architecture)
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

Install the published CLI:

```bash
npm install -g propio
```

Or run it ad hoc with npm:

```bash
npx propio --help
```

For local development in this repository:

```bash
npm install
```

Run `propio` from the directory you want to use as the workspace root; it reads provider settings from `~/.propio/providers.json`.

### Configure providers

Create the config directory and provider file:

```bash
mkdir -p ~/.propio
```

Then create `~/.propio/providers.json`. See the [Configuration](#configuration) section for the full schema and per-provider examples.

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

Rebuild the Docker image after code changes:

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

### Schema

```json
{
  "default": "<provider-name>",
  "providers": [
    {
      "name": "string — unique identifier for this entry",
      "type": "ollama | bedrock | openrouter | gemini | xai",
      "models": [{ "name": "Human label", "key": "provider-model-id" }],
      "defaultModel": "provider-model-id"
    }
  ]
}
```

### Ollama

```json
{
  "name": "local-ollama",
  "type": "ollama",
  "host": "http://localhost:11434",
  "models": [
    { "name": "Qwen3 Coder 30b", "key": "qwen3-coder:30b" },
    { "name": "Llama 3.1 8b", "key": "llama3.1:8b" }
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
      "key": "global.anthropic.claude-sonnet-4-5-20250929-v1:0"
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
    { "name": "GPT-4o", "key": "openai/gpt-4o" },
    { "name": "DeepSeek Chat", "key": "deepseek/deepseek-chat" }
  ],
  "defaultModel": "openai/gpt-4o",
  "apiKey": "sk-or-v1-...",
  "httpReferer": "https://myapp.com",
  "xTitle": "My App"
}
```

The `apiKey` can also be set via the `OPENROUTER_API_KEY` environment variable. `httpReferer` and `xTitle` are optional and used for OpenRouter leaderboard tracking.

### Gemini

```json
{
  "name": "gemini",
  "type": "gemini",
  "models": [
    { "name": "Gemini 3.1 Pro Preview", "key": "gemini-3.1-pro-preview" },
    { "name": "Gemini 3 Flash Preview", "key": "gemini-3-flash-preview" },
    {
      "name": "Gemini 3.1 Flash-Lite Preview",
      "key": "gemini-3.1-flash-lite-preview"
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
  "models": [{ "name": "Grok Beta", "key": "grok-beta" }],
  "defaultModel": "grok-beta",
  "apiKey": "xai-..."
}
```

The `apiKey` can also be set via the `XAI_API_KEY` environment variable.

---

## Usage

Start the agent and type messages at the prompt. Session context is maintained across turns, with structured context inspection and workspace-scoped session snapshots available from the CLI.

### CLI flags

| Flag                       | Description                                           |
| -------------------------- | ----------------------------------------------------- |
| `--help`, `-h`             | Show CLI help                                         |
| `--sandbox`                | Run in Docker sandbox mode                            |
| `--json`                   | Read one prompt from stdin, print JSON to stdout      |
| `--plain`                  | Disable ANSI colors and spinner                       |
| `--no-interactive`         | Disable prompts/spinners, read one prompt from stdin  |
| `--show-activity`          | Show tool start/finish/failure activity events        |
| `--show-status`            | Show high-level agent status updates                  |
| `--show-reasoning-summary` | Show the turn reasoning summary after each response   |
| `--show-trace`             | Enable activity, status, and reasoning summary output |
| `--show-context-stats`     | Print compact context stats after each turn           |
| `--show-prompt-plan`       | Print a compact prompt-plan summary for each request  |
| `--debug-llm`              | Emit provider diagnostics to stderr                   |
| `--debug-llm-file <path>`  | Append provider diagnostics to a file                 |

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
| `/context`           | Show structured context overview                       |
| `/context prompt`    | Show the latest prompt plan                            |
| `/context memory`    | Show rolling summary and pinned memory                 |
| `/tools`             | Enable or disable tools at runtime                     |
| `/session list`      | List saved session snapshots for the current workspace |
| `/session load`      | Load the latest saved session snapshot                 |
| `/session load <id>` | Load a specific saved session snapshot                 |
| `/exit`              | Save a session snapshot and quit                       |

Session snapshots are stored under `~/.propio/sessions/` and are scoped by workspace, so different repositories keep separate histories automatically.

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
│   ├── providers/
│   │   ├── interface.ts        # LLMProvider interface
│   │   ├── types.ts            # Shared message/request/response types
│   │   ├── config.ts           # Provider config types
│   │   ├── configLoader.ts     # Config file loading
│   │   ├── factory.ts          # Provider factory
│   │   ├── ollama.ts           # Ollama provider
│   │   ├── bedrock.ts          # Amazon Bedrock provider
│   │   ├── openrouter.ts       # OpenRouter provider
│   │   ├── gemini.ts           # Gemini provider
│   │   ├── xai.ts              # xAI provider
│   │   └── __tests__/
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
├── openspec/                   # Spec-driven change management
├── Dockerfile
├── docker-compose.yml
├── jest.config.js
├── tsconfig.json
└── package.json
```

---

## Architecture

### Provider abstraction

All LLM backends implement the `LLMProvider` interface (`src/providers/interface.ts`), which exposes a single `streamChat()` method. The `Agent` class communicates only through this interface, making providers interchangeable at runtime.

Shared types (`src/providers/types.ts`) — `ChatMessage`, `ChatTool`, `ChatRequest`, `ChatResponse`, etc. — provide a provider-agnostic layer. Each provider implementation translates between these types and its own native API format.

Provider-specific errors (`ProviderError`, `ProviderAuthenticationError`, `ProviderRateLimitError`, `ProviderModelNotFoundError`) are also defined in `types.ts` and are thrown consistently across providers.

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

### Tool registry

`src/tools/registry.ts` maintains the set of available tools and their enabled/disabled state. Tools can be toggled at runtime via `/tools` or the `agent.enableTool()` / `agent.disableTool()` APIs.

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
| `XAI_API_KEY`                                                     | xAI        |

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
