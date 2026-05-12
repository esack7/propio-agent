# Re-Review Feedback on Long-Running Bottlenecks Implementation Plan

This is feedback on the latest `docs/long-running-bottlenecks-plan.md` as an implementation plan for addressing `docs/long-running-bottlenecks.md`.

## Overall Assessment

The plan looks solid now. The earlier blockers have been addressed:

- Stable `sessionId` is metadata rather than the snapshot filename.
- Artifact paths are absolute and directly readable.
- Artifact retention is anchored to saved sessions.
- Encoding remains persistence-only.
- Artifact IDs stay owned by `ContextManager`.
- Batch `recordToolResults(...)` is preserved.

## Remaining Cleanup

Only two minor documentation references should be fixed before calling the plan final:

1. In the critical files list, the `src/context/contextManager.ts` bullet still says `recordToolResult` singular. Phase 3 now correctly extends the batch `recordToolResults(...)` API.
2. The `src/context/types.ts` bullet lists `SessionIndexEntry.sessionId`, but `SessionIndexEntry` lives in `src/sessions/sessionHistory.ts`.

## Bottom Line

These are bookkeeping issues, not design blockers. After those two references are corrected, the plan is implementation-ready.
