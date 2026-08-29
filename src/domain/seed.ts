/**
 * Deterministic seed data for local development and tests: participants,
 * hashed API tokens, and one versioned problem with correctness and
 * benchmark test cases.
 *
 * Tokens are stored as SHA-256 hex hashes only; the plaintext tokens are
 * documented constants for local development and are never persisted.
 */

import { createHash } from "node:crypto";
import type {
  ApiTokenRecord,
  ParticipantRecord,
  ProblemRecord,
  ProblemVersionRecord,
  TestCaseRecord,
} from "./entities";
import type { ParticipantId } from "./ids";
import { asApiTokenId, asParticipantId, asProblemId, asTestCaseId } from "./ids";

export interface SeedData {
  participants: readonly ParticipantRecord[];
  tokens: readonly ApiTokenRecord[];
  problems: readonly ProblemRecord[];
  problemVersions: readonly ProblemVersionRecord[];
  testCases: readonly TestCaseRecord[];
}

export const SEED_PARTICIPANT_ID = asParticipantId("participant_seed_alpha");
export const SEED_ADMIN_ID = asParticipantId("participant_seed_admin");
export const SEED_PROBLEM_ID = asProblemId("problem_seed_two_sum");

export const SEED_PARTICIPANT_TOKEN = "rr_dev_participant_token_0001";
export const SEED_ADMIN_TOKEN = "rr_dev_admin_token_0001";

export const SOURCE_R2_KEY_PREFIX = "submissions";
export const TEST_INPUT_R2_PREFIX = "problems";

const EPOCH_MS = 1_700_000_000_000;

// Precomputed SHA-256 hex of the documented seed tokens (workerd-safe: no Bun).
// Kept in lockstep with hashSeedToken so seeded rows always match auth lookups.
export const SEED_PARTICIPANT_TOKEN_HASH = "afc1f094ad03b7aef7dd7e02f410e0058ac650c88bae0b1746300284860c41d3";
export const SEED_ADMIN_TOKEN_HASH = "afc11f9ebce86d8690f879a76a6b83d6b84816603c8d33c27a1ff7b638bf17c4";

const sha256Hex = (input: string): string => createHash("sha256").update(input).digest("hex");

function participant(id: ParticipantId, displayName: string): ParticipantRecord {
  return { id, displayName, status: "ACTIVE", createdAtMs: EPOCH_MS };
}

const participants: readonly ParticipantRecord[] = [
  participant(SEED_PARTICIPANT_ID, "Seed Participant"),
  participant(SEED_ADMIN_ID, "Seed Admin"),
];

const tokens: readonly ApiTokenRecord[] = [
  {
    id: asApiTokenId("token_seed_participant"),
    participantId: SEED_PARTICIPANT_ID,
    tokenHash: sha256Hex(SEED_PARTICIPANT_TOKEN),
    role: "PARTICIPANT",
    revokedAtMs: null,
    createdAtMs: EPOCH_MS,
  },
  {
    id: asApiTokenId("token_seed_admin"),
    participantId: SEED_ADMIN_ID,
    tokenHash: sha256Hex(SEED_ADMIN_TOKEN),
    role: "ADMIN",
    revokedAtMs: null,
    createdAtMs: EPOCH_MS,
  },
];

const problems: readonly ProblemRecord[] = [
  {
    id: SEED_PROBLEM_ID,
    slug: "two-sum",
    title: "Two Sum",
    lifecycleState: "ACTIVE",
    activeVersion: 1,
    limits: {
      timeLimitMs: 2000,
      memoryLimitKb: 262144,
      outputLimitBytes: 1048576,
      compileTimeLimitMs: 10000,
      compileOutputLimitBytes: 262144,
    },
    createdAtMs: EPOCH_MS,
    updatedAtMs: EPOCH_MS,
  },
];

const problemVersions: readonly ProblemVersionRecord[] = [
  {
    problemId: SEED_PROBLEM_ID,
    version: 1,
    languagePolicy: "cpp17",
    compilerImageVersion: "gcc-13.2.0-cpp17",
    comparatorVersion: "normalized-v1",
    runnerImageVersion: "judge-runner-v1",
    createdAtMs: EPOCH_MS,
  },
];

function testCase(id: string, kind: TestCaseRecord["kind"], ordinal: number): TestCaseRecord {
  const file = String(ordinal).padStart(3, "0");
  // Seed fixtures are deterministic (see LocalArtifactStore/bootstrap mapping:
  // tests/*.in = "21\n", tests/*.out = "42\n", benchmarks/*.in = "100000\n",
  // benchmarks/*.out = "200000\n"), so the SHA-256 integrity columns
  // (business-logic section 80) are populated with the fixture byte hashes.
  const isBenchmark = kind === "BENCHMARK";
  const input = isBenchmark ? "100000\n" : "21\n";
  const expected = isBenchmark ? "200000\n" : "42\n";
  return {
    id: asTestCaseId(id),
    problemId: SEED_PROBLEM_ID,
    problemVersion: 1,
    kind,
    ordinal,
    inputR2Key: `${TEST_INPUT_R2_PREFIX}/${SEED_PROBLEM_ID}/v1/${isBenchmark ? "benchmarks" : "tests"}/${file}.in`,
    expectedR2Key: `${TEST_INPUT_R2_PREFIX}/${SEED_PROBLEM_ID}/v1/${isBenchmark ? "benchmarks" : "tests"}/${file}.out`,
    comparator: "NORMALIZED",
    weight: 1,
    inputSha256: sha256Hex(input),
    expectedSha256: sha256Hex(expected),
  };
}

const testCases: readonly TestCaseRecord[] = [
  testCase("test_seed_two_sum_001", "CORRECTNESS", 1),
  testCase("test_seed_two_sum_002", "CORRECTNESS", 2),
  testCase("test_seed_two_sum_003", "CORRECTNESS", 3),
  testCase("test_seed_two_sum_001b", "BENCHMARK", 1),
];

export function seedData(): SeedData {
  // Return fresh copies on every call: consumers (tests, repos) must be free
  // to mutate records without poisoning the module-level seed constants or
  // other consumers sharing the same process.
  return {
    participants: participants.map((p) => ({ ...p })),
    tokens: tokens.map((t) => ({ ...t })),
    problems: problems.map((p) => ({ ...p, limits: { ...p.limits } })),
    problemVersions: problemVersions.map((v) => ({ ...v })),
    testCases: testCases.map((t) => ({ ...t })),
  };
}

/** Recomputes the hash so tests can assert the documented plaintext maps to the stored hash. */
export function hashSeedToken(plaintext: string): string {
  return sha256Hex(plaintext);
}

export function sourceR2KeyFor(submissionId: string): string {
  return `${SOURCE_R2_KEY_PREFIX}/${submissionId}/source.cpp`;
}
