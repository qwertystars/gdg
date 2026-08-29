import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { createApp } from "../../src/api/app";
import type { SubmissionQueue } from "../../src/api/queue-adapter";
import { reconcileSubmissionDispatches } from "../../src/api/reconcile";
import { newSubmissionId } from "../../src/domain/ids";
import { SEED_PARTICIPANT_ID, SEED_PROBLEM_ID, seedData, sourceR2KeyFor } from "../../src/domain/seed";
import type { Judge, JudgeRequest, JudgeResult } from "../../src/judge";
import { JudgeConsumer, JudgeInfraError } from "../../src/judge/consumer";
import type { ArtifactStore } from "../../src/storage/artifact-store";
import { MemoryRepository } from "../../src/storage/memory-repository";

const NOW = 1_700_000_000_000;
const sha256 = (value: string): string => createHash("sha256").update(value).digest("hex");

class MemoryArtifacts implements ArtifactStore {
  readonly values = new Map<string, string>();
  async read(key: string): Promise<string> {
    const value = this.values.get(key);
    if (value === undefined) throw new Error(`missing artifact ${key}`);
    return value;
  }
  async write(key: string, contents: string): Promise<string> {
    this.values.set(key, contents);
    return key;
  }
  async cleanup(): Promise<void> {}
}

function setup() {
  const data = seedData();
  const repo = new MemoryRepository();
  repo.seed(data);
  const artifacts = new MemoryArtifacts();
  for (const testCase of data.testCases) {
    const benchmark = testCase.kind === "BENCHMARK";
    artifacts.values.set(testCase.inputR2Key, benchmark ? "100000\n" : "21\n");
    artifacts.values.set(testCase.expectedR2Key, benchmark ? "200000\n" : "42\n");
  }
  return { repo, artifacts };
}

async function queued(repo: MemoryRepository, artifacts: MemoryArtifacts, source = "int main(){}") {
  const requestedId = newSubmissionId();
  const submission = await repo.createSubmission({
    participantId: SEED_PARTICIPANT_ID,
    problemId: SEED_PROBLEM_ID,
    language: "cpp17",
    sourceR2Key: sourceR2KeyFor(requestedId),
    sourceSha256: sha256(source),
    nowMs: NOW,
  });
  await artifacts.write(submission.sourceR2Key, source);
  await repo.setSubmissionStatus(submission.id, "QUEUED", NOW);
  return submission;
}

const accepted: JudgeResult = {
  status: "ACCEPTED",
  passedTests: 3,
  totalTests: 3,
  performanceScoreNs: 1,
  peakMemoryKb: 1,
  runs: [],
  benchmarks: [],
  cleanup: { sandboxDestroyed: true, workspaceRemoved: true, remainingProcessIds: [] },
};

describe("reliable judge orchestration", () => {
  test("API accepts a durably stored submission when the initial Queue send fails", async () => {
    const { repo, artifacts } = setup();
    const failingQueue: SubmissionQueue = {
      enqueue: async () => {
        throw new Error("queue unavailable");
      },
    };
    const judge: Judge = { judge: async () => accepted };
    const app = createApp({ repo, store: artifacts, queue: failingQueue, judge, nowMs: () => NOW });
    const response = await app.request("/api/v1/submissions", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer rr_dev_participant_token_0001" },
      body: JSON.stringify({ problemId: SEED_PROBLEM_ID, language: "cpp17", source: "int main(){}" }),
    });

    expect(response.status).toBe(202);
    const body = (await response.json()) as { submissionId: string };
    expect((await repo.findSubmissionById(body.submissionId as never))?.status).toBe("QUEUED");
    const recovered: string[] = [];
    await reconcileSubmissionDispatches(repo, { enqueue: async (id) => void recovered.push(id) }, NOW + 30_000);
    expect(recovered).toEqual([body.submissionId]);
  });

  test("scheduled reconciliation repairs a lost D1-to-Queue handoff", async () => {
    const { repo, artifacts } = setup();
    const submission = await queued(repo, artifacts);
    await repo.markDispatchAttempt(submission.id, NOW);
    const sent: string[] = [];
    const queue: SubmissionQueue = { enqueue: async (id) => void sent.push(id) };

    expect(await reconcileSubmissionDispatches(repo, queue, NOW + 29_999)).toBe(0);
    expect(await reconcileSubmissionDispatches(repo, queue, NOW + 30_000)).toBe(1);
    expect(sent).toEqual([submission.id]);
    expect((await repo.findSubmissionById(submission.id))?.dispatchAttempts).toBe(2);
  });

  test("source tampering is rejected before participant code reaches the judge", async () => {
    const { repo, artifacts } = setup();
    const submission = await queued(repo, artifacts);
    await artifacts.write(submission.sourceR2Key, "tampered");
    let calls = 0;
    const judge: Judge = {
      judge: async () => {
        calls++;
        return accepted;
      },
    };
    const consumer = new JudgeConsumer({ repo, artifacts, judge, maxJudgeRetries: 1, nowMs: () => NOW + 1 });

    await expect(consumer.consume(submission.id)).rejects.toBeInstanceOf(JudgeInfraError);
    expect(calls).toBe(0);
    expect((await repo.findSubmissionById(submission.id))?.status).toBe("JUDGE_RETRY");
  });

  test("hidden test tampering is rejected before participant code reaches the judge", async () => {
    const { repo, artifacts } = setup();
    const submission = await queued(repo, artifacts);
    const hidden = (await repo.listTestCases(SEED_PROBLEM_ID, 1))[0]!;
    await artifacts.write(hidden.inputR2Key, "changed hidden input\n");
    let calls = 0;
    const judge: Judge = {
      judge: async () => {
        calls++;
        return accepted;
      },
    };
    const consumer = new JudgeConsumer({ repo, artifacts, judge, maxJudgeRetries: 1, nowMs: () => NOW + 1 });

    await expect(consumer.consume(submission.id)).rejects.toBeInstanceOf(JudgeInfraError);
    expect(calls).toBe(0);
    expect((await repo.findSubmissionById(submission.id))?.status).toBe("JUDGE_RETRY");
  });

  test("a submission uses immutable version limits after mutable problem defaults change", async () => {
    const { repo, artifacts } = setup();
    const submission = await queued(repo, artifacts);
    const problem = repo.problems.get(SEED_PROBLEM_ID)!;
    problem.limits.timeLimitMs = 99;
    problem.limits.memoryLimitKb = 99;
    let request: JudgeRequest | undefined;
    const judge: Judge = {
      judge: async (value) => {
        request = value;
        return accepted;
      },
    };
    const consumer = new JudgeConsumer({ repo, artifacts, judge, nowMs: () => NOW + 1 });

    await consumer.consume(submission.id);
    expect(request?.limits.wallTimeMs).toBe(2000);
    expect(request?.limits.memoryKb).toBe(262144);
  });
});
