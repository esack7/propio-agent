## 1. Create Dockerfile

- [x] 1.1 Create Dockerfile in project root with `FROM node:20-alpine`
- [x] 1.2 Set initial WORKDIR to `/app` for build context
- [x] 1.3 Copy package.json and package-lock.json to `/app`
- [x] 1.4 Run `npm install` to install dependencies
- [x] 1.5 Copy tsconfig.json and src/ directory to `/app`
- [x] 1.6 Run `npm run build` to compile TypeScript
- [x] 1.7 Set default environment variable OLLAMA_HOST=http://host.docker.internal:11434
- [x] 1.8 Create /workspace directory with `RUN mkdir -p /workspace`
- [x] 1.9 Change WORKDIR to `/workspace` for runtime
- [x] 1.10 Set CMD to `["node", "/app/dist/index.js"]` using absolute path

## 2. Create docker-compose.yml

- [x] 2.1 Create docker-compose.yml in project root
- [x] 2.2 Define `agent` service with `build: .`
- [x] 2.3 Enable interactive mode with `stdin_open: true` and `tty: true`
- [x] 2.4 Environment variables set via Dockerfile ENV directive
- [x] 2.5 Add volume mount for config: `./.propio:/app/.propio:ro` (read-only)
- [x] 2.6 Add volume mount for workspace: `./:/workspace` (read-write)
- [x] 2.7 Add extra_hosts mapping for host.docker.internal: `- "host.docker.internal:host-gateway"`

## 3. Create CLI wrapper script

- [x] 3.1 Create bin/ directory if it doesn't exist
- [x] 3.2 Create bin/propio-sandbox shell script with shebang `#!/bin/bash`
- [x] 3.3 Add logic to resolve PROPIO_DIR using BASH_SOURCE
- [x] 3.4 Add docker compose run command with -f flag pointing to PROPIO_DIR/docker-compose.yml
- [x] 3.5 Add --rm flag for automatic container cleanup
- [x] 3.6 Add dynamic volume mount for current directory: `-v "$(pwd):/workspace"`
- [x] 3.7 Add dynamic volume mount for config: `-v "$PROPIO_DIR/.propio:/app/.propio:ro"`
- [x] 3.8 Add `agent` as the service name argument
- [x] 3.9 Make script executable with `chmod +x bin/propio-sandbox`

## 4. Update .gitignore

- [x] 4.1 Add Docker-related files to .gitignore if not already present
- [x] 4.2 Verify bin/propio-sandbox is NOT in .gitignore (should be tracked)

## 5. Test sandbox functionality

- [x] 5.1 Build Docker image with `docker compose build`
- [x] 5.2 Test CLI wrapper from agent directory: `bin/propio-sandbox`
- [x] 5.3 Verify agent starts and can read/write files in current directory
- [x] 5.4 Test reading .propio/providers.json config (should succeed)
- [x] 5.5 Test attempting to write to .propio/ (should fail with read-only error)
- [x] 5.6 Create test external directory and test running from there
- [x] 5.7 Test that agent cannot read files outside workspace (e.g., ~/.ssh)
- [x] 5.8 Test that session_context.txt is created in correct location
- [x] 5.9 Test interactive mode (stdin/stdout/tty work correctly)
- [x] 5.10 Test Ctrl+C interrupt and verify container cleanup with `docker ps -a`

## 6. Test LLM provider connectivity

- [x] 6.1 Test Ollama connectivity from container using host.docker.internal
- [x] 6.2 Test cloud provider (OpenRouter or Bedrock) connectivity
- [x] 6.3 Verify environment variables from Dockerfile are accessible

## 7. Test native mode compatibility

- [x] 7.1 Verify `npm start` still works without Docker
- [x] 7.2 Verify native mode has unrestricted filesystem access
- [x] 7.3 Verify all agent functionality works identically in both modes

## 8. Documentation

- [x] 8.1 Update README.md with sandbox mode usage instructions
- [x] 8.2 Document Docker and Docker Compose as prerequisites for sandbox mode
- [x] 8.3 Document how to create symlink for global access
- [x] 8.4 Document rebuild requirement after code changes
- [x] 8.5 Add troubleshooting section for common Docker issues
- [x] 8.6 Document environment variable handling for AWS credentials

## 9. Error handling improvements (optional)

- [x] 9.1 Add Docker installation check to CLI wrapper with helpful error message
- [x] 9.2 Add Docker daemon running check with helpful error message
- [x] 9.3 Add image build check with instructions to run `docker compose build`

## 10. Cleanup POC artifacts

- [x] 10.1 Remove Dockerfile.poc
- [x] 10.2 Remove docker-compose.poc.yml
- [x] 10.3 Remove bin/propio-sandbox-poc
- [x] 10.4 Remove test-sandbox-poc-v2.sh
- [x] 10.5 Remove test-external-directory-poc.sh
- [x] 10.6 Remove POC-RESULTS.md
