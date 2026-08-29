/**
 * D1-backed Repository contract implementation for the Cloudflare runtime.
 * Runs under workerd (no node:child_process, no Bun): all state lives in the
 * D1 binding. row-mapping mirrors the schema in migrations/0001 and the
 * atomic lease/commit semantics of MemoryRepository.
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
import type {
  ComparatorPolicy,
  JudgeAttemptStatus,
  Role,
  SubmissionLanguage,
  SubmissionStatus,
  TestCaseKind,
} from "../domain/enums";
import { isTerminalSubmissionStatus } from "../domain/enums";
import {
  type ApiTokenId,
  type AuditLogId,
  asAuditLogId,
  asJudgeAttemptId,
  asParticipantId,
  asProblemId,
  asSubmissionId,
  asTestCaseId,
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

/**
 * Minimal structural D1 binding used by this adapter. The real binding shape
 * comes from @cloudflare/workers-types; the runtime matches structurally.
 */
export interface D1Like {
  prepare(sql: string): {
    bind(...params: unknown[]): D1Statement;
    all<T = Record<string, unknown>>(...args: unknown[]): Promise<{ results: T[] }>;
    first<T = Record<string, unknown>>(...args: unknown[]): Promise<T | null>;
    run(...args: unknown[]): Promise<{ meta: { changes: number } }>;
  };
}

interface D1Statement {
  first<T = Record<string, unknown>>(...args: unknown[]): Promise<T | null>;
  all<T = Record<string, unknown>>(...args: unknown[]): Promise<{ results: T[] }>;
  run(...args: unknown[]): Promise<{ meta: { changes: number } }>;
}

type Row = Record<string, unknown>;

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

function isoNullable(ms: number | null): string | null {
  return ms === null ? null : new Date(ms).toISOString();
}

function parseMs(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "number") return value;
  const t = Date.parse(String(value));
  return Number.isNaN(t) ? null : t;
}

const emptyString = (v: unknown): string => (v === null || v === undefined ? "" : String(v));
const nullableString = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));
const nullableNumber = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));

function asApiTokenIdRef(value: string): ApiTokenId {
  return value as ApiTokenId;
}

const randomSuffix = (length: number): string => {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  const alphabet = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  let out = "";
  for (const byte of bytes) out += alphabet[byte % alphabet.length]!;
  return out;
};

export class D1Repository implements Repository {
  private readonly db: D1Like;

  constructor(db: D1Like) {
    this.db = db;
  }

  // Participants and tokens -------------------------------------------------

  async findParticipantById(id: ParticipantId): Promise<ParticipantRecord | null> {
    const r = await this.db.prepare("SELECT * FROM participants WHERE id = ?").bind(id).first();
    return r ? this.mapParticipant(r) : null;
  }

  async listParticipants(): Promise<ParticipantRecord[]> {
    const { results } = await this.db.prepare("SELECT * FROM participants ORDER BY created_at").all();
    return results.map((r) => this.mapParticipant(r as Row));
  }

  async findTokenById(id: ApiTokenId): Promise<ApiTokenRecord | null> {
    const r = await this.db.prepare("SELECT * FROM api_tokens WHERE id = ?").bind(id).first();
    return r ? this.mapToken(r) : null;
  }

  async findTokenByHash(hash: string): Promise<ApiTokenRecord | null> {
    const r = await this.db.prepare("SELECT * FROM api_tokens WHERE token_hash = ?").bind(hash).first();
    return r ? this.mapToken(r) : null;
  }

  async revokeToken(id: ApiTokenId, nowMs: number): Promise<ApiTokenRecord | null> {
    await this.db.prepare("UPDATE api_tokens SET revoked_at = ? WHERE id = ?").bind(iso(nowMs), id).run();
    const refreshed = await this.findTokenById(id);
    return refreshed && refreshed.revokedAtMs !== null ? refreshed : null;
  }

  async createApiToken(input: {
    id: ApiTokenId;
    participantId: ParticipantId;
    tokenHash: string;
    role: Role;
    nowMs: number;
  }): Promise<ApiTokenRecord> {
    await this.db
      .prepare(
        "INSERT INTO api_tokens (id, participant_id, token_hash, role, revoked_at, created_at) VALUES (?, ?, ?, ?, NULL, ?)",
      )
      .bind(input.id, input.participantId, input.tokenHash, input.role, iso(input.nowMs))
      .run();
    const created = await this.findTokenById(input.id);
    if (!created) throw new Error("api token insert failed");
    return created;
  }

  async listTokens(): Promise<ApiTokenRecord[]> {
    const { results } = await this.db.prepare("SELECT * FROM api_tokens ORDER BY created_at").all();
    return results.map((r) => this.mapToken(r as Row));
  }

  private mapToken(r: Row): ApiTokenRecord {
    return {
      id: asApiTokenIdRef(emptyString(r.id)),
      participantId: r.participant_id === null ? null : asParticipantId(emptyString(r.participant_id)),
      tokenHash: emptyString(r.token_hash),
      role: r.role as ApiTokenRecord["role"],
      revokedAtMs: parseMs(r.revoked_at),
      createdAtMs: parseMs(r.created_at) ?? 0,
    };
  }

  private mapParticipant(r: Row): ParticipantRecord {
    return {
      id: asParticipantId(emptyString(r.id)),
      displayName: emptyString(r.display_name),
      status: r.status as ParticipantRecord["status"],
      createdAtMs: parseMs(r.created_at) ?? 0,
    };
  }

  // Problems and tests ------------------------------------------------------

  async findProblemById(id: ProblemId): Promise<ProblemRecord | null> {
    const r = await this.db.prepare("SELECT * FROM problems WHERE id = ?").bind(id).first();
    return r ? this.mapProblem(r) : null;
  }

  async findProblemBySlug(slug: string): Promise<ProblemRecord | null> {
    const r = await this.db.prepare("SELECT * FROM problems WHERE slug = ?").bind(slug).first();
    return r ? this.mapProblem(r) : null;
  }

  async listProblems(): Promise<ProblemRecord[]> {
    const { results } = await this.db.prepare("SELECT * FROM problems ORDER BY created_at").all();
    return results.map((r) => this.mapProblem(r as Row));
  }

  private mapProblem(r: Row): ProblemRecord {
    return {
      id: asProblemId(emptyString(r.id)),
      slug: emptyString(r.slug),
      title: emptyString(r.title),
      lifecycleState: r.lifecycle_state as ProblemRecord["lifecycleState"],
      activeVersion: r.active_version === null ? null : Number(r.active_version),
      limits: {
        timeLimitMs: Number(r.time_limit_ms),
        memoryLimitKb: Number(r.memory_limit_kb),
        outputLimitBytes: Number(r.output_limit_bytes),
        compileTimeLimitMs: Number(r.compile_time_limit_ms),
        compileOutputLimitBytes: Number(r.compile_output_limit_bytes),
      },
      createdAtMs: parseMs(r.created_at) ?? 0,
      updatedAtMs: parseMs(r.updated_at) ?? 0,
    };
  }

  async findProblemVersion(problemId: ProblemId, version: number): Promise<ProblemVersionRecord | null> {
    const r = await this.db
      .prepare("SELECT * FROM problem_versions WHERE problem_id = ? AND version = ?")
      .bind(problemId, version)
      .first();
    return r ? this.mapProblemVersion(r) : null;
  }

  async listProblemVersions(problemId: ProblemId): Promise<ProblemVersionRecord[]> {
    const { results } = await this.db
      .prepare("SELECT * FROM problem_versions WHERE problem_id = ? ORDER BY version")
      .bind(problemId)
      .all();
    return results.map((r) => this.mapProblemVersion(r as Row));
  }

  private mapProblemVersion(r: Row): ProblemVersionRecord {
    return {
      problemId: asProblemId(emptyString(r.problem_id)),
      version: Number(r.version),
      languagePolicy: emptyString(r.language_policy),
      compilerImageVersion: emptyString(r.compiler_image_version),
      comparatorVersion: emptyString(r.comparator_version),
      runnerImageVersion: emptyString(r.runner_image_version),
      limits: {
        timeLimitMs: Number(r.time_limit_ms),
        memoryLimitKb: Number(r.memory_limit_kb),
        outputLimitBytes: Number(r.output_limit_bytes),
        compileTimeLimitMs: Number(r.compile_time_limit_ms),
        compileOutputLimitBytes: Number(r.compile_output_limit_bytes),
      },
      createdAtMs: parseMs(r.created_at) ?? 0,
    };
  }

  async findTestCaseById(id: TestCaseId): Promise<TestCaseRecord | null> {
    const r = await this.db.prepare("SELECT * FROM test_cases WHERE id = ?").bind(id).first();
    return r ? this.mapTestCase(r) : null;
  }

  async listTestCases(problemId: ProblemId, version: number): Promise<TestCaseRecord[]> {
    const { results } = await this.db
      .prepare("SELECT * FROM test_cases WHERE problem_id = ? AND problem_version = ? ORDER BY kind DESC, ordinal ASC")
      .bind(problemId, version)
      .all();
    return results.map((r) => this.mapTestCase(r as Row));
  }

  private mapTestCase(r: Row): TestCaseRecord {
    return {
      id: asTestCaseId(emptyString(r.id)),
      problemId: asProblemId(emptyString(r.problem_id)),
      problemVersion: Number(r.problem_version),
      kind: r.kind as TestCaseKind,
      ordinal: Number(r.ordinal),
      inputR2Key: emptyString(r.input_r2_key),
      expectedR2Key: emptyString(r.expected_r2_key),
      comparator: r.comparator as TestCaseRecord["comparator"],
      weight: Number(r.weight),
      inputSha256: nullableString(r.input_sha256),
      expectedSha256: nullableString(r.expected_sha256),
    };
  }

  // Submissions -------------------------------------------------------------

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
    await this.db
      .prepare(
        `INSERT INTO problems (id, slug, title, lifecycle_state, active_version, time_limit_ms, memory_limit_kb, output_limit_bytes, compile_time_limit_ms, compile_output_limit_bytes, created_at, updated_at)
         VALUES (?, ?, ?, 'DRAFT', NULL, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        input.id,
        input.slug,
        input.title,
        input.timeLimitMs,
        input.memoryLimitKb,
        input.outputLimitBytes,
        input.compileTimeLimitMs,
        input.compileOutputLimitBytes,
        iso(input.nowMs),
        iso(input.nowMs),
      )
      .run();
    const created = await this.findProblemById(input.id);
    if (!created) throw new Error("problem insert failed");
    return created;
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
    await this.db
      .prepare(
        `INSERT INTO problem_versions (problem_id, version, language_policy, compiler_image_version, comparator_version, runner_image_version,
           time_limit_ms, memory_limit_kb, output_limit_bytes, compile_time_limit_ms, compile_output_limit_bytes, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        input.problemId,
        input.version,
        input.languagePolicy,
        input.compilerImageVersion,
        input.comparatorVersion,
        input.runnerImageVersion,
        input.limits.timeLimitMs,
        input.limits.memoryLimitKb,
        input.limits.outputLimitBytes,
        input.limits.compileTimeLimitMs,
        input.limits.compileOutputLimitBytes,
        iso(input.nowMs),
      )
      .run();
    const created = await this.findProblemVersion(input.problemId, input.version);
    if (!created) throw new Error("problem version insert failed");
    return created;
  }

  async activateProblemVersion(problemId: ProblemId, version: number, nowMs: number): Promise<ProblemRecord | null> {
    const result = await this.db
      .prepare(
        `UPDATE problems SET lifecycle_state='ACTIVE', active_version=?, updated_at=?
         WHERE id=? AND EXISTS (
           SELECT 1 FROM problem_versions WHERE problem_id=? AND version=?
         )`,
      )
      .bind(version, iso(nowMs), problemId, problemId, version)
      .run();
    if (result.meta.changes !== 1) return null;
    return this.findProblemById(problemId);
  }

  async updateProblem(
    problemId: ProblemId,
    patch: { title?: string; timeLimitMs?: number; memoryLimitKb?: number; outputLimitBytes?: number },
    nowMs: number,
  ): Promise<ProblemRecord | null> {
    const current = await this.findProblemById(problemId);
    if (!current) return null;
    await this.db
      .prepare(
        `UPDATE problems SET title = ?, time_limit_ms = ?, memory_limit_kb = ?, output_limit_bytes = ?, updated_at = ? WHERE id = ?`,
      )
      .bind(
        patch.title ?? current.title,
        patch.timeLimitMs ?? current.limits.timeLimitMs,
        patch.memoryLimitKb ?? current.limits.memoryLimitKb,
        patch.outputLimitBytes ?? current.limits.outputLimitBytes,
        iso(nowMs),
        problemId,
      )
      .run();
    return this.findProblemById(problemId);
  }

  async closeProblem(problemId: ProblemId, nowMs: number): Promise<ProblemRecord | null> {
    const result = await this.db
      .prepare(
        "UPDATE problems SET lifecycle_state = 'CLOSED', updated_at = ? WHERE id = ? AND lifecycle_state = 'ACTIVE'",
      )
      .bind(iso(nowMs), problemId)
      .run();
    return result.meta.changes === 1 ? this.findProblemById(problemId) : null;
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
    await this.db
      .prepare(
        `INSERT INTO test_cases (id, problem_id, problem_version, kind, ordinal, input_r2_key, expected_r2_key, comparator, weight, input_sha256, expected_sha256)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        input.id,
        input.problemId,
        input.problemVersion,
        input.kind,
        input.ordinal,
        input.inputR2Key,
        input.expectedR2Key,
        input.comparator,
        input.weight,
        input.inputSha256,
        input.expectedSha256,
      )
      .run();
    const created = await this.findTestCaseById(input.id);
    if (!created) throw new Error("test case insert failed");
    return created;
  }

  async listSubmissionsByProblem(problemId: ProblemId): Promise<SubmissionRecord[]> {
    const { results } = await this.db.prepare("SELECT * FROM submissions WHERE problem_id = ?").bind(problemId).all();
    return results.map((r) => this.mapSubmission(r as Row));
  }

  async createSubmission(input: CreateSubmissionInput): Promise<SubmissionRecord> {
    const problem = await this.findProblemById(input.problemId);
    if (!problem) throw new Error(`Unknown problem: ${input.problemId}`);
    if (problem.lifecycleState !== "ACTIVE" || problem.activeVersion === null) {
      throw new Error(`Problem is not ACTIVE: ${input.problemId}`);
    }
    const id = asSubmissionId(`sub_${randomSuffix(16)}`);
    const now = iso(input.nowMs);
    await this.db
      .prepare(
        `INSERT INTO submissions (id, participant_id, problem_id, problem_version, language, source_r2_key, source_sha256, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'CREATED', ?, ?)`,
      )
      .bind(
        id,
        input.participantId,
        input.problemId,
        problem.activeVersion,
        input.language,
        input.sourceR2Key,
        input.sourceSha256,
        now,
        now,
      )
      .run();
    const created = await this.findSubmissionById(id);
    if (!created) throw new Error("submission insert failed");
    return created;
  }

  async consumeSubmissionRateLimit(
    participantId: ParticipantId,
    nowMs: number,
    limit: number,
    windowMs: number,
  ): Promise<boolean> {
    const bucketStartMs = Math.floor(nowMs / windowMs) * windowMs;
    const result = await this.db
      .prepare(
        `INSERT INTO submission_rate_limits (participant_id, window_ms, bucket_start_ms, request_count, updated_at)
         VALUES (?, ?, ?, 1, ?)
         ON CONFLICT(participant_id, window_ms, bucket_start_ms) DO UPDATE
         SET request_count = request_count + 1, updated_at = excluded.updated_at
         WHERE request_count < ?`,
      )
      .bind(participantId, windowMs, bucketStartMs, iso(nowMs), limit)
      .run();
    return result.meta.changes === 1;
  }

  async findSubmissionById(id: SubmissionId): Promise<SubmissionRecord | null> {
    const r = await this.db.prepare("SELECT * FROM submissions WHERE id = ?").bind(id).first();
    return r ? this.mapSubmission(r) : null;
  }

  async listSubmissions(filter: SubmissionListFilter, _cursor: string | null, limit: number): Promise<SubmissionList> {
    const pageSize = Math.min(Math.max(1, limit), SUBMISSION_LIST_MAX_PAGE_SIZE);
    const clauses: string[] = [];
    const params: unknown[] = [];
    if (filter.participantId !== undefined) {
      clauses.push("participant_id = ?");
      params.push(filter.participantId);
    }
    if (filter.problemId !== undefined) {
      clauses.push("problem_id = ?");
      params.push(filter.problemId);
    }
    if (filter.status !== undefined) {
      clauses.push("status = ?");
      params.push(filter.status);
    }
    const where = clauses.length > 0 ? ` WHERE ${clauses.join(" AND ")}` : "";
    // Newest first, then id desc, matching MemoryRepository ordering.
    const { results } = await this.db
      .prepare(`SELECT * FROM submissions${where} ORDER BY created_at DESC, id DESC LIMIT ?`)
      .bind(...params, pageSize + 1)
      .all();
    const hasMore = results.length > pageSize;
    const items = results.slice(0, pageSize).map((r) => this.mapSubmission(r as Row));
    return { items, nextCursor: hasMore ? (items.at(-1)?.id ?? null) : null };
  }

  async claimExecution(request: ClaimRequest): Promise<ClaimOutcome> {
    const record = await this.findSubmissionById(request.submissionId);
    if (!record) return { ok: false, reason: "MISSING", submissionId: request.submissionId };
    if (isTerminalSubmissionStatus(record.status)) {
      return { ok: false, reason: "TERMINAL", submissionId: request.submissionId };
    }
    if (record.status === "RUNNING" && record.leaseUntilMs !== null && record.leaseUntilMs > request.nowMs) {
      return { ok: false, reason: "LEASE_VALID", submissionId: request.submissionId };
    }
    assertTransition(record.status, "RUNNING");
    const attemptNumber = record.attemptCount + 1;
    const now = iso(request.nowMs);
    const lease = iso(request.leaseUntilMs);
    // Claim predicate per backend 11:395: a QUEUED row (or an expired-lease
    // RUNNING row) may be claimed with a fresh token. An expired RUNNING row
    // still carries its old execution_token, so the claim must NOT depend on
    // execution_token being NULL (that predicate made dead-worker recovery
    // impossible on D1 while the memory repo recovered fine).
    await this.db
      .prepare(
        `UPDATE submissions SET status='RUNNING', execution_token=?, lease_until=?, attempt_count=?,
           started_at=COALESCE(started_at, ?), updated_at=?
         WHERE id=? AND (status IN ('CREATED','QUEUED','JUDGE_RETRY') OR (status='RUNNING' AND lease_until < ?))`,
      )
      .bind(request.executionToken, lease, attemptNumber, now, now, request.submissionId, iso(request.nowMs))
      .run();
    const refreshed = await this.findSubmissionById(request.submissionId);
    if (!refreshed || refreshed.executionToken !== request.executionToken) {
      return { ok: false, reason: "LEASE_VALID", submissionId: request.submissionId };
    }
    return { ok: true, attemptNumber, status: "RUNNING" };
  }

  async submitResult(request: SubmitResultRequest): Promise<SubmitResultOutcome> {
    const record = await this.findSubmissionById(request.submissionId);
    if (!record) return "MISSING";
    const decision = evaluateResultCommit({ status: record.status, executionToken: record.executionToken }, request);
    if (decision !== "COMMITTED") return decision;
    if (!isTerminalSubmissionStatus(request.status)) {
      throw new Error(`submitResult requires a terminal status, got ${request.status}`);
    }
    assertTransition(record.status, request.status);
    const now = iso(request.nowMs);
    await this.db
      .prepare(
        `UPDATE submissions SET status=?, execution_token=NULL, lease_until=NULL,
           compile_log_r2_key=COALESCE(?, compile_log_r2_key),
           passed_tests=COALESCE(?, passed_tests), total_tests=COALESCE(?, total_tests),
           performance_score_ns=COALESCE(?, performance_score_ns), peak_memory_kb=COALESCE(?, peak_memory_kb),
           error_id=COALESCE(?, error_id),
           completed_at=?, updated_at=? WHERE id=? AND execution_token=?`,
      )
      .bind(
        request.status,
        request.compileLogR2Key ?? null,
        request.passedTests ?? null,
        request.totalTests ?? null,
        request.performanceScoreNs ?? null,
        request.peakMemoryKb ?? null,
        request.errorId ?? null,
        now,
        now,
        request.submissionId,
        request.executionToken,
      )
      .run();
    const refreshed = await this.findSubmissionById(request.submissionId);
    return refreshed && refreshed.status === request.status ? "COMMITTED" : "STALE_TOKEN";
  }

  async setSubmissionStatus(id: SubmissionId, to: SubmissionStatus, nowMs: number): Promise<SubmissionRecord | null> {
    const record = await this.findSubmissionById(id);
    if (!record) return null;
    assertTransition(record.status, to);
    const now = iso(nowMs);
    const completed = isTerminalSubmissionStatus(to) ? now : null;
    // In-flight pre-claim statuses never hold a lease: QUEUED awaits the
    // first claim, JUDGE_RETRY awaits a retry claim after an infra failure.
    // A stale token would block either claim on D1.
    const clearLease = to === "QUEUED" || to === "JUDGE_RETRY" ? 1 : 0;
    await this.db
      .prepare(
        `UPDATE submissions SET status=?, updated_at=?, completed_at=COALESCE(?, completed_at),
           execution_token=CASE WHEN ? = 1 THEN NULL ELSE execution_token END,
           lease_until=CASE WHEN ? = 1 THEN NULL ELSE lease_until END,
           queued_at=CASE WHEN queued_at IS NULL THEN ? ELSE queued_at END WHERE id=?`,
      )
      .bind(to, now, completed, clearLease, clearLease, to === "QUEUED" ? now : null, id)
      .run();
    return this.findSubmissionById(id);
  }

  async resetForRejudge(id: SubmissionId, nowMs: number): Promise<SubmissionRecord | null> {
    const record = await this.findSubmissionById(id);
    if (!record) return null;
    assertRejudgeTransition(record.status);
    const now = iso(nowMs);
    await this.db
      .prepare(
        `UPDATE submissions SET status='QUEUED', execution_token=NULL, lease_until=NULL,
           completed_at=NULL, queued_at=?, updated_at=? WHERE id=?`,
      )
      .bind(now, now, id)
      .run();
    return this.findSubmissionById(id);
  }

  async markDispatchAttempt(id: SubmissionId, nowMs: number): Promise<void> {
    const now = iso(nowMs);
    await this.db
      .prepare(
        "UPDATE submissions SET dispatch_attempts=dispatch_attempts+1, last_dispatch_at=?, updated_at=? WHERE id=?",
      )
      .bind(now, now, id)
      .run();
  }

  async listDispatchableSubmissions(beforeMs: number, limit: number): Promise<SubmissionRecord[]> {
    const { results } = await this.db
      .prepare(
        `SELECT * FROM submissions
         WHERE status IN ('CREATED','QUEUED','JUDGE_RETRY')
           AND (last_dispatch_at IS NULL OR last_dispatch_at <= ?)
         ORDER BY created_at ASC LIMIT ?`,
      )
      .bind(iso(beforeMs), Math.max(1, Math.min(limit, 1000)))
      .all();
    return results.map((row) => this.mapSubmission(row as Row));
  }

  private mapSubmission(r: Row): SubmissionRecord {
    return {
      id: asSubmissionId(emptyString(r.id)),
      participantId: asParticipantId(emptyString(r.participant_id)),
      problemId: asProblemId(emptyString(r.problem_id)),
      problemVersion: Number(r.problem_version),
      language: emptyString(r.language) as SubmissionLanguage,
      sourceR2Key: emptyString(r.source_r2_key),
      sourceSha256: emptyString(r.source_sha256),
      status: r.status as SubmissionStatus,
      attemptCount: Number(r.attempt_count),
      executionToken: nullableString(r.execution_token),
      leaseUntilMs: parseMs(r.lease_until),
      dispatchAttempts: Number(r.dispatch_attempts),
      lastDispatchAtMs: parseMs(r.last_dispatch_at),
      compilerVersion: nullableString(r.compiler_version),
      compilerFlags: nullableString(r.compiler_flags),
      runnerImageVersion: nullableString(r.runner_image_version),
      compileLogR2Key: nullableString(r.compile_log_r2_key),
      errorId: nullableString(r.error_id),
      passedTests: nullableNumber(r.passed_tests),
      totalTests: nullableNumber(r.total_tests),
      performanceScoreNs: nullableNumber(r.performance_score_ns),
      peakMemoryKb: nullableNumber(r.peak_memory_kb),
      createdAtMs: parseMs(r.created_at) ?? 0,
      queuedAtMs: parseMs(r.queued_at),
      startedAtMs: parseMs(r.started_at),
      completedAtMs: parseMs(r.completed_at),
      updatedAtMs: parseMs(r.updated_at) ?? 0,
    };
  }

  // Attempts and per-test results -------------------------------------------

  async createJudgeAttempt(input: CreateJudgeAttemptInput): Promise<JudgeAttemptRecord> {
    const id = newJudgeAttemptId();
    const now = iso(input.nowMs);
    await this.db
      .prepare(
        `INSERT INTO judge_attempts (submission_id, attempt_number, execution_token, status, started_at)
         VALUES (?, ?, ?, 'CLAIMED', ?)`,
      )
      .bind(input.submissionId, input.attemptNumber, input.executionToken, now)
      .run();
    return {
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
  }

  async updateJudgeAttempt(
    submissionId: SubmissionId,
    attemptNumber: number,
    patch: Partial<
      Pick<JudgeAttemptRecord, "status" | "sandboxId" | "infrastructureError" | "errorId" | "completedAtMs">
    >,
  ): Promise<JudgeAttemptRecord | null> {
    const current = await this.findJudgeAttempt(submissionId, attemptNumber);
    if (!current) return null;
    if (patch.status !== undefined && patch.status !== current.status) {
      if (!canJudgeAttemptTransition(current.status, patch.status)) {
        throw new Error(`Invalid judge attempt status transition: ${current.status} -> ${patch.status}`);
      }
    }
    const sets: string[] = [];
    const params: unknown[] = [];
    const set = (column: string, value: unknown): void => {
      sets.push(`${column} = ?`);
      params.push(value);
    };
    if (patch.status !== undefined) set("status", patch.status);
    if (patch.sandboxId !== undefined) set("sandbox_id", patch.sandboxId);
    if (patch.infrastructureError !== undefined) set("infrastructure_error", patch.infrastructureError);
    if (patch.errorId !== undefined) set("error_id", patch.errorId);
    if (patch.completedAtMs !== undefined) set("completed_at", isoNullable(patch.completedAtMs));
    if (sets.length === 0) return current;
    params.push(submissionId, attemptNumber);
    await this.db
      .prepare(`UPDATE judge_attempts SET ${sets.join(", ")} WHERE submission_id=? AND attempt_number=?`)
      .bind(...params)
      .run();
    return this.findJudgeAttempt(submissionId, attemptNumber);
  }

  async listJudgeAttempts(submissionId: SubmissionId): Promise<JudgeAttemptRecord[]> {
    const { results } = await this.db
      .prepare("SELECT * FROM judge_attempts WHERE submission_id = ? ORDER BY attempt_number")
      .bind(submissionId)
      .all();
    return results.map((r) => this.mapJudgeAttempt(r as Row));
  }

  private async findJudgeAttempt(
    submissionId: SubmissionId,
    attemptNumber: number,
  ): Promise<JudgeAttemptRecord | null> {
    const r = await this.db
      .prepare("SELECT * FROM judge_attempts WHERE submission_id = ? AND attempt_number = ?")
      .bind(submissionId, attemptNumber)
      .first();
    return r ? this.mapJudgeAttempt(r as Row) : null;
  }

  private mapJudgeAttempt(r: Row): JudgeAttemptRecord {
    return {
      id: asJudgeAttemptId(`${emptyString(r.submission_id)}#${Number(r.attempt_number)}`),
      submissionId: asSubmissionId(emptyString(r.submission_id)),
      attemptNumber: Number(r.attempt_number),
      executionToken: emptyString(r.execution_token),
      sandboxId: nullableString(r.sandbox_id),
      status: r.status as JudgeAttemptStatus,
      infrastructureError: nullableString(r.infrastructure_error),
      errorId: nullableString(r.error_id),
      startedAtMs: parseMs(r.started_at) ?? 0,
      completedAtMs: parseMs(r.completed_at),
    };
  }

  async saveTestResult(record: SubmissionTestResultRecord): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO submission_test_results
           (submission_id, test_case_id, status, cpu_time_ns, wall_time_ns, peak_memory_kb, exit_code, signal)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(submission_id, test_case_id) DO UPDATE SET
           status=excluded.status, cpu_time_ns=excluded.cpu_time_ns, wall_time_ns=excluded.wall_time_ns,
           peak_memory_kb=excluded.peak_memory_kb, exit_code=excluded.exit_code, signal=excluded.signal`,
      )
      .bind(
        record.submissionId,
        record.testCaseId,
        record.status,
        record.cpuTimeNs,
        record.wallTimeNs,
        record.peakMemoryKb,
        record.exitCode,
        record.signal,
      )
      .run();
  }

  async saveBenchmarkRun(record: SubmissionBenchmarkRecord): Promise<void> {
    await this.db
      .prepare(
        `INSERT OR REPLACE INTO submission_benchmarks
           (submission_id, test_case_id, run_number, cpu_time_ns, wall_time_ns, peak_memory_kb)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        record.submissionId,
        record.testCaseId,
        record.runNumber,
        record.cpuTimeNs,
        record.wallTimeNs,
        record.peakMemoryKb,
      )
      .run();
  }

  async listTestResults(submissionId: SubmissionId): Promise<SubmissionTestResultRecord[]> {
    const { results } = await this.db
      .prepare("SELECT * FROM submission_test_results WHERE submission_id = ? ORDER BY test_case_id")
      .bind(submissionId)
      .all();
    return results.map((r) => this.mapTestResult(r as Row));
  }

  async listBenchmarkRuns(submissionId: SubmissionId): Promise<SubmissionBenchmarkRecord[]> {
    const { results } = await this.db
      .prepare("SELECT * FROM submission_benchmarks WHERE submission_id = ? ORDER BY test_case_id, run_number")
      .bind(submissionId)
      .all();
    return results.map((r) => this.mapBenchmarkRun(r as Row));
  }

  private mapTestResult(r: Row): SubmissionTestResultRecord {
    return {
      submissionId: asSubmissionId(emptyString(r.submission_id)),
      testCaseId: asTestCaseId(emptyString(r.test_case_id)),
      status: r.status as SubmissionTestResultRecord["status"],
      cpuTimeNs: nullableNumber(r.cpu_time_ns),
      wallTimeNs: nullableNumber(r.wall_time_ns),
      peakMemoryKb: nullableNumber(r.peak_memory_kb),
      exitCode: nullableNumber(r.exit_code),
      signal: nullableNumber(r.signal),
    };
  }

  private mapBenchmarkRun(r: Row): SubmissionBenchmarkRecord {
    return {
      submissionId: asSubmissionId(emptyString(r.submission_id)),
      testCaseId: asTestCaseId(emptyString(r.test_case_id)),
      runNumber: Number(r.run_number),
      cpuTimeNs: Number(r.cpu_time_ns),
      wallTimeNs: Number(r.wall_time_ns),
      peakMemoryKb: Number(r.peak_memory_kb),
    };
  }

  async createAuditLog(input: {
    id: AuditLogId;
    actorId: string | null;
    actorRole: Role | "SYSTEM";
    action: string;
    subjectType: string;
    subjectId: string;
    detailJson: string | null;
    nowMs: number;
  }): Promise<AuditLogRecord> {
    await this.db
      .prepare(
        `INSERT INTO audit_log (id, actor_id, actor_role, action, subject_type, subject_id, detail_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        input.id,
        input.actorId,
        input.actorRole,
        input.action,
        input.subjectType,
        input.subjectId,
        input.detailJson,
        iso(input.nowMs),
      )
      .run();
    return {
      id: input.id,
      actorId: input.actorId,
      actorRole: input.actorRole,
      action: input.action,
      subjectType: input.subjectType,
      subjectId: input.subjectId,
      detailJson: input.detailJson,
      createdAtMs: input.nowMs,
    };
  }

  async listAuditLogs(subjectType: string, subjectId: string): Promise<AuditLogRecord[]> {
    const { results } = await this.db
      .prepare("SELECT * FROM audit_log WHERE subject_type = ? AND subject_id = ? ORDER BY created_at")
      .bind(subjectType, subjectId)
      .all();
    return results.map((r) => this.mapAuditLog(r as Row));
  }

  private mapAuditLog(r: Row): AuditLogRecord {
    return {
      id: asAuditLogId(emptyString(r.id)),
      actorId: nullableString(r.actor_id),
      actorRole: emptyString(r.actor_role) as AuditLogRecord["actorRole"],
      action: emptyString(r.action),
      subjectType: emptyString(r.subject_type),
      subjectId: emptyString(r.subject_id),
      detailJson: nullableString(r.detail_json),
      createdAtMs: parseMs(r.created_at) ?? 0,
    };
  }
}
