import { spawn } from "node:child_process";
import { chmod, mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { SubmissionLanguage } from "../domain/enums";
import { languageDefinition } from "./languages";
import { parseTrustedMetrics } from "./metrics";
import type {
  CompileLimits,
  CompilerAdapter,
  ProcessExecutionAdapter,
  ProcessExecutionResult,
  ProcessExecutionSpec,
  SandboxAdapter,
  SandboxSession,
} from "./types";

const DEFAULT_COMPILE_LIMITS: CompileLimits = {
  wallTimeMs: 10_000,
  memoryKb: 524_288,
  outputBytes: 262_144,
  maxProcesses: 32,
};

// Lazy: resolved on first use. `import.meta.dir` is undefined under workerd
// (Cloudflare runtime); this module only runs when the LOCAL judge executes
// under Bun/Node, where the dir is defined.
function runnerSourcePath(): string {
  return join(import.meta.dir, "../../runner/judge-runner.cpp");
}

type CommandResult = { code: number | null; signal: string | null; output: string };

async function readBounded(path: string, bytes: number): Promise<string> {
  return Bun.file(path)
    .slice(0, bytes)
    .text()
    .catch(() => "");
}

function command(
  command: string,
  args: string[],
  cwd: string,
  timeoutMs: number,
  outputLimit: number,
): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, LANG: "C.UTF-8", LC_ALL: "C.UTF-8", TZ: "UTC" },
    });
    let output = "";
    let exceeded = false;
    const append = (chunk: Buffer) => {
      if (output.length < outputLimit) output += chunk.toString("utf8").slice(0, outputLimit - output.length);
      if (output.length >= outputLimit) exceeded = true;
    };
    child.stdout?.on("data", append);
    child.stderr?.on("data", append);
    const timer = setTimeout(() => {
      exceeded = true;
      if (child.pid) process.kill(-child.pid, "SIGKILL");
    }, timeoutMs);
    child.once("error", reject);
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, output: exceeded ? `${output}\n[output or compile timeout exceeded]` : output });
    });
  });
}

const runnerBuilds = new Map<string, Promise<string>>();

function ensureRunner(workspace: string): Promise<string> {
  const existing = runnerBuilds.get(workspace);
  if (existing) return existing;
  const build = (async () => {
    await mkdir(workspace, { recursive: true });
    const path = join(workspace, "judge-runner");
    const result = await command(
      "g++",
      ["-std=c++17", "-O2", "-pipe", runnerSourcePath(), "-o", path],
      workspace,
      30_000,
      256 * 1024,
    );
    if (result.code !== 0 || result.signal) throw new Error(`could not build judge-runner: ${result.output}`);
    return path;
  })();
  runnerBuilds.set(workspace, build);
  return build;
}

export class LocalCpp17Compiler implements CompilerAdapter {
  async compile(
    source: string,
    workspace: string,
    language: SubmissionLanguage = "cpp17",
    limits: CompileLimits = DEFAULT_COMPILE_LIMITS,
  ): Promise<
    | { ok: true; binaryPath: string; args: string[]; memoryAccounting: "address-space" | "rss" }
    | { ok: false; output: string }
  > {
    await mkdir(workspace, { recursive: true });
    // The trusted runner drops to nobody when invoked as root. Only this
    // disposable per-submission directory is writable by the compiler.
    await chmod(workspace, 0o777);
    const definition = languageDefinition(language);
    const sourcePath = join(workspace, definition.sourceFile);
    const binaryPath = join(workspace, "submission");
    await Bun.write(sourcePath, source);
    const compile = definition.compile(sourcePath, binaryPath);
    const runner = await ensureRunner(dirname(workspace));
    const trustedWorkspace = join(dirname(workspace), "trusted-compile");
    await mkdir(trustedWorkspace, { recursive: true, mode: 0o700 });
    await chmod(trustedWorkspace, 0o700);
    const inputPath = join(trustedWorkspace, "compile.stdin");
    const stdoutPath = join(trustedWorkspace, "compile.stdout");
    const stderrPath = join(trustedWorkspace, "compile.stderr");
    const metricsPath = join(trustedWorkspace, "compile.metrics.json");
    await Bun.write(inputPath, "");
    const child = spawn(
      runner,
      [
        "--binary",
        Bun.which(compile.command) ?? compile.command,
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
      { cwd: workspace, detached: true, stdio: "ignore" },
    );
    const supervisor = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code, signal) => resolve({ code, signal }));
    });
    if (supervisor.code !== 0 || supervisor.signal !== null) throw new Error("compile supervisor failed");
    const metrics = parseTrustedMetrics(await readFile(metricsPath, "utf8"));
    const output = `${await readBounded(stdoutPath, limits.outputBytes)}${await readBounded(
      stderrPath,
      limits.outputBytes,
    )}`.slice(0, limits.outputBytes);
    if (metrics.classification !== "NORMAL" || metrics.exitCode !== 0) {
      const suffix = metrics.classification === "NORMAL" ? "" : `\n[compile ${metrics.classification}]`;
      return { ok: false, output: `${output.slice(0, Math.max(0, limits.outputBytes - suffix.length))}${suffix}` };
    }
    const execution = definition.execute(sourcePath, binaryPath);
    return {
      ok: true,
      binaryPath: Bun.which(execution.command) ?? execution.command,
      args: execution.args,
      memoryAccounting: definition.memoryAccounting,
    };
  }
}

export class LocalProcessExecutionAdapter implements ProcessExecutionAdapter {
  private readonly active = new Set<number>();
  private runnerPath: string | undefined;
  private runnerPromise: Promise<string> | undefined;
  private readonly workspace: string;

  constructor(workspace: string) {
    this.workspace = workspace;
  }

  remainingProcessIds(): number[] {
    return [...this.active];
  }

  private async ensureRunner(): Promise<string> {
    if (this.runnerPath) return this.runnerPath;
    this.runnerPromise ??= ensureRunner(this.workspace).then((path) => {
      this.runnerPath = path;
      return path;
    });
    return this.runnerPromise;
  }

  async execute(spec: ProcessExecutionSpec): Promise<ProcessExecutionResult> {
    const runner = await this.ensureRunner();
    const args = [
      "--binary",
      spec.binaryPath,
      ...spec.args.flatMap((arg) => ["--arg", arg]),
      "--memory-accounting",
      spec.memoryAccounting,
      "--input",
      spec.inputPath,
      "--stdout",
      spec.stdoutPath,
      "--stderr",
      spec.stderrPath,
      "--metrics",
      spec.metricsPath,
      "--wall-ms",
      String(spec.limits.wallTimeMs),
      "--cpu-ms",
      String(spec.limits.cpuTimeMs),
      "--memory-kb",
      String(spec.limits.memoryKb),
      "--output-bytes",
      String(spec.limits.outputBytes),
      "--max-processes",
      String(spec.limits.maxProcesses),
    ];
    const child = spawn(runner, args, { cwd: this.workspace, detached: true, stdio: "ignore" });
    if (!child.pid) throw new Error("judge-runner did not start");
    this.active.add(child.pid);
    const supervisor = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code, signal) => resolve({ code, signal }));
    }).finally(() => this.active.delete(child.pid!));
    if (supervisor.code !== 0 || supervisor.signal !== null) throw new Error("execution supervisor failed");
    const metrics = parseTrustedMetrics(await readFile(spec.metricsPath, "utf8"));
    return {
      stdout: await readBounded(spec.stdoutPath, spec.limits.outputBytes),
      stderr: await readBounded(spec.stderrPath, spec.limits.outputBytes),
      metrics,
    };
  }
}

class LocalSandboxSession implements SandboxSession {
  public readonly id: string;
  public readonly root: string;
  private readonly processes: ProcessExecutionAdapter;

  constructor(id: string, root: string, processes: ProcessExecutionAdapter) {
    this.id = id;
    this.root = root;
    this.processes = processes;
  }

  async writeFile(relativePath: string, contents: string): Promise<string> {
    const path = join(this.root, relativePath);
    await mkdir(dirname(path), { recursive: true });
    await Bun.write(path, contents);
    return path;
  }

  execute(spec: ProcessExecutionSpec): Promise<ProcessExecutionResult> {
    return this.processes.execute(spec);
  }

  async destroy(): Promise<void> {
    // The native runner always kills the complete participant process group before it exits.
    // Removing the disposable workspace prevents state from crossing submissions.
  }
}

export class LocalSandboxAdapter implements SandboxAdapter {
  private readonly processes: ProcessExecutionAdapter;

  constructor(processes: ProcessExecutionAdapter) {
    this.processes = processes;
  }

  async create(id: string, root: string): Promise<SandboxSession> {
    const trustedRoot = join(root, "trusted-run");
    await mkdir(trustedRoot, { recursive: true, mode: 0o700 });
    await chmod(trustedRoot, 0o700);
    return new LocalSandboxSession(id, trustedRoot, this.processes);
  }
}
