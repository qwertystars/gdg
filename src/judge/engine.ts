import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanupAttempt } from "./cleanup";
import { compareOutput } from "./comparator";
import { LocalCpp17Compiler, LocalProcessExecutionAdapter, LocalSandboxAdapter } from "./local-process";
import { medianInteger, scoreBenchmarks } from "./scoring";
import type {
  BenchmarkResult,
  CleanupEvidence,
  CompilerAdapter,
  JudgeRequest,
  JudgeResult,
  JudgeRun,
  JudgeStatus,
  ProcessExecutionAdapter,
  SandboxAdapter,
  SandboxSession,
} from "./types";

export interface LocalCpp17JudgeOptions {
  workspaceRoot?: string;
  compiler?: CompilerAdapter;
  processAdapter?: ProcessExecutionAdapter;
  sandboxAdapter?: SandboxAdapter;
}

function statusForRun(classification: string): JudgeStatus {
  if (classification === "TIME_LIMIT_EXCEEDED") return "TIME_LIMIT_EXCEEDED";
  if (classification === "MEMORY_LIMIT_EXCEEDED") return "MEMORY_LIMIT_EXCEEDED";
  if (classification === "OUTPUT_LIMIT_EXCEEDED") return "OUTPUT_LIMIT_EXCEEDED";
  if (classification === "RUNTIME_ERROR") return "RUNTIME_ERROR";
  return "RUNTIME_ERROR";
}

const emptyCleanup = (): CleanupEvidence => ({
  sandboxDestroyed: false,
  workspaceRemoved: false,
  remainingProcessIds: [],
});

export class LocalCpp17Judge {
  private readonly workspaceRoot: string | undefined;
  private readonly compiler: CompilerAdapter;
  private readonly processAdapterFactory: (root: string) => ProcessExecutionAdapter;
  private readonly sandboxAdapterFactory: (processes: ProcessExecutionAdapter) => SandboxAdapter;

  constructor(options: LocalCpp17JudgeOptions = {}) {
    this.workspaceRoot = options.workspaceRoot;
    this.compiler = options.compiler ?? new LocalCpp17Compiler();
    const processAdapter = options.processAdapter;
    const sandboxAdapter = options.sandboxAdapter;
    this.processAdapterFactory = processAdapter
      ? () => processAdapter
      : (root) => new LocalProcessExecutionAdapter(root);
    this.sandboxAdapterFactory = sandboxAdapter
      ? () => sandboxAdapter
      : (processes) => new LocalSandboxAdapter(processes);
  }

  async judge(request: JudgeRequest): Promise<JudgeResult> {
    const root = this.workspaceRoot ?? requestRoot();
    await mkdir(root, { recursive: true });
    const processes = this.processAdapterFactory(root);
    const sandboxAdapter = this.sandboxAdapterFactory(processes);
    let sandbox: SandboxSession | undefined;
    const runs: JudgeRun[] = [];
    const benchmarks: BenchmarkResult[] = [];
    let status: JudgeStatus = "JUDGE_ERROR";
    let passedTests = 0;
    let peakMemoryKb = 0;
    let compilerOutput: string | undefined;
    try {
      sandbox = await sandboxAdapter.create(`local-${Date.now()}`, root);
      const compiled = await this.compiler.compile(request.source, join(root, "build"));
      if (!compiled.ok) {
        status = "COMPILE_ERROR";
        compilerOutput = compiled.output;
      } else {
        status = "ACCEPTED";
        for (const test of request.correctness) {
          const run = await this.runOne(
            sandbox,
            compiled.binaryPath,
            root,
            test.id,
            test.input,
            test.expected,
            request,
          );
          runs.push(run);
          peakMemoryKb = Math.max(peakMemoryKb, run.metrics.maxRssKb);
          if (run.metrics.classification !== "NORMAL") {
            status = statusForRun(run.metrics.classification);
            break;
          }
          if (!run.passed) {
            status = "WRONG_ANSWER";
            break;
          }
          passedTests++;
        }
        if (status === "ACCEPTED") {
          const benchmarkRuns = request.benchmarkRuns ?? 5;
          for (const test of request.benchmarks ?? []) {
            // Warm-up pass (business-logic 53 consideration): prime caches and
            // page tables so the recorded trials measure steady-state speed.
            await this.runOne(
              sandbox,
              compiled.binaryPath,
              root,
              `${test.id}-warmup`,
              test.input,
              test.expected,
              request,
            );
            const cpuTimesNs: number[] = [];
            for (let runNumber = 0; runNumber < benchmarkRuns; runNumber++) {
              const run = await this.runOne(
                sandbox,
                compiled.binaryPath,
                root,
                `${test.id}-${runNumber + 1}`,
                test.input,
                test.expected,
                request,
              );
              runs.push(run);
              peakMemoryKb = Math.max(peakMemoryKb, run.metrics.maxRssKb);
              if (run.metrics.classification !== "NORMAL") {
                status = statusForRun(run.metrics.classification);
                break;
              }
              if (!run.passed) {
                status = "WRONG_ANSWER";
                break;
              }
              cpuTimesNs.push(run.metrics.userCpuTimeNs + run.metrics.systemCpuTimeNs);
            }
            if (status !== "ACCEPTED") break;
            benchmarks.push({ testId: test.id, cpuTimesNs, medianCpuTimeNs: medianInteger(cpuTimesNs) });
          }
        }
      }
    } catch {
      status = "JUDGE_ERROR";
    }
    const cleanup = await cleanupAttempt(sandbox, processes, root).catch(() => emptyCleanup());
    const result: JudgeResult = {
      status,
      passedTests,
      totalTests: request.correctness.length,
      ...(compilerOutput === undefined ? {} : { compilerOutput }),
      runs,
      benchmarks,
      ...(status === "ACCEPTED" ? { performanceScoreNs: scoreBenchmarks(benchmarks) } : {}),
      peakMemoryKb,
      cleanup,
    };
    return result;
  }

  private async runOne(
    sandbox: SandboxSession,
    binaryPath: string,
    root: string,
    testId: string,
    input: string,
    expected: string,
    _request: JudgeRequest,
  ): Promise<JudgeRun> {
    const safeId = testId.replace(/[^a-zA-Z0-9_-]/g, "_");
    const inputPath = await sandbox.writeFile(`input/${safeId}.txt`, input);
    const stdoutPath = join(root, "output", `${safeId}.stdout`);
    const stderrPath = join(root, "output", `${safeId}.stderr`);
    const metricsPath = join(root, "metrics", `${safeId}.json`);
    await mkdir(join(root, "output"), { recursive: true });
    await mkdir(join(root, "metrics"), { recursive: true });
    const execution = await sandbox.execute({
      binaryPath,
      inputPath,
      stdoutPath,
      stderrPath,
      metricsPath,
      limits: _request.limits,
    });
    return {
      testId,
      stdout: execution.stdout,
      stderr: execution.stderr,
      metrics: execution.metrics,
      passed: execution.metrics.classification === "NORMAL" && compareOutput(execution.stdout, expected),
    };
  }
}

function requestRoot(): string {
  return join(tmpdir(), `local-judge-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
}

export function serializePublicResult(result: JudgeResult): string {
  return JSON.stringify({
    status: result.status,
    passedTests: result.passedTests,
    totalTests: result.totalTests,
    ...(result.compilerOutput === undefined ? {} : { compilerOutput: result.compilerOutput }),
    ...(result.performanceScoreNs === undefined ? {} : { performanceScoreNs: result.performanceScoreNs }),
    peakMemoryKb: result.peakMemoryKb,
  });
}
