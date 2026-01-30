# Ollama Agent

A TypeScript AI agent that interacts with a local Ollama model (qwen3-coder:30b) running in a Docker container.

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

Once running, type your messages and press Enter. The agent maintains conversation history across messages.

**Commands:**
- `/clear` - Clear conversation history
- `/history` - Show conversation history
- `/exit` - Quit the agent

## Tool Calling

The agent supports tool calling, allowing it to interact with the filesystem and manage conversation history. Available tools:

- **save_history**: Saves the current conversation to `history.txt`. The agent is instructed to call this automatically after each exchange.
- **read_file**: Reads content from a file on the filesystem
- **write_file**: Writes content to a file on the filesystem

When the agent uses a tool, you'll see a notification like `[Tool: save_history executed]` in the output.

## Configuration

Copy `.env.example` to `.env` and modify as needed:

```bash
cp .env.example .env
```

| Variable | Default | Description |
|----------|---------|-------------|
| `OLLAMA_HOST` | `http://localhost:11434` | Ollama server URL |
| `OLLAMA_MODEL` | `qwen3-coder:30b` | Model to use |

## Project Structure

```
├── .devcontainer/
│   └── devcontainer.json  # VS Code dev container config
├── src/
│   ├── agent.ts           # Agent class with chat functionality
│   └── index.ts           # CLI entry point
├── .env.example           # Sample environment variables
├── Dockerfile
├── docker-compose.yml
├── package.json
└── tsconfig.json
```

## Linux Users

On Linux, `host.docker.internal` may not work. Use one of these alternatives:

1. Add `--network=host` to docker run
2. Set `OLLAMA_HOST` to your host IP address
