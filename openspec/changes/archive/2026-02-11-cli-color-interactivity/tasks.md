## 1. Setup & Dependencies

- [x] 1.1 Add chalk@5.6.2 to package.json dependencies
- [x] 1.2 Add ora@9.3.0 to package.json dependencies
- [x] 1.3 Run npm install to install new dependencies
- [x] 1.4 Create src/ui/ directory

## 2. Implement colors.ts

- [x] 2.1 Create src/ui/colors.ts file
- [x] 2.2 Import chalk and define One Atom Dark color palette using chalk.hex() for all 9 semantic roles (userInput, assistant, tool, success, error, warning, command, subtle, info)
- [x] 2.3 Export color functions for each semantic role
- [x] 2.4 Verify NO_COLOR and FORCE_COLOR environment variables work via chalk's built-in detection

## 3. Implement symbols.ts

- [x] 3.1 Create src/ui/symbols.ts file
- [x] 3.2 Define Unicode symbol constants (prompt: ❯, bullet: ◆, success: ✔, error: ✖, ellipsis: …)
- [x] 3.3 Define ASCII fallback symbols (prompt: >, bullet: \*, success: √, error: x, ellipsis: ...)
- [x] 3.4 Implement terminal detection logic based on process.platform and process.env.TERM
- [x] 3.5 Export appropriate symbol set based on terminal capabilities

## 4. Implement formatting.ts

- [x] 4.1 Create src/ui/formatting.ts file
- [x] 4.2 Import colors and symbols modules
- [x] 4.3 Implement formatUserMessage() - compose user input color
- [x] 4.4 Implement formatAssistantMessage() - compose assistant color
- [x] 4.5 Implement formatToolExecution() - compose tool/function color with symbols
- [x] 4.6 Implement formatSuccess() - compose success color with success symbol
- [x] 4.7 Implement formatError() - compose error color with error symbol
- [x] 4.8 Implement formatWarning() - compose warning color with symbol
- [x] 4.9 Implement formatCommand() - compose command color
- [x] 4.10 Implement formatInfo() - compose info color
- [x] 4.11 Implement formatSubtle() - compose subtle/muted color

## 5. Implement spinner.ts

- [x] 5.1 Create src/ui/spinner.ts file
- [x] 5.2 Import ora library
- [x] 5.3 Create OperationSpinner class that wraps ora instance
- [x] 5.4 Implement constructor that accepts operation text
- [x] 5.5 Implement start() method to begin spinner animation
- [x] 5.6 Implement succeed(message: string) method to stop with success
- [x] 5.7 Implement fail(message: string) method to stop with error
- [x] 5.8 Implement stop() method to stop without status
- [x] 5.9 Ensure spinner respects NO_COLOR environment variable

## 6. Extend Agent with Tool Callbacks

- [x] 6.1 Add onToolStart?: (toolName: string) => void parameter to streamChat method signature in src/agent.ts
- [x] 6.2 Add onToolEnd?: (toolName: string, result: string) => void parameter to streamChat method signature
- [x] 6.3 Modify tool execution logic to invoke onToolStart callback when tool begins (if provided)
- [x] 6.4 Modify tool execution logic to invoke onToolEnd callback when tool completes (if provided)
- [x] 6.5 Suppress bracketed tool status messages through onToken when both callbacks are provided
- [x] 6.6 Maintain backward compatibility - use onToken for tool status when callbacks are not provided
- [x] 6.7 Handle partial callback support (only onToolStart or only onToolEnd provided)

## 7. Integrate Colored Output in CLI

- [x] 7.1 Import formatting functions and OperationSpinner in src/index.ts
- [x] 7.2 Apply formatUserMessage() to user input prompts
- [x] 7.3 Apply formatAssistantMessage() to assistant streaming response tokens
- [x] 7.4 Apply formatCommand() to command help text
- [x] 7.5 Apply formatError() to error messages and stack traces
- [x] 7.6 Apply formatInfo() to context display and informational messages
- [x] 7.7 Apply formatSubtle() to secondary/muted text
- [x] 7.8 Implement onToolStart callback that creates and starts OperationSpinner
- [x] 7.9 Implement onToolEnd callback that stops spinner with success/failure message
- [x] 7.10 Ensure spinner is stopped before streaming output begins
- [x] 7.11 Pass onToolStart and onToolEnd callbacks to agent.streamChat()

## 8. Verification & Testing

- [x] 8.1 Test CLI with colored output on a truecolor terminal
- [x] 8.2 Test CLI with NO_COLOR=1 environment variable (should output plain text)
- [x] 8.3 Test CLI with stdout redirected to file (colors should be disabled)
- [x] 8.4 Test spinners during tool execution (start, success, failure scenarios)
- [x] 8.5 Test backward compatibility - ensure agent works without providing callbacks
- [x] 8.6 Verify Unicode symbols display correctly on supported terminals
- [x] 8.7 Verify ASCII fallbacks on limited terminals (Windows, TERM=dumb)
- [x] 8.8 Build TypeScript and verify no type errors
