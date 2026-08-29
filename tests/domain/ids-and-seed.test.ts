import { describe, expect, test } from "bun:test";
import {
  hashSeedToken,
  SEED_ADMIN_ID,
  SEED_ADMIN_TOKEN,
  SEED_PARTICIPANT_ID,
  SEED_PARTICIPANT_TOKEN,
  SEED_PROBLEM_ID,
  seedData,
} from "../../src/domain";
import { isSubmissionId, newJudgeAttemptId, newProblemId, newSubmissionId } from "../../src/domain/ids";
import { MemoryRepository } from "../../src/storage/memory-repository";

describe("branded ids", () => {
  test("id factories produce distinct branded values with the documented prefix", () => {
    const subA = newSubmissionId();
    const subB = newSubmissionId();
    expect(subA).not.toBe(subB);
    expect(subA.startsWith("sub_")).toBe(true);
    expect(isSubmissionId(subA)).toBe(true);

    const problem = newProblemId();
    expect(problem.startsWith("problem_")).toBe(true);

    const attempt = newJudgeAttemptId();
    expect(attempt.startsWith("attempt_")).toBe(true);
  });
});

describe("seed data", () => {
  test("seed contains participants, hashed tokens, an active problem with version 1, and tests", () => {
    const seed = seedData();
    expect(seed.participants.map((p) => p.id)).toContain(SEED_PARTICIPANT_ID);
    expect(seed.participants.map((p) => p.id)).toContain(SEED_ADMIN_ID);

    const participantToken = seed.tokens.find((t) => t.role === "PARTICIPANT");
    const adminToken = seed.tokens.find((t) => t.role === "ADMIN");
    expect(participantToken?.tokenHash).toBe(hashSeedToken(SEED_PARTICIPANT_TOKEN));
    expect(adminToken?.tokenHash).toBe(hashSeedToken(SEED_ADMIN_TOKEN));
    expect(seed.tokens.every((t) => t.tokenHash !== SEED_PARTICIPANT_TOKEN && t.tokenHash !== SEED_ADMIN_TOKEN)).toBe(
      true,
    );

    const problem = seed.problems.find((p) => p.id === SEED_PROBLEM_ID);
    expect(problem?.lifecycleState).toBe("ACTIVE");
    expect(problem?.activeVersion).toBe(1);
    expect(problem?.limits.timeLimitMs).toBe(2000);

    const versions = seed.problemVersions.filter((v) => v.problemId === SEED_PROBLEM_ID);
    expect(versions).toHaveLength(1);
    expect(versions[0]?.version).toBe(1);

    const tests = seed.testCases.filter((t) => t.problemId === SEED_PROBLEM_ID);
    expect(tests.some((t) => t.kind === "CORRECTNESS")).toBe(true);
    expect(tests.some((t) => t.kind === "BENCHMARK")).toBe(true);
    expect(tests.every((t) => t.inputR2Key.startsWith(`problems/${SEED_PROBLEM_ID}/v1/`))).toBe(true);
  });
});

describe("seeded repository", () => {
  test("a seeded repository resolves the seed token hash to the seed participant", async () => {
    const repo = new MemoryRepository();
    repo.seed(seedData());
    const token = await repo.findTokenByHash(hashSeedToken(SEED_PARTICIPANT_TOKEN));
    expect(token?.participantId).toBe(SEED_PARTICIPANT_ID);
    expect(token?.role).toBe("PARTICIPANT");
    const admin = await repo.findTokenByHash(hashSeedToken(SEED_ADMIN_TOKEN));
    expect(admin?.role).toBe("ADMIN");
  });
});
