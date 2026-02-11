# Plan: Docker-Based Sandbox for Agent

**Status:** Pending review
**Date:** 2026-02-10

## Problem

The agent's `read_file` and `write_file` tools accept arbitrary filesystem paths with no validation. The LLM can read or write any file the Node.js process has OS-level permissions to access, including files outside the project directory.

## Goal

Restrict the agent's filesystem access to the current project directory and its subdirectories using Docker container isolation. The sandbox should be optional — easy to toggle on and off.

## How Docker Sandboxing Works

Docker containers can only access files explicitly mounted into them. By mounting only the project directory, the agent is physically unable to touch anything else on the host filesystem, regardless of what paths the LLM tries.

## Toggle Mechanism

- `npm start` — runs natively, no sandbox (unchanged behavior)
- `npm run start:sandbox` — runs inside a Docker container (sandboxed)

Uses `docker compose run --rm` instead of `docker compose up` because this is an interactive CLI tool, not a background service.

## Changes Required

### 1. `Dockerfile`

Build the app at `/app`, but set the runtime working directory to `/workspace` (the mount point for the project directory).

```dockerfile
FROM node:20-alpine

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm install

# Copy source code
COPY tsconfig.json ./
COPY src ./src

# Build TypeScript
RUN npm run build

# Set default environment variables
ENV OLLAMA_HOST=http://host.docker.internal:11434

# Create workspace directory for volume mount
RUN mkdir -p /workspace

# Run from workspace so process.cwd() resolves inside the sandbox
WORKDIR /workspace

# Reference built app by absolute path
CMD ["node", "/app/dist/index.js"]
```

**Key changes:**
- Added `RUN mkdir -p /workspace`
- Changed `WORKDIR` to `/workspace` (from `/app`)
- Changed `CMD` to use absolute path `/app/dist/index.js` (since cwd is now `/workspace`)

### 2. `docker-compose.yml`

Mount the project directory and config with appropriate permissions.

```yaml
services:
  agent:
    build: .
    stdin_open: true
    tty: true
    volumes:
      - ./.propio:/app/.propio:ro   # Config (read-only)
      - ./:/workspace               # Project directory (read-write sandbox)
    extra_hosts:
      - "host.docker.internal:host-gateway"
```

**Key changes:**
- Added `./.propio:/app/.propio:ro` — config accessible but write-protected
- Added `./:/workspace` — project directory mounted as the agent's sandbox boundary

### 3. `package.json`

Add a sandbox script.

```json
"scripts": {
  "build": "tsc",
  "start": "node dist/index.js",
  "start:sandbox": "docker compose run --rm agent",
  "dev": "ts-node src/index.ts",
  "test": "jest",
  "test:watch": "jest --watch",
  "test:openrouter": "jest openrouter",
  "format": "prettier --write .",
  "format:check": "prettier --check ."
}
```

**Key change:**
- Added `start:sandbox` script

### 4. `src/index.ts` — No changes needed

- Config path: resolves from `__dirname` (`/app/dist/../.propio/providers.json` → `/app/.propio/providers.json`), which matches the read-only volume mount.
- Session context path: uses `process.cwd()` which will be `/workspace` in Docker, mapping back to the project root on the host.

### 5. `src/agent.ts` — No changes needed

All filesystem operations go through `fs.readFileSync` / `fs.writeFileSync` which are constrained by the container's filesystem view. No application-level path validation is needed because Docker enforces the boundary.

## What the Sandbox Enforces

| Concern | Behavior in sandbox |
|---|---|
| Read files in project directory | Allowed (via `/workspace` mount) |
| Write files in project directory | Allowed (via `/workspace` mount) |
| Read/write provider config | Read-only (`:ro` mount) |
| Access `~/.aws`, `~/.ssh`, `/etc` | Blocked (not mounted) |
| Absolute host paths (e.g., `/Users/...`) | Fail inside container (desired) |
| Network access to LLM providers | Allowed (Docker default networking) |
| Access to host Ollama instance | Allowed (via `host.docker.internal`) |

## Notes

- After changing agent source code, the Docker image must be rebuilt. Use `docker compose build` or `docker compose run --build --rm agent`.
- If AWS credentials are needed for Bedrock, they must be passed as environment variables via `docker compose` environment config, since `~/.aws` is not mounted.
