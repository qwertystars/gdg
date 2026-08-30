import { describe, expect, test } from "bun:test";
import type { SubmissionLanguage } from "../../src/domain/enums";
import type { JudgeLimits } from "../../src/judge";
import { CloudflareSandboxJudge } from "../../src/judge/cloudflare/sandbox";

type ExecCall = { command: string; env: Record<string, string | undefined> };

const normalMetrics = JSON.stringify({
  exitCode: 0,
  signal: null,
  wallTimeNs: 1,
  userCpuTimeNs: 1,
  systemCpuTimeNs: 0,
  maxRssKb: 1,
  maxVirtualMemoryKb: 1,
  timedOut: false,
  memoryExceeded: false,
  outputExceeded: false,
  processLimitExceeded: false,
  resourceAccounting: "cgroup-v2",
  classification: "NORMAL",
});

const limits: JudgeLimits = {
  wallTimeMs: 500,
  cpuTimeMs: 500,
  memoryKb: 64 * 1024,
  outputBytes: 4 * 1024,
  maxProcesses: 8,
};

describe("CloudflareSandboxJudge execution environment", () => {
  test("every sandbox exec passes the explicit minimal environment", async () => {
    const calls: ExecCall[] = [];
    const sandbox = {
      writeFile: async (): Promise<void> => {},
      exec: async (command: string, options?: { env?: Record<string, string | undefined> }) => {
        // Snapshot the env per call: bun's toMatchObject with asymmetric matchers
        // mutates the received object, corrupting shared references across calls.
        calls.push({ command, env: { ...(options?.env ?? {}) } });
        return {
          success: true,
          stdout: command.includes("metrics") ? normalMetrics : "1\n",
          stderr: "",
          exitCode: 0,
        };
      },
      destroy: async (): Promise<void> => {},
    };
    const judge = new CloudflareSandboxJudge({
      getSandbox: () => sandbox,
    } as unknown as ConstructorParameters<typeof CloudflareSandboxJudge>[0]);

    const result = await judge.judge(
      { source: "int main() {}", correctness: [{ id: "t", input: "1\n", expected: "1\n" }], limits },
      "sbx-test",
    );

    expect(result.status).toBe("ACCEPTED");

    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) {
      // Fixed minimal participant env on every exec: compile, runs, reads.
      // Inherited platform secrets must never reach the container.
      expect(call.env, call.command).toEqual({
        LANG: "C.UTF-8",
        LC_ALL: "C.UTF-8",
        TZ: "UTC",
        PATH: "/usr/local/bin:/usr/bin:/bin",
      });
    }
  });

  test.each(["", "{}", JSON.stringify({ ...JSON.parse(normalMetrics), userCpuTimeNs: 0 })])(
    "fails closed when trusted metrics are missing, malformed, or implausibly zero",
    async (metricsBody) => {
      const sandbox = {
        writeFile: async (): Promise<void> => {},
        exec: async (command: string) => {
          if (command.includes("judge-runner")) {
            return { success: true, stdout: "", stderr: "", exitCode: 0 };
          }
          if (command.includes("compile.metrics.json")) {
            return { success: true, stdout: metricsBody, stderr: "", exitCode: 0 };
          }
          return { success: true, stdout: "42\n", stderr: "", exitCode: 0 };
        },
        destroy: async (): Promise<void> => {},
      };
      const judge = new CloudflareSandboxJudge({ getSandbox: () => sandbox });

      const result = await judge.judge(
        { source: "int main() {}", correctness: [{ id: "t", input: "1\n", expected: "1\n" }], limits },
        "sbx-invalid-metrics",
      );

      expect(result.status).toBe("JUDGE_ERROR");
      expect(result.performanceScoreNs).toBeUndefined();
    },
  );

  test("does not synthesize NORMAL zero metrics when a run metrics file is unreadable", async () => {
    const sandbox = {
      writeFile: async (): Promise<void> => {},
      exec: async (command: string) => {
        if (command.includes("judge-runner")) {
          return { success: true, stdout: "", stderr: "", exitCode: 0 };
        }
        if (command.includes("compile.metrics.json")) {
          return { success: true, stdout: normalMetrics, stderr: "", exitCode: 0 };
        }
        if (command.includes("metrics-t.json")) {
          return { success: false, stdout: "", stderr: "missing", exitCode: 1 };
        }
        return { success: true, stdout: "1\n", stderr: "", exitCode: 0 };
      },
      destroy: async (): Promise<void> => {},
    };
    const judge = new CloudflareSandboxJudge({ getSandbox: () => sandbox });

    const result = await judge.judge(
      { source: "int main() {}", correctness: [{ id: "t", input: "1\n", expected: "1\n" }], limits },
      "sbx-missing-run-metrics",
    );

    expect(result.status).toBe("JUDGE_ERROR");
    expect(result.performanceScoreNs).toBeUndefined();
    expect(result.peakMemoryKb).toBe(0);
  });
});

describe("CloudflareSandboxJudge language commands", () => {
  test.each([
    ["cpp17", "source.cpp", "g++", "--memory-accounting' 'address-space"],
    ["c17", "source.c", "gcc", "--memory-accounting' 'address-space"],
    ["python3", "source.py", "py_compile", "--memory-accounting' 'rss"],
    ["javascript", "source.cjs", "node", "--memory-accounting' 'rss"],
  ] as const)("uses only the trusted %s adapter command", async (language, sourceFile, compiler, memoryFlag) => {
    const commands: string[] = [];
    const writes: string[] = [];
    const sandbox = {
      writeFile: async (path: string): Promise<void> => {
        writes.push(path);
      },
      exec: async (command: string) => {
        commands.push(command);
        if (command.includes("metrics-")) {
          return {
            success: true,
            stdout: JSON.stringify({
              exitCode: 0,
              signal: null,
              wallTimeNs: 1,
              userCpuTimeNs: 1,
              systemCpuTimeNs: 0,
              maxRssKb: 1,
              maxVirtualMemoryKb: 1,
              timedOut: false,
              memoryExceeded: false,
              outputExceeded: false,
              processLimitExceeded: false,
              resourceAccounting: "cgroup-v2",
              classification: "NORMAL",
            }),
            stderr: "",
            exitCode: 0,
          };
        }
        if (command.includes("compile.metrics.json")) {
          return { success: true, stdout: normalMetrics, stderr: "", exitCode: 0 };
        }
        return { success: true, stdout: "42\n", stderr: "", exitCode: 0 };
      },
      destroy: async (): Promise<void> => {},
    };
    const judge = new CloudflareSandboxJudge({ getSandbox: () => sandbox });
    const hostileSource = "$(touch /tmp/adapter-command-injection)'; rm -rf /";
    const result = await judge.judge(
      {
        language: language as SubmissionLanguage,
        source: hostileSource,
        correctness: [{ id: "t", input: "21\n", expected: "42\n" }],
        limits,
      },
      "sbx-language",
    );

    expect(result.status).toBe("ACCEPTED");
    expect(writes.some((path) => path.endsWith(sourceFile))).toBe(true);
    expect(commands.some((command) => command.includes(compiler))).toBe(true);
    expect(commands.some((command) => command.includes("judge-runner") && command.includes(compiler))).toBe(true);
    expect(commands.some((command) => command.includes(memoryFlag))).toBe(true);
    expect(commands.some((command) => command.includes("install") && command.includes("0700"))).toBe(true);
    expect(
      commands
        .filter((command) => command.includes("judge-runner"))
        .every((command) => command.includes("/run/gdg-judge/")),
    ).toBe(true);
    expect(commands.every((command) => !command.includes(hostileSource))).toBe(true);
  });
});
