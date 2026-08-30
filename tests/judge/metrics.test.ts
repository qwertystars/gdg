import { describe, expect, test } from "bun:test";
import { parseTrustedMetrics } from "../../src/judge/metrics";

const valid = {
  exitCode: 0,
  signal: null,
  wallTimeNs: 1000,
  userCpuTimeNs: 1000,
  systemCpuTimeNs: 0,
  maxRssKb: 16,
  maxVirtualMemoryKb: 32,
  timedOut: false,
  memoryExceeded: false,
  outputExceeded: false,
  processLimitExceeded: false,
  resourceAccounting: "cgroup-v2",
  classification: "NORMAL",
};

describe("trusted judge metrics", () => {
  test("accepts a complete, internally consistent runner record", () => {
    expect(parseTrustedMetrics(JSON.stringify(valid))).toMatchObject(valid);
  });

  test.each(["", "not-json", "{}"])("rejects missing or malformed metrics: %s", (raw) => {
    expect(() => parseTrustedMetrics(raw)).toThrow("invalid trusted judge metrics");
  });

  test.each([
    ["wall time", { wallTimeNs: 0 }],
    ["CPU time", { userCpuTimeNs: 0, systemCpuTimeNs: 0 }],
    ["resident memory", { maxRssKb: 0 }],
    ["classification flags", { timedOut: true }],
    ["exit status", { exitCode: 1 }],
  ])("rejects implausible NORMAL %s", (_name, patch) => {
    expect(() => parseTrustedMetrics(JSON.stringify({ ...valid, ...patch }))).toThrow("invalid trusted judge metrics");
  });
});
