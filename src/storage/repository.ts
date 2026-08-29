/**
 * Repository contract for the Remote Runtime state layer.
 *
 * The API and judge lanes consume this interface; local development uses
 * the in-memory implementation (MemoryRepository), and the Cloudflare
 * deployment binds a D1 implementation behind the same contract.
 *
 * Execution semantics that matter for judging:
 * - `claimExecution` is atomic: it transitions QUEUED (or RUNNING with an
 *   expired lease) to RUNNING with a fresh execution token and lease, and
 *   increments the attempt counter. A concurrent or duplicate claim is
 *   rejected, which is what makes Queue redelivery idempotent.
 * - `submitResult` commits a terminal status only when the caller still
 *   holds the current execution token (stale-result protection). On commit
 *   the lease is cleared.
 * - `createSubmission` requires the problem's active version and stores
 *   the source key under the submission id.
 */

import type {
  ApiTokenRecord,
  AuditLogRecord,
  JudgeAttemptRecord,
  ParticipantRecord,
  ProblemRecord,
  ProblemVersionRecord,
  SubmissionBenchmarkRecord,
  SubmissionRecord,
  SubmissionTestResultRecord,
  TestCaseRecord,
} from "../domain/entities";
import type { ComparatorPolicy, Role, SubmissionLanguage, SubmissionStatus, TestCaseKind } from "../domain/enums";
import type { ApiTokenId, AuditLogId, ParticipantId, ProblemId, SubmissionId, TestCaseId } from "../domain/ids";
import type { ClaimOutcome, ClaimRequest, SubmitResultOutcome, SubmitResultRequest } from "../domain/state";

export interface CreateSubmissionInput {
  participantId: ParticipantId;
  problemId: ProblemId;
  language: SubmissionLanguage;
  sourceR2Key: string;
  sourceSha256: string;
  nowMs: number;
}

export interface CreateJudgeAttemptInput {
  submissionId: SubmissionId;
  attemptNumber: number;
  executionToken: string;
  nowMs: number;
}

export interface SubmissionListFilter {
  participantId?: ParticipantId;
  problemId?: ProblemId;
  status?: SubmissionStatus;
}

export interface SubmissionList {
  items: SubmissionRecord[];
  nextCursor: string | null;
}

export interface Repository {
  // Participants and tokens -------------------------------------------------
  findParticipantById(id: ParticipantId): Promise<ParticipantRecord | null>;
  listParticipants(): Promise<ParticipantRecord[]>;
  findTokenById(id: ApiTokenId): Promise<ApiTokenRecord | null>;
  findTokenByHash(hash: string): Promise<ApiTokenRecord | null>;
  listTokens(): Promise<ApiTokenRecord[]>;
  /** Revoke a token: sets revoked_at (business-logic section 2.2, backend 41). */
  revokeToken(id: ApiTokenId, nowMs: number): Promise<ApiTokenRecord | null>;
  /** Create a token row storing only the SHA-256 hash (business-logic section 2.1, backend 41/42). */
  createApiToken(input: {
    id: ApiTokenId;
    participantId: ParticipantId;
    tokenHash: string;
    role: Role;
    nowMs: number;
  }): Promise<ApiTokenRecord>;

  // Problems and tests ------------------------------------------------------
  findProblemById(id: ProblemId): Promise<ProblemRecord | null>;
  findProblemBySlug(slug: string): Promise<ProblemRecord | null>;
  listProblems(): Promise<ProblemRecord[]>;
  findProblemVersion(problemId: ProblemId, version: number): Promise<ProblemVersionRecord | null>;
  listProblemVersions(problemId: ProblemId): Promise<ProblemVersionRecord[]>;
  findTestCaseById(id: TestCaseId): Promise<TestCaseRecord | null>;
  listTestCases(problemId: ProblemId, version: number): Promise<TestCaseRecord[]>;
  /** Create a problem in DRAFT state. */
  createProblem(input: {
    id: ProblemId;
    slug: string;
    title: string;
    timeLimitMs: number;
    memoryLimitKb: number;
    outputLimitBytes: number;
    compileTimeLimitMs: number;
    compileOutputLimitBytes: number;
    nowMs: number;
  }): Promise<ProblemRecord>;
  /** Create a new problem version. */
  createProblemVersion(input: {
    problemId: ProblemId;
    version: number;
    languagePolicy: string;
    compilerImageVersion: string;
    comparatorVersion: string;
    runnerImageVersion: string;
    limits: ProblemRecord["limits"];
    nowMs: number;
  }): Promise<ProblemVersionRecord>;
  /** Create a test case row and persist its artifacts via the store. */
  createTestCase(input: {
    id: TestCaseId;
    problemId: ProblemId;
    problemVersion: number;
    kind: TestCaseKind;
    ordinal: number;
    inputR2Key: string;
    expectedR2Key: string;
    comparator: ComparatorPolicy;
    weight: number;
    inputSha256: string | null;
    expectedSha256: string | null;
  }): Promise<TestCaseRecord>;
  /** All submissions matching a problem (admin judge-error inspection). */
  listSubmissionsByProblem(problemId: ProblemId): Promise<SubmissionRecord[]>;

  // Submissions -------------------------------------------------------------
  createSubmission(input: CreateSubmissionInput): Promise<SubmissionRecord>;
  findSubmissionById(id: SubmissionId): Promise<SubmissionRecord | null>;
  listSubmissions(filter: SubmissionListFilter, cursor: string | null, limit: number): Promise<SubmissionList>;
  /** Atomic claim: QUEUED -> RUNNING, or RUNNING with an expired lease. */
  claimExecution(request: ClaimRequest): Promise<ClaimOutcome>;
  /** Conditional terminal commit; rejected when the execution token no longer matches. */
  submitResult(request: SubmitResultRequest): Promise<SubmitResultOutcome>;
  /** Explicit status transition with transition validation. */
  setSubmissionStatus(id: SubmissionId, to: SubmissionStatus, nowMs: number): Promise<SubmissionRecord | null>;
  /**
   * Admin rejudge reset: validates the source with assertRejudgeTransition,
   * moves the submission to QUEUED, and clears all execution-lease fields so
   * a fresh judge attempt can claim it. Leaves attempt history intact.
   */
  resetForRejudge(id: SubmissionId, nowMs: number): Promise<SubmissionRecord | null>;
  /** Mark a Queue delivery attempt; used by the scheduled recovery scanner. */
  markDispatchAttempt(id: SubmissionId, nowMs: number): Promise<void>;
  /** In-flight rows whose Queue message may have been lost. */
  listDispatchableSubmissions(beforeMs: number, limit: number): Promise<SubmissionRecord[]>;

  // Attempts and per-test results -------------------------------------------
  createJudgeAttempt(input: CreateJudgeAttemptInput): Promise<JudgeAttemptRecord>;
  updateJudgeAttempt(
    id: SubmissionId,
    attemptNumber: number,
    patch: Partial<
      Pick<JudgeAttemptRecord, "status" | "sandboxId" | "infrastructureError" | "errorId" | "completedAtMs">
    >,
  ): Promise<JudgeAttemptRecord | null>;
  listJudgeAttempts(submissionId: SubmissionId): Promise<JudgeAttemptRecord[]>;
  saveTestResult(record: SubmissionTestResultRecord): Promise<void>;
  saveBenchmarkRun(record: SubmissionBenchmarkRecord): Promise<void>;
  /** Per-test-case correctness results for a submission (business-logic 42/74). */
  listTestResults(submissionId: SubmissionId): Promise<SubmissionTestResultRecord[]>;
  /** Per-run benchmark results for a submission (business-logic 42/74). */
  listBenchmarkRuns(submissionId: SubmissionId): Promise<SubmissionBenchmarkRecord[]>;

  // Audit trail ------------------------------------------------------------
  /** Append an admin/system audit record (business-logic sections 46, 94). */
  createAuditLog(input: {
    id: AuditLogId;
    actorId: string | null;
    actorRole: Role | "SYSTEM";
    action: string;
    subjectType: string;
    subjectId: string;
    detailJson: string | null;
    nowMs: number;
  }): Promise<AuditLogRecord>;
  listAuditLogs(subjectType: string, subjectId: string): Promise<AuditLogRecord[]>;
}

export const SUBMISSION_LIST_PAGE_SIZE = 50;
export const SUBMISSION_LIST_MAX_PAGE_SIZE = 200;
