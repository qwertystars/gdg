import { describe, expect, test } from "bun:test";
import {
  assertRejudgeTransition,
  canRejudgeTransition,
  canTransition,
  isTerminalSubmissionStatus,
  REJUDGE_SOURCES,
  SEED_PARTICIPANT_ID,
  SEED_PROBLEM_ID,
  type SubmissionStatus,
  seedData,
  sourceR2KeyFor,
} from "../../src/domain";
import { asSubmissionId, type SubmissionId } from "../../src/domain/ids";
import { MemoryRepository } from "../../src/storage/memory-repository";

const NOW = 1_700_000_000_000;

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

async function acceptedSubmission(repo: MemoryRepository): Promise<SubmissionId> {
  const submission = await repo.createSubmission({
    participantId: SEED_PARTICIPANT_ID,
    problemId: SEED_PROBLEM_ID,
    language: "cpp17",
    sourceR2Key: sourceR2KeyFor(asSubmissionId("sub_seed_rejudge_target")),
    nowMs: NOW,
  });
  const claim = await repo.claimExecution({
    submissionId: submission.id,
    executionToken: "token-A",
    leaseUntilMs: NOW + 600_000,
    nowMs: NOW,
  });
  expect(claim.ok).toBe(true);
  await repo.submitResult({
    submissionId: submission.id,
    executionToken: "token-A",
    status: "ACCEPTED",
    performanceScoreNs: 800_000_000,
    peakMemoryKb: 28_672,
    passedTests: 3,
    totalTests: 3,
    nowMs: NOW + 1,
  });
  return submission.id;
}

describe("rejudge transition helpers", () => {
  test("every terminal status is a rejudge source and no in-flight status is", () => {
    for (const status of TERMINAL) {
      expect(REJUDGE_SOURCES.has(status), status).toBe(true);
      expect(canRejudgeTransition(status), status).toBe(true);
    }
    for (const status of ["CREATED", "QUEUED", "RUNNING", "JUDGE_RETRY"] as const) {
      expect(REJUDGE_SOURCES.has(status), status).toBe(false);
      expect(canRejudgeTransition(status), status).toBe(false);
    }
  });

  test("assertRejudgeTransition accepts a terminal source and rejects an in-flight source", () => {
    expect(() => assertRejudgeTransition("ACCEPTED")).not.toThrow();
    expect(() => assertRejudgeTransition("JUDGE_ERROR")).not.toThrow();
    expect(() => assertRejudgeTransition("QUEUED")).toThrow(/QUEUED/);
    expect(() => assertRejudgeTransition("RUNNING")).toThrow(/RUNNING/);
    expect(() => assertRejudgeTransition("CREATED")).toThrow(/CREATED/);
  });

  test("rejudge uses a dedicated path: the normal transition table forbids EVERY terminal -> QUEUED", () => {
    for (const status of TERMINAL) {
      expect(canTransition(status, "QUEUED"), status).toBe(false);
    }
    // JUDGE_ERROR is a terminal status, so the normal table must not let it
    // re-enter QUEUED; infrastructure retries use the non-terminal
    // JUDGE_RETRY status instead, and admin rejudge is the only path that
    // returns any terminal status to QUEUED.
    expect(canRejudgeTransition("JUDGE_ERROR")).toBe(true);
    expect(canTransition("JUDGE_ERROR", "QUEUED")).toBe(false);
    expect(canRejudgeTransition("ACCEPTED")).toBe(true);
    expect(canTransition("ACCEPTED", "QUEUED")).toBe(false);
  });

  test("infrastructure retries route through the non-terminal JUDGE_RETRY status", () => {
    // JUDGE_RETRY is in-flight, never terminal: it carries no lease and can be
    // re-claimed by a redelivered queue message.
    expect(isTerminalSubmissionStatus("JUDGE_RETRY")).toBe(false);
    expect(canTransition("RUNNING", "JUDGE_RETRY")).toBe(true);
    expect(canTransition("JUDGE_RETRY", "RUNNING")).toBe(true);
    // Retry budget exhausted: terminal JUDGE_ERROR, never QUEUED.
    expect(canTransition("JUDGE_RETRY", "JUDGE_ERROR")).toBe(true);
    expect(canTransition("JUDGE_RETRY", "QUEUED")).toBe(false);
    expect(canTransition("JUDGE_ERROR", "JUDGE_RETRY")).toBe(false);
  });
});

describe("resetForRejudge repository behavior", () => {
  test("resetForRejudge moves an ACCEPTED submission to QUEUED and clears the lease", async () => {
    const repo = new MemoryRepository();
    repo.seed(seedData());
    const id = await acceptedSubmission(repo);
    const before = (await repo.findSubmissionById(id))!;
    expect(before.status).toBe("ACCEPTED");

    const reset = await repo.resetForRejudge(id, NOW + 2);
    expect(reset?.status).toBe("QUEUED");
    expect(reset?.queuedAtMs).toBe(NOW + 2);
    expect(reset?.executionToken).toBeNull();
    expect(reset?.leaseUntilMs).toBeNull();
    expect(reset?.completedAtMs).toBe(before.completedAtMs);
    expect(reset?.attemptCount).toBe(1);
  });

  test("resetForRejudge rejects an in-flight source (QUEUED stays queued)", async () => {
    const repo = new MemoryRepository();
    repo.seed(seedData());
    const submission = await repo.createSubmission({
      participantId: SEED_PARTICIPANT_ID,
      problemId: SEED_PROBLEM_ID,
      language: "cpp17",
      sourceR2Key: sourceR2KeyFor(asSubmissionId("sub_seed_queued")),
      nowMs: NOW,
    });
    await repo.setSubmissionStatus(submission.id, "QUEUED", NOW);

    await expect(repo.resetForRejudge(submission.id, NOW + 1)).rejects.toThrow(/QUEUED/);
    const stored = (await repo.findSubmissionById(submission.id))!;
    expect(stored.status).toBe("QUEUED");
  });

  test("resetForRejudge on a missing submission returns null", async () => {
    const repo = new MemoryRepository();
    repo.seed(seedData());
    const result = await repo.resetForRejudge(asSubmissionId("sub_missing_000000000000000"), NOW);
    expect(result).toBeNull();
  });
});
