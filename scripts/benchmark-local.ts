#!/usr/bin/env bun

import { cpus, platform, release } from "node:os";
import type { SubmissionLanguage } from "../src/domain/enums";
import { LocalCpp17Judge } from "../src/judge";

interface Scenario {
  name: string;
  language: SubmissionLanguage;
  sourcePath: string;
  expectedStatus: string;
}

const scenarios: Scenario[] = [
  { name: "accepted-cpp17", language: "cpp17", sourcePath: "accepted.cpp", expectedStatus: "ACCEPTED" },
  { name: "accepted-c17", language: "c17", sourcePath: "accepted.c", expectedStatus: "ACCEPTED" },
  { name: "accepted-python3", language: "python3", sourcePath: "accepted.py", expectedStatus: "ACCEPTED" },
  { name: "accepted-javascript", language: "javascript", sourcePath: "accepted.cjs", expectedStatus: "ACCEPTED" },
  { name: "compile-error", language: "cpp17", sourcePath: "compile-error.cpp", expectedStatus: "COMPILE_ERROR" },
  { name: "wrong-answer", language: "cpp17", sourcePath: "wrong-answer.cpp", expectedStatus: "WRONG_ANSWER" },
  { name: "infinite-loop", language: "cpp17", sourcePath: "infinite-loop.cpp", expectedStatus: "TIME_LIMIT_EXCEEDED" },
  {
    name: "memory-overflow",
    language: "cpp17",
    sourcePath: "memory-overflow.cpp",
    expectedStatus: "MEMORY_LIMIT_EXCEEDED",
  },
  { name: "output-flood", language: "cpp17", sourcePath: "output-flood.cpp", expectedStatus: "OUTPUT_LIMIT_EXCEEDED" },
];

const args = process.argv.slice(2);
const repeats = positiveInteger(flag("--repeats") ?? "3", "--repeats");
const concurrency = positiveInteger(flag("--concurrency") ?? "2", "--concurrency");
const outputPath = flag("--output");

function flag(name: string): string | undefined {
  const index = args.indexOf(name);
  if (index < 0) return undefined;
  const value = args[index + 1];
  if (value === undefined || value.startsWith("--")) throw new Error(`${name} requires a value`);
  return value;
}

function positiveInteger(value: string, name: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new Error(`${name} must be a positive integer`);
  return parsed;
}

async function runScenario(scenario: Scenario, iteration: number) {
  const source = await Bun.file(`scripts/fixtures/demo/sources/${scenario.sourcePath}`).text();
  const started = performance.now();
  const result = await new LocalCpp17Judge().judge({
    language: scenario.language,
    source,
    correctness: [{ id: "correctness", input: "21\n", expected: "42\n" }],
    ...(scenario.expectedStatus === "ACCEPTED"
      ? { benchmarks: [{ id: "benchmark", input: "100000\n", expected: "200000\n" }], benchmarkRuns: 5 }
      : {}),
    limits: { wallTimeMs: 500, cpuTimeMs: 500, memoryKb: 64 * 1024, outputBytes: 4096, maxProcesses: 8 },
    compileLimits: { wallTimeMs: 10_000, memoryKb: 512 * 1024, outputBytes: 64 * 1024, maxProcesses: 32 },
  });
  return {
    scenario: scenario.name,
    language: scenario.language,
    iteration,
    expectedStatus: scenario.expectedStatus,
    actualStatus: result.status,
    passed: result.status === scenario.expectedStatus,
    endToEndMs: Math.round((performance.now() - started) * 100) / 100,
    performanceScoreNs: result.performanceScoreNs ?? null,
    peakMemoryKb: result.peakMemoryKb,
    cleanup: result.cleanup,
  };
}

async function mapConcurrent<T, R>(values: T[], limit: number, operation: (value: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(values.length);
  let cursor = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, values.length) }, async () => {
      while (cursor < values.length) {
        const index = cursor++;
        results[index] = await operation(values[index]!);
      }
    }),
  );
  return results;
}

function summarize(values: number[]) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length;
  return {
    min: sorted[0],
    median: sorted[Math.floor(sorted.length / 2)],
    max: sorted.at(-1),
    mean: Math.round(mean),
    coefficientOfVariation: mean === 0 ? 0 : Math.sqrt(variance) / mean,
  };
}

const work = scenarios.flatMap((scenario) =>
  Array.from({ length: scenario.expectedStatus === "ACCEPTED" ? repeats : 1 }, (_, index) => ({
    scenario,
    iteration: index + 1,
  })),
);
const suiteStarted = performance.now();
const runs = await mapConcurrent(work, concurrency, ({ scenario, iteration }) => runScenario(scenario, iteration));
const failed = runs.filter((run) => !run.passed);
const acceptedSummary = Object.fromEntries(
  scenarios
    .filter((scenario) => scenario.expectedStatus === "ACCEPTED")
    .map((scenario) => {
      const matching = runs.filter((run) => run.scenario === scenario.name);
      return [
        scenario.name,
        {
          scoreNs: summarize(matching.flatMap((run) => run.performanceScoreNs ?? [])),
          peakMemoryKb: summarize(matching.map((run) => run.peakMemoryKb)),
          endToEndMs: summarize(matching.map((run) => run.endToEndMs)),
        },
      ];
    }),
);
const report = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  target: "local",
  environment: {
    platform: platform(),
    release: release(),
    cpuModel: cpus()[0]?.model ?? "unknown",
    logicalCpus: cpus().length,
    bun: Bun.version,
  },
  configuration: { repeats, concurrency },
  totalDurationMs: Math.round((performance.now() - suiteStarted) * 100) / 100,
  assertions: { passed: runs.length - failed.length, failed: failed.length },
  acceptedSummary,
  runs,
};

const serialized = `${JSON.stringify(report, null, 2)}\n`;
if (outputPath) await Bun.write(outputPath, serialized);
process.stdout.write(serialized);
if (failed.length > 0) process.exitCode = 1;
