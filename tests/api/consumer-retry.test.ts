import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { asSubmissionId, type SubmissionId } from "../../src/domain/ids";
import { SEED_PARTICIPANT_ID, SEED_PROBLEM_ID, seedData, sourceR2KeyFor } from "../../src/domain/seed";
import type { Judge, JudgeResult } from "../../src/judge";
import { JudgeConsumer, JudgeInfraError } from "../../src/judge/consumer";
import { LocalArtifactStore } from "../../src/storage/artifact-store";
import { MemoryRepository } from "../../src/storage/memory-repository";

const FIXTURES = "scripts/fixtures/demo";
const NOW = 1_700_000_000_000;

const INFRA_RESULT: JudgeResult = {
  status: "JUDGE_ERROR",
  passedTests: 0,
  totalTests: 3,
  runs: [],
  benchmarks: [],
  peakMemoryKb: 0,
  cleanup: { sandboxDestroyed: true, workspaceRemoved: true, remainingProcessIds: [] },
};

const infraJudge: Judge = { judge: async () => INFRA_RESULT };

const tempRoots: string[] = [];

async function makeConsumer(maxJudgeRetries: number): Promise<{
  repo: MemoryRepository;
  consumer: JudgeConsumer;
  submissionsRoot: string;
}> {
  const repo = new MemoryRepository();
  repo.seed(seedData());
  const submissionsRoot = await mkdtemp(join(tmpdir(), "gdg-consumer-retry-"));
  tempRoots.push(submissionsRoot);
  const store = new LocalArtifactStore(FIXTURES, submissionsRoot);
  const consumer = new JudgeConsumer({ repo, artifacts: store, judge: infraJudge, maxJudgeRetries });
  return { repo, consumer, submissionsRoot };
}

async function queuedSubmission(repo: MemoryRepository, store: LocalArtifactStore): Promise<SubmissionId> {
  const id = asSubmissionId("sub_retry_1234567890abcd");
  const submission = await repo.createSubmission({
    participantId: SEED_PARTICIPANT_ID,
    problemId: SEED_PROBLEM_ID,
    language: "cpp17",
    sourceR2Key: sourceR2KeyFor(id),
    nowMs: NOW,
  });
  await store.write(submission.sourceR2Key, "int main() { return 0; }");
  await repo.setSubmissionStatus(submission.id, "QUEUED", NOW + 1);
  return submission.id;
}

afterEach(async () => {
  while (tempRoots.length > 0) {
    const root = tempRoots.pop();
    if (root) await rm(root, { recursive: true, force: true });
  }
});

describe("judge consumer infrastructure-retry path", () => {
  test("an infra failure throws and parks the submission on JUDGE_RETRY (non-terminal, no lease)", async () => {
    const { repo, consumer, submissionsRoot } = await makeConsumer(1);
    const store = new LocalArtifactStore(FIXTURES, submissionsRoot);
    const id = await queuedSubmission(repo, store);

    await expect(consumer.consume(id)).rejects.toBeInstanceOf(JudgeInfraError);

    const stored = (await repo.findSubmissionById(id))!;
    expect(stored.status).toBe("JUDGE_RETRY");
    expect(stored.executionToken).toBeNull();
    expect(stored.leaseUntilMs).toBeNull();
    expect(stored.attemptCount).toBe(1);
    const attempts = await repo.listJudgeAttempts(id);
    expect(attempts).toHaveLength(1);
    expect(attempts[0]?.status).toBe("FAILED_RETRYABLE");
  });

  test("after the retry budget is exhausted the submission terminates as JUDGE_ERROR with an errorId", async () => {
    const { repo, consumer, submissionsRoot } = await makeConsumer(1);
    const store = new LocalArtifactStore(FIXTURES, submissionsRoot);
    const id = await queuedSubmission(repo, store);

    await expect(consumer.consume(id)).rejects.toBeInstanceOf(JudgeInfraError);
    await expect(consumer.consume(id)).rejects.toBeInstanceOf(JudgeInfraError);

    const stored = (await repo.findSubmissionById(id))!;
    expect(stored.status).toBe("JUDGE_ERROR");
    expect(stored.executionToken).toBeNull();
    expect(stored.leaseUntilMs).toBeNull();
    expect(stored.errorId).not.toBeNull();
    expect(stored.attemptCount).toBe(2);
    const attempts = await repo.listJudgeAttempts(id);
    expect(attempts.map((a) => a.status)).toEqual(["FAILED_RETRYABLE", "FAILED_TERMINAL"]);
  });

  test("a redelivery after terminal JUDGE_ERROR is an idempotent no-op (no re-claim)", async () => {
    const { repo, consumer, submissionsRoot } = await makeConsumer(1);
    const store = new LocalArtifactStore(FIXTURES, submissionsRoot);
    const id = await queuedSubmission(repo, store);

    await expect(consumer.consume(id)).rejects.toBeInstanceOf(JudgeInfraError);
    await expect(consumer.consume(id)).rejects.toBeInstanceOf(JudgeInfraError);

    await consumer.consume(id);
    const stored = (await repo.findSubmissionById(id))!;
    expect(stored.status).toBe("JUDGE_ERROR");
    expect(await repo.listJudgeAttempts(id)).toHaveLength(2);
  });
});
