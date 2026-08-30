import type { JudgeRunMetrics, RunClassification } from "./types";

const CLASSIFICATIONS = new Set<RunClassification>([
  "NORMAL",
  "RUNTIME_ERROR",
  "TIME_LIMIT_EXCEEDED",
  "MEMORY_LIMIT_EXCEEDED",
  "OUTPUT_LIMIT_EXCEEDED",
]);

function invalid(field: string): never {
  throw new Error(`invalid trusted judge metrics: ${field}`);
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) invalid("root");
  return value as Record<string, unknown>;
}

function nonNegativeInteger(metrics: Record<string, unknown>, field: string): number {
  const value = metrics[field];
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) invalid(field);
  return value;
}

function positiveInteger(metrics: Record<string, unknown>, field: string): number {
  const value = nonNegativeInteger(metrics, field);
  if (value === 0) invalid(field);
  return value;
}

function booleanField(metrics: Record<string, unknown>, field: string): boolean {
  const value = metrics[field];
  if (typeof value !== "boolean") invalid(field);
  return value;
}

function nullableInteger(metrics: Record<string, unknown>, field: string, maximum: number): number | null {
  const value = metrics[field];
  if (value === null) return null;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > maximum) invalid(field);
  return value;
}

function nullableSignal(metrics: Record<string, unknown>): number | null {
  const signal = nullableInteger(metrics, "signal", 128);
  if (signal === 0) invalid("signal");
  return signal;
}

/**
 * Parse the complete native-runner record. Missing, malformed, internally
 * inconsistent, or implausibly zero NORMAL metrics are infrastructure errors.
 */
export function parseTrustedMetrics(raw: string): JudgeRunMetrics {
  let decoded: unknown;
  try {
    decoded = JSON.parse(raw);
  } catch {
    return invalid("json");
  }
  const metrics = record(decoded);
  const classification = metrics.classification;
  if (typeof classification !== "string" || !CLASSIFICATIONS.has(classification as RunClassification)) {
    invalid("classification");
  }

  const parsed: JudgeRunMetrics = {
    exitCode: nullableInteger(metrics, "exitCode", 255),
    signal: nullableSignal(metrics),
    wallTimeNs: positiveInteger(metrics, "wallTimeNs"),
    userCpuTimeNs: nonNegativeInteger(metrics, "userCpuTimeNs"),
    systemCpuTimeNs: nonNegativeInteger(metrics, "systemCpuTimeNs"),
    maxRssKb: nonNegativeInteger(metrics, "maxRssKb"),
    maxVirtualMemoryKb: nonNegativeInteger(metrics, "maxVirtualMemoryKb"),
    timedOut: booleanField(metrics, "timedOut"),
    memoryExceeded: booleanField(metrics, "memoryExceeded"),
    outputExceeded: booleanField(metrics, "outputExceeded"),
    processLimitExceeded: booleanField(metrics, "processLimitExceeded"),
    resourceAccounting:
      metrics.resourceAccounting === "cgroup-v2" || metrics.resourceAccounting === "rlimit-proc-fallback"
        ? metrics.resourceAccounting
        : invalid("resourceAccounting"),
    classification: classification as RunClassification,
  };

  if ((parsed.exitCode === null) === (parsed.signal === null)) invalid("process status");

  const expectedClassification: RunClassification = parsed.timedOut
    ? "TIME_LIMIT_EXCEEDED"
    : parsed.memoryExceeded
      ? "MEMORY_LIMIT_EXCEEDED"
      : parsed.outputExceeded
        ? "OUTPUT_LIMIT_EXCEEDED"
        : parsed.processLimitExceeded || parsed.exitCode !== 0 || parsed.signal !== null
          ? "RUNTIME_ERROR"
          : "NORMAL";
  if (parsed.classification !== expectedClassification) invalid("classification consistency");

  if (parsed.classification === "NORMAL") {
    if (parsed.exitCode !== 0 || parsed.signal !== null) invalid("normal exit");
    if (parsed.userCpuTimeNs + parsed.systemCpuTimeNs <= 0) invalid("normal cpu time");
    if (parsed.maxRssKb <= 0) invalid("normal resident memory");
  }
  return parsed;
}
