/**
 * Cloudflare Sandbox execution adapter: replaces LocalCpp17Judge under
 * workerd. Each attempt gets a fresh sandbox (getSandbox(env.Sandbox,
 * <submission>-<attempt>)); source + one input are written via writeFile;
 * g++ compiles once inside the container; the trusted judge-runner enforces
 * CPU/memory/output/process limits and writes trusted metrics. Expected
 * outputs never enter the container.
 */

import type { SubmissionLanguage } from "../../domain/enums";
import { compareOutput } from "../comparator";
import { type CommandSpec, languageDefinition } from "../languages";
import { parseTrustedMetrics } from "../metrics";
import { medianInteger, scoreBenchmarks } from "../scoring";
import type {
  BenchmarkResult,
  CompileLimits,
  JudgeLimits,
  JudgeRequest,
  JudgeResult,
  JudgeRun,
  JudgeStatus,
  RunClassification,
} from "../types";

const COMPILER_OUTPUT_LIMIT_BYTES = 65536;
const DEFAULT_COMPILE_LIMITS: CompileLimits = {
  wallTimeMs: 10_000,
  memoryKb: 524_288,
  outputBytes: 262_144,
  maxProcesses: 32,
};
const DEFAULT_BENCHMARK_RUNS = 5;
const SANDBOX_STARTUP_RETRIES = 6;
const SANDBOX_STARTUP_DELAY_MS = 5000;

/** Fixed minimal participant environment (business-logic 55): no inherited secrets. */
const JUDGE_EXEC_ENV = { LANG: "C.UTF-8", LC_ALL: "C.UTF-8", TZ: "UTC", PATH: "/usr/local/bin:/usr/bin:/bin" };

/** Minimal structural Sandbox binding (stable @cloudflare/sandbox). */
interface SandboxLike {
  writeFile(path: string, content: string): Promise<unknown>;
  exec(
    command: string,
    options?: {
      timeout?: number;
      env?: Record<string, string | undefined>;
      cwd?: string;
      stdin?: string;
    },
  ): Promise<{ success: boolean; stdout: string; stderr: string; exitCode: number }>;
  destroy(): Promise<void>;
}

export interface CloudflareSandboxDeps {
  getSandbox: (sandboxId: string) => SandboxLike;
}

/** True when the sandbox layer reports a transient container-starting condition. */
function isStartupError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return (
    message.includes("Container is starting") ||
    message.includes("not ready") ||
    /(?:status|code)\s*[:=]\s*503/i.test(message) ||
    message.includes("Container failed to start")
  );
}

function statusForRun(classification: RunClassification): JudgeStatus {
  switch (classification) {
    case "TIME_LIMIT_EXCEEDED":
    case "MEMORY_LIMIT_EXCEEDED":
    case "OUTPUT_LIMIT_EXCEEDED":
    case "RUNTIME_ERROR":
      return classification;
    case "NORMAL":
      return "ACCEPTED";
  }
}

/** Quote only trusted server-owned command arguments for the stable SDK shell surface. */
function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function shellCommand(spec: CommandSpec): string {
  return [spec.command, ...spec.args].map(shellQuote).join(" ");
}

export class CloudflareSandboxJudge {
  private readonly deps: CloudflareSandboxDeps;

  constructor(deps: CloudflareSandboxDeps) {
    this.deps = deps;
  }

  async judge(request: JudgeRequest, sandboxId: string): Promise<JudgeResult> {
    if (!/^[a-zA-Z0-9_-]+$/.test(sandboxId)) throw new Error("invalid sandbox id");
    const sandbox = this.deps.getSandbox(sandboxId);
    const workspace = `/workspace/${sandboxId}`;
    const trustedWorkspace = `/run/gdg-judge/${sandboxId}`;
    const runs: JudgeRun[] = [];
    const benchmarks: BenchmarkResult[] = [];
    let status: JudgeStatus = "JUDGE_ERROR";
    let passedTests = 0;
    let peakMemoryKb = 0;
    let compilerOutput: string | undefined;
    try {
      // First sandbox round-trip triggers container provisioning; the
      // container may take up to ~90s to become ready, so every early
      // operation retries through transient "Container is starting" 503s.
      const language = request.language ?? "cpp17";
      const definition = languageDefinition(language);
      await this.withStartupRetry(() =>
        this.execChecked(sandbox, shellCommand({ command: "mkdir", args: ["-p", workspace] })),
      );
      await this.withStartupRetry(() =>
        this.execChecked(sandbox, shellCommand({ command: "chmod", args: ["0777", workspace] })),
      );
      await this.withStartupRetry(() =>
        this.execChecked(
          sandbox,
          shellCommand({
            command: "install",
            args: ["-d", "-o", "root", "-g", "root", "-m", "0700", trustedWorkspace],
          }),
        ),
      );
      await this.withStartupRetry(() => sandbox.writeFile(`${workspace}/${definition.sourceFile}`, request.source));
      const compiled = await this.withStartupRetry(() =>
        this.compile(sandbox, workspace, trustedWorkspace, language, request.compileLimits ?? DEFAULT_COMPILE_LIMITS),
      );
      if (!compiled.ok) {
        status = "COMPILE_ERROR";
        compilerOutput = compiled.output;
      } else {
        status = "ACCEPTED";
        for (const test of request.correctness) {
          const run = await this.withStartupRetry(() =>
            this.runOne(
              sandbox,
              trustedWorkspace,
              compiled.program,
              compiled.memoryAccounting,
              test.id,
              test.input,
              test.expected,
              request.limits,
            ),
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
          for (const test of request.benchmarks ?? []) {
            // Warm-up pass (business-logic 53 consideration): one unrecorded
            // run per benchmark primes caches before the recorded trials.
            await this.withStartupRetry(() =>
              this.runOne(
                sandbox,
                trustedWorkspace,
                compiled.program,
                compiled.memoryAccounting,
                `${test.id}-warmup`,
                test.input,
                test.expected,
                request.limits,
              ),
            );
            const cpuTimesNs: number[] = [];
            for (let runNumber = 0; runNumber < (request.benchmarkRuns ?? DEFAULT_BENCHMARK_RUNS); runNumber++) {
              const run = await this.withStartupRetry(() =>
                this.runOne(
                  sandbox,
                  trustedWorkspace,
                  compiled.program,
                  compiled.memoryAccounting,
                  `${test.id}-${runNumber + 1}`,
                  test.input,
                  test.expected,
                  request.limits,
                ),
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
    let sandboxDestroyed = false;
    try {
      await sandbox.destroy();
      sandboxDestroyed = true;
    } catch {
      // destroy is best-effort; the container also auto-sleeps.
    }
    return {
      status,
      passedTests,
      totalTests: request.correctness.length,
      ...(compilerOutput === undefined ? {} : { compilerOutput }),
      runs,
      benchmarks,
      ...(status === "ACCEPTED" ? { performanceScoreNs: scoreBenchmarks(benchmarks) } : {}),
      peakMemoryKb,
      cleanup: { sandboxDestroyed, workspaceRemoved: sandboxDestroyed, remainingProcessIds: [] },
    };
  }

  private async withStartupRetry<T>(operation: () => Promise<T>): Promise<T> {
    let lastError: unknown;
    for (let attempt = 0; attempt < SANDBOX_STARTUP_RETRIES; attempt++) {
      if (attempt > 0) {
        await new Promise((resolve) => setTimeout(resolve, SANDBOX_STARTUP_DELAY_MS));
      }
      try {
        return await operation();
      } catch (error) {
        lastError = error;
        if (!isStartupError(error)) throw error;
      }
    }
    throw lastError;
  }

  private async execChecked(sandbox: SandboxLike, command: string): Promise<void> {
    const result = await sandbox.exec(command, { env: JUDGE_EXEC_ENV });
    if (!result.success || result.exitCode !== 0) throw new Error("trusted sandbox setup failed");
  }

  private async compile(
    sandbox: SandboxLike,
    workspace: string,
    trustedWorkspace: string,
    language: SubmissionLanguage,
    limits: CompileLimits,
  ): Promise<
    { ok: true; program: CommandSpec; memoryAccounting: "address-space" | "rss" } | { ok: false; output: string }
  > {
    const definition = languageDefinition(language);
    const sourcePath = `${workspace}/${definition.sourceFile}`;
    const outputPath = `${workspace}/submission`;
    const compile = definition.compile(sourcePath, outputPath);
    const inputPath = `${trustedWorkspace}/compile.stdin`;
    const stdoutPath = `${trustedWorkspace}/compile.stdout`;
    const stderrPath = `${trustedWorkspace}/compile.stderr`;
    const metricsPath = `${trustedWorkspace}/compile.metrics.json`;
    await sandbox.writeFile(inputPath, "");
    const runnerCommand = shellCommand({
      command: "judge-runner",
      args: [
        "--binary",
        compile.command,
        ...compile.args.flatMap((arg) => ["--arg", arg]),
        "--memory-accounting",
        definition.memoryAccounting,
        "--input",
        inputPath,
        "--stdout",
        stdoutPath,
        "--stderr",
        stderrPath,
        "--metrics",
        metricsPath,
        "--wall-ms",
        String(limits.wallTimeMs),
        "--cpu-ms",
        String(limits.wallTimeMs),
        "--memory-kb",
        String(limits.memoryKb),
        "--output-bytes",
        String(limits.outputBytes),
        "--max-processes",
        String(limits.maxProcesses),
      ],
    });
    const result = await sandbox.exec(runnerCommand, {
      timeout: limits.wallTimeMs + 5000,
      env: JUDGE_EXEC_ENV,
    });
    if (!result.success || result.exitCode !== 0) throw new Error("compile supervisor failed");
    const [metricsRaw, stdout, stderr] = await Promise.all([
      this.readSandboxFile(sandbox, metricsPath),
      this.readSandboxFile(sandbox, stdoutPath),
      this.readSandboxFile(sandbox, stderrPath),
    ]);
    const metrics = parseTrustedMetrics(metricsRaw);
    if (metrics.classification !== "NORMAL" || metrics.exitCode !== 0) {
      const suffix = metrics.classification === "NORMAL" ? "" : `\n[compile ${metrics.classification}]`;
      const cap = Math.min(limits.outputBytes, COMPILER_OUTPUT_LIMIT_BYTES);
      const diagnostics = `${stdout}\n${stderr}`.trim();
      const output = `${diagnostics.slice(0, Math.max(0, cap - suffix.length))}${suffix}`;
      return { ok: false, output };
    }
    return {
      ok: true,
      program: definition.execute(sourcePath, outputPath),
      memoryAccounting: definition.memoryAccounting,
    };
  }

  private async runOne(
    sandbox: SandboxLike,
    trustedWorkspace: string,
    program: CommandSpec,
    memoryAccounting: "address-space" | "rss",
    testId: string,
    input: string,
    expected: string,
    limits: JudgeLimits,
  ): Promise<JudgeRun> {
    const safeId = testId.replace(/[^a-zA-Z0-9_-]/g, "_");
    const inputPath = `${trustedWorkspace}/input-${safeId}.txt`;
    const stdoutPath = `${trustedWorkspace}/stdout-${safeId}.txt`;
    const stderrPath = `${trustedWorkspace}/stderr-${safeId}.txt`;
    const metricsPath = `${trustedWorkspace}/metrics-${safeId}.json`;
    await sandbox.writeFile(inputPath, input);
    const runnerCommand = shellCommand({
      command: "judge-runner",
      args: [
        "--binary",
        program.command,
        ...program.args.flatMap((arg) => ["--arg", arg]),
        "--memory-accounting",
        memoryAccounting,
        "--input",
        inputPath,
        "--stdout",
        stdoutPath,
        "--stderr",
        stderrPath,
        "--metrics",
        metricsPath,
        "--wall-ms",
        String(limits.wallTimeMs),
        "--cpu-ms",
        String(limits.cpuTimeMs),
        "--memory-kb",
        String(limits.memoryKb),
        "--output-bytes",
        String(limits.outputBytes),
        "--max-processes",
        String(limits.maxProcesses),
      ],
    });
    const result = await sandbox.exec(runnerCommand, { timeout: limits.wallTimeMs + 5000, env: JUDGE_EXEC_ENV });
    if (!result.success || result.exitCode !== 0) throw new Error("execution supervisor failed");
    const metrics = parseTrustedMetrics(await this.readSandboxFile(sandbox, metricsPath));
    const stdout =
      metrics.classification === "OUTPUT_LIMIT_EXCEEDED" ? "" : await this.readSandboxFile(sandbox, stdoutPath);
    const stderr = await this.readSandboxFile(sandbox, stderrPath);
    const passed =
      metrics.classification === "NORMAL" && result.success && result.exitCode === 0 && compareOutput(stdout, expected);
    return { testId, stdout, stderr, metrics, passed };
  }

  private async readSandboxFile(sandbox: SandboxLike, path: string): Promise<string> {
    const result = await sandbox.exec(shellCommand({ command: "cat", args: [path] }), { env: JUDGE_EXEC_ENV });
    if (!result.success || result.exitCode !== 0) throw new Error("trusted judge artifact missing");
    return result.stdout;
  }
}
