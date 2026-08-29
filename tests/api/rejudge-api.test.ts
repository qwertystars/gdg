import { describe, expect, test } from "bun:test";
import { createApp } from "../../src/api/app";
import { LocalQueueAdapter } from "../../src/api/queue-adapter";
import { asSubmissionId, type SubmissionId } from "../../src/domain/ids";
import { seedData } from "../../src/domain/seed";
import { LocalCpp17Judge } from "../../src/judge";
import { LocalArtifactStore } from "../../src/storage/artifact-store";
import { MemoryRepository } from "../../src/storage/memory-repository";

const PARTICIPANT_TOKEN = "rr_dev_participant_token_0001";
const ADMIN_TOKEN = "rr_dev_admin_token_0001";
const FIXTURES = "scripts/fixtures/demo";

type TestCtx = {
  app: ReturnType<typeof createApp>;
  repo: MemoryRepository;
  queue: LocalQueueAdapter;
};

function ctx(): TestCtx {
  const repo = new MemoryRepository();
  repo.seed(seedData());
  const queue = new LocalQueueAdapter();
  const store = new LocalArtifactStore(FIXTURES);
  const judge = new LocalCpp17Judge();
  const app = createApp({ repo, queue, store, judge });
  return { app, repo, queue };
}

async function submitSource(c: TestCtx, source: string, token = PARTICIPANT_TOKEN): Promise<SubmissionId> {
  const res = await c.app.request("/api/v1/submissions", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({ problemId: "problem_seed_two_sum", language: "cpp17", source }),
  });
  expect(res.status).toBe(202);
  const body = (await res.json()) as Record<string, unknown>;
  return asSubmissionId(body.submissionId as string);
}

async function createAccepted(c: TestCtx): Promise<SubmissionId> {
  const source = await Bun.file(`${FIXTURES}/sources/accepted.cpp`).text();
  const id = await submitSource(c, source);
  await c.queue.flush();
  return id;
}

describe("admin rejudge API", () => {
  test("rejudge enqueues the submission and keeps the previous attempt history", async () => {
    const c = ctx();
    const id = await createAccepted(c);
    const attemptsBefore = await c.repo.listJudgeAttempts(id);
    expect(attemptsBefore).toHaveLength(1);

    const res = await c.app.request(`/api/v1/admin/submissions/${id}/rejudge`, {
      method: "POST",
      headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
    });
    expect(res.status).toBe(202);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.status).toBe("QUEUED");

    await c.queue.flush();
    const attemptsAfter = await c.repo.listJudgeAttempts(id);
    expect(attemptsAfter).toHaveLength(2);
    const stored = (await c.repo.findSubmissionById(id))!;
    expect(stored.status).toBe("ACCEPTED");
    expect(stored.attemptCount).toBe(2);
  });

  test("rejudge of a QUEUED submission is a no-op", async () => {
    const c = ctx();
    const source = await Bun.file(`${FIXTURES}/sources/accepted.cpp`).text();
    const id = await submitSource(c, source);
    expect((await c.repo.findSubmissionById(id))!.status).toBe("QUEUED");

    const res = await c.app.request(`/api/v1/admin/submissions/${id}/rejudge`, {
      method: "POST",
      headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
    });
    expect(res.status).toBe(202);
    await c.queue.flush();
    expect((await c.repo.findSubmissionById(id))!.status).toBe("ACCEPTED");
    expect((await c.repo.findSubmissionById(id))!.attemptCount).toBe(1);
  });
});
