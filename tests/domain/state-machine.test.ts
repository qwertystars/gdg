import { describe, expect, test } from "bun:test";
import {
  assertTransition,
  canTransition,
  evaluateResultCommit,
  IN_FLIGHT_SUBMISSION_STATUSES,
  isTerminalSubmissionStatus,
  type SubmissionStatus,
  TERMINAL_SUBMISSION_STATUSES,
} from "../../src/domain";

const TERMINAL: readonly SubmissionStatus[] = [
  "COMPILE_ERROR",
  "WRONG_ANSWER",
  "RUNTIME_ERROR",
  "TIME_LIMIT_EXCEEDED",
  "MEMORY_LIMIT_EXCEEDED",
  "OUTPUT_LIMIT_EXCEEDED",
  "ACCEPTED",
  "JUDGE_ERROR",
];

describe("submission status transitions", () => {
  test("documented terminal statuses are recognized as terminal", () => {
    for (const status of TERMINAL) expect(isTerminalSubmissionStatus(status)).toBe(true);
    for (const status of IN_FLIGHT_SUBMISSION_STATUSES) expect(isTerminalSubmissionStatus(status)).toBe(false);
    expect(TERMINAL_SUBMISSION_STATUSES.size).toBe(8);
  });

  test("a running submission can reach every participant verdict", () => {
    for (const status of TERMINAL) {
      expect(canTransition("RUNNING", status), `RUNNING -> ${status}`).toBe(true);
    }
  });

  test("QUEUED -> RUNNING is allowed", () => {
    expect(canTransition("QUEUED", "RUNNING")).toBe(true);
  });

  test("a terminal submission cannot move to RUNNING", () => {
    for (const status of TERMINAL) {
      expect(canTransition(status, "RUNNING"), `${status} -> RUNNING`).toBe(false);
    }
  });

  test("ACCEPTED cannot move to QUEUED (no silent rejudge without admin flow)", () => {
    expect(canTransition("ACCEPTED", "QUEUED")).toBe(false);
  });

  test("assertTransition throws with from/to details on an illegal move", () => {
    let thrown: unknown;
    try {
      assertTransition("ACCEPTED", "RUNNING");
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toContain("ACCEPTED");
    expect((thrown as Error).message).toContain("RUNNING");
  });
});

describe("stale-result protection", () => {
  const running = { status: "RUNNING" as const, executionToken: "token-A" };

  test("a terminal commit with the matching token is allowed", () => {
    expect(
      evaluateResultCommit(running, {
        submissionId: "sub_x" as never,
        executionToken: "token-A",
        status: "ACCEPTED",
        nowMs: 0,
      }),
    ).toBe("COMMITTED");
  });

  test("a commit with a stale token is rejected", () => {
    expect(
      evaluateResultCommit(running, {
        submissionId: "sub_x" as never,
        executionToken: "token-B",
        status: "ACCEPTED",
        nowMs: 0,
      }),
    ).toBe("STALE_TOKEN");
  });

  test("a commit against a non-running submission is rejected even with a matching token", () => {
    expect(
      evaluateResultCommit(
        { status: "QUEUED", executionToken: null },
        { submissionId: "sub_x" as never, executionToken: "token-A", status: "ACCEPTED", nowMs: 0 },
      ),
    ).toBe("NOT_RUNNING");
  });
});
