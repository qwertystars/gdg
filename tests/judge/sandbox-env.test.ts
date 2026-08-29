import { describe, expect, test } from "bun:test";
import type { JudgeLimits } from "../../src/judge";
import { CloudflareSandboxJudge } from "../../src/judge/cloudflare/sandbox";

type ExecCall = { command: string; env: Record<string, string | undefined> };

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
        return { success: true, stdout: "", stderr: "", exitCode: 0 };
      },
      destroy: async (): Promise<void> => {},
    };
    const judge = new CloudflareSandboxJudge({
      getSandbox: () => sandbox,
    } as unknown as ConstructorParameters<typeof CloudflareSandboxJudge>[0]);

    await judge.judge(
      { source: "int main() {}", correctness: [{ id: "t", input: "1\\n", expected: "1\\n" }], limits },
      "sbx-test",
    );

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
});
