import { afterEach, describe, expect, test } from "bun:test";
import {
  type JudgeLimits,
  LocalCpp17Judge,
  medianInteger,
  scoreBenchmarks,
  serializePublicResult,
} from "../../src/judge";
import { LocalProcessExecutionAdapter } from "../../src/judge/local-process";
import type { ProcessExecutionAdapter } from "../../src/judge/types";

const limits: JudgeLimits = {
  wallTimeMs: 500,
  cpuTimeMs: 500,
  memoryKb: 64 * 1024,
  outputBytes: 4 * 1024,
  maxProcesses: 8,
};

const fixture = (name: string) => Bun.file(`tests/judge/fixtures/${name}`).text();

const tempRoots: string[] = [];

async function judge(source: string, input = "21\n", expected = "42\n") {
  const root = await Bun.$`mktemp -d`.text();
  const workspace = root.trim();
  tempRoots.push(workspace);
  const engine = new LocalCpp17Judge({ workspaceRoot: workspace });
  return engine.judge({
    source,
    correctness: [{ id: "sample", input, expected }],
    limits,
  });
}

afterEach(async () => {
  while (tempRoots.length > 0) {
    const root = tempRoots.pop();
    if (root) await Bun.$`rm -rf ${root}`;
  }
});

describe("local C++17 judge", () => {
  test("accepts correct output and keeps stdout outside metrics", async () => {
    const result = await judge(await fixture("accepted.cpp"));

    expect(result.status).toBe("ACCEPTED");
    expect(result.passedTests).toBe(1);
    expect(result.runs[0]?.stdout).toBe("42\n");
    expect(result.runs[0]?.metrics.outputExceeded).toBe(false);
    expect("stdout" in result.runs[0]!.metrics).toBe(false);

    const publicResult = serializePublicResult(result);
    expect(publicResult).not.toContain("stdout");
    expect(publicResult).not.toContain("expected");
    expect(Object.keys(JSON.parse(publicResult))).not.toContain("runs");
  });

  test("classifies compiler diagnostics as COMPILE_ERROR", async () => {
    const result = await judge(await fixture("compile-error.cpp"));
    expect(result.status).toBe("COMPILE_ERROR");
    expect(result.compilerOutput).toBeTruthy();
  });

  test("classifies mismatched output as WRONG_ANSWER", async () => {
    const result = await judge(await fixture("wrong-answer.cpp"), "21\n", "42\n");
    expect(result.status).toBe("WRONG_ANSWER");
  });

  test("classifies a non-zero exit as RUNTIME_ERROR", async () => {
    const result = await judge(await fixture("runtime-error.cpp"), "", "");
    expect(result.status).toBe("RUNTIME_ERROR");
  });

  test("classifies an infinite loop as TIME_LIMIT_EXCEEDED", async () => {
    const result = await judge(await fixture("infinite-loop.cpp"), "", "");
    expect(result.status).toBe("TIME_LIMIT_EXCEEDED");
    expect(result.cleanup.sandboxDestroyed).toBe(true);
    expect(result.cleanup.remainingProcessIds).toEqual([]);
  });

  test("classifies unbounded output as OUTPUT_LIMIT_EXCEEDED", async () => {
    const result = await judge(await fixture("output-flood.cpp"), "", "");
    expect(result.status).toBe("OUTPUT_LIMIT_EXCEEDED");
    expect(result.cleanup.sandboxDestroyed).toBe(true);
  });
});

test("benchmark scoring runs one warm-up pass before the recorded trials", async () => {
  const root = await Bun.$`mktemp -d`.text();
  const workspace = root.trim();
  tempRoots.push(workspace);
  const inner = new LocalProcessExecutionAdapter(workspace);
  const executed: string[] = [];
  const counting: ProcessExecutionAdapter = {
    execute: (spec) => {
      executed.push(spec.binaryPath);
      return inner.execute(spec);
    },
    remainingProcessIds: () => inner.remainingProcessIds(),
  };
  const engine = new LocalCpp17Judge({ processAdapter: counting });
  const result = await engine.judge({
    source: await fixture("accepted.cpp"),
    correctness: [{ id: "sample", input: "21\n", expected: "42\n" }],
    benchmarks: [{ id: "bench", input: "100000\n", expected: "200000\n" }],
    limits,
    benchmarkRuns: 3,
  });
  expect(result.status).toBe("ACCEPTED");
  expect(executed.length).toBe(5);
  expect(result.benchmarks[0]?.cpuTimesNs).toHaveLength(3);
});

test("medianInteger returns the integer middle value and benchmark scores sum medians", () => {
  expect(medianInteger([91, 94, 92, 181, 93])).toBe(93);
  expect(medianInteger([8, 2, 4, 6])).toBe(5);
  expect(
    scoreBenchmarks([
      { testId: "a", cpuTimesNs: [10], medianCpuTimeNs: 10 },
      { testId: "b", cpuTimesNs: [20], medianCpuTimeNs: 20 },
    ]),
  ).toBe(30);
});
