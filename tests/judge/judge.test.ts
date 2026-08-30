import { afterEach, describe, expect, test } from "bun:test";
import type { SubmissionLanguage } from "../../src/domain/enums";
import {
  type JudgeLimits,
  LocalCpp17Judge,
  medianInteger,
  scoreBenchmarks,
  serializePublicResult,
} from "../../src/judge";
import { classifyTestResult } from "../../src/judge/consumer";
import { LocalCpp17Compiler, LocalProcessExecutionAdapter } from "../../src/judge/local-process";
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

async function judgeLanguage(language: SubmissionLanguage, source: string) {
  const root = await Bun.$`mktemp -d`.text();
  const workspace = root.trim();
  tempRoots.push(workspace);
  return new LocalCpp17Judge({ workspaceRoot: workspace }).judge({
    language,
    source,
    correctness: [{ id: "sample", input: "21\n", expected: "42\n" }],
    limits: { ...limits, memoryKb: 512 * 1024 },
  });
}

afterEach(async () => {
  while (tempRoots.length > 0) {
    const root = tempRoots.pop();
    if (root) await Bun.$`rm -rf ${root}`;
  }
});

describe("multi-language judge", () => {
  test.each([
    [
      "c17",
      '#include <stdio.h>\nint main(void) { long long n; if (scanf("%lld", &n) != 1) return 1; printf("%lld\\n", n * 2); }',
    ],
    ["python3", "import sys\nn = int(sys.stdin.readline())\nprint(n * 2)\n"],
    [
      "javascript",
      "const fs = require('node:fs'); const n = BigInt(fs.readFileSync(0, 'utf8').trim()); console.log(String(n * 2n));",
    ],
  ] as const)("accepts a correct %s submission", async (language, source) => {
    const result = await judgeLanguage(language, source);
    expect(result.status).toBe("ACCEPTED");
    expect(result.runs[0]?.stdout).toBe("42\n");
    expect(result.runs[0]?.metrics.wallTimeNs).toBeGreaterThan(0);
  });

  test.each([
    ["c17", "int main( {"],
    ["python3", "if True print('broken')"],
    ["javascript", "const = broken"],
  ] as const)("classifies invalid %s source as COMPILE_ERROR", async (language, source) => {
    const result = await judgeLanguage(language, source);
    expect(result.status).toBe("COMPILE_ERROR");
    expect(result.compilerOutput).toBeTruthy();
  });

  test("enforces Python memory by aggregate RSS without triggering a runtime crash dialog", async () => {
    const root = await Bun.$`mktemp -d`.text();
    const workspace = root.trim();
    tempRoots.push(workspace);
    const result = await new LocalCpp17Judge({ workspaceRoot: workspace }).judge({
      language: "python3",
      source: "chunks = []\nwhile True:\n    chunks.append(bytearray(1024 * 1024))\n",
      correctness: [{ id: "memory", input: "", expected: "" }],
      limits: { ...limits, memoryKb: 64 * 1024 },
    });
    expect(result.status).toBe("MEMORY_LIMIT_EXCEEDED");
    expect(result.runs[0]?.metrics.memoryExceeded).toBe(true);
  });
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

  test("classifies native address-space exhaustion as MEMORY_LIMIT_EXCEEDED", async () => {
    const source = await Bun.file("scripts/fixtures/demo/sources/memory-overflow.cpp").text();
    const result = await judge(source, "", "");
    expect(result.status).toBe("MEMORY_LIMIT_EXCEEDED");
    expect(result.runs[0]?.metrics.maxRssKb).toBeGreaterThan(0);
    expect(result.cleanup.remainingProcessIds).toEqual([]);
  });

  test("accounts CPU work performed by participant child processes", async () => {
    const result = await judge(await fixture("forked-work.cpp"));
    expect(result.status).toBe("ACCEPTED");
    const cpuNs = result.runs[0]!.metrics.userCpuTimeNs + result.runs[0]!.metrics.systemCpuTimeNs;
    expect(cpuNs).toBeGreaterThan(1_000_000);
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

test("a normal exit with mismatched output persists as WRONG_ANSWER", () => {
  expect(
    classifyTestResult({
      testId: "t",
      stdout: "wrong\n",
      stderr: "",
      passed: false,
      metrics: {
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
      },
    }),
  ).toBe("WRONG_ANSWER");
});

test("participant-controlled compiler diagnostics are supervisor-bounded", async () => {
  const root = (await Bun.$`mktemp -d`.text()).trim();
  tempRoots.push(root);
  const compiler = new LocalCpp17Compiler();
  const source = `${Array.from({ length: 2000 }, (_, index) => `#warning participant_${index}`).join("\n")}\nint main(){}`;
  const result = await compiler.compile(source, `${root}/build`, "cpp17", {
    wallTimeMs: 5000,
    memoryKb: 512 * 1024,
    outputBytes: 1024,
    maxProcesses: 16,
  });

  expect(result.ok).toBe(false);
  if (!result.ok) {
    expect(new TextEncoder().encode(result.output).byteLength).toBeLessThanOrEqual(1024);
    expect(result.output).toContain("compile OUTPUT_LIMIT_EXCEEDED");
  }
});

test("the parent-cmdline metrics symlink exploit fails closed", async () => {
  const root = (await Bun.$`mktemp -d`.text()).trim();
  tempRoots.push(root);
  const source = String.raw`
#include <fstream>
#include <iostream>
#include <iterator>
#include <string>
#include <unistd.h>
#include <vector>

int main() {
  std::ifstream stream("/proc/" + std::to_string(getppid()) + "/cmdline", std::ios::binary);
  const std::string raw((std::istreambuf_iterator<char>(stream)), std::istreambuf_iterator<char>());
  std::vector<std::string> arguments;
  for (size_t start = 0; start < raw.size();) {
    const size_t end = raw.find('\0', start);
    arguments.push_back(raw.substr(start, end == std::string::npos ? raw.size() - start : end - start));
    if (end == std::string::npos) break;
    start = end + 1;
  }
  for (size_t index = 0; index + 1 < arguments.size(); ++index) {
    if (arguments[index] == "--metrics") {
      unlink(arguments[index + 1].c_str());
      symlink("/dev/null", arguments[index + 1].c_str());
      break;
    }
  }
  long long value = 0;
  std::cin >> value;
  std::cout << value * 2 << '\n';
}
`;
  const result = await new LocalCpp17Judge({ workspaceRoot: root }).judge({
    source,
    correctness: [{ id: "correctness", input: "21\n", expected: "42\n" }],
    benchmarks: [{ id: "benchmark", input: "100000\n", expected: "200000\n" }],
    limits,
  });

  expect(result.status).toBe("JUDGE_ERROR");
  expect(result.performanceScoreNs).toBeUndefined();
});
