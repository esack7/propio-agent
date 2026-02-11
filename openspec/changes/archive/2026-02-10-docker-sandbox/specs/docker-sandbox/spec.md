## ADDED Requirements

### Requirement: CLI wrapper invocation

The system SHALL provide an executable CLI wrapper script at `bin/propio-sandbox` that can be invoked from any directory on the host system.

#### Scenario: Invoke from agent directory
- **WHEN** user runs `bin/propio-sandbox` from the agent's installation directory
- **THEN** the agent starts in sandbox mode with the agent directory as the workspace

#### Scenario: Invoke from external repository
- **WHEN** user runs `/path/to/propio/bin/propio-sandbox` from an external repository directory
- **THEN** the agent starts in sandbox mode with the external repository as the workspace

#### Scenario: Invoke via symlink
- **WHEN** user creates a symlink `ln -s ~/propio/bin/propio-sandbox ~/bin/propio-sandbox` and runs `propio-sandbox` from any directory
- **THEN** the agent starts in sandbox mode with the current working directory as the workspace

### Requirement: Filesystem isolation

The system SHALL restrict filesystem access to only the current working directory and its subdirectories when running in sandbox mode.

#### Scenario: Read file in workspace
- **WHEN** the agent attempts to read a file within the current working directory
- **THEN** the operation succeeds and returns the file contents

#### Scenario: Write file in workspace
- **WHEN** the agent attempts to write a file within the current working directory
- **THEN** the operation succeeds and creates/modifies the file

#### Scenario: Read file outside workspace
- **WHEN** the agent attempts to read a file outside the current working directory (e.g., `~/.aws/credentials`, `/etc/passwd`)
- **THEN** the operation fails with "No such file or directory" error

#### Scenario: Write file outside workspace
- **WHEN** the agent attempts to write to a path outside the current working directory (e.g., `/tmp/file`, `../outside/file`)
- **THEN** the operation fails with "No such file or directory" or "Permission denied" error

#### Scenario: Traverse subdirectories
- **WHEN** the agent attempts to read or write files in subdirectories of the workspace
- **THEN** all operations succeed normally

### Requirement: Configuration file access

The system SHALL mount the agent's configuration directory (`.propio/`) as read-only and accessible to the sandboxed agent.

#### Scenario: Read provider configuration
- **WHEN** the agent reads `.propio/providers.json` from the agent installation directory
- **THEN** the operation succeeds and returns the configuration

#### Scenario: Attempt to modify configuration
- **WHEN** the agent attempts to write to any file in `.propio/`
- **THEN** the operation fails with "Read-only file system" error

#### Scenario: Load provider settings
- **WHEN** the agent starts and loads provider configuration
- **THEN** all configured providers are available for use

### Requirement: Working directory mapping

The system SHALL mount the current working directory at container start time as `/workspace` inside the container.

#### Scenario: Process working directory
- **WHEN** the agent queries `process.cwd()` inside the container
- **THEN** the result is `/workspace`

#### Scenario: Relative path resolution
- **WHEN** the agent uses relative paths like `./file.txt` or `subdir/file.txt`
- **THEN** paths resolve relative to `/workspace` (the mounted current working directory)

#### Scenario: Session context file location
- **WHEN** the agent writes `session_context.txt` using `process.cwd()`
- **THEN** the file is created in the host's current working directory

### Requirement: Docker image build

The system SHALL provide a Dockerfile that builds the agent application at `/app` and sets the runtime working directory to `/workspace`.

#### Scenario: Initial image build
- **WHEN** user runs `docker compose build` from the agent directory
- **THEN** the Docker image is built successfully with all dependencies installed

#### Scenario: Code changes require rebuild
- **WHEN** agent source code is modified
- **THEN** the Docker image MUST be rebuilt before changes take effect in sandbox mode

#### Scenario: Runtime directory separation
- **WHEN** the container starts
- **THEN** agent application code exists at `/app` and the working directory is `/workspace`

### Requirement: Interactive mode support

The system SHALL support interactive CLI operation with stdin, stdout, and tty when running in sandbox mode.

#### Scenario: User input prompt
- **WHEN** the agent prompts for user input via stdin
- **THEN** the user can type input and it is received by the agent

#### Scenario: Output display
- **WHEN** the agent writes to stdout or stderr
- **THEN** the output is displayed in the user's terminal in real-time

#### Scenario: Terminal control characters
- **WHEN** the agent uses terminal formatting (colors, cursor control)
- **THEN** the formatting is preserved and displayed correctly

### Requirement: Network access

The system SHALL allow network access from the sandboxed container to external services including LLM providers and local services on the host.

#### Scenario: Cloud provider access
- **WHEN** the agent calls a cloud LLM provider (OpenRouter, Bedrock)
- **THEN** the network request succeeds and the agent receives the response

#### Scenario: Local Ollama access
- **WHEN** the agent connects to Ollama running on the host at `host.docker.internal:11434`
- **THEN** the connection succeeds and the agent can use the local model

#### Scenario: DNS resolution
- **WHEN** the agent resolves external hostnames
- **THEN** DNS resolution works using the host's network configuration

### Requirement: Environment variable handling

The system SHALL pass environment variables from the host to the container while maintaining security boundaries.

#### Scenario: Default environment variables
- **WHEN** the container starts
- **THEN** default environment variables from the Dockerfile are available (e.g., `OLLAMA_HOST`)

#### Scenario: Access API keys
- **WHEN** the agent reads environment variables containing API keys (e.g., `OPENROUTER_API_KEY`, `AWS_ACCESS_KEY_ID`)
- **THEN** the values are accessible for authenticating with LLM providers

#### Scenario: Override default settings
- **WHEN** environment variables override default settings (e.g., `OLLAMA_HOST`)
- **THEN** the agent uses the overridden values

### Requirement: Container cleanup

The system SHALL automatically remove the container after the agent exits when using the CLI wrapper.

#### Scenario: Normal exit
- **WHEN** the agent exits normally (user quits, task completes)
- **THEN** the container is automatically removed and does not appear in `docker ps -a`

#### Scenario: Error exit
- **WHEN** the agent exits due to an error
- **THEN** the container is automatically removed

#### Scenario: Interrupt signal
- **WHEN** the user presses Ctrl+C to interrupt the agent
- **THEN** the container is stopped and removed

### Requirement: Native mode compatibility

The system SHALL maintain backward compatibility with native execution mode without requiring Docker.

#### Scenario: Native mode execution
- **WHEN** user runs `npm start` instead of the sandbox CLI wrapper
- **THEN** the agent runs natively without Docker and has unrestricted filesystem access

#### Scenario: No Docker requirement for native mode
- **WHEN** Docker is not installed on the system
- **THEN** native mode (`npm start`) continues to work normally

#### Scenario: Identical functionality
- **WHEN** comparing agent capabilities between native and sandbox modes
- **THEN** all agent tools and LLM providers work identically (except filesystem scope)

### Requirement: Error handling

The system SHALL provide clear error messages when sandbox mode prerequisites are not met.

#### Scenario: Docker not installed
- **WHEN** user runs the CLI wrapper but Docker is not installed
- **THEN** the system displays an error message indicating Docker is required

#### Scenario: Docker daemon not running
- **WHEN** user runs the CLI wrapper but Docker daemon is not running
- **THEN** the system displays an error message indicating Docker daemon must be started

#### Scenario: Image not built
- **WHEN** user runs the CLI wrapper but the Docker image has not been built
- **THEN** the system displays an error message with instructions to run `docker compose build`
