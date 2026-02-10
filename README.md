# Multi-Provider AI Agent

A TypeScript AI agent that supports multiple LLM providers (Ollama, Amazon Bedrock, and OpenRouter) with a unified interface and runtime provider switching capability.

## Prerequisites

- [Docker](https://docs.docker.com/get-docker/)
- [Ollama](https://ollama.ai/) running locally with the `qwen3-coder:30b` model

## Setup

1. Pull the Ollama model:

   ```bash
   ollama pull qwen3-coder:30b
   ```

2. Ensure Ollama is running:

   ```bash
   ollama serve
   ```

3. Create your environment file:

   ```bash
   cp .env.example .env
   ```

4. Create the configuration directory and providers file:

   ```bash
   mkdir .propio
   ```

   Create `.propio/providers.json` with your provider configuration (see Configuration section below for details).

## Running the Agent

### Using Docker Compose (recommended)

```bash
docker compose run --rm agent
```

### Using Docker directly

```bash
docker build -t ollama-agent .
docker run -it --rm ollama-agent
```

### Local development (without Docker)

```bash
npm install
npm run dev
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

- **save_session_context**: Saves the current session context to `session_context.txt`. The agent is instructed to call this after completing requests.
- **read_file**: Reads content from a file on the filesystem
- **write_file**: Writes content to a file on the filesystem

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
const response1 = await agent.chat('Hello!');

// Switch to Bedrock
(agent as any).switchProvider({
  provider: 'bedrock',
  bedrock: {
    model: 'global.anthropic.claude-sonnet-4-5-20250929-v1:0'
  }
});

// Continue chatting with Bedrock, session context is preserved
const response2 = await agent.chat('Continue the conversation...');
```

### Environment Variables

Copy `.env.example` to `.env` and modify as needed:

```bash
cp .env.example .env
```

| Variable       | Default                  | Description       |
| -------------- | ------------------------ | ----------------- |
| `OLLAMA_HOST`  | `http://localhost:11434` | Ollama server URL |
| `OLLAMA_MODEL` | `qwen3-coder:30b`        | Model to use      |

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
├── .env.example                         # Sample environment variables
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
  - `chat()`: Non-streaming completions
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

## Linux Users

On Linux, `host.docker.internal` may not work. Use one of these alternatives:

1. Add `--network=host` to docker run
2. Set `OLLAMA_HOST` to your host IP address
