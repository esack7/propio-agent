import type {
  ProviderReportedCost,
  ProviderRequestPurpose,
  ProviderTokenUsage,
  ProviderTraceEvent,
  ProviderUsageAvailability,
} from "@propio-ai/providers";
import type { TraceEventEnvelope } from "./types.js";
import { redactTraceValue } from "./redaction.js";

export type ProviderMeasurementCompleteness =
  "complete" | "partial" | "unavailable";

export interface ProviderPricingResolverMetadata {
  readonly source: string;
  readonly version: string;
  readonly effectiveDate: string;
}

export interface ProviderPricingInput {
  readonly provider: string;
  readonly purpose: ProviderRequestPurpose;
  readonly requestedModel: string;
  readonly actualModel?: string;
  readonly endpointClass?: string;
  readonly requestId: string;
  readonly attemptId?: string;
  readonly usageAvailability: ProviderUsageAvailability;
  readonly usage: ProviderTokenUsage;
}

export interface ProviderPriceCalculation {
  readonly amount: number;
  readonly currency: string;
  readonly calculationInputs: Readonly<Record<string, unknown>>;
}

/** Application-owned pricing. The trace layer never infers rates or free usage. */
export interface ProviderPricingResolver {
  readonly metadata: ProviderPricingResolverMetadata;
  resolve(input: ProviderPricingInput): ProviderPriceCalculation | undefined;
}

export interface ProviderCostEstimate extends ProviderPriceCalculation {
  readonly kind: "locally_estimated";
  readonly resolver: ProviderPricingResolverMetadata;
  readonly provider: string;
  readonly purpose: ProviderRequestPurpose;
  readonly requestedModel: string;
  readonly actualModel?: string;
  readonly endpointClass?: string;
  readonly requestId: string;
  readonly attemptId?: string;
  readonly usageAvailability: ProviderUsageAvailability;
  readonly usage: ProviderTokenUsage;
}

export interface ProviderCostCurrencyTotal {
  readonly currency?: string;
  readonly providerReportedAmount?: number;
  readonly locallyEstimatedAmount?: number;
}

export interface ProviderUsageAggregate {
  readonly completeness: ProviderMeasurementCompleteness;
  readonly usage?: ProviderTokenUsage;
}

export interface ProviderCostAggregate {
  readonly completeness: ProviderMeasurementCompleteness;
  readonly currencies: ReadonlyArray<ProviderCostCurrencyTotal>;
  readonly unpricedAttempts: ReadonlyArray<{
    readonly requestId: string;
    readonly attemptId?: string;
  }>;
}

export interface ProviderAttemptMeasurement {
  readonly requestId: string;
  readonly attemptId?: string;
  readonly attemptNumber?: number;
  readonly purpose: ProviderRequestPurpose;
  readonly provider: string;
  readonly requestedModel: string;
  readonly actualModel?: string;
  readonly endpointClass?: string;
  readonly outcome: "completed" | "failed" | "unknown";
  readonly usageAvailability: ProviderUsageAvailability;
  readonly usage?: ProviderTokenUsage;
  readonly providerReportedCosts: ReadonlyArray<ProviderReportedCost>;
  readonly localEstimate?: ProviderCostEstimate;
}

export interface ProviderPurposeMeasurementSummary {
  readonly purpose: ProviderRequestPurpose;
  readonly requestCount: number;
  readonly attemptCount: number;
  readonly usage: ProviderUsageAggregate;
  readonly cost: ProviderCostAggregate;
  readonly retries: ProviderRetryMeasurementSummary;
}

export interface ProviderRetryMeasurementSummary {
  readonly attemptCount: number;
  readonly usage: ProviderUsageAggregate;
  readonly cost: ProviderCostAggregate;
}

export interface ProviderMeasurementSummary {
  readonly requestCount: number;
  readonly attemptCount: number;
  readonly usage: ProviderUsageAggregate;
  readonly cost: ProviderCostAggregate;
  readonly retries: ProviderRetryMeasurementSummary;
  readonly byPurpose: ReadonlyArray<ProviderPurposeMeasurementSummary>;
  readonly attempts: ReadonlyArray<ProviderAttemptMeasurement>;
  readonly estimates: ReadonlyArray<ProviderCostEstimate>;
  readonly pricingWarnings: ReadonlyArray<{
    readonly requestId: string;
    readonly attemptId?: string;
    readonly errorName: string;
  }>;
}

type UsageMetric = keyof ProviderTokenUsage;

const USAGE_METRICS: ReadonlyArray<UsageMetric> = [
  "inputTokens",
  "outputTokens",
  "cacheReadInputTokens",
  "cacheWriteInputTokens",
  "reasoningTokens",
  "totalTokens",
];

interface MetricAccumulator {
  observed: boolean;
  cumulative?: number;
  deltaAfterCumulative: number;
  deltaOnly: number;
}

interface CostAccumulator extends MetricAccumulator {
  currency?: string;
}

interface AttemptState {
  readonly requestId: string;
  attemptId?: string;
  attemptNumber?: number;
  purpose: ProviderRequestPurpose;
  provider: string;
  requestedModel: string;
  actualModel?: string;
  endpointClass?: string;
  outcome: "completed" | "failed" | "unknown";
  usageAvailability: ProviderUsageAvailability;
  readonly usage: Map<UsageMetric, MetricAccumulator>;
  readonly costs: Map<string, CostAccumulator>;
}

interface MeasurementCollection {
  readonly attempts: Map<string, AttemptState>;
  readonly requests: Map<string, ProviderRequestPurpose>;
}

function createMetricAccumulator(): MetricAccumulator {
  return { observed: false, deltaAfterCumulative: 0, deltaOnly: 0 };
}

function applyMeasurement(
  accumulator: MetricAccumulator,
  value: number,
  reportKind: "delta" | "cumulative",
): void {
  if (!Number.isFinite(value) || value < 0) return;
  accumulator.observed = true;
  if (reportKind === "delta") {
    if (accumulator.cumulative === undefined) accumulator.deltaOnly += value;
    else accumulator.deltaAfterCumulative += value;
    return;
  }
  accumulator.cumulative = value;
  accumulator.deltaAfterCumulative = 0;
}

function measurementValue(accumulator: MetricAccumulator): number | undefined {
  if (!accumulator.observed) return undefined;
  if (accumulator.cumulative !== undefined) {
    return accumulator.cumulative + accumulator.deltaAfterCumulative;
  }
  return accumulator.deltaOnly;
}

function providerEvent(
  event: TraceEventEnvelope,
): ProviderTraceEvent | undefined {
  if (event.component !== "provider") return undefined;
  if (!event.payload || typeof event.payload !== "object") return undefined;
  const payload = event.payload as Partial<ProviderTraceEvent>;
  if (payload.type !== event.type || !payload.trace?.requestId)
    return undefined;
  return payload as ProviderTraceEvent;
}

function attemptKey(event: ProviderTraceEvent): string {
  const attemptId = "attemptId" in event ? event.attemptId : undefined;
  return `${event.trace.requestId}:${attemptId ?? "unattributed"}`;
}

function ensureAttempt(
  collection: MeasurementCollection,
  event: ProviderTraceEvent,
): AttemptState {
  const key = attemptKey(event);
  let attempt = collection.attempts.get(key);
  if (!attempt) {
    attempt = {
      requestId: event.trace.requestId,
      attemptId: "attemptId" in event ? event.attemptId : undefined,
      attemptNumber: "attemptNumber" in event ? event.attemptNumber : undefined,
      purpose: event.trace.purpose,
      provider: event.provider,
      requestedModel: event.requestedModel,
      endpointClass: "endpointClass" in event ? event.endpointClass : undefined,
      outcome: "unknown",
      usageAvailability: "unavailable",
      usage: new Map(),
      costs: new Map(),
    };
    collection.attempts.set(key, attempt);
  }
  collection.requests.set(event.trace.requestId, event.trace.purpose);
  if ("endpointClass" in event && event.endpointClass) {
    attempt.endpointClass = event.endpointClass;
  }
  return attempt;
}

function applyUsageEvent(
  attempt: AttemptState,
  event: Extract<ProviderTraceEvent, { type: "provider_usage_reported" }>,
): void {
  attempt.usageAvailability = event.availability;
  const reportKind = event.reportKind ?? "cumulative";
  applyUsageMetrics(attempt, event.usage, reportKind);
  applyReportedCost(attempt, event.providerReportedCost, reportKind);
}

function applyUsageMetrics(
  attempt: AttemptState,
  usage: ProviderTokenUsage | undefined,
  reportKind: "delta" | "cumulative",
): void {
  for (const metric of USAGE_METRICS) {
    const value = usage?.[metric];
    if (value === undefined) continue;
    const accumulator = attempt.usage.get(metric) ?? createMetricAccumulator();
    applyMeasurement(accumulator, value, reportKind);
    attempt.usage.set(metric, accumulator);
  }
}

function applyReportedCost(
  attempt: AttemptState,
  reportedCost: ProviderReportedCost | undefined,
  reportKind: "delta" | "cumulative",
): void {
  if (!reportedCost) return;
  const currency = reportedCost.currency?.trim() || undefined;
  const key = currency ?? "";
  const accumulator = attempt.costs.get(key) ?? {
    ...createMetricAccumulator(),
    currency,
  };
  applyMeasurement(accumulator, reportedCost.amount, reportKind);
  attempt.costs.set(key, accumulator);
}

type MeasurementProviderEvent = Extract<
  ProviderTraceEvent,
  {
    type:
      | "provider_attempt_started"
      | "provider_attempt_connected"
      | "provider_attempt_failed"
      | "provider_attempt_completed"
      | "provider_response_metadata"
      | "provider_usage_reported";
  }
>;

const MEASUREMENT_EVENT_TYPES = new Set<ProviderTraceEvent["type"]>([
  "provider_attempt_started",
  "provider_attempt_connected",
  "provider_attempt_failed",
  "provider_attempt_completed",
  "provider_response_metadata",
  "provider_usage_reported",
]);

function isMeasurementEvent(
  event: ProviderTraceEvent,
): event is MeasurementProviderEvent {
  return MEASUREMENT_EVENT_TYPES.has(event.type);
}

function applyAttemptEvent(
  attempt: AttemptState,
  event: MeasurementProviderEvent,
): void {
  switch (event.type) {
    case "provider_attempt_failed":
      attempt.outcome = "failed";
      return;
    case "provider_attempt_completed":
      attempt.outcome = "completed";
      return;
    case "provider_response_metadata":
      if (event.actualModel) attempt.actualModel = event.actualModel;
      return;
    case "provider_usage_reported":
      applyUsageEvent(attempt, event);
      return;
    default:
      return;
  }
}

function collectMeasurements(
  events: ReadonlyArray<TraceEventEnvelope>,
): MeasurementCollection {
  const collection: MeasurementCollection = {
    attempts: new Map(),
    requests: new Map(),
  };
  for (const envelope of events) {
    const event = providerEvent(envelope);
    if (!event) continue;
    collection.requests.set(event.trace.requestId, event.trace.purpose);
    if (!isMeasurementEvent(event)) continue;
    const attempt = ensureAttempt(collection, event);
    applyAttemptEvent(attempt, event);
  }
  return collection;
}

function usageForAttempt(
  attempt: AttemptState,
): ProviderTokenUsage | undefined {
  const usage: Record<string, number> = {};
  for (const metric of USAGE_METRICS) {
    const accumulator = attempt.usage.get(metric);
    if (!accumulator) continue;
    const value = measurementValue(accumulator);
    if (value !== undefined) usage[metric] = value;
  }
  return Object.keys(usage).length > 0 ? usage : undefined;
}

function reportedCostsForAttempt(
  attempt: AttemptState,
): ProviderReportedCost[] {
  const costs: ProviderReportedCost[] = [];
  for (const accumulator of attempt.costs.values()) {
    const amount = measurementValue(accumulator);
    if (amount === undefined) continue;
    costs.push({
      amount,
      ...(accumulator.currency ? { currency: accumulator.currency } : {}),
    });
  }
  return costs.sort((left, right) =>
    (left.currency ?? "").localeCompare(right.currency ?? ""),
  );
}

function resolveEstimate(
  attempt: AttemptState,
  usage: ProviderTokenUsage | undefined,
  resolver: ProviderPricingResolver | undefined,
  warnings: Array<{
    requestId: string;
    attemptId?: string;
    errorName: string;
  }>,
): ProviderCostEstimate | undefined {
  if (!usage || !resolver) return undefined;
  const input: ProviderPricingInput = {
    provider: attempt.provider,
    purpose: attempt.purpose,
    requestedModel: attempt.requestedModel,
    actualModel: attempt.actualModel,
    endpointClass: attempt.endpointClass,
    requestId: attempt.requestId,
    attemptId: attempt.attemptId,
    usageAvailability: attempt.usageAvailability,
    usage,
  };
  try {
    const calculation = resolver.resolve(input);
    if (!calculation) return undefined;
    const metadata = resolver.metadata;
    if (!isValidPricingResult(calculation, metadata)) {
      addPricingWarning(attempt, warnings, "InvalidPricingResult");
      return undefined;
    }
    return createCostEstimate(calculation, metadata, input);
  } catch (error) {
    addPricingWarning(
      attempt,
      warnings,
      error instanceof Error ? error.name : "Error",
    );
    return undefined;
  }
}

function isValidPricingResult(
  calculation: ProviderPriceCalculation,
  metadata: ProviderPricingResolverMetadata,
): boolean {
  const requiredStrings = [
    calculation.currency,
    metadata.source,
    metadata.version,
    metadata.effectiveDate,
  ];
  return (
    Number.isFinite(calculation.amount) &&
    calculation.amount >= 0 &&
    requiredStrings.every((value) => value.trim().length > 0) &&
    !Number.isNaN(Date.parse(metadata.effectiveDate))
  );
}

function addPricingWarning(
  attempt: AttemptState,
  warnings: Array<{
    requestId: string;
    attemptId?: string;
    errorName: string;
  }>,
  errorName: string,
): void {
  warnings.push({
    requestId: attempt.requestId,
    attemptId: attempt.attemptId,
    errorName,
  });
}

function createCostEstimate(
  calculation: ProviderPriceCalculation,
  metadata: ProviderPricingResolverMetadata,
  input: ProviderPricingInput,
): ProviderCostEstimate {
  return {
    kind: "locally_estimated",
    ...calculation,
    currency: calculation.currency.trim(),
    calculationInputs: redactTraceValue(
      calculation.calculationInputs,
    ) as Readonly<Record<string, unknown>>,
    resolver: {
      source: metadata.source.trim(),
      version: metadata.version.trim(),
      effectiveDate: metadata.effectiveDate.trim(),
    },
    ...input,
  };
}

function materializeAttempts(
  collection: MeasurementCollection,
  resolver: ProviderPricingResolver | undefined,
): {
  attempts: ProviderAttemptMeasurement[];
  warnings: ProviderMeasurementSummary["pricingWarnings"];
} {
  const warnings: Array<{
    requestId: string;
    attemptId?: string;
    errorName: string;
  }> = [];
  const attempts = [...collection.attempts.values()].map((attempt) => {
    const usage = usageForAttempt(attempt);
    const localEstimate = resolveEstimate(attempt, usage, resolver, warnings);
    return {
      requestId: attempt.requestId,
      attemptId: attempt.attemptId,
      attemptNumber: attempt.attemptNumber,
      purpose: attempt.purpose,
      provider: attempt.provider,
      requestedModel: attempt.requestedModel,
      actualModel: attempt.actualModel,
      endpointClass: attempt.endpointClass,
      outcome: attempt.outcome,
      usageAvailability: usage ? attempt.usageAvailability : "unavailable",
      usage,
      providerReportedCosts: reportedCostsForAttempt(attempt),
      localEstimate,
    } satisfies ProviderAttemptMeasurement;
  });
  return { attempts, warnings };
}

function sumUsage(
  attempts: ReadonlyArray<ProviderAttemptMeasurement>,
): ProviderUsageAggregate {
  const totals: Record<string, number> = {};
  let availableAttempts = 0;
  for (const attempt of attempts) {
    if (!attempt.usage) continue;
    availableAttempts += 1;
    addUsageTotals(totals, attempt.usage);
  }
  return {
    completeness: usageCompleteness(attempts, availableAttempts),
    ...(availableAttempts > 0 ? { usage: totals } : {}),
  };
}

function addUsageTotals(
  totals: Record<string, number>,
  usage: ProviderTokenUsage,
): void {
  for (const metric of USAGE_METRICS) {
    const value = usage[metric];
    if (value !== undefined) totals[metric] = (totals[metric] ?? 0) + value;
  }
}

function usageCompleteness(
  attempts: ReadonlyArray<ProviderAttemptMeasurement>,
  availableAttempts: number,
): ProviderMeasurementCompleteness {
  if (availableAttempts === 0) return "unavailable";
  if (availableAttempts !== attempts.length) return "partial";
  return attempts.every((attempt) => attempt.usageAvailability === "reported")
    ? "complete"
    : "partial";
}

interface MutableCostTotal {
  currency?: string;
  providerReportedAmount?: number;
  locallyEstimatedAmount?: number;
}

function addProviderReportedCosts(
  totals: Map<string, MutableCostTotal>,
  costs: ReadonlyArray<ProviderReportedCost>,
): void {
  for (const cost of costs) {
    const key = cost.currency ?? "";
    const total = totals.get(key) ?? { currency: cost.currency };
    total.providerReportedAmount =
      (total.providerReportedAmount ?? 0) + cost.amount;
    totals.set(key, total);
  }
}

function addLocalEstimate(
  totals: Map<string, MutableCostTotal>,
  estimate: ProviderCostEstimate | undefined,
): void {
  if (!estimate) return;
  const total = totals.get(estimate.currency) ?? {
    currency: estimate.currency,
  };
  total.locallyEstimatedAmount =
    (total.locallyEstimatedAmount ?? 0) + estimate.amount;
  totals.set(estimate.currency, total);
}

function hasKnownCost(attempt: ProviderAttemptMeasurement): boolean {
  return (
    attempt.providerReportedCosts.length > 0 || Boolean(attempt.localEstimate)
  );
}

function hasCompleteCost(attempt: ProviderAttemptMeasurement): boolean {
  if (attempt.providerReportedCosts.length > 0) return true;
  return (
    Boolean(attempt.localEstimate) && attempt.usageAvailability === "reported"
  );
}

function costCompleteness(
  attempts: ReadonlyArray<ProviderAttemptMeasurement>,
): ProviderMeasurementCompleteness {
  if (!attempts.some(hasKnownCost)) return "unavailable";
  return attempts.every(hasCompleteCost) ? "complete" : "partial";
}

function sumCosts(
  attempts: ReadonlyArray<ProviderAttemptMeasurement>,
): ProviderCostAggregate {
  const totals = new Map<string, MutableCostTotal>();
  const unpricedAttempts: Array<{ requestId: string; attemptId?: string }> = [];
  for (const attempt of attempts) {
    if (!hasKnownCost(attempt)) {
      unpricedAttempts.push({
        requestId: attempt.requestId,
        attemptId: attempt.attemptId,
      });
    }
    addProviderReportedCosts(totals, attempt.providerReportedCosts);
    addLocalEstimate(totals, attempt.localEstimate);
  }
  return {
    completeness: costCompleteness(attempts),
    currencies: [...totals.values()].sort((left, right) =>
      (left.currency ?? "").localeCompare(right.currency ?? ""),
    ),
    unpricedAttempts,
  };
}

function requestCount(
  requests: ReadonlyMap<string, ProviderRequestPurpose>,
  purpose?: ProviderRequestPurpose,
): number {
  return [...requests.values()].filter(
    (requestPurpose) => !purpose || requestPurpose === purpose,
  ).length;
}

function summarizeRetries(
  attempts: ReadonlyArray<ProviderAttemptMeasurement>,
): ProviderRetryMeasurementSummary {
  const retries = attempts.filter(
    (attempt) => (attempt.attemptNumber ?? 1) > 1,
  );
  return {
    attemptCount: retries.length,
    usage: sumUsage(retries),
    cost: sumCosts(retries),
  };
}

export function summarizeProviderMeasurements(
  events: ReadonlyArray<TraceEventEnvelope>,
  pricingResolver?: ProviderPricingResolver,
): ProviderMeasurementSummary {
  const collection = collectMeasurements(events);
  const materialized = materializeAttempts(collection, pricingResolver);
  const purposes: ReadonlyArray<ProviderRequestPurpose> = [
    "answer",
    "summarize",
    "recovery",
  ];
  const byPurpose = purposes
    .map((purpose) => {
      const attempts = materialized.attempts.filter(
        (attempt) => attempt.purpose === purpose,
      );
      return {
        purpose,
        requestCount: requestCount(collection.requests, purpose),
        attemptCount: attempts.length,
        usage: sumUsage(attempts),
        cost: sumCosts(attempts),
        retries: summarizeRetries(attempts),
      } satisfies ProviderPurposeMeasurementSummary;
    })
    .filter((summary) => summary.requestCount > 0 || summary.attemptCount > 0);
  return {
    requestCount: collection.requests.size,
    attemptCount: materialized.attempts.length,
    usage: sumUsage(materialized.attempts),
    cost: sumCosts(materialized.attempts),
    retries: summarizeRetries(materialized.attempts),
    byPurpose,
    attempts: materialized.attempts,
    estimates: materialized.attempts.flatMap((attempt) =>
      attempt.localEstimate ? [attempt.localEstimate] : [],
    ),
    pricingWarnings: materialized.warnings,
  };
}
