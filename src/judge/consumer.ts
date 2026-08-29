/**
 * Judge queue consumer: one queue message is one judging attempt.
 *
 * Orchestrates the attempt per business-logic sections 12-24 and 73:
 * load submission (missing/terminal -> ack and return), claim the
 * execution lease with a fresh token, create the judge attempt, load the
 * problem limits and test cases, read source and test fixtures from the
 * artifact store, run the judge, persist per-test results and benchmark
 * runs, then commit the terminal result with the current execution token.
 *
 * Infrastructure failures (JUDGE_ERROR) follow business-logic sections
 * 47-48: the attempt is marked FAILED_RETRYABLE and the consumer THROWS so
 * the queue handler does not ack - Cloudflare retries the message. While
 * the retry budget (MAX_JUDGE_RETRIES) remains, the submission is parked
 * on the non-terminal JUDGE_RETRY status (no lease) so a redelivered
 * message can claim it again. Once the budget is exhausted the submission
 * terminates as JUDGE_ERROR (with a correlation errorId) and the message
 * is allowed to reach the DLQ. A STALE_TOKEN commit result is discarded:
 * the submission was reclaimed by a newer attempt.
 */

import { randomUUID } from "node:crypto";
import type { SubmissionBenchmarkRecord, SubmissionTestResultRecord, TestCaseRecord } from "../domain/entities";
import { isTerminalSubmissionStatus, type SubmissionStatus } from "../domain/enums";
import type { SubmissionId } from "../domain/ids";
import type { ArtifactStore } from "../storage/artifact-store";
import type { Repository } from "../storage/repository";
import type { Judge, JudgeResult, JudgeRun, JudgeStatus } from "./types";

export const LEASE_DURATION_MS = 600_000;
export const BENCHMARK_RUNS = 5;
export const JUDGE_MAX_PROCESSES = 16;
export const DEFAULT_MAX_JUDGE_RETRIES = 3;
/** Bounded compiler diagnostic returned to participants (business-logic section 44). */
const COMPILER_OUTPUT_LIMIT_BYTES = 65_536;

/**
 * Raised by the consumer when a judge attempt fails on infrastructure so
 * the queue handler refuses to ack and the message is retried (and, once
 * retries are exhausted, reaches the DLQ).
 */
export class JudgeInfraError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "JudgeInfraError";
  }
}

export interface JudgeConsumerDeps {
  repo: Repository;
  artifacts: ArtifactStore;
  judge: Judge;
  nowMs?: () => number;
  /** Infra retries allowed after the first JUDGE_ERROR before terminating (default 3). */
  maxJudgeRetries?: number;
}

const JUDGE_STATUS_TO_SUBMISSION_STATUS: Readonly<Record<JudgeStatus, SubmissionStatus>> = {
  ACCEPTED: "ACCEPTED",
  COMPILE_ERROR: "COMPILE_ERROR",
  WRONG_ANSWER: "WRONG_ANSWER",
  RUNTIME_ERROR: "RUNTIME_ERROR",
  TIME_LIMIT_EXCEEDED: "TIME_LIMIT_EXCEEDED",
  MEMORY_LIMIT_EXCEEDED: "MEMORY_LIMIT_EXCEEDED",
  OUTPUT_LIMIT_EXCEEDED: "OUTPUT_LIMIT_EXCEEDED",
  JUDGE_ERROR: "JUDGE_ERROR",
};

const RUN_STATUS_TO_TEST_RESULT_STATUS: Readonly<
  Record<JudgeRun["metrics"]["classification"], SubmissionTestResultRecord["status"]>
> = {
  NORMAL: "PASS",
  RUNTIME_ERROR: "RUNTIME_ERROR",
  TIME_LIMIT_EXCEEDED: "TIME_LIMIT_EXCEEDED",
  MEMORY_LIMIT_EXCEEDED: "MEMORY_LIMIT_EXCEEDED",
  OUTPUT_LIMIT_EXCEEDED: "OUTPUT_LIMIT_EXCEEDED",
};

export function classifyTestResult(run: JudgeRun): SubmissionTestResultRecord["status"] {
  return RUN_STATUS_TO_TEST_RESULT_STATUS[run.metrics.classification];
}

export class JudgeConsumer {
  private readonly deps: JudgeConsumerDeps;
  private readonly maxJudgeRetries: number;

  constructor(deps: JudgeConsumerDeps) {
    this.deps = deps;
    this.maxJudgeRetries = deps.maxJudgeRetries ?? DEFAULT_MAX_JUDGE_RETRIES;
  }

  /** Processes one queue message. Missing and terminal submissions are acknowledged without work. */
  async consume(submissionId: SubmissionId): Promise<void> {
    const { repo } = this.deps;
    const submission = await repo.findSubmissionById(submissionId);
    if (submission === null) return;
    if (isTerminalSubmissionStatus(submission.status)) return;

    const nowMs = this.deps.nowMs?.() ?? Date.now();
    const executionToken = randomUUID();
    const claim = await repo.claimExecution({
      submissionId,
      executionToken,
      leaseUntilMs: nowMs + LEASE_DURATION_MS,
      nowMs,
    });
    if (!claim.ok) return;

    const problem = await repo.findProblemById(submission.problemId);
    if (problem === null) throw new Error(`problem ${submission.problemId} missing for submission ${submissionId}`);

    const allTests = await repo.listTestCases(submission.problemId, submission.problemVersion);
    const correctness = allTests.filter((t) => t.kind === "CORRECTNESS").sort((a, b) => a.ordinal - b.ordinal);
    const benchmarks = allTests.filter((t) => t.kind === "BENCHMARK").sort((a, b) => a.ordinal - b.ordinal);

    await repo.createJudgeAttempt({
      submissionId,
      attemptNumber: claim.attemptNumber,
      executionToken,
      nowMs,
    });

    const source = await this.deps.artifacts.read(submission.sourceR2Key);
    const correctnessCases = await Promise.all(correctness.map((t) => this.loadTestCase(t)));
    const benchmarkCases = await Promise.all(benchmarks.map((t) => this.loadTestCase(t)));

    const result = await this.deps.judge.judge({
      language: submission.language,
      source,
      correctness: correctnessCases,
      benchmarks: benchmarkCases,
      limits: {
        wallTimeMs: problem.limits.timeLimitMs,
        cpuTimeMs: problem.limits.timeLimitMs,
        memoryKb: problem.limits.memoryLimitKb,
        outputBytes: problem.limits.outputLimitBytes,
        maxProcesses: JUDGE_MAX_PROCESSES,
      },
      benchmarkRuns: BENCHMARK_RUNS,
    });

    await this.persistRuns(submissionId, correctness, benchmarks, result);
    await this.commitResult(submissionId, executionToken, claim.attemptNumber, nowMs, result);
  }

  private async loadTestCase(testCase: TestCaseRecord): Promise<{ id: string; input: string; expected: string }> {
    const [input, expected] = await Promise.all([
      this.deps.artifacts.read(testCase.inputR2Key),
      this.deps.artifacts.read(testCase.expectedR2Key),
    ]);
    return { id: testCase.id, input, expected };
  }

  private async persistRuns(
    submissionId: SubmissionId,
    correctness: TestCaseRecord[],
    benchmarks: TestCaseRecord[],
    result: JudgeResult,
  ): Promise<void> {
    const testResults: SubmissionTestResultRecord[] = [];
    for (let i = 0; i < correctness.length; i++) {
      const run = result.runs[i];
      if (run === undefined) continue;
      testResults.push({
        submissionId,
        testCaseId: correctness[i]!.id,
        status: classifyTestResult(run),
        cpuTimeNs: run.metrics.userCpuTimeNs + run.metrics.systemCpuTimeNs,
        wallTimeNs: run.metrics.wallTimeNs,
        peakMemoryKb: run.metrics.maxRssKb,
        exitCode: run.metrics.exitCode,
        signal: run.metrics.signal,
      });
    }
    for (const record of testResults) await this.deps.repo.saveTestResult(record);

    const benchmarkRuns: SubmissionBenchmarkRecord[] = [];
    for (const benchmark of result.benchmarks) {
      const testCase = benchmarks.find((t) => t.id === benchmark.testId);
      if (testCase === undefined) continue;
      for (let runNumber = 0; runNumber < benchmark.cpuTimesNs.length; runNumber++) {
        const run = result.runs.find((r) => r.testId === `${testCase.id}-${runNumber + 1}`);
        benchmarkRuns.push({
          submissionId,
          testCaseId: testCase.id,
          runNumber: runNumber + 1,
          cpuTimeNs: benchmark.cpuTimesNs[runNumber]!,
          wallTimeNs: run?.metrics.wallTimeNs ?? 0,
          peakMemoryKb: run?.metrics.maxRssKb ?? 0,
        });
      }
    }
    for (const record of benchmarkRuns) await this.deps.repo.saveBenchmarkRun(record);
  }

  private async commitResult(
    submissionId: SubmissionId,
    executionToken: string,
    attemptNumber: number,
    nowMs: number,
    result: JudgeResult,
  ): Promise<void> {
    const { repo } = this.deps;
    if (result.status === "JUDGE_ERROR") {
      // Mark the attempt retryable, then decide: schedule another attempt
      // (non-terminal JUDGE_RETRY + throw so the queue retries the message)
      // or, once the retry budget is exhausted, terminate the submission as
      // JUDGE_ERROR and let the message reach the DLQ.
      await repo.updateJudgeAttempt(submissionId, attemptNumber, {
        status: "FAILED_RETRYABLE",
        infrastructureError: "judge engine reported JUDGE_ERROR",
        completedAtMs: nowMs,
      });
      const retriesUsed = (await repo.listJudgeAttempts(submissionId)).filter(
        (attempt) => attempt.status === "FAILED_RETRYABLE",
      ).length;
      if (retriesUsed <= this.maxJudgeRetries) {
        await repo.setSubmissionStatus(submissionId, "JUDGE_RETRY", nowMs);
        throw new JudgeInfraError(
          `judge infrastructure failure; scheduled retry ${retriesUsed}/${this.maxJudgeRetries}`,
        );
      }
      const errorId = `judge_err_${randomUUID().replaceAll("-", "")}`;
      const outcome = await repo.submitResult({
        submissionId,
        executionToken,
        status: "JUDGE_ERROR",
        errorId,
        nowMs,
      });
      await repo.updateJudgeAttempt(submissionId, attemptNumber, {
        status: "FAILED_TERMINAL",
        infrastructureError: `judge infrastructure failure; retries exhausted (${retriesUsed}/${this.maxJudgeRetries})`,
        errorId,
        completedAtMs: nowMs,
      });
      if (outcome === "STALE_TOKEN") {
        // A newer attempt owns the submission; do not force another retry.
        return;
      }
      throw new JudgeInfraError(`judge infrastructure failure; retries exhausted, submission JUDGE_ERROR`);
    }
    // Compiler diagnostics live in the artifact store, never in repository
    // rows: persist the bounded log under the attempt's key and carry that
    // key into the commit so the submission stores compileLogR2Key.
    let compileLogR2Key: string | undefined;
    if (result.status === "COMPILE_ERROR" && result.compilerOutput !== undefined) {
      const key = `judge-artifacts/${submissionId}/${attemptNumber}/compile.log`;
      await this.deps.artifacts.write(key, result.compilerOutput.slice(0, COMPILER_OUTPUT_LIMIT_BYTES));
      compileLogR2Key = key;
    }
    const outcome = await repo.submitResult({
      submissionId,
      executionToken,
      status: JUDGE_STATUS_TO_SUBMISSION_STATUS[result.status],
      nowMs,
      ...(compileLogR2Key === undefined ? {} : { compileLogR2Key }),
      ...(result.performanceScoreNs === undefined ? {} : { performanceScoreNs: result.performanceScoreNs }),
      ...(result.peakMemoryKb === undefined ? {} : { peakMemoryKb: result.peakMemoryKb }),
      ...(result.passedTests === undefined ? {} : { passedTests: result.passedTests }),
      ...(result.totalTests === undefined ? {} : { totalTests: result.totalTests }),
    });
    if (outcome === "STALE_TOKEN") {
      // The submission was reclaimed by a newer attempt; this attempt's
      // result must not overwrite the authoritative one.
      await repo.updateJudgeAttempt(submissionId, attemptNumber, {
        status: "FAILED_RETRYABLE",
        infrastructureError: "stale execution token; result discarded",
        completedAtMs: nowMs,
      });
      return;
    }
    await repo.updateJudgeAttempt(submissionId, attemptNumber, { status: "SUCCEEDED", completedAtMs: nowMs });
  }
}
