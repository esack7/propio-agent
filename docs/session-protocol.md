# Session event protocol

`AgentSession.subscribeProtocol` receives `{ seq, event, replacedValues? }` records.
Each session starts at `firstSequence`, the supplied log’s `lastSequence + 1`, or 1 and numbers all delivered records,
including transient command output, across turns. `subscribe` remains the typed
in-process API; it can carry original errors and non-JSON tool arguments. CLI
sessions now forward turn visibility events as well as session lifecycle events.

The protocol converts errors to `{ name, message }`, reduces prompt plans to
numeric metadata (no prompt messages), and replaces non-JSON arguments with
stable diagnostic strings such as `[bigint]` or `[circular reference]`.
`replacedValues` counts those substitutions. Optional undefined event fields are
omitted. Custom events from generic session runners use `{ type: "custom", value }`.
Generic events whose names collide with built-in variants, including `custom`,
are wrapped when they do not fit a built-in schema. The untrusted parser still
rejects malformed built-in protocol records.

Records are detached and recursively frozen, with readonly envelope and
event properties in TypeScript. Nested data is frozen at runtime.
The optional synchronous `eventLog.append` runs before notification. If append
fails, the log is detached to avoid recording a discontinuous suffix, and live
delivery continues. `onProtocolError` reports recording, normalization, sequence
and subscriber failures; exceptions in that callback are isolated too. Subscriber
failures do not fail the turn or hide events from later subscribers. Reentrant
notifications remain ordered. If normalization or sequence allocation fails, raw
subscribers still receive the event; CLI settlement uses this raw lifecycle.
The protocol stream contains no marker for that omitted event. If it was
`session_turn_ended`, a replay client cannot infer that the turn finished. Hosts
must handle the reported error; complete-recording guarantees await durable
session storage. Production CLI sessions collect these failures during each turn and emit one
escaped warning afterward, including the count of additional failures suppressed.
Between turns, failures are reported immediately and do not carry into the next
turn’s summary. A supplied `onProtocolError` replaces these warnings and receives
each failure.
Sequence seeds must be positive safe integers. Exhaustion reports an error and
stops protocol delivery rather than emitting duplicate numbers.

`SessionTurnControl.emit` now returns `SessionEventBody | undefined` instead of
`void`, so the live renderer can reuse the normalized body. Existing callers can
ignore the return value. This is an additive change to the provisional agent-core
API; implementations of the control interface must allow the new return type.
Its immutable records are recognized by the in-memory log without another copy
or schema parse. Records supplied from elsewhere are validated and detached.

`InMemorySessionEventLog.after(seq)` returns records strictly after the cursor.
It accepts any initial positive sequence, then requires contiguous appends.
`lastSequence` supports session recreation, and cursor reads slice directly from
the sequence offset. The
in-memory log is unbounded and process-local. The sessions entry point also
exports `DurableEventLog`, an explicit-path, synced JSONL adapter. Open it while
holding writer ownership, supply it as `eventLog`, and call `after(cursor)` for
strict incremental replay. A fresh session starts after its last durable sequence.
The CLI persists these logs independently of diagnostic trace capture.

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
