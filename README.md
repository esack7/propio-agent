# propio-agent

A TypeScript CLI agent that supports multiple LLM providers (Ollama, Amazon Bedrock, OpenRouter, and xAI) through a unified interface, with tool calling, an agentic loop, and optional Docker sandbox isolation.

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

### 1. Install dependencies

```bash
npm install
```

### 2. Configure providers

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

# Or via npm start
npm start -- --sandbox
node dist/index.js --sandbox
```

For system-wide access from any directory, create a symlink:

```bash
ln -s /path/to/propio-agent/bin/propio-sandbox ~/bin/propio-sandbox
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

| Platform    | Path                                               |
| ----------- | -------------------------------------------------- |
| Unix/macOS  | `~/.propio/providers.json`                         |
| Windows     | `%USERPROFILE%\.propio\providers.json`             |

### Schema

```json
{
  "default": "<provider-name>",
  "providers": [
    {
      "name": "string — unique identifier for this entry",
      "type": "ollama | bedrock | openrouter | xai",
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

Start the agent and type messages at the prompt. Session context is maintained across turns.

### CLI flags

| Flag                        | Description                                              |
| --------------------------- | -------------------------------------------------------- |
| `--help`, `-h`              | Show CLI help                                            |
| `--sandbox`                 | Run in Docker sandbox mode                               |
| `--json`                    | Read one prompt from stdin, print JSON to stdout         |
| `--plain`                   | Disable ANSI colors and spinner                          |
| `--no-interactive`          | Disable prompts/spinners, read one prompt from stdin     |
| `--debug-llm`               | Emit provider diagnostics to stderr                      |
| `--debug-llm-file <path>`   | Append provider diagnostics to a file                    |

```bash
# One-shot non-interactive
echo "Summarize this repository." | npm start -- --no-interactive

# Machine-readable JSON output
echo "List top-level files." | npm start -- --json

# Persist diagnostics
npm start -- --debug-llm-file /tmp/propio-debug.log
```

### Session commands

| Command    | Description                          |
| ---------- | ------------------------------------ |
| `/clear`   | Clear session context                |
| `/context` | Show current session context         |
| `/tools`   | Enable or disable tools at runtime   |
| `/exit`    | Quit the agent                       |

---

## Tools

The agent has a built-in tool registry and an agentic loop: it calls tools, processes results, and can chain additional tool calls before returning a final response.

### Built-in tools

| Tool                   | Category   | Default  | Description                                        |
| ---------------------- | ---------- | -------- | -------------------------------------------------- |
| `read_file`            | Filesystem | enabled  | Read file contents                                 |
| `write_file`           | Filesystem | enabled  | Write content to a file                            |
| `list_dir`             | Filesystem | enabled  | List directory contents                            |
| `mkdir`                | Filesystem | enabled  | Create directories (recursive)                     |
| `move`                 | Filesystem | enabled  | Move or rename files and directories               |
| `remove`               | Filesystem | disabled | Delete files or directories ⚠️                     |
| `search_text`          | Search     | enabled  | Search for regex patterns in files                 |
| `search_files`         | Search     | enabled  | Find files by glob pattern                         |
| `run_bash`             | Execution  | disabled | Execute shell commands ⚠️                          |
| `save_session_context` | Context    | enabled  | Persist session context to `session_context.txt`   |

`remove` and `run_bash` are **disabled by default** because they are destructive or execute arbitrary code. Enable them at runtime with `/tools`, or programmatically:

```typescript
agent.toolRegistry.enable("remove");
agent.toolRegistry.enable("run_bash");
```

All filesystem tools validate paths to prevent traversal outside the working directory.

---

## Project Structure

```
propio-agent/
├── bin/
│   └── propio-sandbox          # Shell wrapper for Docker sandbox mode
├── src/
│   ├── index.ts                # CLI entry point
│   ├── agent.ts                # Agent class and agentic loop
│   ├── agentsMd.ts             # AGENTS.md loader
│   ├── diagnostics.ts          # LLM diagnostics helpers
│   ├── sandboxDelegation.ts    # Sandbox delegation logic
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
│   │   ├── sessionContext.ts   # Session context tool
│   │   └── __tests__/
│   └── ui/
│       ├── banner.ts           # Startup banner
│       ├── colors.ts           # Color helpers
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

### Tool registry

`src/tools/registry.ts` maintains the set of available tools and their enabled/disabled state. Tools can be toggled at runtime via `/tools` or the `agent.toolRegistry` API.

---

## Sandbox Mode

The sandbox runs the agent in Docker with filesystem isolation:

- **Read-write**: The current working directory is mounted at `/workspace`.
- **Read-only**: `~/.propio/` is mounted at `/app/.propio` (provider configs and credentials).
- **Blocked**: All other host paths.

### Environment variable passthrough

`bin/propio-sandbox` automatically forwards these variables when set in your shell:

| Variable                                            | Provider       |
| --------------------------------------------------- | -------------- |
| `OLLAMA_HOST`                                       | Ollama         |
| `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_SESSION_TOKEN` | Bedrock |
| `AWS_PROFILE`, `AWS_DEFAULT_REGION`, `AWS_REGION`  | Bedrock        |
| `OPENROUTER_API_KEY`                                | OpenRouter     |
| `XAI_API_KEY`                                       | xAI            |

> **Note:** When using `docker compose run --rm agent` directly, variables are not forwarded automatically — pass them with `-e VAR_NAME`.

---

## Troubleshooting

### Ollama tool calling: XML output instead of tool calls

**Symptom:**

```
<function=search_text>
<parameter=query>some query</parameter>
```

**Fix:** Switch to a model with better tool calling support:

```bash
ollama pull llama3.1:8b
# Update defaultModel in ~/.propio/providers.json
```

Models with confirmed good tool calling: `llama3.1:8b`, `llama3.1:70b`, `mistral:7b-instruct-v0.3`, `deepseek-coder-v2:16b`, `qwen2.5:14b`.

---

### Docker errors

| Error                                      | Fix                                                    |
| ------------------------------------------ | ------------------------------------------------------ |
| `docker: command not found`                | Install [Docker Desktop](https://docs.docker.com/get-docker/) |
| `Cannot connect to Docker daemon`          | Start Docker Desktop or the Docker service             |
| `no such file or directory: ./docker-compose.yml` | Run from the agent project directory           |
| `image not found`                          | Run `docker compose build`                             |

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
