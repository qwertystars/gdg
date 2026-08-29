import { afterEach, describe, expect, test } from "bun:test";
import {
  SEED_PARTICIPANT_ID,
  SEED_PROBLEM_ID,
  type SubmissionRecord,
  seedData,
  sourceR2KeyFor,
} from "../../src/domain";
import { newSubmissionId, type SubmissionId } from "../../src/domain/ids";
import { MemoryRepository } from "../../src/storage/memory-repository";

const NOW = 1_700_000_000_000;
const LEASE_DURATION_MS = 600_000;

function seededRepo(): MemoryRepository {
  const repo = new MemoryRepository();
  repo.seed(seedData());
  return repo;
}

async function createSubmission(repo: MemoryRepository): Promise<SubmissionRecord> {
  return repo.createSubmission({
    participantId: SEED_PARTICIPANT_ID,
    problemId: SEED_PROBLEM_ID,
    language: "cpp17",
    sourceR2Key: sourceR2KeyFor(newSubmissionId()),
    sourceSha256: "0".repeat(64),
    nowMs: NOW,
  });
}

async function claim(repo: MemoryRepository, submissionId: SubmissionId, token: string, nowMs: number = NOW) {
  return repo.claimExecution({
    submissionId,
    executionToken: token,
    leaseUntilMs: nowMs + LEASE_DURATION_MS,
    nowMs,
  });
}

afterEach(() => {
  // No timers or files are involved; kept for clarity of lifecycle.
});

describe("submission repository lifecycle", () => {
  test("createSubmission snapshots the active problem version and starts in CREATED", async () => {
    const repo = seededRepo();
    const submission = await createSubmission(repo);
    expect(submission.status).toBe("CREATED");
    expect(submission.problemVersion).toBe(1);
    expect(submission.attemptCount).toBe(0);
    expect(submission.executionToken).toBeNull();
    expect(submission.leaseUntilMs).toBeNull();
  });

  test("createSubmission rejects a problem without an active version", async () => {
    const repo = seededRepo();
    const problem = (await repo.findProblemById(SEED_PROBLEM_ID))!;
    problem.activeVersion = null;
    await expect(
      repo.createSubmission({
        participantId: SEED_PARTICIPANT_ID,
        problemId: SEED_PROBLEM_ID,
        language: "cpp17",
        sourceR2Key: "submissions/x/source.cpp",
        sourceSha256: "0".repeat(64),
        nowMs: NOW,
      }),
    ).rejects.toThrow(/active version/);
  });
});

describe("claimExecution lease semantics", () => {
  test("a QUEUED submission is claimed atomically with token, lease, and incremented attempt count", async () => {
    const repo = seededRepo();
    const submission = await createSubmission(repo);
    const outcome = await claim(repo, submission.id, "token-A", NOW);
    expect(outcome).toEqual({ ok: true, attemptNumber: 1, status: "RUNNING" });

    const stored = (await repo.findSubmissionById(submission.id))!;
    expect(stored.status).toBe("RUNNING");
    expect(stored.executionToken).toBe("token-A");
    expect(stored.leaseUntilMs).toBe(NOW + LEASE_DURATION_MS);
    expect(stored.attemptCount).toBe(1);
    expect(stored.startedAtMs).toBe(NOW);
  });

  test("a second claim with a live lease is rejected", async () => {
    const repo = seededRepo();
    const submission = await createSubmission(repo);
    await claim(repo, submission.id, "token-A", NOW);
    const second = await claim(repo, submission.id, "token-B", NOW);
    expect(second).toEqual({ ok: false, reason: "LEASE_VALID", submissionId: submission.id });

    const stored = (await repo.findSubmissionById(submission.id))!;
    expect(stored.executionToken).toBe("token-A");
    expect(stored.attemptCount).toBe(1);
  });

  test("an expired lease can be reclaimed with a fresh token and attempt number", async () => {
    const repo = seededRepo();
    const submission = await createSubmission(repo);
    await claim(repo, submission.id, "token-A", NOW);
    const reclaimed = await claim(repo, submission.id, "token-B", NOW + LEASE_DURATION_MS + 1);
    expect(reclaimed).toEqual({ ok: true, attemptNumber: 2, status: "RUNNING" });

    const stored = (await repo.findSubmissionById(submission.id))!;
    expect(stored.executionToken).toBe("token-B");
    expect(stored.attemptCount).toBe(2);
  });

  test("claiming a terminal submission is rejected", async () => {
    const repo = seededRepo();
    const submission = await createSubmission(repo);
    await claim(repo, submission.id, "token-A", NOW);
    await repo.submitResult({
      submissionId: submission.id,
      executionToken: "token-A",
      status: "ACCEPTED",
      nowMs: NOW + 1,
    });
    const outcome = await claim(repo, submission.id, "token-B", NOW + 2);
    expect(outcome).toEqual({ ok: false, reason: "TERMINAL", submissionId: submission.id });
  });

  test("claiming a missing submission reports MISSING", async () => {
    const repo = seededRepo();
    const outcome = await claim(repo, newSubmissionId(), "token-A", NOW);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.reason).toBe("MISSING");
      expect(typeof outcome.submissionId).toBe("string");
    }
  });
});

describe("submitResult stale-result protection", () => {
  test("the current token holder commits a terminal result and clears the lease", async () => {
    const repo = seededRepo();
    const submission = await createSubmission(repo);
    await claim(repo, submission.id, "token-A", NOW);
    const outcome = await repo.submitResult({
      submissionId: submission.id,
      executionToken: "token-A",
      status: "ACCEPTED",
      performanceScoreNs: 800_000_000,
      peakMemoryKb: 28_672,
      passedTests: 3,
      totalTests: 3,
      nowMs: NOW + 1,
    });
    expect(outcome).toBe("COMMITTED");

    const stored = (await repo.findSubmissionById(submission.id))!;
    expect(stored.status).toBe("ACCEPTED");
    expect(stored.executionToken).toBeNull();
    expect(stored.leaseUntilMs).toBeNull();
    expect(stored.performanceScoreNs).toBe(800_000_000);
    expect(stored.passedTests).toBe(3);
  });

  test("a stale token is rejected and the newer result is preserved", async () => {
    const repo = seededRepo();
    const submission = await createSubmission(repo);

    // Attempt 1 claims, its lease expires, attempt 2 reclaims and commits ACCEPTED.
    await claim(repo, submission.id, "token-A", NOW);
    await claim(repo, submission.id, "token-B", NOW + LEASE_DURATION_MS + 1);
    await repo.submitResult({
      submissionId: submission.id,
      executionToken: "token-B",
      status: "ACCEPTED",
      performanceScoreNs: 500_000_000,
      nowMs: NOW + LEASE_DURATION_MS + 2,
    });

    // Late attempt 1 tries to commit; it must be discarded. The submission
    // is already terminal, so the commit is rejected outright.
    const late = await repo.submitResult({
      submissionId: submission.id,
      executionToken: "token-A",
      status: "WRONG_ANSWER",
      nowMs: NOW + LEASE_DURATION_MS + 3,
    });
    expect(late).not.toBe("COMMITTED");

    const stored = (await repo.findSubmissionById(submission.id))!;
    expect(stored.status).toBe("ACCEPTED");
    expect(stored.performanceScoreNs).toBe(500_000_000);
  });

  test("submitting a non-terminal status is rejected", async () => {
    const repo = seededRepo();
    const submission = await createSubmission(repo);
    await claim(repo, submission.id, "token-A", NOW);
    await expect(
      repo.submitResult({
        submissionId: submission.id,
        executionToken: "token-A",
        status: "RUNNING",
        nowMs: NOW + 1,
      }),
    ).rejects.toThrow(/terminal/);
  });

  test("committing to a missing submission reports MISSING", async () => {
    const repo = seededRepo();
    const outcome = await repo.submitResult({
      submissionId: newSubmissionId(),
      executionToken: "token-A",
      status: "ACCEPTED",
      nowMs: NOW,
    });
    expect(outcome).toBe("MISSING");
  });
});

describe("submission list", () => {
  test("listSubmissions filters by participant, problem, and status with paging", async () => {
    const repo = seededRepo();
    const sub1 = await createSubmission(repo);
    const sub2 = await createSubmission(repo);
    await repo.setSubmissionStatus(sub1.id, "QUEUED", NOW);
    await repo.setSubmissionStatus(sub2.id, "QUEUED", NOW);
    const sub3 = await createSubmission(repo);

    const all = await repo.listSubmissions({}, null, 10);
    expect(all.items).toHaveLength(3);

    const queued = await repo.listSubmissions({ status: "QUEUED" }, null, 10);
    expect(queued.items.map((s) => s.id).sort()).toEqual([sub1.id, sub2.id].sort());

    const byProblem = await repo.listSubmissions({ problemId: SEED_PROBLEM_ID }, null, 10);
    expect(byProblem.items).toHaveLength(3);

    const byParticipant = await repo.listSubmissions({ participantId: SEED_PARTICIPANT_ID }, null, 10);
    expect(byParticipant.items).toHaveLength(3);

    const one = await repo.listSubmissions({}, null, 1);
    expect(one.items).toHaveLength(1);
    expect(one.nextCursor).not.toBeNull();
    const next = await repo.listSubmissions({}, one.nextCursor, 1);
    expect(next.items).toHaveLength(1);
    expect(next.nextCursor).not.toBeNull();
    const rest = await repo.listSubmissions({}, next.nextCursor, 10);
    expect(rest.items).toHaveLength(1);
    expect(rest.nextCursor).toBeNull();
    expect([...one.items, ...next.items, ...rest.items].map((s) => s.id).sort()).toEqual(
      [sub1.id, sub2.id, sub3.id].sort(),
    );
  });
});

describe("judge attempts", () => {
  test("judge attempts are recorded per claim and can transition through their lifecycle", async () => {
    const repo = seededRepo();
    const submission = await createSubmission(repo);
    const claimOutcome = await claim(repo, submission.id, "token-A", NOW);
    expect(claimOutcome.ok).toBe(true);

    const attempt = await repo.createJudgeAttempt({
      submissionId: submission.id,
      attemptNumber: 1,
      executionToken: "token-A",
      nowMs: NOW,
    });
    expect(attempt.status).toBe("CLAIMED");

    const updated = await repo.updateJudgeAttempt(submission.id, 1, {
      status: "RUNNING",
      sandboxId: "sandbox-1",
    });
    expect(updated?.status).toBe("RUNNING");

    const finished = await repo.updateJudgeAttempt(submission.id, 1, { status: "SUCCEEDED" });
    expect(finished?.status).toBe("SUCCEEDED");

    const attempts = await repo.listJudgeAttempts(submission.id);
    expect(attempts).toHaveLength(1);
    expect(attempts[0]?.executionToken).toBe("token-A");
  });
});
