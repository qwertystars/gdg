import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { createApp } from "../../src/api/app";
import { LocalQueueAdapter } from "../../src/api/queue-adapter";
import {
  asApiTokenId,
  asParticipantId,
  asProblemId,
  asSubmissionId,
  newSubmissionId,
  type SubmissionId,
} from "../../src/domain/ids";
import { hashSeedToken, SEED_PARTICIPANT_ID, SEED_PROBLEM_ID, seedData } from "../../src/domain/seed";
import { LocalCpp17Judge } from "../../src/judge";
import { type ArtifactStore, LocalArtifactStore } from "../../src/storage/artifact-store";
import { MemoryRepository } from "../../src/storage/memory-repository";

const sha256Hex = (value: string): string => createHash("sha256").update(value).digest("hex");

const PARTICIPANT_TOKEN = "rr_dev_participant_token_0001";
const ADMIN_TOKEN = "rr_dev_admin_token_0001";
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

function bearer(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` };
}

async function post(
  c: TestCtx,
  path: string,
  body: unknown,
  token?: string,
): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await c.app.request(path, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token === undefined ? {} : bearer(token)),
    },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

async function patch(
  c: TestCtx,
  path: string,
  body: unknown,
  token?: string,
): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await c.app.request(path, {
    method: "PATCH",
    headers: {
      "content-type": "application/json",
      ...(token === undefined ? {} : bearer(token)),
    },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

async function get(
  c: TestCtx,
  path: string,
  token?: string,
): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await c.app.request(path, {
    headers: token === undefined ? {} : bearer(token),
  });
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

async function sourceFixture(name: string): Promise<string> {
  return Bun.file(`${FIXTURES}/sources/${name}`).text();
}

async function submit(
  c: TestCtx,
  source: string,
  token = PARTICIPANT_TOKEN,
  problemId: string = SEED_PROBLEM_ID,
): Promise<SubmissionId> {
  const res = await post(c, "/api/v1/submissions", { problemId, language: "cpp17", source }, token);
  expect(res.status).toBe(202);
  const submissionId = res.json.submissionId;
  expect(typeof submissionId).toBe("string");
  return asSubmissionId(submissionId as string);
}

async function acceptedSubmission(c: TestCtx, token = PARTICIPANT_TOKEN): Promise<SubmissionId> {
  const id = await submit(c, await sourceFixture("accepted.cpp"), token);
  await c.queue.flush();
  return id;
}

afterEach(() => {
  // Local judge compiles to the OS temp dir; the judge engine cleans up its
  // own workspace. Nothing further to tear down.
});

describe("health and problems", () => {
  test("GET /api/v1/health reports ok without auth", async () => {
    const c = ctx();
    const res = await get(c, "/api/v1/health");
    expect(res.status).toBe(200);
    expect(res.json.status).toBe("ok");
  });

  test("GET /api/v1/problems lists the active seed problem without exposing hidden test keys", async () => {
    const c = ctx();
    const res = await get(c, "/api/v1/problems", PARTICIPANT_TOKEN);
    expect(res.status).toBe(200);
    const problems = res.json.problems as Array<Record<string, unknown>>;
    expect(Array.isArray(problems)).toBe(true);
    expect(problems.some((p) => p.id === SEED_PROBLEM_ID)).toBe(true);
    expect(JSON.stringify(res.json)).not.toContain("inputR2Key");
    expect(JSON.stringify(res.json)).not.toContain("expectedR2Key");
  });
});

describe("submission lifecycle", () => {
  test("POST /api/v1/submissions returns 202 QUEUED and the judged result is ACCEPTED with a score", async () => {
    const c = ctx();
    const submissionId = await acceptedSubmission(c);
    const res = await get(c, `/api/v1/submissions/${submissionId}`, PARTICIPANT_TOKEN);
    expect(res.status).toBe(200);
    expect(res.json.id).toBe(submissionId);
    expect(res.json.submissionId).toBe(submissionId);
    expect(res.json.problemId).toBe(SEED_PROBLEM_ID);
    expect(res.json.status).toBe("ACCEPTED");
    expect(res.json.passedTests).toBe(3);
    expect(res.json.totalTests).toBe(3);
    expect(typeof res.json.performanceScoreNs).toBe("number");
    expect((res.json.performanceScoreNs as number) > 0).toBe(true);
    expect(typeof res.json.peakMemoryKb).toBe("number");
    expect(typeof res.json.createdAtMs).toBe("number");
    expect(typeof res.json.completedAtMs).toBe("number");
  });

  test("a rejected source write leaves no orphan submission row", async () => {
    const repo = new MemoryRepository();
    repo.seed(seedData());
    const queue = new LocalQueueAdapter();
    const judge = new LocalCpp17Judge();
    const store = new LocalArtifactStore(FIXTURES);
    const failingStore: ArtifactStore = {
      read: (key) => store.read(key),
      write: async () => {
        throw new Error("source write failed");
      },
      cleanup: () => store.cleanup(),
    };
    const app = createApp({ repo, queue, store: failingStore, judge });
    const res = await app.request("/api/v1/submissions", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...bearer(PARTICIPANT_TOKEN),
      },
      body: JSON.stringify({ problemId: SEED_PROBLEM_ID, language: "cpp17", source: "int main() {}" }),
    });
    expect(res.status).toBe(500);
    const list = await repo.listSubmissions({ participantId: SEED_PARTICIPANT_ID }, null, 100);
    expect(list.items).toEqual([]);
  });

  test("submission responses never leak storage keys or test content", async () => {
    const c = ctx();
    const submissionId = await acceptedSubmission(c);
    const res = await get(c, `/api/v1/submissions/${submissionId}`, PARTICIPANT_TOKEN);
    const body = JSON.stringify(res.json);
    expect(body).not.toContain("sourceR2Key");
    expect(body).not.toContain("inputR2Key");
    expect(body).not.toContain("expectedR2Key");
    expect(body).not.toContain("200000");
  });

  test("a duplicate queue delivery of a terminal submission is a no-op", async () => {
    const c = ctx();
    const submissionId = await acceptedSubmission(c);
    c.queue.enqueue(submissionId);
    await c.queue.flush();
    const res = await get(c, `/api/v1/submissions/${submissionId}`, PARTICIPANT_TOKEN);
    expect(res.json.status).toBe("ACCEPTED");
    const stored = (await c.repo.findSubmissionById(submissionId))!;
    expect(stored.attemptCount).toBe(1);
    expect(await c.repo.listJudgeAttempts(submissionId)).toHaveLength(1);
  });

  test("POST /api/v1/submissions without a token is 401", async () => {
    const c = ctx();
    const res = await post(c, "/api/v1/submissions", {
      problemId: SEED_PROBLEM_ID,
      language: "cpp17",
      source: "int main() {}",
    });
    expect(res.status).toBe(401);
  });

  test("POST /api/v1/submissions with a garbage token is 401", async () => {
    const c = ctx();
    const res = await post(
      c,
      "/api/v1/submissions",
      { problemId: SEED_PROBLEM_ID, language: "cpp17", source: "int main() {}" },
      "not-a-real-token",
    );
    expect(res.status).toBe(401);
  });

  test("POST /api/v1/submissions with an unknown problem is 404", async () => {
    const c = ctx();
    const res = await post(
      c,
      "/api/v1/submissions",
      { problemId: "problem_does_not_exist", language: "cpp17", source: "int main() {}" },
      PARTICIPANT_TOKEN,
    );
    expect(res.status).toBe(404);
  });

  test("POST /api/v1/submissions with an unsupported language is 422 UNSUPPORTED_LANGUAGE", async () => {
    const c = ctx();
    const res = await post(
      c,
      "/api/v1/submissions",
      { problemId: SEED_PROBLEM_ID, language: "rust", source: "fn main() {}" },
      PARTICIPANT_TOKEN,
    );
    expect(res.status).toBe(422);
    expect(res.json.error).toBe("unsupported language");
    expect(res.json.code).toBe("UNSUPPORTED_LANGUAGE");
  });

  test("POST /api/v1/submissions with empty source is 422", async () => {
    const c = ctx();
    const res = await post(
      c,
      "/api/v1/submissions",
      { problemId: SEED_PROBLEM_ID, language: "cpp17", source: "" },
      PARTICIPANT_TOKEN,
    );
    expect(res.status).toBe(422);
  });

  test("POST /api/v1/submissions rejects an oversized body before JSON parsing", async () => {
    const c = ctx();
    const res = await c.app.request("/api/v1/submissions", {
      method: "POST",
      headers: { ...bearer(PARTICIPANT_TOKEN), "content-type": "application/json" },
      body: "x".repeat(1_048_577),
    });
    expect(res.status).toBe(413);
    expect(await res.json()).toEqual({ error: "request body too large" });
  });

  test("API responses disable caching and MIME sniffing", async () => {
    const c = ctx();
    const res = await c.app.request("/api/v1/health");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  });

  test("POST /api/v1/submissions is rate limited to 5 per 10 seconds", async () => {
    const c = ctx();
    for (let i = 0; i < 5; i++) {
      const ok = await post(
        c,
        "/api/v1/submissions",
        { problemId: SEED_PROBLEM_ID, language: "cpp17", source: "int main() {}" },
        PARTICIPANT_TOKEN,
      );
      expect(ok.status).toBe(202);
    }
    const rejected = await post(
      c,
      "/api/v1/submissions",
      { problemId: SEED_PROBLEM_ID, language: "cpp17", source: "int main() {}" },
      PARTICIPANT_TOKEN,
    );
    expect(rejected.status).toBe(429);
    const list = await get(c, "/api/v1/submissions", PARTICIPANT_TOKEN);
    expect((list.json.submissions as Array<Record<string, unknown>>).length).toBe(5);
  });

  test("the rate limit is configurable via createApp deps (env threading, backend 45)", async () => {
    const repo = new MemoryRepository();
    repo.seed(seedData());
    const queue = new LocalQueueAdapter();
    const judge = new LocalCpp17Judge();
    const store = new LocalArtifactStore(FIXTURES);
    const app = createApp({ repo, queue, store, judge, rateLimitSubmissions: 3, rateLimitWindowMs: 10_000 });
    const c = { app, repo, queue, judge };
    for (let i = 0; i < 3; i++) {
      const ok = await post(
        c,
        "/api/v1/submissions",
        { problemId: SEED_PROBLEM_ID, language: "cpp17", source: "int main() {}" },
        PARTICIPANT_TOKEN,
      );
      expect(ok.status).toBe(202);
    }
    const rejected = await post(
      c,
      "/api/v1/submissions",
      { problemId: SEED_PROBLEM_ID, language: "cpp17", source: "int main() {}" },
      PARTICIPANT_TOKEN,
    );
    expect(rejected.status).toBe(429);
    const list = await get(c, "/api/v1/submissions", PARTICIPANT_TOKEN);
    expect((list.json.submissions as Array<Record<string, unknown>>).length).toBe(3);
  });

  test("a suspended participant cannot submit", async () => {
    const c = ctx();
    const participant = (await c.repo.findParticipantById(asParticipantId("participant_seed_alpha")))!;
    participant.status = "SUSPENDED";
    const res = await post(
      c,
      "/api/v1/submissions",
      { problemId: SEED_PROBLEM_ID, language: "cpp17", source: "int main() {}" },
      PARTICIPANT_TOKEN,
    );
    expect(res.status).toBe(403);
  });

  test("a revoked token is rejected with 401", async () => {
    const c = ctx();
    const token = await c.repo.findTokenByHash(hashSeedToken(PARTICIPANT_TOKEN));
    expect(token).not.toBeNull();
    token!.revokedAtMs = 1;
    const res = await post(
      c,
      "/api/v1/submissions",
      { problemId: SEED_PROBLEM_ID, language: "cpp17", source: "int main() {}" },
      PARTICIPANT_TOKEN,
    );
    expect(res.status).toBe(401);
  });

  test("a participant reading another participant's submission gets 404 (never reveals existence)", async () => {
    const c = ctx();
    const submissionId = await acceptedSubmission(c);

    const otherId = asParticipantId("participant_seed_beta");
    c.repo.participants.set(otherId, {
      id: otherId,
      displayName: "Seed Beta",
      status: "ACTIVE",
      createdAtMs: 1_700_000_000_000,
    });
    c.repo.tokens.set(asApiTokenId("token_seed_beta"), {
      id: asApiTokenId("token_seed_beta"),
      participantId: otherId,
      tokenHash: hashSeedToken("rr_dev_participant_token_0002"),
      role: "PARTICIPANT",
      revokedAtMs: null,
      createdAtMs: 1_700_000_000_000,
    });

    const res = await get(c, `/api/v1/submissions/${submissionId}`, "rr_dev_participant_token_0002");
    expect(res.status).toBe(404);
  });
});

describe("judge outcome classification", () => {
  test("COMPILE_ERROR is persisted and returns bounded compiler output", async () => {
    const c = ctx();
    const id = await submit(c, await sourceFixture("compile-error.cpp"));
    await c.queue.flush();
    const detail = await get(c, `/api/v1/submissions/${id}`, PARTICIPANT_TOKEN);
    expect(detail.json.status).toBe("COMPILE_ERROR");
    expect(typeof detail.json.compilerOutput).toBe("string");
  });

  test("WRONG_ANSWER is persisted with passedTests below totalTests", async () => {
    const c = ctx();
    const id = await submit(c, await sourceFixture("wrong-answer.cpp"));
    await c.queue.flush();
    const detail = await get(c, `/api/v1/submissions/${id}`, PARTICIPANT_TOKEN);
    expect(detail.json.status).toBe("WRONG_ANSWER");
    expect((detail.json.passedTests as number) < (detail.json.totalTests as number)).toBe(true);
  });

  test("TIME_LIMIT_EXCEEDED is persisted for an infinite loop", async () => {
    const c = ctx();
    const id = await submit(c, await sourceFixture("infinite-loop.cpp"));
    await c.queue.flush();
    const detail = await get(c, `/api/v1/submissions/${id}`, PARTICIPANT_TOKEN);
    expect(detail.json.status).toBe("TIME_LIMIT_EXCEEDED");
  });

  test("OUTPUT_LIMIT_EXCEEDED is persisted for an output flood", async () => {
    const c = ctx();
    const id = await submit(c, await sourceFixture("output-flood.cpp"));
    await c.queue.flush();
    const detail = await get(c, `/api/v1/submissions/${id}`, PARTICIPANT_TOKEN);
    expect(detail.json.status).toBe("OUTPUT_LIMIT_EXCEEDED");
  });
});

describe("submission list and admin read", () => {
  test("GET /api/v1/submissions lists own submissions newest first and hides storage keys", async () => {
    const c = ctx();
    const first = await acceptedSubmission(c);
    const second = await acceptedSubmission(c);
    const res = await get(c, "/api/v1/submissions", PARTICIPANT_TOKEN);
    expect(res.status).toBe(200);
    const submissions = res.json.submissions as Array<Record<string, unknown>>;
    expect(submissions.map((s) => s.id)).toEqual([second, first]);
    expect(JSON.stringify(res.json)).not.toContain("sourceR2Key");
    expect(JSON.stringify(res.json)).not.toContain("inputR2Key");
  });

  test("an admin can read any submission", async () => {
    const c = ctx();
    const submissionId = await acceptedSubmission(c);
    const res = await get(c, `/api/v1/submissions/${submissionId}`, ADMIN_TOKEN);
    expect(res.status).toBe(200);
    expect(res.json.status).toBe("ACCEPTED");
  });

  test("an unknown submission is 404", async () => {
    const c = ctx();
    const res = await get(c, `/api/v1/submissions/${newSubmissionId()}`, PARTICIPANT_TOKEN);
    expect(res.status).toBe(404);
  });

  test("GET /api/v1/submissions/:id/source returns the owner's source and hides test content", async () => {
    const c = ctx();
    const submissionId = await acceptedSubmission(c);
    const res = await get(c, `/api/v1/submissions/${submissionId}/source`, PARTICIPANT_TOKEN);
    expect(res.status).toBe(200);
    expect(res.json.submissionId).toBe(submissionId);
    expect(res.json.language).toBe("cpp17");
    expect(res.json.problemId).toBe(SEED_PROBLEM_ID);
    expect(typeof res.json.source).toBe("string");
    expect((res.json.source as string).length).toBeGreaterThan(0);
    const body = JSON.stringify(res.json);
    expect(body).not.toContain("expectedR2Key");
    expect(body).not.toContain("inputR2Key");
  });

  test("a participant reading another participant's source gets 404", async () => {
    const c = ctx();
    const submissionId = await acceptedSubmission(c);
    const otherId = asParticipantId("participant_seed_beta");
    c.repo.participants.set(otherId, {
      id: otherId,
      displayName: "Seed Beta",
      status: "ACTIVE",
      createdAtMs: 1_700_000_000_000,
    });
    c.repo.tokens.set(asApiTokenId("token_seed_beta"), {
      id: asApiTokenId("token_seed_beta"),
      participantId: otherId,
      tokenHash: hashSeedToken("rr_dev_participant_token_0002"),
      role: "PARTICIPANT",
      revokedAtMs: null,
      createdAtMs: 1_700_000_000_000,
    });
    const res = await get(c, `/api/v1/submissions/${submissionId}/source`, "rr_dev_participant_token_0002");
    expect(res.status).toBe(404);
  });

  test("an admin can read any participant's source", async () => {
    const c = ctx();
    const submissionId = await acceptedSubmission(c);
    const res = await get(c, `/api/v1/submissions/${submissionId}/source`, ADMIN_TOKEN);
    expect(res.status).toBe(200);
    expect(typeof res.json.source).toBe("string");
  });

  test("GET /api/v1/submissions/:id/test-results returns per-test results and benchmark runs", async () => {
    const c = ctx();
    const submissionId = await acceptedSubmission(c);
    const res = await get(c, `/api/v1/submissions/${submissionId}/test-results`, PARTICIPANT_TOKEN);
    expect(res.status).toBe(200);
    const testResults = res.json.testResults as Array<Record<string, unknown>>;
    expect(Array.isArray(testResults)).toBe(true);
    expect(testResults.length).toBe(3); // three correctness tests for the seed problem
    for (const row of testResults) {
      expect(typeof row.testCaseId).toBe("string");
      expect(row.status).toBe("PASS");
      expect(typeof row.cpuTimeNs).toBe("number");
      expect(typeof row.wallTimeNs).toBe("number");
      expect(typeof row.peakMemoryKb).toBe("number");
      expect(typeof row.exitCode).toBe("number");
      expect(row.signal).toBeNull();
    }
    const benchmarkRuns = res.json.benchmarkRuns as Array<Record<string, unknown>>;
    expect(Array.isArray(benchmarkRuns)).toBe(true);
    expect(benchmarkRuns.length).toBeGreaterThan(0);
    for (const row of benchmarkRuns) {
      expect(typeof row.testCaseId).toBe("string");
      expect(typeof row.runNumber).toBe("number");
      expect(typeof row.cpuTimeNs).toBe("number");
      expect(typeof row.wallTimeNs).toBe("number");
      expect(typeof row.peakMemoryKb).toBe("number");
    }
    expect(JSON.stringify(res.json)).not.toContain("sourceR2Key");
    expect(JSON.stringify(res.json)).not.toContain("expected");
  });

  test("a participant reading another participant's test-results gets 404", async () => {
    const c = ctx();
    const submissionId = await acceptedSubmission(c);
    const otherId = asParticipantId("participant_seed_beta");
    c.repo.participants.set(otherId, {
      id: otherId,
      displayName: "Seed Beta",
      status: "ACTIVE",
      createdAtMs: 1_700_000_000_000,
    });
    c.repo.tokens.set(asApiTokenId("token_seed_beta"), {
      id: asApiTokenId("token_seed_beta"),
      participantId: otherId,
      tokenHash: hashSeedToken("rr_dev_participant_token_0002"),
      role: "PARTICIPANT",
      revokedAtMs: null,
      createdAtMs: 1_700_000_000_000,
    });
    const res = await get(c, `/api/v1/submissions/${submissionId}/test-results`, "rr_dev_participant_token_0002");
    expect(res.status).toBe(404);
  });
});

describe("leaderboard", () => {
  test("leaderboard contains the best accepted submission per participant sorted by score", async () => {
    const c = ctx();
    const submissionId = await acceptedSubmission(c);
    const res = await get(c, `/api/v1/leaderboard/${SEED_PROBLEM_ID}`, PARTICIPANT_TOKEN);
    expect(res.status).toBe(200);
    const entries = res.json.entries as Array<Record<string, unknown>>;
    expect(entries).toHaveLength(1);
    expect(entries[0]?.rank).toBe(1);
    expect(entries[0]?.participantId).toBe("participant_seed_alpha");
    expect(entries[0]?.problemId).toBe(SEED_PROBLEM_ID);
    expect(entries[0]?.submissionId).toBe(submissionId);
    expect(typeof entries[0]?.performanceScoreNs).toBe("number");
    expect(typeof entries[0]?.peakMemoryKb).toBe("number");
    expect(typeof entries[0]?.completedAtMs).toBe("number");
  });

  test("only the best accepted submission per participant appears on the leaderboard", async () => {
    const c = ctx();
    const first = await acceptedSubmission(c);
    const second = await acceptedSubmission(c);
    const res = await get(c, `/api/v1/leaderboard/${SEED_PROBLEM_ID}`, PARTICIPANT_TOKEN);
    expect(res.status).toBe(200);
    const entries = res.json.entries as Array<Record<string, unknown>>;
    expect(entries).toHaveLength(1);
    const winner = entries[0]?.submissionId;
    expect(winner === first || winner === second).toBe(true);
    expect(JSON.stringify(res.json)).not.toContain("sourceR2Key");
  });

  test("non-accepted submissions do not appear on the leaderboard", async () => {
    const c = ctx();
    const id = await submit(c, await sourceFixture("wrong-answer.cpp"));
    await c.queue.flush();
    void id;
    const board = await get(c, `/api/v1/leaderboard/${SEED_PROBLEM_ID}`, PARTICIPANT_TOKEN);
    expect(board.json.entries).toEqual([]);
  });
});

describe("admin problem management", () => {
  test("a participant cannot call admin routes (403)", async () => {
    const c = ctx();
    const res = await post(
      c,
      "/api/v1/admin/problems",
      { slug: "x", title: "X", limits: { timeLimitMs: 1000, memoryLimitKb: 65536, outputLimitBytes: 65536 } },
      PARTICIPANT_TOKEN,
    );
    expect(res.status).toBe(403);
  });

  test("an admin can create, version, test, and activate a problem, then participants can solve it", async () => {
    const c = ctx();
    const created = await post(
      c,
      "/api/v1/admin/problems",
      {
        slug: "triple",
        title: "Triple",
        limits: { timeLimitMs: 1000, memoryLimitKb: 65536, outputLimitBytes: 65536 },
      },
      ADMIN_TOKEN,
    );
    expect(created.status).toBe(201);
    const problemId = created.json.problemId as string;
    expect(typeof problemId).toBe("string");

    const version = await post(c, `/api/v1/admin/problems/${problemId}/versions`, { version: 1 }, ADMIN_TOKEN);
    expect(version.status).toBe(201);

    const tests = await post(
      c,
      `/api/v1/admin/problems/${problemId}/versions/1/tests`,
      {
        tests: [
          {
            kind: "CORRECTNESS",
            ordinal: 1,
            input: "1\n",
            expected: "3\n",
            comparator: "NORMALIZED",
            weight: 1,
          },
        ],
      },
      ADMIN_TOKEN,
    );
    expect(tests.status).toBe(201);

    const activated = await post(c, `/api/v1/admin/problems/${problemId}/activate/1`, {}, ADMIN_TOKEN);
    expect(activated.status).toBe(200);

    const id = await submit(
      c,
      `#include <iostream>
int main() { long long n; if (std::cin >> n) std::cout << n * 3 << "\\n"; }`,
      PARTICIPANT_TOKEN,
      problemId,
    );
    await c.queue.flush();
    const detail = await get(c, `/api/v1/submissions/${id}`, PARTICIPANT_TOKEN);
    expect(detail.json.status).toBe("ACCEPTED");
  });

  test("PATCH /api/v1/admin/problems/:problemId updates limits", async () => {
    const c = ctx();
    const res = await patch(c, `/api/v1/admin/problems/${SEED_PROBLEM_ID}`, { title: "Two Sum v2" }, ADMIN_TOKEN);
    expect(res.status).toBe(200);
    expect(res.json.title).toBe("Two Sum v2");
  });

  test("test upload persists SHA-256 integrity hashes for input and expected artifacts (business-logic 80)", async () => {
    const c = ctx();
    const created = await post(
      c,
      "/api/v1/admin/problems",
      {
        slug: `integrity-${Math.random().toString(36).slice(2)}`,
        title: "Integrity",
        limits: { timeLimitMs: 1000, memoryLimitKb: 65536, outputLimitBytes: 65536 },
      },
      ADMIN_TOKEN,
    );
    expect(created.status).toBe(201);
    const problemId = created.json.problemId as string;
    await post(c, `/api/v1/admin/problems/${problemId}/versions`, { version: 1 }, ADMIN_TOKEN);

    const input = "1\n2\n";
    const expected = "3\n";
    const uploaded = await post(
      c,
      `/api/v1/admin/problems/${problemId}/versions/1/tests`,
      {
        tests: [
          { kind: "CORRECTNESS", ordinal: 1, input, expected, comparator: "NORMALIZED", weight: 1 },
          { kind: "BENCHMARK", ordinal: 1, input: "9\n", expected: "81\n" },
        ],
      },
      ADMIN_TOKEN,
    );
    expect(uploaded.status).toBe(201);
    expect(uploaded.json.uploaded).toBe(2);
    // The upload response must not leak raw hidden test content.
    expect(JSON.stringify(uploaded.json)).not.toContain("1\n2\n");

    const tests = await c.repo.listTestCases(asProblemId(problemId), 1);
    expect(tests).toHaveLength(2);
    for (const test of tests) {
      expect(test.inputSha256, `${test.id} input`).toBe(sha256Hex(test.kind === "CORRECTNESS" ? input : "9\n"));
      expect(test.expectedSha256, `${test.id} expected`).toBe(
        sha256Hex(test.kind === "CORRECTNESS" ? expected : "81\n"),
      );
    }
  });

  test("the seed problem test cases carry SHA-256 integrity hashes", async () => {
    const repo = new MemoryRepository();
    repo.seed(seedData());
    const tests = await repo.listTestCases(asProblemId(SEED_PROBLEM_ID), 1);
    expect(tests.length).toBeGreaterThan(0);
    for (const test of tests) {
      expect(test.inputSha256, `${test.id} input`).toMatch(/^[0-9a-f]{64}$/);
      expect(test.expectedSha256, `${test.id} expected`).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  test("an admin can revoke a participant token; the revoked token gets 401 and an audit row is written", async () => {
    const c = ctx();
    // Create a dedicated token directly in the repo map so its plaintext is known.
    const tokenId = asApiTokenId("token_seed_revoke_me");
    c.repo.tokens.set(tokenId, {
      id: tokenId,
      participantId: asParticipantId("participant_seed_alpha"),
      tokenHash: hashSeedToken("rr_dev_participant_token_0002"),
      role: "PARTICIPANT",
      revokedAtMs: null,
      createdAtMs: 1_700_000_000_000,
    });
    // The token works before revocation.
    const before = await get(c, "/api/v1/problems", "rr_dev_participant_token_0002");
    expect(before.status).toBe(200);

    const revoke = await post(c, `/api/v1/admin/tokens/${tokenId}/revoke`, {}, ADMIN_TOKEN);
    expect(revoke.status).toBe(200);
    expect(revoke.json.revokedAtMs).toEqual(expect.any(Number));

    const after = await get(c, "/api/v1/problems", "rr_dev_participant_token_0002");
    expect(after.status).toBe(401);

    const audit = await c.repo.listAuditLogs("API_TOKEN", tokenId);
    expect(audit.some((log) => log.action === "TOKEN_REVOKE" && log.actorRole === "ADMIN")).toBe(true);
  });

  test("a participant cannot revoke a token", async () => {
    const c = ctx();
    const token = await c.repo.findTokenByHash(hashSeedToken(PARTICIPANT_TOKEN));
    expect(token).not.toBeNull();
    const res = await post(c, `/api/v1/admin/tokens/${token!.id}/revoke`, {}, PARTICIPANT_TOKEN);
    expect(res.status).toBe(403);
  });

  test("an admin can create a participant token; the secret is returned once and only its hash is stored", async () => {
    const c = ctx();
    const created = await post(
      c,
      "/api/v1/admin/tokens",
      { participantId: SEED_PARTICIPANT_ID, role: "PARTICIPANT" },
      ADMIN_TOKEN,
    );
    expect(created.status).toBe(201);
    expect(typeof created.json.token).toBe("string");
    expect(typeof created.json.tokenId).toBe("string");
    const secret = created.json.token as string;
    expect(secret.length).toBeGreaterThanOrEqual(32);

    // Only the SHA-256 hash is stored; the plaintext never appears in the repo.
    const stored = await c.repo.findTokenById(asApiTokenId(created.json.tokenId as string));
    expect(stored).not.toBeNull();
    expect(stored!.tokenHash).toBe(hashSeedToken(secret));
    expect(stored!.tokenHash).not.toBe(secret);
    expect(stored!.participantId).toBe(SEED_PARTICIPANT_ID);
    expect(stored!.role).toBe("PARTICIPANT");

    // The new token authenticates a real request.
    const authed = await get(c, "/api/v1/problems", secret);
    expect(authed.status).toBe(200);

    const audit = await c.repo.listAuditLogs("API_TOKEN", stored!.id);
    expect(audit.some((log) => log.action === "TOKEN_CREATE" && log.actorRole === "ADMIN")).toBe(true);
  });

  test("admin token creation rejects an unknown participant", async () => {
    const c = ctx();
    const res = await post(
      c,
      "/api/v1/admin/tokens",
      { participantId: asParticipantId("participant_does_not_exist"), role: "PARTICIPANT" },
      ADMIN_TOKEN,
    );
    expect(res.status).toBe(404);
  });

  test("admin token creation rejects an invalid role", async () => {
    const c = ctx();
    const res = await post(
      c,
      "/api/v1/admin/tokens",
      { participantId: SEED_PARTICIPANT_ID, role: "SUPERADMIN" },
      ADMIN_TOKEN,
    );
    expect(res.status).toBe(400);
  });
});

describe("admin rejudge", () => {
  test("POST /api/v1/admin/submissions/:submissionId/rejudge resets to QUEUED and judges again", async () => {
    const c = ctx();
    const submissionId = await acceptedSubmission(c);
    const before = (await c.repo.findSubmissionById(submissionId))!;
    expect(before.status).toBe("ACCEPTED");
    expect(before.attemptCount).toBe(1);

    const rejudged = await post(c, `/api/v1/admin/submissions/${submissionId}/rejudge`, {}, ADMIN_TOKEN);
    expect(rejudged.status).toBe(202);
    expect(rejudged.json.status).toBe("QUEUED");

    const queued = (await c.repo.findSubmissionById(submissionId))!;
    expect(queued.status).toBe("QUEUED");

    await c.queue.flush();
    const after = (await c.repo.findSubmissionById(submissionId))!;
    expect(after.status).toBe("ACCEPTED");
    expect(after.attemptCount).toBe(2);
    expect(await c.repo.listJudgeAttempts(submissionId)).toHaveLength(2);
    const res = await get(c, `/api/v1/submissions/${submissionId}`, ADMIN_TOKEN);
    expect(res.json.status).toBe("ACCEPTED");
  });

  test("a participant cannot rejudge", async () => {
    const c = ctx();
    const submissionId = await acceptedSubmission(c);
    const res = await post(c, `/api/v1/admin/submissions/${submissionId}/rejudge`, {}, PARTICIPANT_TOKEN);
    expect(res.status).toBe(403);
  });
});

describe("admin judge errors", () => {
  test("GET /api/v1/admin/judge-errors returns judge-error submissions", async () => {
    const c = ctx();
    const submissionId = await acceptedSubmission(c);
    const submission = (await c.repo.findSubmissionById(submissionId))!;
    submission.status = "JUDGE_ERROR";
    submission.errorId = "judge_err_123";
    const res = await get(c, "/api/v1/admin/judge-errors", ADMIN_TOKEN);
    expect(res.status).toBe(200);
    const errors = res.json.errors as Array<Record<string, unknown>>;
    expect(errors.some((e) => e.id === submissionId)).toBe(true);
  });

  test("GET /api/v1/admin/judge-errors/:submissionId returns the submission error and its judge attempts", async () => {
    const c = ctx();
    const submissionId = await acceptedSubmission(c);
    // acceptedSubmission leaves one SUCCEEDED attempt; add two failing
    // attempts (retryable then terminal) and flip the submission to JUDGE_ERROR.
    const submission = (await c.repo.findSubmissionById(submissionId))!;
    submission.status = "JUDGE_ERROR";
    submission.errorId = "judge_err_456";
    await c.repo.createJudgeAttempt({
      submissionId,
      attemptNumber: 2,
      executionToken: "tok-2",
      nowMs: 1_700_000_001_000,
    });
    await c.repo.updateJudgeAttempt(submissionId, 2, {
      status: "FAILED_RETRYABLE",
      infrastructureError: "sandbox startup failed",
      errorId: null,
      completedAtMs: 1_700_000_002_000,
    });
    await c.repo.createJudgeAttempt({
      submissionId,
      attemptNumber: 3,
      executionToken: "tok-3",
      nowMs: 1_700_000_003_000,
    });
    await c.repo.updateJudgeAttempt(submissionId, 3, {
      status: "FAILED_TERMINAL",
      infrastructureError: "retries exhausted",
      errorId: "judge_err_456",
      completedAtMs: 1_700_000_004_000,
    });

    const res = await get(c, `/api/v1/admin/judge-errors/${submissionId}`, ADMIN_TOKEN);
    expect(res.status).toBe(200);
    expect(res.json.submissionId).toBe(submissionId);
    expect(res.json.errorId).toBe("judge_err_456");
    const attempts = res.json.attempts as Array<Record<string, unknown>>;
    expect(attempts).toHaveLength(3);
    expect(attempts[1]).toMatchObject({
      attemptNumber: 2,
      status: "FAILED_RETRYABLE",
      infrastructureError: "sandbox startup failed",
    });
    expect(attempts[2]).toMatchObject({
      attemptNumber: 3,
      status: "FAILED_TERMINAL",
      errorId: "judge_err_456",
    });
  });

  test("a participant cannot read judge-error detail", async () => {
    const c = ctx();
    const submissionId = await acceptedSubmission(c);
    const res = await get(c, `/api/v1/admin/judge-errors/${submissionId}`, PARTICIPANT_TOKEN);
    expect(res.status).toBe(403);
  });

  test("judge-error detail for a non-JUDGE_ERROR submission is 404", async () => {
    const c = ctx();
    const submissionId = await acceptedSubmission(c);
    const res = await get(c, `/api/v1/admin/judge-errors/${submissionId}`, ADMIN_TOKEN);
    expect(res.status).toBe(404);
  });
});

describe("admin audit log", () => {
  test("GET /api/v1/admin/audit returns the audit rows for a subject", async () => {
    const c = ctx();
    const submissionId = await acceptedSubmission(c);
    // The rejudge path writes an audit row.
    await post(c, `/api/v1/admin/submissions/${submissionId}/rejudge`, {}, ADMIN_TOKEN);
    const res = await get(c, `/api/v1/admin/audit?subjectType=SUBMISSION&subjectId=${submissionId}`, ADMIN_TOKEN);
    expect(res.status).toBe(200);
    const rows = res.json.audit as Array<Record<string, unknown>>;
    expect(Array.isArray(rows)).toBe(true);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0]).toMatchObject({
      action: "SUBMISSION_REJUDGE",
      actorRole: "ADMIN",
      subjectType: "SUBMISSION",
      subjectId: submissionId,
    });
    expect(typeof rows[0]?.id).toBe("string");
    expect(typeof rows[0]?.createdAtMs).toBe("number");
    expect(typeof rows[0]?.detailJson).toBe("string");
  });

  test("audit rows are filtered by subjectType and subjectId", async () => {
    const c = ctx();
    const submissionId = await acceptedSubmission(c);
    await post(c, `/api/v1/admin/submissions/${submissionId}/rejudge`, {}, ADMIN_TOKEN);
    // Wrong subject id -> no rows.
    const res = await get(c, `/api/v1/admin/audit?subjectType=SUBMISSION&subjectId=${newSubmissionId()}`, ADMIN_TOKEN);
    expect(res.status).toBe(200);
    expect(res.json.audit).toEqual([]);
  });

  test("a participant cannot read the audit log", async () => {
    const c = ctx();
    const res = await get(c, `/api/v1/admin/audit?subjectType=SUBMISSION&subjectId=x`, PARTICIPANT_TOKEN);
    expect(res.status).toBe(403);
  });
});

describe("admin lifecycle guards and audit", () => {
  async function activeProblem(c: TestCtx): Promise<string> {
    const created = await post(
      c,
      "/api/v1/admin/problems",
      {
        slug: `lifecycle-${Math.random().toString(36).slice(2)}`,
        title: "Lifecycle",
        limits: { timeLimitMs: 1000, memoryLimitKb: 65536, outputLimitBytes: 65536 },
      },
      ADMIN_TOKEN,
    );
    expect(created.status).toBe(201);
    const problemId = created.json.problemId as string;
    await post(c, `/api/v1/admin/problems/${problemId}/versions`, { version: 1 }, ADMIN_TOKEN);
    await post(
      c,
      `/api/v1/admin/problems/${problemId}/versions/1/tests`,
      { tests: [{ kind: "CORRECTNESS", ordinal: 1, input: "1\n", expected: "1\n" }] },
      ADMIN_TOKEN,
    );
    const activated = await post(c, `/api/v1/admin/problems/${problemId}/activate/1`, {}, ADMIN_TOKEN);
    expect(activated.status).toBe(200);
    return problemId;
  }

  test("hidden tests cannot be uploaded to the ACTIVE (frozen) version", async () => {
    const c = ctx();
    const problemId = await activeProblem(c);
    const res = await post(
      c,
      `/api/v1/admin/problems/${problemId}/versions/1/tests`,
      { tests: [{ kind: "CORRECTNESS", ordinal: 2, input: "2\n", expected: "2\n" }] },
      ADMIN_TOKEN,
    );
    expect(res.status).toBe(409);
  });

  test("a version with no tests cannot be activated", async () => {
    const c = ctx();
    const created = await post(
      c,
      "/api/v1/admin/problems",
      {
        slug: `empty-${Math.random().toString(36).slice(2)}`,
        title: "Empty",
        limits: { timeLimitMs: 1000, memoryLimitKb: 65536, outputLimitBytes: 65536 },
      },
      ADMIN_TOKEN,
    );
    expect(created.status).toBe(201);
    const problemId = created.json.problemId as string;
    await post(c, `/api/v1/admin/problems/${problemId}/versions`, { version: 1 }, ADMIN_TOKEN);
    const res = await post(c, `/api/v1/admin/problems/${problemId}/activate/1`, {}, ADMIN_TOKEN);
    expect(res.status).toBe(409);
  });

  test("a non-active version can still receive tests after a guard is hit", async () => {
    const c = ctx();
    const created = await post(
      c,
      "/api/v1/admin/problems",
      {
        slug: `guarded-${Math.random().toString(36).slice(2)}`,
        title: "Guarded",
        limits: { timeLimitMs: 1000, memoryLimitKb: 65536, outputLimitBytes: 65536 },
      },
      ADMIN_TOKEN,
    );
    expect(created.status).toBe(201);
    const problemId = created.json.problemId as string;
    await post(c, `/api/v1/admin/problems/${problemId}/versions`, { version: 1 }, ADMIN_TOKEN);
    await post(
      c,
      `/api/v1/admin/problems/${problemId}/versions/1/tests`,
      { tests: [{ kind: "CORRECTNESS", ordinal: 1, input: "1\n", expected: "1\n" }] },
      ADMIN_TOKEN,
    );
    const activated = await post(c, `/api/v1/admin/problems/${problemId}/activate/1`, {}, ADMIN_TOKEN);
    expect(activated.status).toBe(200);
    await post(c, `/api/v1/admin/problems/${problemId}/versions`, { version: 2 }, ADMIN_TOKEN);
    const res = await post(
      c,
      `/api/v1/admin/problems/${problemId}/versions/2/tests`,
      { tests: [{ kind: "CORRECTNESS", ordinal: 1, input: "3\n", expected: "3\n" }] },
      ADMIN_TOKEN,
    );
    expect(res.status).toBe(201);
  });

  test("an ACTIVE problem can be closed and then stops accepting submissions", async () => {
    const c = ctx();
    const problemId = await activeProblem(c);
    const closed = await post(c, `/api/v1/admin/problems/${problemId}/close`, {}, ADMIN_TOKEN);
    expect(closed.status).toBe(200);
    expect(closed.json.lifecycleState).toBe("CLOSED");
    const res = await post(
      c,
      "/api/v1/submissions",
      { problemId, language: "cpp17", source: "int main() {}" },
      PARTICIPANT_TOKEN,
    );
    expect(res.status).toBe(404);
    const reclose = await post(c, `/api/v1/admin/problems/${problemId}/close`, {}, ADMIN_TOKEN);
    expect(reclose.status).toBe(409);
  });

  test("a rejudge request is recorded in the audit log with the admin actor", async () => {
    const c = ctx();
    const submissionId = await acceptedSubmission(c);
    const res = await post(c, `/api/v1/admin/submissions/${submissionId}/rejudge`, {}, ADMIN_TOKEN);
    expect(res.status).toBe(202);
    const audit = await c.repo.listAuditLogs("SUBMISSION", submissionId);
    expect(audit.some((log) => log.action === "SUBMISSION_REJUDGE")).toBe(true);
    expect(audit[0]?.actorRole).toBe("ADMIN");
  });

  test("problem lifecycle actions write audit rows (business-logic 94)", async () => {
    const c = ctx();
    const created = await post(
      c,
      "/api/v1/admin/problems",
      {
        slug: `audit-lifecycle-${Math.random().toString(36).slice(2)}`,
        title: "Audit Lifecycle",
        limits: { timeLimitMs: 1000, memoryLimitKb: 65536, outputLimitBytes: 65536 },
      },
      ADMIN_TOKEN,
    );
    expect(created.status).toBe(201);
    const problemId = created.json.problemId as string;

    await post(c, `/api/v1/admin/problems/${problemId}/versions`, { version: 1 }, ADMIN_TOKEN);
    await post(
      c,
      `/api/v1/admin/problems/${problemId}/versions/1/tests`,
      { tests: [{ kind: "CORRECTNESS", ordinal: 1, input: "1\n", expected: "1\n" }] },
      ADMIN_TOKEN,
    );
    await post(c, `/api/v1/admin/problems/${problemId}/activate/1`, {}, ADMIN_TOKEN);
    await post(c, `/api/v1/admin/problems/${problemId}/close`, {}, ADMIN_TOKEN);

    const actions = (await c.repo.listAuditLogs("PROBLEM", problemId)).map((log) => log.action).sort();
    expect(actions).toEqual([
      "PROBLEM_ACTIVATE",
      "PROBLEM_CLOSE",
      "PROBLEM_CREATE",
      "PROBLEM_VERSION_CREATE",
      "TEST_UPLOAD",
    ]);
  });
});

describe("submission status visibility", () => {
  test("in-flight submission shows QUEUED before flush and terminal after", async () => {
    const c = ctx();
    const id = await submit(c, await sourceFixture("accepted.cpp"));
    const pending = await get(c, `/api/v1/submissions/${id}`, PARTICIPANT_TOKEN);
    expect(pending.json.status).toBe("QUEUED");
    await c.queue.flush();
    const done = await get(c, `/api/v1/submissions/${id}`, PARTICIPANT_TOKEN);
    expect(done.json.status).toBe("ACCEPTED");
  });

  test("rejected submissions are not stored", async () => {
    const c = ctx();
    const res = await post(
      c,
      "/api/v1/submissions",
      { problemId: SEED_PROBLEM_ID, language: "cpp17", source: "" },
      PARTICIPANT_TOKEN,
    );
    expect(res.status).toBe(422);
    const list = await get(c, "/api/v1/submissions", PARTICIPANT_TOKEN);
    expect(list.json.submissions).toEqual([]);
  });
});
