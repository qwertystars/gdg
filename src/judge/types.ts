export type JudgeStatus =
  | "ACCEPTED"
  | "COMPILE_ERROR"
  | "WRONG_ANSWER"
  | "RUNTIME_ERROR"
  | "TIME_LIMIT_EXCEEDED"
  | "MEMORY_LIMIT_EXCEEDED"
  | "OUTPUT_LIMIT_EXCEEDED"
  | "JUDGE_ERROR";

export type RunClassification =
  | "NORMAL"
  | "RUNTIME_ERROR"
  | "TIME_LIMIT_EXCEEDED"
  | "MEMORY_LIMIT_EXCEEDED"
  | "OUTPUT_LIMIT_EXCEEDED";

export interface JudgeLimits {
  wallTimeMs: number;
  cpuTimeMs: number;
  memoryKb: number;
  outputBytes: number;
  maxProcesses: number;
}

export interface CompileLimits {
  wallTimeMs: number;
  memoryKb: number;
  outputBytes: number;
  maxProcesses: number;
}

export interface JudgeTestCase {
  id: string;
  input: string;
  expected: string;
}

export interface JudgeRunMetrics {
  exitCode: number | null;
  signal: number | null;
  wallTimeNs: number;
  userCpuTimeNs: number;
  systemCpuTimeNs: number;
  maxRssKb: number;
  timedOut: boolean;
  memoryExceeded: boolean;
  outputExceeded: boolean;
  processLimitExceeded?: boolean;
  classification: RunClassification;
}

export interface JudgeRun {
  testId: string;
  stdout: string;
  stderr: string;
  metrics: JudgeRunMetrics;
  passed: boolean;
}

export interface BenchmarkResult {
  testId: string;
  cpuTimesNs: number[];
  medianCpuTimeNs: number;
}

export interface CleanupEvidence {
  sandboxDestroyed: boolean;
  workspaceRemoved: boolean;
  remainingProcessIds: number[];
}

export interface JudgeResult {
  status: JudgeStatus;
  passedTests: number;
  totalTests: number;
  compilerOutput?: string;
  runs: JudgeRun[];
  benchmarks: BenchmarkResult[];
  performanceScoreNs?: number;
  peakMemoryKb: number;
  cleanup: CleanupEvidence;
}

export interface JudgeRequest {
  /** Defaults to cpp17 for existing internal callers. API submissions always set it. */
  language?: import("../domain/enums").SubmissionLanguage;
  source: string;
  correctness: JudgeTestCase[];
  benchmarks?: JudgeTestCase[];
  limits: JudgeLimits;
  compileLimits?: CompileLimits;
  benchmarkRuns?: number;
}

/** Runtime-agnostic judge seam: both LocalCpp17Judge and CloudflareSandboxJudge satisfy this. */
export interface Judge {
  judge(request: JudgeRequest): Promise<JudgeResult>;
}

export interface ProcessExecutionSpec {
  binaryPath: string;
  /** Trusted language-adapter arguments; participant input never populates this directly. */
  args: string[];
  memoryAccounting: "address-space" | "rss";
  inputPath: string;
  stdoutPath: string;
  stderrPath: string;
  metricsPath: string;
  limits: JudgeLimits;
}

export interface ProcessExecutionResult {
  stdout: string;
  stderr: string;
  metrics: JudgeRunMetrics;
}

export interface ProcessExecutionAdapter {
  execute(spec: ProcessExecutionSpec): Promise<ProcessExecutionResult>;
  remainingProcessIds(): number[];
}

export interface SandboxSession {
  readonly id: string;
  readonly root: string;
  writeFile(relativePath: string, contents: string): Promise<string>;
  execute(spec: ProcessExecutionSpec): Promise<ProcessExecutionResult>;
  destroy(): Promise<void>;
}

export interface SandboxAdapter {
  create(id: string, root: string): Promise<SandboxSession>;
}

export interface CompilerAdapter {
  compile(
    source: string,
    workspace: string,
    language?: import("../domain/enums").SubmissionLanguage,
    limits?: CompileLimits,
  ): Promise<
    | { ok: true; binaryPath: string; args: string[]; memoryAccounting: "address-space" | "rss" }
    | { ok: false; output: string }
  >;
}

export interface OutputComparator {
  compare(actual: string, expected: string): boolean;
}
