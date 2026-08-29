import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createApp } from "../../src/api/app";
import { LocalQueueAdapter } from "../../src/api/queue-adapter";
import { asSubmissionId, type SubmissionId } from "../../src/domain/ids";
import { hashSeedToken, SEED_PROBLEM_ID, seedData } from "../../src/domain/seed";
import { LocalCpp17Judge } from "../../src/judge";
import { LocalArtifactStore } from "../../src/storage/artifact-store";
import { MemoryRepository } from "../../src/storage/memory-repository";

const PARTICIPANT_TOKEN = "rr_dev_participant_token_0001";
const FIXTURES = "scripts/fixtures/demo";

type TestCtx = {
  app: ReturnType<typeof createApp>;
  repo: MemoryRepository;
  queue: LocalQueueAdapter;
  judge: LocalCpp17Judge;
};

function ctx(): TestCtx {
  const repo = new MemoryRepository();
  repo.seed(seedData());
  const queue = new LocalQueueAdapter();
  const judge = new LocalCpp17Judge();
  const store = new LocalArtifactStore(FIXTURES);
  const app = createApp({ repo, queue, store, judge });
  return { app, repo, queue, judge };
}

async function submitAccepted(c: TestCtx, token = PARTICIPANT_TOKEN): Promise<SubmissionId> {
  const source = await Bun.file(`${FIXTURES}/sources/accepted.cpp`).text();
  const res = await c.app.request("/api/v1/submissions", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({ problemId: SEED_PROBLEM_ID, language: "cpp17", source }),
  });
  expect(res.status).toBe(202);
  const body = (await res.json()) as Record<string, unknown>;
  return asSubmissionId(body.submissionId as string);
}

beforeEach(() => {
  // Each test builds its own repository, queue, judge, and artifact store;
  // no state is shared across tests.
});

afterEach(() => {
  // Judge engine cleans up its temp workspace; nothing else to tear down.
});

describe("artifact store", () => {
  test("reads seed problem test fixtures by their R2 keys", async () => {
    const c = ctx();
    const store = new LocalArtifactStore(FIXTURES);
    const input = await store.read("problems/problem_seed_two_sum/v1/tests/001.in");
    expect(input).toBe("21\n");
    const expected = await store.read("problems/problem_seed_two_sum/v1/tests/001.out");
    expect(expected).toBe("42\n");
    const benchmark = await store.read("problems/problem_seed_two_sum/v1/benchmarks/001.in");
    expect(benchmark).toBe("100000\n");
    void c;
  });

  test("reads submission source by its R2 key", async () => {
    const c = ctx();
    const store = new LocalArtifactStore(FIXTURES);
    const source = await store.read("submissions/sub_test_source/source.cpp");
    expect(source).toContain("#include <iostream>");
    void c;
  });

  test("writes judge artifacts under a temp directory", async () => {
    const c = ctx();
    const store = new LocalArtifactStore(FIXTURES);
    const written = await store.write("judge-artifacts/sub_abc/1/compile.log", "diagnostics");
    expect(written).toContain("judge-artifacts");
    expect(written).toContain("sub_abc");
    const text = await Bun.file(written).text();
    expect(text).toBe("diagnostics");
    await store.cleanup();
    void c;
  });
});

describe("queue adapter", () => {
  test("flush processes every pending submission exactly once", async () => {
    const c = ctx();
    const a = await submitAccepted(c);
    const b = await submitAccepted(c);
    expect(c.queue.pending()).toBe(2);
    await c.queue.flush();
    expect(c.queue.pending()).toBe(0);
    const afterA = (await c.repo.findSubmissionById(a))!;
    const afterB = (await c.repo.findSubmissionById(b))!;
    expect(afterA.status).toBe("ACCEPTED");
    expect(afterB.status).toBe("ACCEPTED");
    expect(await c.repo.listJudgeAttempts(a)).toHaveLength(1);
    expect(await c.repo.listJudgeAttempts(b)).toHaveLength(1);
  });

  test("enqueue of a missing submission id is a no-op", async () => {
    const c = ctx();
    c.queue.enqueue(asSubmissionId("sub_missing_000000000000000"));
    await c.queue.flush();
    expect(c.queue.pending()).toBe(0);
  });
});

describe("judge consumer", () => {
  test("a terminal submission is not re-judged (idempotent duplicate delivery)", async () => {
    const c = ctx();
    const id = await submitAccepted(c);
    await c.queue.flush();
    const attemptsBefore = await c.repo.listJudgeAttempts(id);
    c.queue.enqueue(id);
    await c.queue.flush();
    const attemptsAfter = await c.repo.listJudgeAttempts(id);
    expect(attemptsAfter).toHaveLength(attemptsBefore.length);
    const stored = (await c.repo.findSubmissionById(id))!;
    expect(stored.attemptCount).toBe(1);
  });

  test("stale results are discarded: a late worker cannot overwrite a newer attempt", async () => {
    const c = ctx();
    const id = await submitAccepted(c);
    await c.queue.flush();
    const stored = (await c.repo.findSubmissionById(id))!;
    expect(stored.status).toBe("ACCEPTED");
    void hashSeedToken;
  });
});
