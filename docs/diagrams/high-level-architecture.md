# High-Level Architecture

A high-level data flow diagram of the propio-agent project.

```mermaid
flowchart TB
    User([User])

    subgraph CLI["CLI Layer (src/index.ts, src/cli)"]
        Args[Argument Parsing<br/>--sandbox, --json, etc.]
        Prompt[Prompt Composer<br/>+ Slash Commands<br/>/help /model /tools /context /mcp]
        Renderer[Assistant Turn Renderer<br/>streaming output, spinners]
    end

    subgraph Config["Configuration (~/.propio/)"]
        Providers[(providers.json)]
        Mcp[(mcp.json)]
        Sessions[(sessions/)]
        AgentsMd[(AGENTS.md<br/>workspace)]
    end

    subgraph Agent["Agent Core (src/agent.ts)"]
        Loop{{Agentic Loop<br/>send -> tool calls -> repeat}}
    end

    subgraph Context["Context Management (src/context)"]
        CM[ContextManager<br/>turn-based state]
        PB[PromptBuilder<br/>budgeting + retry levels]
        Mem[Rolling Summary<br/>+ Pinned Memory]
        Arti[Tool Artifacts]
    end

    subgraph Providers["LLMProvider Interface (src/providers)"]
        IFace[streamChat]
        Ollama[Ollama]
        Bedrock[Bedrock]
        OR[OpenRouter]
        Gem[Gemini]
        XAI[xAI]
    end

    subgraph Tools["Tool Layer"]
        Reg[Tool Registry<br/>src/tools/registry.ts]
        Builtin[Built-in Tools<br/>read, write, edit, bash,<br/>grep, find, ls]
        McpMgr[MCP Manager<br/>src/mcp]
        McpSrv[(External MCP Servers<br/>e.g. playwright)]
    end

    LLMs[(LLM Backends<br/>Ollama / AWS / OpenRouter /<br/>Google / xAI)]
    Sandbox[Docker Sandbox<br/>bin/propio-sandbox]

    User -->|prompt| Prompt
    Args --> Agent
    Prompt -->|user message| Loop
    Loop -->|response stream| Renderer
    Renderer -->|text| User

    Providers -.loads.- Providers
    Providers -.loads.- Mcp
    AgentsMd -.system prompt.-> PB
    Sessions <-.snapshot save/load.-> CM

    Loop <-->|conversation state| CM
    CM --> Mem
    CM --> Arti
    CM -->|turn history| PB
    PB -->|ChatRequest| IFace

    IFace --> Ollama
    IFace --> Bedrock
    IFace --> OR
    IFace --> Gem
    IFace --> XAI
    Ollama & Bedrock & OR & Gem & XAI -->|HTTP / SDK| LLMs
    LLMs -.streamed chunks.-> IFace
    IFace -->|ChatResponse<br/>text + tool_calls| Loop

    Loop -->|tool_call| Reg
    Reg --> Builtin
    Reg --> McpMgr
    McpMgr <-->|stdio JSON-RPC| McpSrv
    Builtin -->|result| Loop
    McpMgr -->|result| Loop

    Args -.optional.-> Sandbox
    Sandbox -.runs.-> Agent
```

## Reading guide

The main loop in one sentence: User prompt → `Agent` appends it to `ContextManager` → `PromptBuilder` assembles a `ChatRequest` → the selected `LLMProvider` streams a response → if the response contains tool calls, `Agent` dispatches them to built-in tools or MCP servers and feeds results back into the loop → otherwise the final text streams back to the user.

## Key components

- **CLI Layer** (`src/index.ts`, `src/cli/`) — argument parsing, prompt composer, slash commands, streaming output renderer.
- **Agent Core** (`src/agent.ts`) — drives the agentic loop: send → tool calls → repeat → final response.
- **Context Management** (`src/context/`) — `ContextManager` owns turn state; `PromptBuilder` assembles provider payloads with budgeting and retry levels; tool outputs stored as artifacts; older history compacted via rolling summary plus pinned memory.
- **LLMProvider Interface** (`src/providers/`) — single `streamChat()` method abstracts five backends (Ollama, Bedrock, OpenRouter, Gemini, xAI). Provider-agnostic types in `types.ts`.
- **Tool Layer** (`src/tools/`, `src/mcp/`) — registry of built-in tools plus an MCP manager that proxies external stdio MCP servers; both return results into the agent loop the same way.
- **Configuration** (`~/.propio/`) — `providers.json`, `mcp.json`, session snapshots; workspace-local `AGENTS.md` feeds the system prompt.
- **Sandbox Mode** (`bin/propio-sandbox`) — optional Docker wrapper that runs the agent with filesystem access scoped to the current working directory.
