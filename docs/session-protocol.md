# Session event protocol

`AgentSession.subscribeProtocol` receives `{ seq, event, replacedValues? }` records.
Each session starts at `firstSequence ?? 1` and numbers all delivered records,
including transient command output, across turns. `subscribe` remains the typed
in-process API; it can carry original errors and non-JSON tool arguments. CLI
sessions now forward turn visibility events as well as session lifecycle events.

The protocol converts errors to `{ name, message }`, reduces prompt plans to
numeric metadata (no prompt messages), and replaces non-JSON arguments with
stable diagnostic strings such as `[bigint]` or `[circular reference]`.
`replacedValues` counts those substitutions. Optional undefined event fields are
omitted. Custom events from generic session runners use `{ type: "custom", value }`.
Known event variants must satisfy their schema; malformed known events fail the
emitting turn rather than silently becoming custom events.

Records are detached and recursively frozen, with readonly envelope and
event properties in TypeScript. Nested data is frozen at runtime.
The optional synchronous `eventLog.append` runs before notification. A failed
append does not advance the sequence or notify subscribers. Listeners are trusted
code: exceptions fail the emitting turn, but remaining listeners and reentrantly
queued records are still delivered in order. The first listener error is rethrown.
Sequence seeds must be positive safe integers; exhaustion throws instead of
emitting duplicate numbers.

`InMemorySessionEventLog.after(seq)` returns records strictly after the cursor.
It accepts any initial positive sequence, then requires contiguous appends. The
log is unbounded and process-local; durable storage, retention and shared trace
numbering belong to the later session-stores work.

`parseProtocolEvent(unknown)` throws for malformed records, unknown variants or
fields, invalid numbers, non-JSON values, cycles and nesting beyond 100 objects.
It does not coerce values. Transport hosts still own message-size limits and
framing. Run the standalone, credential-free example after building:

```sh
npm run build
npm run example:session-protocol
```

The CLI's `createTurnEventRenderer` consumes normalized event bodies for both
live output and `replaySession`. Replay validates the entire recording and its
contiguous sequence before drawing. Use a complete turn recording and the same
width and visibility options as live rendering. `skipTransient` omits command
progress while retaining final tool tails. `onEvent` lets the host present stored
approval requests using `formatApprovalRequest`; replay never asks for an answer
or executes a tool. Keyboard prompts and temporary bottom regions remain host UI,
not durable transcript data. The CLI still returns its original result and error
objects to its in-process caller.
