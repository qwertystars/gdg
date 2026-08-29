/**
 * Domain enums for the Remote Runtime: roles, lifecycle states, judge
 * statuses, and test case kinds. These are the single source of truth for
 * the string unions used across the domain, storage, API, and judge lanes.
 */

export type Role = "PARTICIPANT" | "ADMIN";

export type ParticipantStatus = "ACTIVE" | "SUSPENDED";

export type ProblemLifecycleState = "DRAFT" | "ACTIVE" | "CLOSED";

export type TestCaseKind = "CORRECTNESS" | "BENCHMARK";

export type ComparatorPolicy = "NORMALIZED" | "EXACT" | "TOKEN" | "FLOAT_TOLERANCE";

/**
 * Submission status. CREATED/QUEUED/RUNNING/JUDGE_RETRY are in-flight; the
 * rest are terminal. Matches migrations/0001_initial.sql (extended by
 * 0003_judge_retry_status.sql) and the state machine in
 * remote-runtime-backend-architecture.md section 12.
 *
 * JUDGE_RETRY is the non-terminal infrastructure-retry status: a judge
 * attempt failed with JUDGE_ERROR but the retry budget is not exhausted, so
 * the submission stays in-flight (no lease) until a redelivered queue
 * message claims it again. Terminating on retry exhaustion goes to
 * JUDGE_ERROR (terminal); admin rejudge is the only path that returns a
 * terminal status to QUEUED.
 */
export type SubmissionStatus =
  | "CREATED"
  | "QUEUED"
  | "RUNNING"
  | "JUDGE_RETRY"
  | "COMPILE_ERROR"
  | "WRONG_ANSWER"
  | "RUNTIME_ERROR"
  | "TIME_LIMIT_EXCEEDED"
  | "MEMORY_LIMIT_EXCEEDED"
  | "OUTPUT_LIMIT_EXCEEDED"
  | "ACCEPTED"
  | "JUDGE_ERROR";

export type JudgeAttemptStatus = "CLAIMED" | "RUNNING" | "SUCCEEDED" | "FAILED_RETRYABLE" | "FAILED_TERMINAL";

export type SubmissionLanguage = "cpp17";

/** The judge lane's classification names; the submission statuses use the same spelling. */
export type RunClassification =
  | "NORMAL"
  | "RUNTIME_ERROR"
  | "TIME_LIMIT_EXCEEDED"
  | "MEMORY_LIMIT_EXCEEDED"
  | "OUTPUT_LIMIT_EXCEEDED";

export const TERMINAL_SUBMISSION_STATUSES: ReadonlySet<SubmissionStatus> = new Set<SubmissionStatus>([
  "COMPILE_ERROR",
  "WRONG_ANSWER",
  "RUNTIME_ERROR",
  "TIME_LIMIT_EXCEEDED",
  "MEMORY_LIMIT_EXCEEDED",
  "OUTPUT_LIMIT_EXCEEDED",
  "ACCEPTED",
  "JUDGE_ERROR",
]);

export const IN_FLIGHT_SUBMISSION_STATUSES: ReadonlySet<SubmissionStatus> = new Set<SubmissionStatus>([
  "CREATED",
  "QUEUED",
  "RUNNING",
  "JUDGE_RETRY",
]);

export function isTerminalSubmissionStatus(status: SubmissionStatus): boolean {
  return TERMINAL_SUBMISSION_STATUSES.has(status);
}

export function isInFlightSubmissionStatus(status: SubmissionStatus): boolean {
  return IN_FLIGHT_SUBMISSION_STATUSES.has(status);
}
