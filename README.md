# Multi-Provider AI Agent

A TypeScript AI agent that supports multiple LLM providers (Ollama, Amazon Bedrock, and OpenRouter) with a unified interface and runtime provider switching capability.

## Prerequisites

### For Native Mode (npm start)

- Node.js 20+ with npm

### For Sandbox Mode (bin/propio-sandbox)

- [Docker](https://docs.docker.com/get-docker/) and [Docker Compose](https://docs.docker.com/compose/install/)
- Ollama (optional, for local LLM provider)

### Optional: Ollama Setup

To use Ollama as your LLM provider:

1. Install [Ollama](https://ollama.ai/)
2. Pull a model with **tool calling support**:

   ```bash
   # Recommended models with good tool calling support:
   ollama pull llama3.1:8b        # Llama 3.1 (fast, good tool calling)
   ollama pull mistral:7b-instruct-v0.3  # Mistral with tool support
   ollama pull deepseek-coder-v2:16b     # DeepSeek Coder v2

   # Or use your preferred model (tool calling quality varies by model)
   ollama pull qwen3-coder:30b
   ```

3. Ensure Ollama is running:
   ```bash
   ollama serve
   ```

**Important:** Not all Ollama models support tool calling equally well. If you see the model outputting XML-like syntax (`<function=...>`) instead of making actual tool calls, try switching to a different model known for better tool calling support (like `llama3.1:8b` or `mistral:7b-instruct-v0.3`).

## Setup

1. Pull the Ollama model:

   ```bash
   ollama pull qwen3-coder:30b
   ```

2. Ensure Ollama is running:

   ```bash
   ollama serve
   ```

3. Create the configuration directory and providers file:

   ```bash
   mkdir .propio
   ```

   Create `.propio/providers.json` with your provider configuration (see Configuration section below for details).

## Running the Agent

### Native Mode (unrestricted filesystem access)

```bash
npm install
npm start
```

### Sandbox Mode (recommended for untrusted codebases)

The sandbox mode restricts filesystem access to the current working directory, protecting your system from accidental or malicious file access.

**Prerequisites:** Docker and Docker Compose

#### From the agent directory:

```bash
bin/propio-sandbox
```

#### From any directory (including external repositories):

```bash
# Create a symlink for global access (optional)
ln -s /path/to/propio/bin/propio-sandbox ~/bin/propio-sandbox

# Then use from any directory
propio-sandbox
```

#### How it works:

- The current working directory is mounted as `/workspace` inside the container (read-write)
- Agent configuration (`.propio/`) is mounted as read-only from the agent installation directory
- LLM provider tools (`read_file`, `write_file`) can only access files within `/workspace` and its subdirectories
- Network access is preserved for LLM providers and local Ollama

#### Rebuild after code changes:

```bash
docker compose build
```

### Using Docker Compose (development)

```bash
docker compose run --rm agent
```

### Using Docker directly

```bash
docker build -t propio-agent .
docker run -it --rm propio-agent
```

### VS Code Dev Container

1. Open the project in VS Code
2. When prompted, click "Reopen in Container" (or use Command Palette: `Dev Containers: Reopen in Container`)
3. Wait for the container to build and dependencies to install
4. Run the agent:
   ```bash
   npm run dev
   ```

## Usage

Once running, type your messages and press Enter. The agent maintains session context across messages.

**Commands:**

- `/clear` - Clear session context
- `/context` - Show session context
- `/exit` - Quit the agent

## Tool Calling & Agentic Loop

The agent supports tool calling with an agentic loop, allowing it to:

1. Call tools to perform actions
2. See the results of those tool calls
3. Decide whether to call more tools or respond to the user
4. Chain multiple tool calls together to complete complex tasks

### Available Tools

The agent comes with 10 built-in tools for file operations, search, and execution:

#### Filesystem Tools

- **read_file**: Reads content from a file
- **write_file**: Writes content to a file
- **list_dir**: Lists directory contents with file/directory types
- **mkdir**: Creates directories (with recursive parent creation)
- **move**: Moves or renames files and directories
- **remove**: ⚠️ Deletes files or directories (recursive) - **Disabled by default**

#### Search Tools

- **search_text**: Searches for text patterns in files (supports regex)
- **search_files**: Finds files by glob patterns (e.g., `**/*.ts`)

#### Execution Tools

- **run_bash**: ⚠️ Executes shell commands - **Disabled by default**

#### Context Tools

- **save_session_context**: Saves current session context to `session_context.txt`

### Security: Destructive Tools

The `remove` and `run_bash` tools are **disabled by default** due to their destructive potential:

- **remove**: Can permanently delete files and directories
- **run_bash**: Can execute arbitrary shell commands

#### Enabling Destructive Tools

⚠️ **Warning**: Only enable these tools in trusted environments. All tools include path validation to prevent directory traversal, but destructive operations cannot be undone.

To enable these tools programmatically:

```typescript
import { Agent } from "./src/agent";
import { createDefaultToolRegistry } from "./src/tools/factory";

const agent = new Agent({
  providerConfig: {
    provider: "ollama",
    ollama: { model: "llama3.1:8b" },
  },
});

// Enable destructive tools
agent.toolRegistry.enable("remove"); // Enable file/directory deletion
agent.toolRegistry.enable("run_bash"); // Enable shell command execution
```

#### Security Features

All filesystem tools include:

- **Path validation**: Prevents access outside the current working directory
- **Error handling**: User-friendly error messages for permission, file-not-found, etc.
- **Async operations**: Non-blocking file I/O for better performance

### How it Works

When you send a message, the agent can:

- Call one or more tools
- Receive and process the tool results
- Make additional tool calls based on the results
- Provide a final response incorporating the information from the tools

You'll see notifications like `[Executing tool: save_session_context]` and `[Tool result: ...]` showing the agent's actions in real-time.

## Configuration

The agent is configured using a `.propio/providers.json` file in the project root. The `.propio` directory is gitignored to keep your provider configurations private.

### Provider Configuration File

Create `.propio/providers.json` with the following structure:

```json
{
  "default": "local-ollama",
  "providers": [
    {
      "name": "local-ollama",
      "type": "ollama",
      "host": "http://localhost:11434",
      "models": [
        {
          "name": "Qwen3 Coder: 30b",
          "key": "qwen3-coder:30b"
        },
        {
          "name": "GPT OSS: 20b",
          "key": "gpt-oss:20b"
        }
      ],
      "defaultModel": "qwen3-coder:30b"
    },
    {
      "name": "bedrock",
      "type": "bedrock",
      "region": "us-east-1",
      "models": [
        {
          "name": "Claude Sonnet 4.5",
          "key": "global.anthropic.claude-sonnet-4-5-20250929-v1:0"
        },
        {
          "name": "Claude Haiku 4.5",
          "key": "global.anthropic.claude-haiku-4-5-20251001-v1:0"
        },
        {
          "name": "Claude Opus 4.6",
          "key": "global.anthropic.claude-opus-4-6-v1"
        }
      ],
      "defaultModel": "global.anthropic.claude-sonnet-4-5-20250929-v1:0"
    }
  ]
}
```

**Configuration Fields:**

- `default`: The name of the default provider to use
- `providers`: Array of provider configurations
  - `name`: Unique identifier for this provider
  - `type`: Provider type (`ollama`, `bedrock`, or `openrouter`)
  - `host`: (Ollama only) Ollama server URL
  - `region`: (Bedrock only) AWS region
  - `apiKey`: (OpenRouter only) OpenRouter API key; can be omitted if `OPENROUTER_API_KEY` env var is set
  - `httpReferer`: (OpenRouter only, optional) Site URL for OpenRouter leaderboard tracking
  - `xTitle`: (OpenRouter only, optional) Site name for OpenRouter leaderboard tracking
  - `models`: Array of available models
    - `name`: Human-readable model name
    - `key`: Model identifier used by the provider
  - `defaultModel`: The default model key to use for this provider

#### Important: Bedrock Model IDs

For AWS Bedrock, you must use **inference profile IDs** instead of direct model IDs:

- ✅ **Correct**: `global.anthropic.claude-sonnet-4-5-20250929-v1:0`
- ❌ **Incorrect**: `anthropic.claude-sonnet-4-5-20250929-v1:0`

Newer Claude 4.x models require inference profiles to work with on-demand throughput. Using direct model IDs will result in an error: "on-demand throughput isn't supported."

The `global.anthropic.*` prefix provides cross-region inference profiles that support on-demand access. To list available inference profiles for your AWS account:

```bash
aws bedrock list-inference-profiles --region us-east-1
```

### Provider Interface

The agent supports multiple LLM providers through a unified interface:

### Ollama Provider (Default)

```javascript
import { Agent } from "./src/agent";

const agent = new Agent({
  providerConfig: {
    provider: "ollama",
    ollama: {
      model: "qwen3-coder:30b",
      host: "http://localhost:11434", // Optional, defaults to localhost:11434
    },
  },
});
```

### Amazon Bedrock Provider

```javascript
import { Agent } from "./src/agent";

const agent = new Agent({
  providerConfig: {
    provider: "bedrock",
    bedrock: {
      model: "global.anthropic.claude-sonnet-4-5-20250929-v1:0",
      region: "us-east-1", // Optional, defaults to us-east-1
    },
  },
});
```

**Note:** Use inference profile IDs (with `global.anthropic.*` or `us.anthropic.*` prefix) for Claude 4.x models. Direct model IDs will not work with on-demand throughput.

### OpenRouter Provider

[OpenRouter](https://openrouter.ai/) provides access to 300+ models (OpenAI, Anthropic, DeepSeek, etc.) through a single API. Use it for affordable models with tool-calling support.

**Required:** `type`, `models`, `defaultModel`, and either `apiKey` or the `OPENROUTER_API_KEY` environment variable.

**Optional:** `httpReferer` and `xTitle` for leaderboard/site tracking on OpenRouter.

**Model format:** Use OpenRouter's `provider/model` format (e.g. `openai/gpt-4o`, `openai/gpt-3.5-turbo`, `deepseek/deepseek-chat`).

Example `.propio/providers.json` with OpenRouter:

```json
{
  "default": "openrouter",
  "providers": [
    {
      "name": "openrouter",
      "type": "openrouter",
      "models": [
        { "name": "GPT-3.5 Turbo", "key": "openai/gpt-3.5-turbo" },
        { "name": "DeepSeek Chat", "key": "deepseek/deepseek-chat" }
      ],
      "defaultModel": "openai/gpt-3.5-turbo",
      "apiKey": "sk-or-v1-...",
      "httpReferer": "https://myapp.com",
      "xTitle": "My App"
    }
  ]
}
```

Store your API key in `.propio/providers.json` (the `.propio/` directory is in `.gitignore`) or set `OPENROUTER_API_KEY` in your environment. Affordable models with tool-calling support include `openai/gpt-3.5-turbo` and `deepseek/deepseek-chat`.

### Backward Compatibility

The agent maintains backward compatibility with legacy configuration:

```javascript
const agent = new Agent({
  model: "qwen3-coder:30b",
  host: "http://localhost:11434",
  systemPrompt: "You are a helpful assistant",
});
// This automatically uses Ollama provider with the specified settings
```

### Runtime Provider Switching

Switch between providers without losing session context:

```javascript
const agent = new Agent();

// Chat with Ollama
const response1 = await agent.streamChat('Hello!', (token) => {
  process.stdout.write(token);
});

// Switch to Bedrock
(agent as any).switchProvider({
  provider: 'bedrock',
  bedrock: {
    model: 'global.anthropic.claude-sonnet-4-5-20250929-v1:0'
  }
});

// Continue chatting with Bedrock, session context is preserved
const response2 = await agent.streamChat('Continue the conversation...', (token) => {
  process.stdout.write(token);
});
```

## Project Structure

```
├── .devcontainer/
│   └── devcontainer.json                # VS Code dev container config
├── src/
│   ├── agent.ts                          # Agent class with provider abstraction
│   ├── index.ts                          # CLI entry point
│   ├── providers/
│   │   ├── interface.ts                  # LLMProvider interface definition
│   │   ├── types.ts                      # Provider-agnostic types and errors
│   │   ├── config.ts                     # Provider configuration types
│   │   ├── ollama.ts                     # Ollama provider implementation
│   │   ├── bedrock.ts                    # Bedrock provider implementation
│   │   ├── openrouter.ts                 # OpenRouter provider implementation
│   │   └── __tests__/                    # Provider tests
│   └── __tests__/                        # Agent tests
├── Dockerfile
├── docker-compose.yml
├── jest.config.js                       # Jest testing configuration
├── package.json
└── tsconfig.json
```

## Provider Architecture

The agent uses a provider abstraction layer that allows swapping between different LLM backends without changing application code.

### Core Components

- **LLMProvider Interface** (`providers/interface.ts`): Defines the standard interface that all providers must implement
  - `streamChat()`: Streaming completions
  - `name`: Provider identifier

- **Provider-Agnostic Types** (`providers/types.ts`):
  - `ChatMessage`, `ChatTool`, `ChatToolCall`: Unified message and tool representations
  - `ChatRequest`, `ChatResponse`, `ChatChunk`: Unified request/response formats
  - Error types: `ProviderError`, `ProviderAuthenticationError`, `ProviderRateLimitError`, `ProviderModelNotFoundError`

- **Provider Implementations**:
  - `OllamaProvider`: Uses the Ollama local model server
  - `BedrockProvider`: Uses Amazon Bedrock with the AWS SDK
  - `OpenRouterProvider`: Uses OpenRouter's unified API (OpenAI-compatible)

### Type Translation

Each provider translates between its native types and the provider-agnostic types, allowing the Agent to work seamlessly with any provider.

## Sandbox Mode Details

### Environment Variable Handling

The `bin/propio-sandbox` wrapper automatically passes the following environment variables from your host into the container when they are set:

- `OLLAMA_HOST`: Ollama server URL (defaults to `http://host.docker.internal:11434` if not set)
- `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_SESSION_TOKEN`: For AWS Bedrock provider
- `AWS_PROFILE`, `AWS_DEFAULT_REGION`, `AWS_REGION`: Additional AWS configuration
- `OPENROUTER_API_KEY`: For OpenRouter provider

No extra configuration is needed — just set the variables in your shell before running `bin/propio-sandbox`.

**Note:** If you use `docker compose run --rm agent` directly, environment variables are not passed automatically. Use `-e VAR_NAME` flags to pass them manually.

**Note:** Model selection is configured via `.propio/providers.json`, not environment variables.

### Rebuild Requirement

**Important:** After modifying agent source code, rebuild the Docker image before using sandbox mode:

```bash
docker compose build
```

The `npm start` (native mode) does not require rebuilds and is faster for development iteration.

### Security Boundaries

The sandbox container enforces filesystem isolation through Docker volume mounts:

- **Read-write**: Current working directory mounted at `/workspace`
- **Read-only**: Agent configuration at `/app/.propio` (provider configs and credentials)
- **Blocked**: Access to home directory, system files, and other mounted paths

This ensures that LLM tool calls (`read_file`, `write_file`) cannot access sensitive files outside the current project directory.

## Troubleshooting

### Tool Calling Issues with Ollama

**Symptom:** The agent outputs XML-like text instead of actually calling tools:

```xml
<function=search_text>
<parameter=query>some query</parameter>
```

**Cause:** The model doesn't properly support Ollama's native tool calling format.

**Solution:**

1. Switch to a model with better tool calling support:

   ```bash
   ollama pull llama3.1:8b
   # Update your .propio/providers.json to use llama3.1:8b
   ```

2. Models with confirmed good tool calling support:
   - `llama3.1:8b`, `llama3.1:70b` - Excellent tool calling
   - `mistral:7b-instruct-v0.3` - Good tool calling
   - `deepseek-coder-v2:16b` - Good for coding tasks
   - `qwen2.5:14b` - Decent tool calling

3. Test tool calling works:
   ```
   You: List the files in the src directory
   Assistant: [Executing tool: list_dir]  ← Should see this, not XML output
   ```

### Docker Errors

**Error: `docker: command not found`**

Docker is not installed. Install Docker Desktop from https://docs.docker.com/get-docker/

**Error: `Cannot connect to Docker daemon`**

Docker daemon is not running. Start Docker Desktop or the Docker service.

**Error: `no such file or directory: ./docker-compose.yml`**

Make sure you're running the command from the agent project directory.

**Error: `image not found`**

Rebuild the Docker image:

```bash
docker compose build
```

### Provider Connection Issues

**Ollama in sandbox mode doesn't connect**

The sandbox uses `host.docker.internal` to reach services on the host. Ensure Ollama is listening on the network (not localhost-only).

On Linux, `host.docker.internal` may not work. Use your host's IP address instead by setting `OLLAMA_HOST` in docker-compose.yml:

```bash
# Find your host IP
hostname -I
# Then set in docker-compose.yml environment section
OLLAMA_HOST=http://192.168.1.100:11434
```

**AWS Bedrock authentication fails in sandbox**

Ensure AWS credentials are available. Set credentials via docker-compose.yml environment section or pass them as command-line flags:

1. AWS CLI: `aws configure` (then pass via environment)
2. Environment variables: `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`

## Linux Users

On Linux, `host.docker.internal` may not work. Use one of these alternatives:

1. Add `--network=host` to docker run
2. Set `OLLAMA_HOST` to your host IP address
