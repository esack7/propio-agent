## Context

The agent currently runs as a native Node.js process with unrestricted filesystem access. The `read_file` and `write_file` tools accept any path the LLM provides, and the Node.js process can access any file its OS-level permissions allow. This creates a security risk where the LLM could read sensitive files (`~/.aws/credentials`, `~/.ssh/id_rsa`) or write to critical system locations.

Docker containers provide isolation at the kernel level - they can only access files explicitly mounted into them. By mounting only the project directory, filesystem access is physically constrained regardless of what paths the application code attempts to access.

**Current Architecture:**

- Agent runs via `npm start` → `node dist/index.js`
- Config loaded from `.propio/providers.json` (relative to app directory)
- Session context written to `session_context.txt` (relative to `process.cwd()`)
- All filesystem operations use native Node.js `fs` module

**Constraints:**

- Must remain backward compatible - native execution mode unchanged
- Must work with interactive CLI (stdin/stdout/tty)
- Must support Ollama on host machine (port 11434)
- Must support cloud LLM providers (Bedrock, OpenRouter)
- Config files must be accessible but protected from modification
- Must support running from external repositories (not just agent's own directory)

## Goals / Non-Goals

**Goals:**

- Restrict filesystem access to project directory and subdirectories only
- Block access to sensitive files outside project (home directory, system files)
- Provide optional sandbox mode that's easy to toggle on/off
- Support running agent in external repositories (not just agent's own directory)
- Maintain full compatibility with existing agent functionality
- Support both local (Ollama) and cloud LLM providers in sandbox mode

**Non-Goals:**

- Application-level path validation (Docker enforces boundary)
- Network isolation or egress filtering
- Changes to agent source code or tool interfaces
- Sandboxing for native execution mode
- Production deployment hardening (this is a development tool)

## Decisions

### Decision 1: Docker Container Isolation vs Application-Level Validation

**Choice:** Use Docker container filesystem isolation with volume mounts.

**Rationale:**

- Physical enforcement - impossible to bypass regardless of LLM output or code bugs
- No code changes needed - enforcement is infrastructure-level
- Clear security boundary - only mounted paths are accessible
- Industry-standard approach for isolation

**Alternatives Considered:**

- Application-level path validation: Regex-based allowlist/denylist. Rejected because:
  - Complex to implement correctly (symlinks, relative paths, path traversal)
  - Can be bypassed with edge cases or bugs
  - Requires maintaining validation logic across tool implementations
- chroot/jail: Rejected because:
  - Requires root privileges
  - Platform-specific (no Windows support)
  - Docker provides better ergonomics

### Decision 2: Optional Sandbox vs Always-On

**Choice:** Make sandbox optional via separate CLI wrapper script.

**Rationale:**

- Native mode has better performance (no container overhead)
- Easier development workflow - no rebuild needed after code changes in native mode
- Users may be working on trusted codebases where sandbox isn't needed
- Gradual adoption - users can try sandbox without committing
- Clear separation of concerns - different entry points for different security contexts

**Alternatives Considered:**

- Always-on sandbox: Rejected because:
  - Forces Docker dependency on all users
  - Slower iteration during development (rebuild required)
  - May be overkill for trusted use cases

### Decision 3: CLI Wrapper Script vs npm Script

**Choice:** Use an executable shell script (`bin/propio-sandbox`) instead of npm script.

**Rationale:**

- **External repo support**: Can be invoked from any directory, sandboxes current working directory
- **Path flexibility**: Can be symlinked to `~/bin` or added to PATH for global access
- **Future-proof**: Natural migration path to npm global install (script becomes bin entry)
- **No file pollution**: Target repos don't need propio's package.json or docker-compose.yml

**Implementation:**

```bash
#!/bin/bash
# bin/propio-sandbox
PROPIO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
docker compose -f "$PROPIO_DIR/docker-compose.yml" run --rm \
  -v "$(pwd):/workspace" \
  -v "$PROPIO_DIR/.propio:/app/.propio:ro" \
  agent
```

**Usage:**

```bash
cd ~/my-project
~/propio/bin/propio-sandbox  # or symlink to ~/bin/propio-sandbox
```

**Alternatives Considered:**

- npm script (`npm run start:sandbox`): Rejected because:
  - Only works from agent's own directory
  - Can't sandbox external repositories without cd gymnastics
  - Requires target repo to have package.json with the script
- Accepting directory argument (`--dir`): Rejected for now because:
  - More complex CLI parsing needed
  - Current working directory is natural and intuitive
  - Can be added later if needed

### Decision 4: Working Directory Strategy

**Choice:** Build at `/app`, run from `/workspace`.

**Rationale:**

- Config resolution: `__dirname` paths resolve to `/app/.propio/` (matches read-only mount)
- Session context: `process.cwd()` is `/workspace` (project directory mount)
- Clean separation: app code vs workspace data
- Existing code works without modification

**Implementation:**

```dockerfile
WORKDIR /app          # Build context
RUN npm install && npm run build
WORKDIR /workspace    # Runtime context
CMD ["node", "/app/dist/index.js"]
```

**Alternatives Considered:**

- Single directory (`/app`): Rejected because:
  - Would require mounting project directory at `/app`, conflicting with built code
  - Config paths would need modification

### Decision 5: Volume Mount Strategy

**Choice:** Mount `.propio/` from agent directory (read-only), current working directory as workspace (read-write).

**Rationale:**

- Config protection: LLM cannot modify provider configuration
- Dynamic workspace: Current directory becomes the sandbox boundary
- Data locality: Session context and agent outputs stay in current directory
- Minimal attack surface: Only one writable mount point
- External repo support: Any directory can become the sandboxed workspace

**Mount configuration (via CLI wrapper):**

```bash
-v "$(pwd):/workspace"                    # Current directory (read-write)
-v "$PROPIO_DIR/.propio:/app/.propio:ro"  # Config from agent dir (read-only)
```

This differs from docker-compose.yml which would use relative paths. The CLI wrapper provides absolute paths dynamically.

**Alternatives Considered:**

- Copy config into image: Rejected because:
  - Requires rebuild to change providers
  - Can't use user-specific API keys or credentials
- Mount entire home directory: Rejected because:
  - Defeats purpose of sandboxing
  - Exposes sensitive files
- Static mounts in docker-compose.yml: Rejected because:
  - Can't support external repositories
  - Forces execution from agent's own directory

### Decision 6: Docker Compose Run vs Up

**Choice:** Use `docker compose run --rm agent` for interactive execution.

**Rationale:**

- This is an interactive CLI tool, not a background service
- `run` provides proper stdin/stdout/tty handling
- `--rm` cleans up container after exit
- Matches user expectation for CLI tools

**Alternatives Considered:**

- `docker compose up`: Rejected because:
  - Designed for long-running services
  - Requires separate attach/exec for interaction
  - Leaves containers running after exit

## Risks / Trade-offs

### Risk: Rebuild Required After Code Changes

When running in sandbox mode, the Docker image contains a snapshot of the agent code. Code changes don't take effect until `docker compose build` is run.

**Mitigation:**

- Document clearly in README
- Provide `docker compose run --build` for auto-rebuild
- Native mode available for rapid iteration

### Risk: Environment Variable Leakage

Environment variables (including API keys) are accessible to the containerized process. If LLM can execute code, it could access environment variables.

**Mitigation:**

- This is acceptable - sandbox prevents filesystem access, not memory access
- Code execution by LLM is a separate threat model
- Users should pass secrets via environment variables (not mounted files) if concerned

### Risk: Docker Not Installed

Users without Docker cannot use sandbox mode and may get confusing errors.

**Mitigation:**

- Sandbox is optional - native mode always works
- Document Docker requirement clearly
- Provide helpful error message if Docker is missing (future enhancement)

### Risk: Ollama Connection Issues

Ollama running on host needs to be accessible from container via `host.docker.internal`.

**Mitigation:**

- Use `extra_hosts` to map `host.docker.internal` to host gateway
- Default `OLLAMA_HOST=http://host.docker.internal:11434`
- Document that Ollama must listen on host network, not localhost-only

### Trade-off: Performance Overhead

Running in Docker adds startup time and slight runtime overhead.

**Impact:**

- Acceptable for security-sensitive use cases
- Native mode available for performance-critical scenarios
- Overhead is minimal for typical LLM interaction patterns

### Trade-off: Disk Space

Docker image includes Node.js runtime and dependencies (~200-300MB).

**Impact:**

- One-time cost per project
- Image can be pruned with `docker image prune`
- Acceptable for modern development machines

### Trade-off: Two Invocation Methods

The CLI wrapper (`bin/propio-sandbox`) is for general use, but docker-compose.yml still exists for development.

**When to use each:**

- **CLI wrapper** (`bin/propio-sandbox`): External repos, production-like sandboxing
- **docker-compose.yml** (`docker compose run agent`): Agent development, testing Docker config
- **npm script** (`npm run start:sandbox`): Future addition, wraps CLI wrapper for convenience

**Impact:**

- Minor documentation burden to explain both methods
- docker-compose.yml mounts may differ from CLI wrapper behavior
- Acceptable complexity for flexibility gained

## Proof of Concept Validation

A proof of concept was completed on 2026-02-10 that validated all architectural decisions before full implementation.

**Validated:**

- Docker filesystem isolation prevents access to host files outside workspace
- Path traversal (`../`) cannot escape workspace boundary
- /app (build) → /workspace (runtime) strategy works correctly
- CLI wrapper correctly resolves agent directory and mounts volumes dynamically
- Read-only config mounting enforced correctly (cannot write to `.propio/`)
- Interactive mode (stdin/stdout/tty) works in container
- Can run from any directory (not just agent's own directory)
- Files created in container persist correctly to host
- External directory usage works as designed

**Findings:**

- All security boundaries work as designed
- No architectural changes needed
- No unexpected issues discovered
- Ready for full implementation

**POC Test Coverage:**

- Core Docker functionality (build, run, interactive)
- Filesystem isolation (workspace access, path traversal blocking, unmounted path blocking)
- Configuration access (read-only enforcement)
- External directory usage (critical use case)
- CLI wrapper functionality (path resolution, dynamic mounts)

**POC Artifacts Created:**

- `Dockerfile.poc` - Proof of concept Dockerfile
- `docker-compose.poc.yml` - Docker Compose configuration
- `bin/propio-sandbox-poc` - CLI wrapper script
- `test-sandbox-poc-v2.sh` - Automated filesystem isolation tests
- `test-external-directory-poc.sh` - External directory usage tests
- `POC-RESULTS.md` - Detailed validation summary

These POC artifacts should be removed after successful implementation (see cleanup task in tasks.md).
