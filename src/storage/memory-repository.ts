/**
 * In-memory repository implementing the Remote Runtime Repository contract.
 *
 * This is the local-MVP state layer: API and judge lanes run against it in
 * tests and `bun run` flows, and a D1 implementation can replace it behind
 * the same interface without changing domain behavior.
 *
 * The lease/claim and token-commit rules mirror the D1 conditional updates
 * in remote-runtime-backend-architecture.md sections 11 and 73, including
 * expired-lease reclamation and stale-result rejection.
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
import type { ComparatorPolicy, Role, SubmissionStatus, TestCaseKind } from "../domain/enums";
import { isTerminalSubmissionStatus } from "../domain/enums";
import {
  type ApiTokenId,
  type AuditLogId,
  asSubmissionId,
  newJudgeAttemptId,
  type ParticipantId,
  type ProblemId,
  type SubmissionId,
  type TestCaseId,
} from "../domain/ids";
import {
  assertRejudgeTransition,
  assertTransition,
  type ClaimOutcome,
  type ClaimRequest,
  canJudgeAttemptTransition,
  evaluateResultCommit,
  type SubmitResultOutcome,
  type SubmitResultRequest,
} from "../domain/state";
import type {
  CreateJudgeAttemptInput,
  CreateSubmissionInput,
  Repository,
  SubmissionList,
  SubmissionListFilter,
} from "./repository";
import { SUBMISSION_LIST_MAX_PAGE_SIZE } from "./repository";

export class MemoryRepository implements Repository {
  private readonly submissionRateLimits = new Map<string, number>();
  readonly participants = new Map<string, ParticipantRecord>();
  readonly tokens = new Map<string, ApiTokenRecord>();
  readonly problems = new Map<string, ProblemRecord>();
  readonly problemVersions = new Map<string, ProblemVersionRecord>();
  readonly testCases = new Map<string, TestCaseRecord>();
  readonly submissions = new Map<string, SubmissionRecord>();
  readonly judgeAttempts = new Map<string, JudgeAttemptRecord>();
  readonly testResults = new Map<string, SubmissionTestResultRecord>();
  readonly benchmarkRuns = new Map<string, SubmissionBenchmarkRecord>();
  readonly auditLogs = new Map<string, AuditLogRecord>();

  seed(records: {
    participants: readonly ParticipantRecord[];
    tokens: readonly ApiTokenRecord[];
    problems: readonly ProblemRecord[];
    problemVersions: readonly ProblemVersionRecord[];
    testCases: readonly TestCaseRecord[];
  }): void {
    for (const record of records.participants) this.participants.set(record.id, record);
    for (const record of records.tokens) this.tokens.set(record.id, record);
    for (const record of records.problems) this.problems.set(record.id, record);
    for (const record of records.problemVersions) {
      this.problemVersions.set(versionKey(record.problemId, record.version), record);
    }
    for (const record of records.testCases) this.testCases.set(record.id, record);
  }

  // Participants and tokens -------------------------------------------------

  async findParticipantById(id: ParticipantId): Promise<ParticipantRecord | null> {
    return this.participants.get(id) ?? null;
  }

  async listParticipants(): Promise<ParticipantRecord[]> {
    return [...this.participants.values()];
  }

  async findTokenById(id: ApiTokenId): Promise<ApiTokenRecord | null> {
    return this.tokens.get(id) ?? null;
  }

  async findTokenByHash(hash: string): Promise<ApiTokenRecord | null> {
    for (const token of this.tokens.values()) {
      if (token.tokenHash === hash) return token;
    }
    return null;
  }

  async revokeToken(id: ApiTokenId, nowMs: number): Promise<ApiTokenRecord | null> {
    const token = this.tokens.get(id);
    if (token === undefined) return null;
    token.revokedAtMs = nowMs;
    return token;
  }

  async createApiToken(input: {
    id: ApiTokenId;
    participantId: ParticipantId;
    tokenHash: string;
    role: Role;
    nowMs: number;
  }): Promise<ApiTokenRecord> {
    const record: ApiTokenRecord = {
      id: input.id,
      participantId: input.participantId,
      tokenHash: input.tokenHash,
      role: input.role,
      revokedAtMs: null,
      createdAtMs: input.nowMs,
    };
    this.tokens.set(record.id, record);
    return record;
  }

  async listTokens(): Promise<ApiTokenRecord[]> {
    return [...this.tokens.values()];
  }

  // Problems and tests ------------------------------------------------------

  async findProblemById(id: ProblemId): Promise<ProblemRecord | null> {
    return this.problems.get(id) ?? null;
  }

  async findProblemBySlug(slug: string): Promise<ProblemRecord | null> {
    for (const problem of this.problems.values()) {
      if (problem.slug === slug) return problem;
    }
    return null;
  }

  async listProblems(): Promise<ProblemRecord[]> {
    return [...this.problems.values()];
  }

  async findProblemVersion(problemId: ProblemId, version: number): Promise<ProblemVersionRecord | null> {
    return this.problemVersions.get(versionKey(problemId, version)) ?? null;
  }

  async listProblemVersions(problemId: ProblemId): Promise<ProblemVersionRecord[]> {
    return [...this.problemVersions.values()].filter((v) => v.problemId === problemId);
  }

  async findTestCaseById(id: TestCaseId): Promise<TestCaseRecord | null> {
    return this.testCases.get(id) ?? null;
  }

  async listTestCases(problemId: ProblemId, version: number): Promise<TestCaseRecord[]> {
    return [...this.testCases.values()]
      .filter((t) => t.problemId === problemId && t.problemVersion === version)
      .sort((a, b) => a.kind.localeCompare(b.kind) || a.ordinal - b.ordinal);
  }

  async createProblem(input: {
    id: ProblemId;
    slug: string;
    title: string;
    timeLimitMs: number;
    memoryLimitKb: number;
    outputLimitBytes: number;
    compileTimeLimitMs: number;
    compileOutputLimitBytes: number;
    nowMs: number;
  }): Promise<ProblemRecord> {
    const record: ProblemRecord = {
      id: input.id,
      slug: input.slug,
      title: input.title,
      lifecycleState: "DRAFT",
      activeVersion: null,
      limits: {
        timeLimitMs: input.timeLimitMs,
        memoryLimitKb: input.memoryLimitKb,
        outputLimitBytes: input.outputLimitBytes,
        compileTimeLimitMs: input.compileTimeLimitMs,
        compileOutputLimitBytes: input.compileOutputLimitBytes,
      },
      createdAtMs: input.nowMs,
      updatedAtMs: input.nowMs,
    };
    this.problems.set(record.id, record);
    return record;
  }

  async createProblemVersion(input: {
    problemId: ProblemId;
    version: number;
    languagePolicy: string;
    compilerImageVersion: string;
    comparatorVersion: string;
    runnerImageVersion: string;
    limits: ProblemRecord["limits"];
    nowMs: number;
  }): Promise<ProblemVersionRecord> {
    if (this.problemVersions.has(versionKey(input.problemId, input.version))) {
      throw new Error(`Problem version already exists: ${input.problemId}#${input.version}`);
    }
    const record: ProblemVersionRecord = {
      problemId: input.problemId,
      version: input.version,
      languagePolicy: input.languagePolicy,
      compilerImageVersion: input.compilerImageVersion,
      comparatorVersion: input.comparatorVersion,
      runnerImageVersion: input.runnerImageVersion,
      limits: { ...input.limits },
      createdAtMs: input.nowMs,
    };
    this.problemVersions.set(versionKey(input.problemId, input.version), record);
    return record;
  }

  async activateProblemVersion(problemId: ProblemId, version: number, nowMs: number): Promise<ProblemRecord | null> {
    const problem = this.problems.get(problemId);
    if (!problem || !this.problemVersions.has(versionKey(problemId, version))) return null;
    problem.lifecycleState = "ACTIVE";
    problem.activeVersion = version;
    problem.updatedAtMs = nowMs;
    return problem;
  }

  async updateProblem(
    problemId: ProblemId,
    patch: { title?: string; timeLimitMs?: number; memoryLimitKb?: number; outputLimitBytes?: number },
    nowMs: number,
  ): Promise<ProblemRecord | null> {
    const problem = this.problems.get(problemId);
    if (!problem) return null;
    if (patch.title !== undefined) problem.title = patch.title;
    if (patch.timeLimitMs !== undefined) problem.limits.timeLimitMs = patch.timeLimitMs;
    if (patch.memoryLimitKb !== undefined) problem.limits.memoryLimitKb = patch.memoryLimitKb;
    if (patch.outputLimitBytes !== undefined) problem.limits.outputLimitBytes = patch.outputLimitBytes;
    problem.updatedAtMs = nowMs;
    return problem;
  }

  async closeProblem(problemId: ProblemId, nowMs: number): Promise<ProblemRecord | null> {
    const problem = this.problems.get(problemId);
    if (problem?.lifecycleState !== "ACTIVE") return null;
    problem.lifecycleState = "CLOSED";
    problem.updatedAtMs = nowMs;
    return problem;
  }

  async createTestCase(input: {
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
  }): Promise<TestCaseRecord> {
    const record: TestCaseRecord = {
      id: input.id,
      problemId: input.problemId,
      problemVersion: input.problemVersion,
      kind: input.kind,
      ordinal: input.ordinal,
      inputR2Key: input.inputR2Key,
      expectedR2Key: input.expectedR2Key,
      comparator: input.comparator,
      weight: input.weight,
      inputSha256: input.inputSha256,
      expectedSha256: input.expectedSha256,
    };
    this.testCases.set(record.id, record);
    return record;
  }

  async listSubmissionsByProblem(problemId: ProblemId): Promise<SubmissionRecord[]> {
    return [...this.submissions.values()].filter((s) => s.problemId === problemId);
  }

  // Submissions -------------------------------------------------------------

  async createSubmission(input: CreateSubmissionInput): Promise<SubmissionRecord> {
    const problem = this.problems.get(input.problemId);
    if (!problem) throw new Error(`Unknown problem: ${input.problemId}`);
    if (problem.lifecycleState !== "ACTIVE") {
      throw new Error(`Problem is not ACTIVE: ${input.problemId}`);
    }
    const version = problem.activeVersion;
    if (version === null) throw new Error(`Problem has no active version: ${input.problemId}`);
    const id = asSubmissionId(`sub_${randomSuffix(16)}`);
    const record: SubmissionRecord = {
      id,
      participantId: input.participantId,
      problemId: input.problemId,
      problemVersion: version,
      language: input.language,
      sourceR2Key: input.sourceR2Key,
      sourceSha256: input.sourceSha256,
      status: "CREATED",
      attemptCount: 0,
      executionToken: null,
      leaseUntilMs: null,
      dispatchAttempts: 0,
      lastDispatchAtMs: null,
      compilerVersion: null,
      compilerFlags: null,
      runnerImageVersion: null,
      compileLogR2Key: null,
      errorId: null,
      passedTests: null,
      totalTests: null,
      performanceScoreNs: null,
      peakMemoryKb: null,
      createdAtMs: input.nowMs,
      queuedAtMs: null,
      startedAtMs: null,
      completedAtMs: null,
      updatedAtMs: input.nowMs,
    };
    this.submissions.set(id, record);
    return record;
  }

  async consumeSubmissionRateLimit(
    participantId: ParticipantId,
    nowMs: number,
    limit: number,
    windowMs: number,
  ): Promise<boolean> {
    const bucket = Math.floor(nowMs / windowMs);
    const key = `${participantId}:${windowMs}:${bucket}`;
    const count = this.submissionRateLimits.get(key) ?? 0;
    if (count >= limit) return false;
    this.submissionRateLimits.set(key, count + 1);
    return true;
  }

  async findSubmissionById(id: SubmissionId): Promise<SubmissionRecord | null> {
    return this.submissions.get(id) ?? null;
  }

  async listSubmissions(filter: SubmissionListFilter, cursor: string | null, limit: number): Promise<SubmissionList> {
    const pageSize = Math.min(Math.max(1, limit), SUBMISSION_LIST_MAX_PAGE_SIZE);
    const all = [...this.submissions.values()]
      .filter((s) => filter.participantId === undefined || s.participantId === filter.participantId)
      .filter((s) => filter.problemId === undefined || s.problemId === filter.problemId)
      .filter((s) => filter.status === undefined || s.status === filter.status)
      .sort((a, b) => b.createdAtMs - a.createdAtMs || a.id.localeCompare(b.id));

    // Cursor is the last id of the previous page: resume AFTER it so items
    // are never returned twice and none are skipped.
    const startIndex = cursor === null ? 0 : all.findIndex((s) => s.id === asSubmissionId(cursor)) + 1;
    const slice = all.slice(startIndex, startIndex + pageSize);
    const nextCursor = startIndex + slice.length < all.length ? (slice.at(-1)?.id ?? null) : null;
    return { items: slice, nextCursor };
  }

  async claimExecution(request: ClaimRequest): Promise<ClaimOutcome> {
    const record = this.submissions.get(request.submissionId);
    if (!record) return { ok: false, reason: "MISSING", submissionId: request.submissionId };
    if (isTerminalSubmissionStatus(record.status)) {
      return { ok: false, reason: "TERMINAL", submissionId: request.submissionId };
    }
    if (record.status === "RUNNING" && record.leaseUntilMs !== null && record.leaseUntilMs > request.nowMs) {
      return { ok: false, reason: "LEASE_VALID", submissionId: request.submissionId };
    }
    assertTransition(record.status, "RUNNING");
    const attemptNumber = record.attemptCount + 1;
    record.status = "RUNNING";
    record.executionToken = request.executionToken;
    record.leaseUntilMs = request.leaseUntilMs;
    record.attemptCount = attemptNumber;
    record.startedAtMs = record.startedAtMs ?? request.nowMs;
    record.updatedAtMs = request.nowMs;
    return { ok: true, attemptNumber, status: "RUNNING" };
  }

  async submitResult(request: SubmitResultRequest): Promise<SubmitResultOutcome> {
    const record = this.submissions.get(request.submissionId);
    if (!record) return "MISSING";
    const decision = evaluateResultCommit({ status: record.status, executionToken: record.executionToken }, request);
    if (decision !== "COMMITTED") return decision;
    if (!isTerminalSubmissionStatus(request.status)) {
      throw new Error(`submitResult requires a terminal status, got ${request.status}`);
    }
    assertTransition(record.status, request.status);
    record.status = request.status;
    record.executionToken = null;
    record.leaseUntilMs = null;
    record.completedAtMs = request.nowMs;
    record.performanceScoreNs = request.performanceScoreNs ?? null;
    record.peakMemoryKb = request.peakMemoryKb ?? null;
    record.passedTests = request.passedTests ?? null;
    record.totalTests = request.totalTests ?? null;
    record.compileLogR2Key = request.compileLogR2Key ?? null;
    record.errorId = request.errorId ?? record.errorId;
    record.updatedAtMs = request.nowMs;
    return "COMMITTED";
  }

  async setSubmissionStatus(id: SubmissionId, to: SubmissionStatus, nowMs: number): Promise<SubmissionRecord | null> {
    const record = this.submissions.get(id);
    if (!record) return null;
    assertTransition(record.status, to);
    if (isTerminalSubmissionStatus(to)) {
      record.executionToken = null;
      record.leaseUntilMs = null;
      record.completedAtMs = record.completedAtMs ?? nowMs;
    }
    // In-flight pre-claim statuses never hold a lease: QUEUED rows await the
    // first claim, JUDGE_RETRY rows await a retry claim after an infra
    // failure. A stale token would block either claim.
    if (to === "QUEUED" || to === "JUDGE_RETRY") {
      record.executionToken = null;
      record.leaseUntilMs = null;
    }
    if (to === "QUEUED") record.queuedAtMs = record.queuedAtMs ?? nowMs;
    record.status = to;
    record.updatedAtMs = nowMs;
    return record;
  }

  async resetForRejudge(id: SubmissionId, nowMs: number): Promise<SubmissionRecord | null> {
    const record = this.submissions.get(id);
    if (!record) return null;
    assertRejudgeTransition(record.status);
    record.status = "QUEUED";
    record.queuedAtMs = nowMs;
    record.executionToken = null;
    record.leaseUntilMs = null;
    record.updatedAtMs = nowMs;
    return record;
  }

  async markDispatchAttempt(id: SubmissionId, nowMs: number): Promise<void> {
    const record = this.submissions.get(id);
    if (!record) return;
    record.dispatchAttempts++;
    record.lastDispatchAtMs = nowMs;
    record.updatedAtMs = nowMs;
  }

  async listDispatchableSubmissions(beforeMs: number, limit: number): Promise<SubmissionRecord[]> {
    return [...this.submissions.values()]
      .filter(
        (record) =>
          (record.status === "CREATED" || record.status === "QUEUED" || record.status === "JUDGE_RETRY") &&
          (record.lastDispatchAtMs === null || record.lastDispatchAtMs <= beforeMs),
      )
      .sort((a, b) => a.createdAtMs - b.createdAtMs)
      .slice(0, limit);
  }

  // Attempts and per-test results -------------------------------------------

  async createJudgeAttempt(input: CreateJudgeAttemptInput): Promise<JudgeAttemptRecord> {
    const id = newJudgeAttemptId();
    const record: JudgeAttemptRecord = {
      id,
      submissionId: input.submissionId,
      attemptNumber: input.attemptNumber,
      executionToken: input.executionToken,
      sandboxId: null,
      status: "CLAIMED",
      infrastructureError: null,
      errorId: null,
      startedAtMs: input.nowMs,
      completedAtMs: null,
    };
    this.judgeAttempts.set(id, record);
    return record;
  }

  async updateJudgeAttempt(
    submissionId: SubmissionId,
    attemptNumber: number,
    patch: Partial<
      Pick<JudgeAttemptRecord, "status" | "sandboxId" | "infrastructureError" | "errorId" | "completedAtMs">
    >,
  ): Promise<JudgeAttemptRecord | null> {
    for (const attempt of this.judgeAttempts.values()) {
      if (attempt.submissionId === submissionId && attempt.attemptNumber === attemptNumber) {
        if (patch.status !== undefined && patch.status !== attempt.status) {
          if (!canJudgeAttemptTransition(attempt.status, patch.status)) {
            throw new Error(`Invalid judge attempt status transition: ${attempt.status} -> ${patch.status}`);
          }
        }
        Object.assign(attempt, patch);
        return attempt;
      }
    }
    return null;
  }

  async listJudgeAttempts(submissionId: SubmissionId): Promise<JudgeAttemptRecord[]> {
    return [...this.judgeAttempts.values()]
      .filter((a) => a.submissionId === submissionId)
      .sort((a, b) => a.attemptNumber - b.attemptNumber);
  }

  async saveTestResult(record: SubmissionTestResultRecord): Promise<void> {
    this.testResults.set(`${record.submissionId}:${record.testCaseId}`, record);
  }

  async saveBenchmarkRun(record: SubmissionBenchmarkRecord): Promise<void> {
    this.benchmarkRuns.set(`${record.submissionId}:${record.testCaseId}:${record.runNumber}`, record);
  }

  async listTestResults(submissionId: SubmissionId): Promise<SubmissionTestResultRecord[]> {
    return [...this.testResults.values()]
      .filter((r) => r.submissionId === submissionId)
      .sort((a, b) => a.testCaseId.localeCompare(b.testCaseId));
  }

  async listBenchmarkRuns(submissionId: SubmissionId): Promise<SubmissionBenchmarkRecord[]> {
    return [...this.benchmarkRuns.values()]
      .filter((r) => r.submissionId === submissionId)
      .sort((a, b) => a.testCaseId.localeCompare(b.testCaseId) || a.runNumber - b.runNumber);
  }

  async createAuditLog(input: {
    id: AuditLogId;
    actorId: string | null;
    actorRole: "PARTICIPANT" | "ADMIN" | "SYSTEM";
    action: string;
    subjectType: string;
    subjectId: string;
    detailJson: string | null;
    nowMs: number;
  }): Promise<AuditLogRecord> {
    const record: AuditLogRecord = {
      id: input.id,
      actorId: input.actorId,
      actorRole: input.actorRole,
      action: input.action,
      subjectType: input.subjectType,
      subjectId: input.subjectId,
      detailJson: input.detailJson,
      createdAtMs: input.nowMs,
    };
    this.auditLogs.set(record.id, record);
    return record;
  }

  async listAuditLogs(subjectType: string, subjectId: string): Promise<AuditLogRecord[]> {
    return [...this.auditLogs.values()]
      .filter((log) => log.subjectType === subjectType && log.subjectId === subjectId)
      .sort((a, b) => a.createdAtMs - b.createdAtMs);
  }
}

function versionKey(problemId: ProblemId, version: number): string {
  return `${problemId}#${version}`;
}

const DEFAULT_ALPHABET = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";

function randomSuffix(length: number): string {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  let out = "";
  for (const byte of bytes) out += DEFAULT_ALPHABET[byte % DEFAULT_ALPHABET.length]!;
  return out;
}
