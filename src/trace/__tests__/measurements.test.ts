import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type {
  ProviderRequestPurpose,
  ProviderTraceEvent,
} from "@propio-ai/providers";
import {
  exportTraceJournal,
  JsonlTraceJournal,
  RunTraceRecorder,
  summarizeProviderMeasurements,
  type ProviderPricingResolver,
  type TraceEventEnvelope,
} from "../index.js";

let sequence = 0;

function providerTraceEvent(options: {
  type: ProviderTraceEvent["type"];
  requestId: string;
  purpose: ProviderRequestPurpose;
  attemptId?: string;
  attemptNumber?: number;
  fields?: Record<string, unknown>;
}): ProviderTraceEvent {
  return {
    version: 1,
    eventId: `provider-event-${++sequence}`,
    observedAt: "2026-09-22T00:00:00.000Z",
    provider: "test-provider",
    requestedModel: "requested-model",
    trace: {
      requestId: options.requestId,
      operationId: `operation-${options.requestId}`,
      purpose: options.purpose,
    },
    type: options.type,
    ...(options.attemptId ? { attemptId: options.attemptId } : {}),
    ...(options.attemptNumber ? { attemptNumber: options.attemptNumber } : {}),
    ...options.fields,
  } as ProviderTraceEvent;
}

function envelope(event: ProviderTraceEvent): TraceEventEnvelope {
  return {
    version: 1,
    eventId: `agent-event-${++sequence}`,
    sequence,
    observedAt: event.observedAt,
    monotonicNanoseconds: String(sequence),
    component: "provider",
    type: event.type,
    identity: {
      sessionId: "session-1",
      runId: "run-1",
      requestId: event.trace.requestId,
      operationId: event.trace.operationId,
      attemptId: "attemptId" in event ? event.attemptId : undefined,
    },
    payload: event,
  };
}

function attemptStarted(
  requestId: string,
  purpose: ProviderRequestPurpose,
  attemptId: string,
  attemptNumber: number,
): ProviderTraceEvent {
  return providerTraceEvent({
    type: "provider_attempt_started",
    requestId,
    purpose,
    attemptId,
    attemptNumber,
    fields: { endpointClass: "messages" },
  });
}

function usageReported(options: {
  requestId: string;
  purpose: ProviderRequestPurpose;
  attemptId: string;
  attemptNumber: number;
  availability: "reported" | "partial" | "unavailable";
  reportKind?: "cumulative" | "delta";
  usage?: Record<string, number>;
  cost?: { amount: number; currency?: string };
}): ProviderTraceEvent {
  return providerTraceEvent({
    type: "provider_usage_reported",
    requestId: options.requestId,
    purpose: options.purpose,
    attemptId: options.attemptId,
    attemptNumber: options.attemptNumber,
    fields: {
      endpointClass: "messages",
      availability: options.availability,
      reportKind: options.reportKind,
      usage: options.usage,
      providerReportedCost: options.cost,
    },
  });
}

function attemptTerminal(options: {
  requestId: string;
  purpose: ProviderRequestPurpose;
  attemptId: string;
  attemptNumber: number;
  outcome: "completed" | "failed";
}): ProviderTraceEvent {
  return providerTraceEvent({
    type:
      options.outcome === "completed"
        ? "provider_attempt_completed"
        : "provider_attempt_failed",
    requestId: options.requestId,
    purpose: options.purpose,
    attemptId: options.attemptId,
    attemptNumber: options.attemptNumber,
    fields:
      options.outcome === "completed"
        ? { durationMs: 10, stopReason: "end_turn" }
        : { durationMs: 5, errorName: "ProviderError", message: "retry" },
  });
}

describe("provider measurement aggregation", () => {
  beforeEach(() => {
    sequence = 0;
  });

  it("deduplicates cumulative reports and keeps unavailable attempts visible", () => {
    const events = [
      attemptStarted("answer-1", "answer", "attempt-1", 1),
      usageReported({
        requestId: "answer-1",
        purpose: "answer",
        attemptId: "attempt-1",
        attemptNumber: 1,
        availability: "reported",
        reportKind: "cumulative",
        usage: { inputTokens: 10, outputTokens: 2 },
        cost: { amount: 0.01, currency: "USD" },
      }),
      attemptTerminal({
        requestId: "answer-1",
        purpose: "answer",
        attemptId: "attempt-1",
        attemptNumber: 1,
        outcome: "failed",
      }),
      attemptStarted("answer-1", "answer", "attempt-2", 2),
      usageReported({
        requestId: "answer-1",
        purpose: "answer",
        attemptId: "attempt-2",
        attemptNumber: 2,
        availability: "reported",
        reportKind: "cumulative",
        usage: { inputTokens: 11, outputTokens: 0 },
      }),
      usageReported({
        requestId: "answer-1",
        purpose: "answer",
        attemptId: "attempt-2",
        attemptNumber: 2,
        availability: "reported",
        reportKind: "cumulative",
        usage: { inputTokens: 11, outputTokens: 7 },
        cost: { amount: 0.02, currency: "USD" },
      }),
      attemptTerminal({
        requestId: "answer-1",
        purpose: "answer",
        attemptId: "attempt-2",
        attemptNumber: 2,
        outcome: "completed",
      }),
      attemptStarted("summary-1", "summarize", "attempt-3", 1),
      usageReported({
        requestId: "summary-1",
        purpose: "summarize",
        attemptId: "attempt-3",
        attemptNumber: 1,
        availability: "unavailable",
      }),
      attemptTerminal({
        requestId: "summary-1",
        purpose: "summarize",
        attemptId: "attempt-3",
        attemptNumber: 1,
        outcome: "completed",
      }),
    ].map(envelope);

    const summary = summarizeProviderMeasurements(events);

    expect(summary).toMatchObject({
      requestCount: 2,
      attemptCount: 3,
      usage: {
        completeness: "partial",
        usage: { inputTokens: 21, outputTokens: 9 },
      },
      cost: {
        completeness: "partial",
        currencies: [{ currency: "USD", providerReportedAmount: 0.03 }],
        unpricedAttempts: [{ requestId: "summary-1", attemptId: "attempt-3" }],
      },
      retries: {
        attemptCount: 1,
        usage: {
          completeness: "complete",
          usage: { inputTokens: 11, outputTokens: 7 },
        },
        cost: {
          completeness: "complete",
          currencies: [{ currency: "USD", providerReportedAmount: 0.02 }],
        },
      },
    });
    expect(summary.byPurpose).toEqual([
      expect.objectContaining({
        purpose: "answer",
        requestCount: 1,
        attemptCount: 2,
        usage: expect.objectContaining({ completeness: "complete" }),
        cost: expect.objectContaining({ completeness: "complete" }),
      }),
      expect.objectContaining({
        purpose: "summarize",
        requestCount: 1,
        attemptCount: 1,
        usage: { completeness: "unavailable" },
        cost: expect.objectContaining({ completeness: "unavailable" }),
      }),
    ]);
    expect(summary.attempts[1]).toMatchObject({
      attemptId: "attempt-2",
      outcome: "completed",
      usage: { inputTokens: 11, outputTokens: 7 },
    });
  });

  it("persists separate provider and local costs with pricing provenance", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "propio-pricing-"));
    try {
      const journalPath = path.join(tempDir, "run.jsonl");
      const journal = new JsonlTraceJournal(journalPath);
      const recorder = new RunTraceRecorder(
        { sessionId: "session-1", runId: "run-1" },
        journal,
      );
      const events = [
        attemptStarted("recovery-1", "recovery", "attempt-1", 1),
        providerTraceEvent({
          type: "provider_response_metadata",
          requestId: "recovery-1",
          purpose: "recovery",
          attemptId: "attempt-1",
          attemptNumber: 1,
          fields: {
            endpointClass: "messages",
            actualModel: "routed-model",
          },
        }),
        usageReported({
          requestId: "recovery-1",
          purpose: "recovery",
          attemptId: "attempt-1",
          attemptNumber: 1,
          availability: "reported",
          reportKind: "delta",
          usage: { inputTokens: 4, outputTokens: 1 },
          cost: { amount: 0.004, currency: "USD" },
        }),
        usageReported({
          requestId: "recovery-1",
          purpose: "recovery",
          attemptId: "attempt-1",
          attemptNumber: 1,
          availability: "reported",
          reportKind: "delta",
          usage: { inputTokens: 6, outputTokens: 2 },
        }),
        attemptTerminal({
          requestId: "recovery-1",
          purpose: "recovery",
          attemptId: "attempt-1",
          attemptNumber: 1,
          outcome: "completed",
        }),
      ];
      for (const event of events) {
        recorder.record({
          component: "provider",
          type: event.type,
          identity: {
            requestId: event.trace.requestId,
            operationId: event.trace.operationId,
            attemptId: "attemptId" in event ? event.attemptId : undefined,
          },
          payload: event,
        });
      }
      journal.close();

      const resolver: ProviderPricingResolver = {
        metadata: {
          source: "test-rate-card",
          version: "2026-09",
          effectiveDate: "2026-09-01",
        },
        resolve(input) {
          expect(input.actualModel).toBe("routed-model");
          return {
            amount: 0.012,
            currency: "USD",
            calculationInputs: {
              inputTokens: input.usage.inputTokens,
              outputTokens: input.usage.outputTokens,
              inputRatePerMillion: 900,
              outputRatePerMillion: 1000,
              apiKey: "pricing-secret",
            },
          };
        },
      };
      const exportDirectory = path.join(tempDir, "export");
      const manifest = exportTraceJournal(journalPath, exportDirectory, {
        pricingResolver: resolver,
      });

      expect(manifest.providerMeasurements).toMatchObject({
        usage: {
          completeness: "complete",
          usage: { inputTokens: 10, outputTokens: 3 },
        },
        cost: {
          completeness: "complete",
          currencies: [
            {
              currency: "USD",
              providerReportedAmount: 0.004,
              locallyEstimatedAmount: 0.012,
            },
          ],
        },
        estimates: [
          {
            kind: "locally_estimated",
            amount: 0.012,
            currency: "USD",
            actualModel: "routed-model",
            resolver: {
              source: "test-rate-card",
              version: "2026-09",
              effectiveDate: "2026-09-01",
            },
            calculationInputs: {
              inputTokens: 10,
              outputTokens: 3,
              inputRatePerMillion: 900,
              outputRatePerMillion: 1000,
              apiKey: "[REDACTED]",
            },
          },
        ],
      });
      const persisted = JSON.parse(
        fs.readFileSync(path.join(exportDirectory, "manifest.json"), "utf8"),
      ) as { providerMeasurements: unknown };
      expect(persisted.providerMeasurements).toEqual(
        manifest.providerMeasurements,
      );
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("keeps partial estimates incomplete and isolates pricing failures", () => {
    const events = [
      attemptStarted("answer-1", "answer", "attempt-1", 1),
      usageReported({
        requestId: "answer-1",
        purpose: "answer",
        attemptId: "attempt-1",
        attemptNumber: 1,
        availability: "partial",
        usage: { inputTokens: 10 },
      }),
    ].map(envelope);
    const resolverMetadata = {
      source: "test-rate-card",
      version: "2026-09",
      effectiveDate: "2026-09-01",
    };

    const partial = summarizeProviderMeasurements(events, {
      metadata: resolverMetadata,
      resolve(input) {
        expect(input.usageAvailability).toBe("partial");
        return {
          amount: 0.01,
          currency: "USD",
          calculationInputs: { inputTokens: input.usage.inputTokens },
        };
      },
    });
    expect(partial.usage.completeness).toBe("partial");
    expect(partial.cost.completeness).toBe("partial");
    expect(partial.cost.unpricedAttempts).toEqual([]);

    const failed = summarizeProviderMeasurements(events, {
      metadata: resolverMetadata,
      resolve() {
        throw new TypeError("rate card unavailable");
      },
    });
    expect(failed.cost.completeness).toBe("unavailable");
    expect(failed.pricingWarnings).toEqual([
      {
        requestId: "answer-1",
        attemptId: "attempt-1",
        errorName: "TypeError",
      },
    ]);
  });
});
