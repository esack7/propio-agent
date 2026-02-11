## Why

The agent's `read_file` and `write_file` tools currently accept arbitrary filesystem paths with no validation. The LLM can read or write any file the Node.js process has OS-level permissions to access, including sensitive files outside the project directory (e.g., `~/.aws`, `~/.ssh`, `/etc`). Additionally, users need to run the agent in external repositories (not just the agent's own directory) with those repositories sandboxed.

## What Changes

- Add Docker containerization support with filesystem isolation
- Add CLI wrapper script (`bin/propio-sandbox`) that can be run from any directory
- Add `Dockerfile` that builds the app at `/app` but runs from sandboxed `/workspace`
- Add `docker-compose.yml` for Docker configuration and development use
- CLI wrapper dynamically mounts current working directory as the sandbox boundary
- No code changes needed in `src/index.ts` or `src/agent.ts` - Docker enforces the boundary at the container level

## Capabilities

### New Capabilities

- `docker-sandbox`: Run the agent in an isolated Docker container with filesystem access restricted to the current working directory. The sandbox is optional and can be invoked via a CLI wrapper script from any directory.

### Modified Capabilities

None. This adds a new execution mode without changing existing behavior.

## Impact

**Build System**:
- New Docker build configuration (Dockerfile, docker-compose.yml)
- Requires Docker installed to use sandbox mode
- Docker image must be rebuilt after agent source code changes

**Runtime Environment**:
- Two execution modes: native (`npm start`) and sandboxed (`bin/propio-sandbox`)
- In sandbox mode, filesystem operations are physically constrained by Docker volume mounts
- Config files (`.propio/`) mounted read-only from agent installation directory
- Current working directory mounted read-write at `/workspace`
- Can be run from any directory, not just agent's own directory

**Dependencies**:
- Docker and Docker Compose required for sandbox mode
- Native mode unchanged (no new dependencies)

**Development Workflow**:
- `npm start` - unchanged, runs natively without sandbox
- `bin/propio-sandbox` - new, runs in Docker container from any directory
- CLI wrapper can be symlinked to PATH for global access (e.g., `ln -s ~/propio/bin/propio-sandbox ~/bin/`)
- After code changes, must rebuild Docker image with `docker compose build`
