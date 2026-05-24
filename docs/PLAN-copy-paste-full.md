# Paste, drop, and clipboard support for propio

## Scope

**Initial ship (this effort):** bracketed paste, paste handler, large-text collapse, image path drag/paste, rich submission through the interactive loop, agent multimodal wiring.

**Deferred (follow-up):** macOS clipboard-image on empty paste, paste-cache history for entries >1024 chars, optional `sharp` for resize/BMP conversion. See [Phase 5 (deferred)](#phase-5-deferred--clipboard-image--paste-cache-history).

## Current state

Propio’s interactive prompt is a **raw-mode, readline keypress** editor in [`src/ui/chatPromptSession.ts`](src/ui/chatPromptSession.ts). Printable input goes straight to `insertText()`; Enter submits immediately. There is **no** bracketed-paste (DEC mode 2004), no paste-vs-type distinction, and no placeholder/collapse for large pastes.

Downstream, [`src/agent.ts`](src/agent.ts) calls `contextManager.beginUserTurn(userMessage)` with **string content only** ([`src/context/contextManager.ts`](src/context/contextManager.ts) L324–331), even though `ChatMessage` and session persistence already support `images` ([`src/providers/types.ts`](src/providers/types.ts) L24, [`src/context/persistence.ts`](src/context/persistence.ts)). `@file` mentions are resolved via [`src/fileSearch/attachmentResolver.ts`](src/fileSearch/attachmentResolver.ts) on submit—not via paste/drop.

Today [`PromptResultSubmitted`](src/ui/promptComposer.ts) is only `{ status, text, inputMode }`, and the REPL trims that to a string at [`src/index.ts`](src/index.ts) L721–723 before routing.

```mermaid
flowchart LR
  subgraph today [Today]
    TTY[Terminal] --> KP[readline keypress]
    KP --> CPS[chatPromptSession.insertText]
    CPS --> Submit[promptComposer.submit]
    Submit --> Agent[agent.streamChat string only]
  end
  subgraph target [Target]
    TTY2[Terminal] --> Parser[keypress + paste parser]
    Parser --> PasteHook[pasteHandler]
    PasteHook --> CPS2[chatPromptSession]
    CPS2 --> Expand[expand refs on submit]
    Expand --> Submission[PromptSubmission]
    Submission --> Agent2[streamChat submission]
  end
```

## Target architecture

| Layer | Responsibility | New / changed location |
|-------|----------------|------------------------|
| Terminal control | Enable/disable bracketed paste on injectable TTY stream | `src/ui/input/bracketedPaste.ts` |
| Stdin / keypress parser | Collect `CSI 200~` … `201~`; emit atomic paste events | `src/ui/input/parseKeypress.ts` |
| Paste hook | Detect paste (bracketed, >800 chars, split-chunk burst); debounce + clean; **not** path-shaped detection | `src/ui/input/pasteHandler.ts` |
| Path parsing | After clean, classify lines for chat `onImagePaths` vs `onTextPaste` (Phase 2: strict all-image-path lines only) | `src/ui/input/parseDroppedPaths.ts` |
| Prompt input | Insert text/images; block Enter while pasting; render pills | [`src/ui/chatPromptSession.ts`](src/ui/chatPromptSession.ts) |
| Submit | Expand registered placeholder tokens → `PromptSubmission` | `src/ui/input/expandSubmit.ts`, [`src/ui/promptComposer.ts`](src/ui/promptComposer.ts) |
| Agent | Attach images on user turn; keep @mention resolver | [`src/agent.ts`](src/agent.ts), [`src/context/contextManager.ts`](src/context/contextManager.ts) |
| History (deferred) | Paste-cache for huge entries | `src/ui/pasteCache.ts` — Phase 5 |

**Terminal control stream:** Prompt rendering uses **stderr** ([`src/ui/terminal.ts`](src/ui/terminal.ts)), but bracketed-paste mode must be written to the **controlling terminal** (usually stdout). Do **not** hardcode `process.stdout` inside `chatPromptSession`:

- Add `terminalControlStream?: NodeJS.WriteStream` to `ChatPromptSessionOptions` / `PromptComposerOptions`, defaulting to `process.stdout`.
- Call `enableBracketedPaste(stream)` only when `stream.isTTY`.
- Always `disableBracketedPaste` in `cleanup()` ([`chatPromptSession.ts`](src/ui/chatPromptSession.ts) L1729) even if enable was skipped (idempotent).
- Tests inject a mock stream and assert disable-on-cleanup.

## Rich submission object (define early)

Introduce a single payload type used end-to-end **before** image/path features land, so later phases only fill fields.

> **Implementation note:** Phase 1–2 shipped bracketed paste and the paste handler without `PromptSubmission` wiring (submission remains `{ text, inputMode }`). Land [`promptSubmission.ts`](src/ui/input/promptSubmission.ts) as a focused step **before Phase 3** (placeholder expansion + history policy), not inside Phase 3 UI work. See [PLAN-copy-paste-phase-2.md](PLAN-copy-paste-phase-2.md#promptsubmission-handoff).

**Module placement:** define `PromptSubmission` and `PromptImage` in a small shared module, e.g. [`src/ui/input/promptSubmission.ts`](src/ui/input/promptSubmission.ts) (export `isSubmissionEmpty` there too). **Do not** put these types in [`promptComposer.ts`](src/ui/promptComposer.ts) — [`index.ts`](src/index.ts) and [`agent.ts`](src/agent.ts) both import them, and keeping types out of the composer avoids awkward UI ↔ agent cross-imports through unrelated files.

```ts
/** Runtime image bytes for providers — NOT PersistedImage (session JSON only). */
export type PromptImage = Uint8Array | string; // base64 or data URL per provider conventions

export interface PromptSubmission {
  /** Expanded text sent to the agent (placeholders resolved). */
  text: string;
  /** What the user saw in the prompt buffer (may contain pills). */
  displayText: string;
  inputMode: InputMode;
  /** Provider-ready attachments; omitted when none. */
  images?: PromptImage[];
}
```

**Pipeline changes (explicit):**

1. [`PromptResultSubmitted`](src/ui/promptComposer.ts) — replace bare `text` with `submission: PromptSubmission` (prefer one nested object).
2. **Expand before session cleanup** — [`settlePending`](src/ui/promptComposer.ts) calls `activeChatSession.cleanup()` before resolve today; expansion must **not** read `pastedContents` after cleanup. **Preferred:** `expandPastedRefs` in [`chatPromptSession`](src/ui/chatPromptSession.ts) `handleEnter`, then `callbacks.submit(submission)`. Composer `settlePending` accepts a pre-built submission, then cleans up. Details: [PLAN-copy-paste-phase-3.md](PLAN-copy-paste-phase-3.md).
3. [`runInteractiveSession`](src/index.ts) — pass `PromptSubmission` into bash vs chat branches; use [empty-submission rule](#empty-submissions) (do not drop image-only turns).
4. [`handleInteractiveSubmission`](src/index.ts) — accept `PromptSubmission`; derive `const trimmedText = submission.text.trim()` for the slash handler chain (handlers stay string-based); chat path uses full `submission`. Route `PromptSubmission` through [`runInteractiveTurn`](src/index.ts), [`streamAssistantTurn`](src/ui/assistantTurnRenderer.ts), and `composer.confirm()` — see [Phase 3 checklist](PLAN-copy-paste-phase-3.md).
5. [`Agent.streamChat`](src/agent.ts) — `streamChat(submission: PromptSubmission, …)`; `beginUserTurn(submission.text, …)` until Phase 6 adds images.
6. **UI transcript vs agent vs history** — three fields, three rules ([Phase 3 doc](PLAN-copy-paste-phase-3.md)):
   - **Agent:** `submission.text` (expanded). **Slash handlers:** `submission.text.trim()` (expanded, then trimmed).
   - **Live transcript** ([`handleChatSubmission`](src/index.ts) → `ui.persistSubmittedInput`): `submission.displayText` (pills), so multi‑KB pastes do not appear expanded in the conversation UI.
   - **Prompt history:** expanded `submission.text` only when ≤ `HISTORY_INLINE_MAX`; never `displayText`.

`PersistedImage` (`{ data, encoding }`) stays in [`src/context/persistence.ts`](src/context/persistence.ts) for save/load only. Conversion: `PromptImage[]` → `ChatMessage.images` at turn creation; persistence layer maps to `PersistedImage` when writing sessions (existing `persistImage` helpers).

## Bash mode and slash commands

| Context | Image path paste/drop | Large text paste |
|---------|----------------------|------------------|
| **Chat (`inputMode: "prompt"`)** | Read image → `[Image #N]` pill + `images` on submit | Collapse to `[Pasted text #N]` when over threshold |
| **Bash (`inputMode: "bash"`)** | **No image pills** — insert path string literally (shell may use the file) | Same collapse rules as chat, or literal insert if under threshold |

**Bash execution vs history:** REPL runs `processBashCommand(submission.text.trim(), …)` only. Bash prompt history (`formatBashHistoryEntry`) is recorded in [`persistSubmittedPrompt`](src/ui/promptComposer.ts) on submit — not in the REPL bash branch ([Phase 3](PLAN-copy-paste-phase-3.md#slash-commands-and-bash-adapter)).

**Slash commands:** Before handler chain in `handleInteractiveSubmission`, if `submission.text.trim()` matches a slash command pattern (`/^\/\w+/`) **and** `submission.images?.length > 0`:

- **Reject** with a clear error: e.g. `Images cannot be sent with slash commands.` (do not attach images to `/help`, `/model`, etc.)
- Do not pass `images` into skill/session handlers.

Chat turns (`handleChatSubmission` / default agent path) receive full `PromptSubmission` including `images`. Transcript uses `displayText`; agent uses expanded `text`.

## Empty submissions

Today [`handleInteractiveSubmission`](src/index.ts) returns early when `!trimmedInput`, and the REPL derives `trimmedInput` from `nextInput.text.trim()` — that **drops image-only** submissions (e.g. drag an image with no caption).

**Rule:** treat a submission as empty only when **both** are true:

```ts
function isSubmissionEmpty(submission: PromptSubmission): boolean {
  return (
    submission.text.trim() === "" &&
    (submission.images?.length ?? 0) === 0
  );
}
```

- Replace `if (!trimmedInput)` (and equivalent checks) with `if (isSubmissionEmpty(submission))`.
- Image-only: `text` may be `""` after expansion (image tokens removed or replaced with markers — see below); `images` must still flow to `streamChat` / `beginUserTurn`.
- Bash mode: same rule; image-only bash submissions are unusual but must not vanish if we ever attach images there in chat-only paths — bash stays path-string-only for drops.

## History policy (MVP)

Until paste-cache (Phase 5), avoid bloating [`prompt-history.json`](src/ui/promptHistory.ts):

| Condition | `historyStore.record()` |
|-----------|-------------------------|
| Expanded `submission.text` length ≤ `HISTORY_INLINE_MAX` (1024) | Record expanded `text` (normal behavior) |
| Expanded `submission.text` length > `HISTORY_INLINE_MAX` | **Skip** history entry for this submit |
| Image-only (`text` empty, has `images`) | Skip history (nothing meaningful to recall) or record a short sentinel like `[image submission]` — **prefer skip** for MVP |

Do **not** record multi‑KB expanded paste bodies inline while paste-cache is deferred. Phase 5 will record `paste:<hash>` and restore on up/down.

`displayText` (with pills) is never written to history. It **is** what the user sees in the live transcript ([`persistSubmittedInput`](src/ui/terminal.ts)); do not substitute expanded `text` there.

## Placeholder expansion policy

Placeholders are **registry tokens**, not free-form editable abbreviations.

- **Canonical pill forms** in the buffer: `[Pasted text #N]`, `[Pasted text #N +M lines]`, `[Image #N]` — stored in `pastedContents: Map<number, PastedContent>`.
- **On submit — scan the full buffer:** Tokens may appear **inline** amid other text (e.g. `fix this [Pasted text #1] please`). Do **not** use a whole-string anchored regex. Scan left-to-right with **separate patterns** (text vs image):
  - Text: `\[(?:Pasted text) #\d+(?: \+\d+ lines)?\]`
  - Image: `\[Image #\d+\]` — **no** `+M lines` suffix on image pills; `[Image #1 +2 lines]` must not match.
- **Text pills:** replace token with full pasted string from registry. Optional `+M lines` in the token is display-only; registry `content` is authoritative.
- **Image pills:** replace token in `submission.text` with a **harmless textual marker**, e.g. `[Attached image: photo.png]` (basename from registry). **Do not** embed base64 in `text`. Binary payload goes only in `submission.images`.
- **Image ordering (fixed rule):** `submission.images` follows **left-to-right token order in `displayText`** as tokens are scanned (not numeric id sort). Matches user intent when they type between multiple `[Image #N]` pills. Tests in `expandSubmit.test.ts` must assert order for e.g. `[Image #2] then [Image #1]` in the buffer.
  - Alternative acceptable for MVP: remove image tokens entirely and rely on `images` only; if so, image-only submits yield `text === ""` and depend on [empty-submission rule](#empty-submissions). **Preferred:** marker string so the model sees a filename hint.
- **Duplicate tokens:** Each exact canonical match expands independently (same id → same body repeated). **No** consume-once. Two `[Pasted text #1]` in the buffer both expand.
- Unrecognized ids / malformed tokens → leave literal in output; debug log only.
- **User edits:** Partial or edited tokens no longer match the pattern → literal text; no fuzzy repair.
- **Manual typing:** `[Pasted text #1]` **without** a registry entry → no expansion; with a registry entry → expands like a real pill.
- **Implementation:** expand-at-submit only in `handleEnter` (not live buffer mutation); see [expand-before-cleanup](#rich-submission-object-define-early) above.

## Phase 1 — Bracketed paste + keypress parser

**New modules**

- `src/ui/input/bracketedPaste.ts` — `EBP` / `DBP`, `enableBracketedPaste(stream)`, `disableBracketedPaste(stream)`.
- `src/ui/input/parseKeypress.ts` — state machine on `str` + `key.sequence`:
  - Incomplete ESC/CSI handling.
  - `PASTE_START` / `PASTE_END` → `{ kind: 'paste', text, isPasted: true }` (emit paste on end even if empty — reserved for deferred clipboard phase).
  - Else → `{ kind: 'key', str, key }`.

**Integration in `createChatPromptSession`**

- On attach: `enableBracketedPaste(options.terminalControlStream ?? process.stdout)` if TTY.
- On `cleanup()`: `disableBracketedPaste` on the same stream.
- Route: `parseKeypress` → paste → `pasteHandler` → keys → existing handlers.

**Heuristic:** printable chunk `length > PASTE_THRESHOLD` (800) → paste when bracketed paste unavailable.

## Phase 2 — Paste handler (text batching + safety)

**New:** `src/ui/input/pasteHandler.ts`

**Paste detection** (what enters the debounced paste path): `isPasted` (bracketed or parser `> PASTE_THRESHOLD`), merged debounced chunks, or burst idle flush (`pastePendingRef` / split chunks). **Not** path-shaped payloads — path logic runs only **after** `cleanPasteText` on flush via `classifyDroppedText` (routing, not detection). See [PLAN-copy-paste-phase-2.md](PLAN-copy-paste-phase-2.md).

Behavior:

- `submitPaste` with `text.length === 0` → no-op (do not set `isPasting` or start debounce).
- 100ms debounce → single `onPasteReady`.
- Clean: strip ANSI, normalize line endings (`/\r\n?/g` → `\n`), tabs → spaces.
- `isPasting` → consume `Return` while active (do not flush-then-submit); see Phase 2 doc for key ordering.
- Callbacks: `onTextPaste`; `onImagePaths` only when every non-empty line is an image path (chat mode).

**No `onEmptyPaste` in initial scope** (deferred with clipboard).

## Phase 3 — Large text placeholders + submit expansion

**Detailed plan:** [PLAN-copy-paste-phase-3.md](PLAN-copy-paste-phase-3.md) (expand-before-cleanup, transcript vs agent, migration checklist, token grammar, `countPasteLines`).

```ts
type PastedContent =
  | { id: number; type: 'text'; content: string }
  | { id: number; type: 'image'; data: PromptImage; mediaType: string; filename: string; path?: string };
```

- `PASTE_THRESHOLD = 800`.
- **Line cap for collapse** uses the **prompt render stream** (`outputStream` / `getPromptOutputStream()`), not `terminalControlStream` — that is the stream whose `rows` reflect layout for the multiline prompt:
  ```ts
  const rows = outputStream.rows ?? 24;
  const maxLines = Math.max(1, Math.min(rows - 10, 2));
  ```
  Guards tiny terminals (e.g. `rows === 5` → `maxLines === 1`).
- **`countPasteLines`:** split on `\n`; if non-empty and ends with `\n`, drop only the trailing empty segment; count all segments (blank lines in the middle count). Pill suffix `+M lines` uses `M = lineCount - 1` when `lineCount > 1`.
- Over char threshold or `countPasteLines(cleaned) > maxLines` → registry token; else `insertText`.
- `expandPastedRefs` in session `handleEnter` → `submission.text` + `images`; buffer snapshot → `submission.displayText`; then `submit(submission)`.
- Transcript: `persistSubmittedInput(submission.displayText)`. History: [History policy (MVP)](#history-policy-mvp).

## Phase 4 — Image paths (drag-and-drop = paste paths)

**New:** `src/ui/input/imagePaste.ts`, `src/ui/input/parseDroppedPaths.ts`

**Path parsing (robust):**

- Split on newlines first; then per line use `parseDroppedPaths` that handles:
  - `file://` URLs → decode path (incl. `%20`).
  - Single-quoted and double-quoted paths (`'/path/with spaces'`, `"C:\\path with spaces"`).
  - Backslash-escaped spaces where terminals emit them.
  - macOS drag formats: bare paths, sometimes URI-encoded; strip trailing `\r`.
  - Multiple paths: whitespace only when **not** inside quotes; avoid naive `split(/ (?=\/)/)` alone.
- Unit tests: spaces in filenames, `file://`, two paths on one line, Windows `C:\` drives.

**Image handling (no required native deps):**

- Extensions: `.png`, `.jpg`, `.jpeg`, `.gif`, `.webp`; `.bmp` → reject with message to convert, unless optional `sharp` added later.
- `tryReadImageFromPath`: read file, enforce max bytes (e.g. 8 MB), validate magic bytes / extension.
- Encode as **base64 string** or `Uint8Array` in `PromptImage[]` — same as [`ChatMessage.images`](src/providers/types.ts).
- **No `sharp` in initial scope.** Optional `optionalDependencies` + feature detect in a follow-up for resize/BMP.
- Failures → fall back to literal path text in buffer.

Chat mode: `[Image #N]` pill + map entry; on submit → `[Attached image: <basename>]` in `text` + bytes in `images`. Bash mode: path string only (no pill, no `images`).

## Phase 5 (deferred) — Clipboard image + paste-cache history

**Clipboard (`src/ui/input/clipboardImage.ts`)**

- macOS: `osascript` / `pngpaste` fallback; wire `onEmptyPaste` from paste handler.
- Optional `/image-paste` or shortcut.

**Paste-cache (`src/ui/pasteCache.ts`)**

- `~/.propio/paste-cache/<hash>.txt` for history entries >1024 chars.
- Schema v2 for `prompt-history.json` with backward-compatible load.
- History up/down restores hash → content.

## Phase 6 — Agent / context multimodal wiring

1. **`beginUserTurn(content: string, images?: PromptImage[]): void`**

   ```ts
   userMessage: {
     role: 'user',
     content,
     ...(images?.length ? { images } : {}),
   }
   ```

   Use **`(Uint8Array | string)[]`** — identical to `ChatMessage.images`. Persistence converts via existing `persistMessage` when saving sessions.

2. **`Agent.streamChat`** — take `PromptSubmission` (or `text` + `images?: PromptImage[]`).

3. **`runInteractiveSession` / `handleInteractiveSubmission`** — pass submission object; apply slash/bash rules above.

4. **Providers** — unchanged; [`promptBuilder.ts`](src/context/promptBuilder.ts) pushes `turn.userMessage` as-is.

5. **Transcript** — show pills / “(N images attached)” via `displayText` in the live UI; never dump expanded multi‑KB paste bodies or raw base64. Session persistence may use markers separately in Phase 6+.

## Testing strategy

| Test file | Cases |
|-----------|--------|
| `parseKeypress.test.ts` | Bracketed boundaries, split ESC, empty paste event |
| `pasteHandler.test.ts` | 800+ heuristic, debounce, bash vs chat image branch |
| `parseDroppedPaths.test.ts` | Quotes, `file://`, spaces, Windows paths, multi-path |
| `imagePaste.test.ts` | Read limits, unsupported type, fallback to path text |
| `expandSubmit.test.ts` | Inline tokens, duplicate pill both expand, image→marker + `images`, `[Image #N +M lines]` no match, broken tokens literal, image-only expand |
| `index.test.ts` or composer | `isSubmissionEmpty` — image-only not ignored |
| `promptComposer.test.ts` | Injectable `terminalControlStream`, disable on cleanup, Enter while pasting |
| `agent.test.ts` / context | `PromptSubmission.images` → `promptBuilder` messages |

Defer: `pasteCache.test.ts`, clipboard mocks until Phase 5.

## Validation

`npm test`, `npm run build`, `npm run format:check`, `npx fallow audit`.

## Risks and mitigations

| Risk | Mitigation |
|------|------------|
| readline mangles CSI | `key.sequence` + buffer; literal sequence tests |
| Hardcoded stdout | Injectable `terminalControlStream` + tests |
| Placeholder ambiguity | Registry + separate text/image token patterns; no fuzzy expand |
| Cleanup clears registry before expand | Expand in `handleEnter` before `submit` / session cleanup ([Phase 3](PLAN-copy-paste-phase-3.md)) |
| Huge paste in transcript UI | `persistSubmittedInput(displayText)` not expanded `text` |
| Image-only submit dropped | `isSubmissionEmpty` requires empty text **and** no images |
| History bloat before paste-cache | Skip record when expanded text > 1024 |
| Images on slash commands | Explicit reject before handler chain |
| `sharp` install friction | Not in initial scope; size/type validation only |
| Fragile path split | Dedicated `parseDroppedPaths` with quoted/URI cases |

## Implementation order (initial scope)

1. `src/ui/input/promptSubmission.ts` (`PromptSubmission`, `PromptImage`, `isSubmissionEmpty`) + wire through `PromptResult`, `index.ts`, `streamChat` (images optional/no-op). **May lag Phase 1–2; must complete before Phase 3.**
2. Bracketed paste + parser + paste handler + Enter guard + injectable terminal stream. *(Phase 1–2 in progress; paste handler per [PLAN-copy-paste-phase-2.md](PLAN-copy-paste-phase-2.md).)*
3. Text placeholders + `expandPastedRefs` + registry policy ([PLAN-copy-paste-phase-3.md](PLAN-copy-paste-phase-3.md)).
4. `parseDroppedPaths` + image read + pills + bash/slash rules + `beginUserTurn` images.
5. Transcript polish + README (document deferred clipboard/cache).

## README (initial)

Document: bracketed paste in TTY chat; drag image files → `[Image #N]` in chat mode; paths literal in bash; large paste → `[Pasted text #N]`; size limits and supported formats. Note: clipboard image paste and history paste-cache planned separately.
