import { spawn } from "node:child_process";
import { mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type {
  CompilerAdapter,
  ProcessExecutionAdapter,
  ProcessExecutionResult,
  ProcessExecutionSpec,
  SandboxAdapter,
  SandboxSession,
} from "./types";

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

export class LocalCpp17Compiler implements CompilerAdapter {
  async compile(
    source: string,
    workspace: string,
  ): Promise<{ ok: true; binaryPath: string } | { ok: false; output: string }> {
    await mkdir(workspace, { recursive: true });
    const sourcePath = join(workspace, "source.cpp");
    const binaryPath = join(workspace, "submission");
    await Bun.write(sourcePath, source);
    const result = await command(
      "g++",
      ["-std=c++17", "-O2", "-pipe", sourcePath, "-o", binaryPath],
      workspace,
      10_000,
      256 * 1024,
    );
    if (result.code !== 0 || result.signal) return { ok: false, output: result.output };
    return { ok: true, binaryPath };
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
    this.runnerPromise ??= (async () => {
      const path = join(this.workspace, "judge-runner");
      const result = await command(
        "g++",
        ["-std=c++17", "-O2", "-pipe", runnerSourcePath(), "-o", path],
        this.workspace,
        30_000,
        256 * 1024,
      );
      if (result.code !== 0 || result.signal) throw new Error(`could not build judge-runner: ${result.output}`);
      this.runnerPath = path;
      return path;
    })();
    return this.runnerPromise;
  }

  async execute(spec: ProcessExecutionSpec): Promise<ProcessExecutionResult> {
    const runner = await this.ensureRunner();
    const args = [
      "--binary",
      spec.binaryPath,
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
    await new Promise<void>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", () => resolve());
    }).finally(() => this.active.delete(child.pid!));
    const metrics = JSON.parse(await readFile(spec.metricsPath, "utf8"));
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
    await mkdir(root, { recursive: true });
    return new LocalSandboxSession(id, root, this.processes);
  }
}
