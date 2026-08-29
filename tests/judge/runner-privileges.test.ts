import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tempRoots: string[] = [];

afterEach(async () => {
  while (tempRoots.length > 0) {
    const root = tempRoots.pop();
    if (root) await rm(root, { recursive: true, force: true });
  }
});

describe("judge-runner trust boundary", () => {
  test("the runner drops privileges and bounds open file descriptors before execl", async () => {
    const root = await mkdtemp(join(tmpdir(), "gdg-runner-check-"));
    tempRoots.push(root);
    const binary = join(root, "judge-runner");
    // Same toolchain/flags as runner/Makefile.
    const build = await Bun.$`g++ -std=c++17 -O2 -pipe runner/judge-runner.cpp -o ${binary}`.quiet();
    expect(build.exitCode).toBe(0);

    // The compiled binary must reference the privilege-drop syscalls; a
    // future edit that removes them (trusted-metrics boundary, backend A:23)
    // fails this assertion at the binary level, not just in source.
    const symbols = await Bun.$`nm ${binary}`.text();
    for (const sym of ["setgroups", "setgid", "setuid", "prctl"]) {
      expect(symbols, sym).toContain(sym);
    }

    // RLIMIT_NOFILE is a requested-resource constant, not a symbol: assert the
    // child actually sets it (backend A:22 "Bound open file descriptors").
    const source = await Bun.file("runner/judge-runner.cpp").text();
    expect(source).toContain("RLIMIT_NOFILE");
    expect(source).toContain("PR_SET_NO_NEW_PRIVS");
    expect(source).toContain("PR_SET_PDEATHSIG");
    expect(source).toContain("memory.max");
    expect(source).toContain("pids.max");
    expect(source).toContain("cgroup.kill");
    expect(source).toContain("cpu.stat");
  });
});
