# Plan: Full Fallow Audit Cleanup

## Step 0 — Save this plan as a repo doc
Write this plan to `docs/fallow-cleanup.md` in the repo before starting any code changes, so the refactoring intent is tracked in version control.



## Context
Running `npx fallow` (full codebase scan, not just diff) on the `feature/refactor-fallow` branch reveals:
- **5 dead class member issues**
- **214 clone groups (6,217 duplicated lines = 12.1% of codebase)**
- **88 complexity violations above threshold**

The goal is to resolve all findings so future `npx fallow audit` runs on new work start from a clean baseline rather than inherited noise.

---

## Phase 1 — Dead Code (5 issues)

**Files:** `src/ui/terminalWriter.ts`, `src/fileSearch/fileSearchIndex.ts`, `src/mcp/tool.ts`

| Member | Action | Reason |
|--------|--------|--------|
| `TerminalWriter.getStdoutStream` (:83) | **Remove** | Zero callers found in entire codebase |
| `TerminalWriter.writeStdoutLine` (:91) | **Suppress** with `fallow-ignore-next-line unused-class-members` | Used via interface dispatch (`this.options.writer.writeStdoutLine`) in `transcriptRenderer.ts`; Fallow doesn't trace through interface-typed references |
| `TerminalWriter.writeStderrLine` (:95) | **Suppress** with `fallow-ignore-next-line unused-class-members` | Used in `transcriptRenderer.ts`, `replRenderer.ts`, `footerRenderer.ts` via same interface dispatch pattern |
| `FileSearchIndex.getEntries` (:366) | **Remove** | Zero callers; `search()` is the used method |
| `McpExecutableTool.execute` (:62) | **Suppress** with `fallow-ignore-next-line unused-class-members` | Required by `ExecutableTool` interface (`src/tools/interface.ts:50`) but never called directly on this concrete class |

---

## Phase 2 — Production Duplication: openrouter.ts / xai.ts (762 lines)

The biggest finding: `src/providers/openrouter.ts` (830 lines) and `src/providers/xai.ts` (447 lines) share ~762 lines of OpenAI-compatible streaming infrastructure.

**Step 1: Move shared interfaces to `src/providers/shared.ts`**
- `OpenAIMessage` (duplicated in both files)
- `OpenAITool` (duplicated in both files)

**Step 2: Create `src/providers/openAiCompatibleProvider.ts`**

Abstract base class `OpenAiCompatibleProvider implements LLMProvider`:
```
protected readonly model: string
protected readonly apiKey: string
protected readonly retryConfig?: RetryConfig
protected readonly onDiagnosticEvent?: EventHandler

// Shared concrete methods (move from both providers):
protected chatMessageToOpenAIMessage(msg): OpenAIMessage
protected openAIMessageToChatMessage(msg): ChatMessage
protected chatToolToOpenAITool(tool): OpenAITool
protected buildRequestHeaders(): Record<string, string>  // calls abstract getApiHeaders()
protected isRetryableError(err: unknown): boolean
protected async fetchStream(url, body, signal): Promise<Response>

// Abstract hooks for subclass-specific behavior:
protected abstract getApiUrl(request: ChatRequest): string
protected abstract getApiHeaders(): Record<string, string>
protected abstract translateError(response: Response, body: string): ProviderError

// Shared streamChat implementation (moves from both providers)
async *streamChat(request: ChatRequest): AsyncIterable<ChatStreamEvent>
```

**Step 3: Update `openrouter.ts`**
- Extend `OpenAiCompatibleProvider`
- Keep: DSML tool call parsing logic (`findDsmlStartTokenIndex`, `parseDsmlToolCalls`, `consumeDsmlBuffer`), provider routing, model context window mappings, OpenRouter-specific error handling (`parseOpenRouterErrorBody`)
- Override: `getApiUrl()`, `getApiHeaders()`, `translateError()`

**Step 4: Update `xai.ts`**
- Extend `OpenAiCompatibleProvider`
- Keep: multi-endpoint support, `shouldRetryEndpoint()`, xAI-specific retry logic
- Override: `getApiUrl()`, `getApiHeaders()`, `translateError()`

**Step 5: Update `src/providers/factory.ts`** if needed to match new import paths.

---

## Phase 3 — Complexity Hotspots

Address in priority order (by Fallow's composite ROI score):

### 3.1 `src/cli/args.ts` — `parseCliArgs` (cognitive: 82)
Extract repetitive flag-parsing pattern into helpers:
- `parseFlagValue(arg, nextArg): { value: string; consumed: boolean } | null` — handles both `--flag=value` and `--flag value` syntaxes
- `parseIntFlag(arg, nextArg, flagName, validator): ParseResult` — handles isNaN + range validation + error collection
- Replace the 23+ sequential if-else chains with a flag definitions object mapping flag names to parser configs

### 3.2 `src/agent.ts` — `streamChat` (cognitive: 62, lines 1642-1929)
Extract 4 focused methods from the main loop:
- `collectProviderStream(request, signal): Promise<StreamResult>` — wraps `provider.streamChat` call + its error handling
- `handleMaxTokensRecovery(state): Promise<RecoveryResult>` — the continuation/recovery retry loop (lines ~1724-1785)
- `handleContextLengthError(error, state): Promise<ContextRetryResult>` — retry escalation logic (lines ~1786-1834)
- `validateTurnCompletion(state): TurnValidationResult` — max iterations check + final validation (lines ~1854-1884)

### 3.3 `src/tools/read.ts` — `execute` (cognitive: 53, lines 80-170)
Extract:
- `validateAndSliceByLines(content, startLine, lineCount): { sliced: string; warning?: string }` — line-based parameter validation + slicing
- `validateAndSliceByBytes(content, offset, limit): { sliced: string }` — byte-based slicing with offset/limit validation
- `classifyReadError(err: unknown): ToolError` — the dense catch block with 7 error type checks

### 3.4 `src/providers/gemini.ts` — `streamChat` (cognitive: 39, lines 275-451)
Extract:
- `mapFinishReason(reason: string): StopReason` — the if-else finish_reason mapping (lines ~388-402)
- `extractThoughtSignature(delta): string | undefined` — thought signature merging logic
- SSE tool call accumulation is already in shared.ts; verify gemini uses shared helpers

### 3.5 Remaining targets (5 more from the top-15 list)
After the above, re-run `npx fallow health` and address remaining targets:
- `src/ui/replRenderer.ts` — untested risk: add coverage for 5 complex functions before modifying
- `src/providers/openrouter.ts` — `streamResponse` and `translateError` (will be partially addressed in Phase 2)
- `src/index.ts` — `main` (cognitive: 44)
- `src/ui/contextInspector.ts` — `formatContextOverview` (cognitive: 35)
- `src/ui/typeahead.ts` — `resolvePathQuery` (cognitive: 34)

---

## Phase 4 — Test Duplication

Create shared test helper files for the top clone families:

### 4.1 `src/__tests__/testHelpers.ts` (for `agent.test.ts`, 13 groups / 170 lines)
```typescript
// Factory for common test agents
function createTestAgent(config?: Partial<AgentOptions>): Agent
// Reusable mock provider with tool call support
class ToolCallMockProvider implements LLMProvider { ... }
// Provider/model assertion helper
function assertProviderResolved(agent, name, model): void
```

### 4.2 `src/context/__tests__/testHelpers.ts` (for `contextManager.test.ts`, 20 groups / 208 lines)
```typescript
class ContextManagerTestBuilder {
  createCompletedTurn(userMsg, assistantMsg): this
  createToolCallTurn(userMsg, toolName, toolResult): this
  assertArtifactProperties(artifact, type, mediaType): void
  getManager(): ContextManager
}
```

### 4.3 `src/providers/__tests__/openrouterTestHelpers.ts` (for `openrouter.test.ts`, multiple groups)
```typescript
class OpenRouterTestFixture {
  static createSseStream(chunks: string[]): ReadableStream
  static setupFetchMock(responses): jest.Mock
  static createProvider(model, apiKey?): OpenRouterProvider
}
```

### 4.4 Other test files
After the above three, re-run `npx fallow dupes` and address remaining clone families in:
- `src/context/__tests__/persistence.test.ts` (14 groups / 149 lines)
- `src/context/__tests__/promptBuilder.test.ts` (12 groups / 168 lines)
- `src/context/__tests__/summaryManager.test.ts` (9 groups / 106 lines)
- `src/providers/__tests__/bedrock.test.ts` (5 groups / 94 lines)
- `src/providers/__tests__/configLoader.test.ts` (5 groups / 73 lines)
- `src/providers/__tests__/gemini.test.ts` (4 groups / 66 lines)
- `src/ui/__tests__/chatPromptSession.test.ts` (49-line dupe)
- `src/__tests__/integration.test.ts` (33-line dupe)

---

## Critical Files

| File | Phase | Role |
|------|-------|------|
| `src/ui/terminalWriter.ts` | 1 | Remove getStdoutStream, add suppressions |
| `src/fileSearch/fileSearchIndex.ts` | 1 | Remove getEntries |
| `src/mcp/tool.ts` | 1 | Add suppression to execute |
| `src/providers/openAiCompatibleProvider.ts` | 2 | **New file** — shared base class |
| `src/providers/shared.ts` | 2 | Add OpenAIMessage, OpenAITool interfaces |
| `src/providers/openrouter.ts` | 2 | Extend base class |
| `src/providers/xai.ts` | 2 | Extend base class |
| `src/cli/args.ts` | 3.1 | Refactor parseCliArgs |
| `src/agent.ts` | 3.2 | Refactor streamChat |
| `src/tools/read.ts` | 3.3 | Refactor execute |
| `src/providers/gemini.ts` | 3.4 | Refactor streamChat |
| `src/__tests__/testHelpers.ts` | 4.1 | **New file** |
| `src/context/__tests__/testHelpers.ts` | 4.2 | **New file** |
| `src/providers/__tests__/openrouterTestHelpers.ts` | 4.3 | **New file** |

---

## Verification

After each phase:
1. `npm run build` — TypeScript compiles clean
2. `npm test` — all tests pass
3. `npx fallow audit` — no new issues introduced

After all phases:
4. `npx fallow` — verify significant reduction in counts (target: 0 dead code, <50 clone groups, <30 complexity violations)
5. `npm run format:check` — formatting compliance
