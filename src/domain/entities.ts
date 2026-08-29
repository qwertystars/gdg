/**
 * Domain entity shapes for the Remote Runtime.
 *
 * These are the storage/domain records: participants, api tokens,
 * problems, problem versions, test cases, submissions, judge attempts, and
 * per-test results. They mirror migrations/0001_initial.sql and the
 * reference schema in remote-runtime-backend-architecture.md section 16,
 * simplified for the first implementation.
 */

import type {
  ComparatorPolicy,
  JudgeAttemptStatus,
  ParticipantStatus,
  ProblemLifecycleState,
  Role,
  SubmissionLanguage,
  SubmissionStatus,
  TestCaseKind,
} from "./enums";
import type { ApiTokenId, AuditLogId, JudgeAttemptId, ParticipantId, ProblemId, SubmissionId, TestCaseId } from "./ids";

export interface ParticipantRecord {
  id: ParticipantId;
  displayName: string;
  status: ParticipantStatus;
  createdAtMs: number;
}

export interface ApiTokenRecord {
  id: ApiTokenId;
  participantId: ParticipantId | null;
  tokenHash: string;
  role: Role;
  revokedAtMs: number | null;
  createdAtMs: number;
}

export interface ProblemLimits {
  timeLimitMs: number;
  memoryLimitKb: number;
  outputLimitBytes: number;
  compileTimeLimitMs: number;
  compileOutputLimitBytes: number;
}

export interface ProblemRecord {
  id: ProblemId;
  slug: string;
  title: string;
  lifecycleState: ProblemLifecycleState;
  activeVersion: number | null;
  limits: ProblemLimits;
  createdAtMs: number;
  updatedAtMs: number;
}

export interface ProblemVersionRecord {
  problemId: ProblemId;
  version: number;
  languagePolicy: string;
  compilerImageVersion: string;
  comparatorVersion: string;
  runnerImageVersion: string;
  createdAtMs: number;
}

export interface TestCaseRecord {
  id: TestCaseId;
  problemId: ProblemId;
  problemVersion: number;
  kind: TestCaseKind;
  ordinal: number;
  inputR2Key: string;
  expectedR2Key: string;
  comparator: ComparatorPolicy;
  weight: number;
  /** SHA-256 hex of the input artifact bytes (business-logic section 80, optional integrity). */
  inputSha256: string | null;
  /** SHA-256 hex of the expected artifact bytes (business-logic section 80, optional integrity). */
  expectedSha256: string | null;
}

export interface SubmissionRecord {
  id: SubmissionId;
  participantId: ParticipantId;
  problemId: ProblemId;
  problemVersion: number;
  language: SubmissionLanguage;
  sourceR2Key: string;
  status: SubmissionStatus;
  attemptCount: number;
  executionToken: string | null;
  leaseUntilMs: number | null;
  compilerVersion: string | null;
  compilerFlags: string | null;
  runnerImageVersion: string | null;
  compileLogR2Key: string | null;
  errorId: string | null;
  passedTests: number | null;
  totalTests: number | null;
  performanceScoreNs: number | null;
  peakMemoryKb: number | null;
  createdAtMs: number;
  queuedAtMs: number | null;
  startedAtMs: number | null;
  completedAtMs: number | null;
  updatedAtMs: number;
}

export interface JudgeAttemptRecord {
  id: JudgeAttemptId;
  submissionId: SubmissionId;
  attemptNumber: number;
  executionToken: string;
  sandboxId: string | null;
  status: JudgeAttemptStatus;
  infrastructureError: string | null;
  errorId: string | null;
  startedAtMs: number;
  completedAtMs: number | null;
}

export interface SubmissionTestResultRecord {
  submissionId: SubmissionId;
  testCaseId: TestCaseId;
  status:
    | "PASS"
    | "WRONG_ANSWER"
    | "RUNTIME_ERROR"
    | "TIME_LIMIT_EXCEEDED"
    | "MEMORY_LIMIT_EXCEEDED"
    | "OUTPUT_LIMIT_EXCEEDED";
  cpuTimeNs: number | null;
  wallTimeNs: number | null;
  peakMemoryKb: number | null;
  exitCode: number | null;
  signal: number | null;
}

export interface SubmissionBenchmarkRecord {
  submissionId: SubmissionId;
  testCaseId: TestCaseId;
  runNumber: number;
  cpuTimeNs: number;
  wallTimeNs: number;
  peakMemoryKb: number;
}

/**
 * Admin/system audit trail (business-logic sections 46 and 94; table
 * audit_log in migrations/0001). Rows are append-only.
 */
export interface AuditLogRecord {
  id: AuditLogId;
  actorId: string | null;
  actorRole: Role | "SYSTEM";
  action: string;
  subjectType: string;
  subjectId: string;
  detailJson: string | null;
  createdAtMs: number;
}
