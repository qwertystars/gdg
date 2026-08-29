#!/usr/bin/env bun

import type { SubmissionLanguage } from "../src/domain/enums";

interface Scenario {
  name: string;
  language: SubmissionLanguage;
  sourcePath: string;
  expectedStatus: string;
}

const terminal = new Set([
  "COMPILE_ERROR",
  "WRONG_ANSWER",
  "RUNTIME_ERROR",
  "TIME_LIMIT_EXCEEDED",
  "MEMORY_LIMIT_EXCEEDED",
  "OUTPUT_LIMIT_EXCEEDED",
  "ACCEPTED",
  "JUDGE_ERROR",
]);
const args = process.argv.slice(2);
const baseUrl = (flag("--base-url") ?? "https://gdg.qwertystars.org").replace(/\/$/, "");
const token = flag("--token") ?? process.env.BENCHMARK_TOKEN;
const problemId = flag("--problem-id") ?? "problem_seed_two_sum";
const outputPath = flag("--output");
const pollMs = integer(flag("--poll-ms") ?? "2000", "--poll-ms");
const timeoutMs = integer(flag("--timeout-ms") ?? "900000", "--timeout-ms");
const batchSize = integer(flag("--batch-size") ?? "5", "--batch-size");
const batchPauseMs = integer(flag("--batch-pause-ms") ?? "11000", "--batch-pause-ms");
if (!token) throw new Error("set BENCHMARK_TOKEN or pass --token; the token is never written to the report");

function flag(name: string): string | undefined {
  const index = args.indexOf(name);
  if (index < 0) return undefined;
  const value = args[index + 1];
  if (value === undefined || value.startsWith("--")) throw new Error(`${name} requires a value`);
  return value;
}

function integer(value: string, name: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new Error(`${name} must be a positive integer`);
  return parsed;
}

const accepted: Scenario[] = [
  { name: "accepted-cpp17", language: "cpp17", sourcePath: "accepted.cpp", expectedStatus: "ACCEPTED" },
  { name: "accepted-c17", language: "c17", sourcePath: "accepted.c", expectedStatus: "ACCEPTED" },
  { name: "accepted-python3", language: "python3", sourcePath: "accepted.py", expectedStatus: "ACCEPTED" },
  { name: "accepted-javascript", language: "javascript", sourcePath: "accepted.cjs", expectedStatus: "ACCEPTED" },
];
const adversarial: Scenario[] = [
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
const scenarios = args.includes("--adversarial") ? [...accepted, ...adversarial] : accepted;
const authorization = { authorization: `Bearer ${token}` };

async function jsonFetch(
  path: string,
  init?: RequestInit,
): Promise<{ response: Response; body: Record<string, unknown> }> {
  const response = await fetch(`${baseUrl}${path}`, { ...init, signal: AbortSignal.timeout(30_000) });
  const text = await response.text();
  let body: Record<string, unknown> = {};
  try {
    body = JSON.parse(text) as Record<string, unknown>;
  } catch {
    body = { raw: text.slice(0, 1000) };
  }
  return { response, body };
}

const healthStarted = performance.now();
const health = await jsonFetch("/api/v1/health");
const healthLatencyMs = performance.now() - healthStarted;
if (!health.response.ok) throw new Error(`health check failed: HTTP ${health.response.status}`);

const submitted: Array<{
  scenario: Scenario;
  submissionId: string;
  submitLatencyMs: number;
  submittedAtMs: number;
}> = [];
const submissionFailures: Array<{ scenario: string; status: number; body: Record<string, unknown> }> = [];

for (let start = 0; start < scenarios.length; start += batchSize) {
  const batch = scenarios.slice(start, start + batchSize);
  await Promise.all(
    batch.map(async (scenario) => {
      const source = await Bun.file(`scripts/fixtures/demo/sources/${scenario.sourcePath}`).text();
      const submittedAtMs = Date.now();
      const started = performance.now();
      const { response, body } = await jsonFetch("/api/v1/submissions", {
        method: "POST",
        headers: { ...authorization, "content-type": "application/json" },
        body: JSON.stringify({ problemId, language: scenario.language, source }),
      });
      const submitLatencyMs = performance.now() - started;
      if (response.status !== 202 || typeof body.submissionId !== "string") {
        submissionFailures.push({ scenario: scenario.name, status: response.status, body });
        return;
      }
      submitted.push({ scenario, submissionId: body.submissionId, submitLatencyMs, submittedAtMs });
    }),
  );
  if (start + batchSize < scenarios.length) await Bun.sleep(batchPauseMs);
}

async function poll(item: (typeof submitted)[number]) {
  const deadline = Date.now() + timeoutMs;
  let polls = 0;
  while (Date.now() < deadline) {
    polls++;
    const { response, body } = await jsonFetch(`/api/v1/submissions/${item.submissionId}`, {
      headers: authorization,
    });
    if (!response.ok) throw new Error(`poll ${item.submissionId} failed: HTTP ${response.status}`);
    if (typeof body.status === "string" && terminal.has(body.status)) {
      return {
        scenario: item.scenario.name,
        language: item.scenario.language,
        submissionId: item.submissionId,
        expectedStatus: item.scenario.expectedStatus,
        actualStatus: body.status,
        passed: body.status === item.scenario.expectedStatus,
        submitLatencyMs: Math.round(item.submitLatencyMs * 100) / 100,
        // Client-observed duration avoids negative values when Worker and
        // client clocks differ. Server timestamps remain response metadata.
        queueAndJudgeMs: Date.now() - item.submittedAtMs,
        polls,
        performanceScoreNs: typeof body.performanceScoreNs === "number" ? body.performanceScoreNs : null,
        peakMemoryKb: typeof body.peakMemoryKb === "number" ? body.peakMemoryKb : null,
        passedTests: body.passedTests ?? null,
        totalTests: body.totalTests ?? null,
      };
    }
    await Bun.sleep(pollMs);
  }
  throw new Error(`submission ${item.submissionId} did not finish within ${timeoutMs} ms`);
}

const runs = await Promise.all(submitted.map(poll));
const failedAssertions = runs.filter((run) => !run.passed);
const report = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  target: "cloudflare",
  baseUrl,
  problemId,
  health: { status: health.response.status, latencyMs: Math.round(healthLatencyMs * 100) / 100 },
  configuration: { pollMs, timeoutMs, batchSize, batchPauseMs, adversarial: args.includes("--adversarial") },
  assertions: {
    passed: runs.length - failedAssertions.length,
    failed: failedAssertions.length + submissionFailures.length,
  },
  submissionFailures,
  runs,
};
const serialized = `${JSON.stringify(report, null, 2)}\n`;
if (outputPath) await Bun.write(outputPath, serialized);
process.stdout.write(serialized);
if (report.assertions.failed > 0) process.exitCode = 1;
