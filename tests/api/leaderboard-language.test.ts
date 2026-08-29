import { describe, expect, test } from "bun:test";
import { computeLeaderboard } from "../../src/api/leaderboard";
import type { SubmissionRecord } from "../../src/domain/entities";
import { asParticipantId, asProblemId, asSubmissionId } from "../../src/domain/ids";

function accepted(id: string, language: SubmissionRecord["language"], score: number): SubmissionRecord {
  return {
    id: asSubmissionId(id),
    participantId: asParticipantId("participant_same"),
    problemId: asProblemId("problem_same"),
    problemVersion: 1,
    language,
    sourceR2Key: `submissions/${id}/source`,
    sourceSha256: "0".repeat(64),
    status: "ACCEPTED",
    attemptCount: 1,
    executionToken: null,
    leaseUntilMs: null,
    dispatchAttempts: 1,
    lastDispatchAtMs: 1,
    compilerVersion: null,
    compilerFlags: null,
    runnerImageVersion: null,
    compileLogR2Key: null,
    errorId: null,
    passedTests: 1,
    totalTests: 1,
    performanceScoreNs: score,
    peakMemoryKb: 1024,
    createdAtMs: 1,
    queuedAtMs: 1,
    startedAtMs: 1,
    completedAtMs: 1,
    updatedAtMs: 1,
  };
}

describe("multi-language leaderboard fairness", () => {
  test("ranks each language independently instead of comparing interpreter overhead", () => {
    const entries = computeLeaderboard(
      [accepted("sub_cpp", "cpp17", 1_000_000), accepted("sub_python", "python3", 20_000_000)],
      "problem_same",
    );
    expect(entries).toHaveLength(2);
    expect(entries.map((entry) => [entry.language, entry.rank])).toEqual([
      ["cpp17", 1],
      ["python3", 1],
    ]);
  });
});
