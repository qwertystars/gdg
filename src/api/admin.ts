/**
 * Admin routes: problem lifecycle (create/version/tests/activate/patch),
 * submission rejudge, and judge-error inspection. Every route is
 * admin-only (business-logic section 59).
 *
 * The repository contract is read-only for mutation (create/update go
 * through D1-style methods in the Cloudflare deployment), so the local
 * in-memory repository is accessed through its concrete map surface here.
 */

import { createHash, randomBytes } from "node:crypto";
import type { Context } from "hono";
import { Hono } from "hono";
import type { ComparatorPolicy, Role, TestCaseKind } from "../domain/enums";
import {
  asApiTokenId,
  asParticipantId,
  asProblemId,
  asSubmissionId,
  newApiTokenId,
  newAuditLogId,
  newProblemId,
  newTestCaseId,
} from "../domain/ids";
import { TEST_INPUT_R2_PREFIX } from "../domain/seed";
import { isSubmissionLanguage, SUPPORTED_LANGUAGES } from "../judge/languages";
import type { ArtifactStore } from "../storage/artifact-store";
import type { Repository } from "../storage/repository";
import { participantIdOf, requireAdmin, requireAuth } from "./auth";
import { ApiError } from "./errors";
import type { SubmissionQueue } from "./queue-adapter";

export interface AdminRouteDeps {
  repo: Repository;
  queue: SubmissionQueue;
  artifacts: ArtifactStore;
  nowMs?: () => number;
}

interface LimitsInput {
  timeLimitMs: number;
  memoryLimitKb: number;
  outputLimitBytes: number;
}

async function parseJson(c: Context): Promise<Record<string, unknown>> {
  const raw = JSON.parse(await c.req.text()) as unknown;
  if (typeof raw !== "object" || raw === null) throw new ApiError(400, "request body must be an object");
  return raw as Record<string, unknown>;
}

function parseLimits(fields: Record<string, unknown>): LimitsInput {
  const limits = fields.limits;
  if (typeof limits !== "object" || limits === null) throw new ApiError(400, "limits required");
  const record = limits as Record<string, unknown>;
  if (typeof record.timeLimitMs !== "number") throw new ApiError(400, "limits.timeLimitMs required");
  if (typeof record.memoryLimitKb !== "number") throw new ApiError(400, "limits.memoryLimitKb required");
  if (typeof record.outputLimitBytes !== "number") throw new ApiError(400, "limits.outputLimitBytes required");
  return {
    timeLimitMs: record.timeLimitMs,
    memoryLimitKb: record.memoryLimitKb,
    outputLimitBytes: record.outputLimitBytes,
  };
}

export function adminRoutes(deps: AdminRouteDeps): Hono {
  const app = new Hono();
  const repo = deps.repo;

  app.use("*", async (c, next) => {
    const auth = await requireAuth(c, repo);
    requireAdmin(auth);
    await next();
  });

  app.post("/problems", async (c) => {
    const auth = await requireAuth(c, repo);
    const fields = await parseJson(c);
    if (typeof fields.slug !== "string" || typeof fields.title !== "string") {
      throw new ApiError(400, "slug and title required");
    }
    const limits = parseLimits(fields);
    const nowMs = deps.nowMs?.() ?? Date.now();
    const problemId = newProblemId();
    await repo.createProblem({
      id: problemId,
      slug: fields.slug,
      title: fields.title,
      timeLimitMs: limits.timeLimitMs,
      memoryLimitKb: limits.memoryLimitKb,
      outputLimitBytes: limits.outputLimitBytes,
      compileTimeLimitMs: 10_000,
      compileOutputLimitBytes: 262_144,
      nowMs,
    });
    await repo.createAuditLog({
      id: newAuditLogId(),
      actorId: participantIdOf(auth),
      actorRole: auth.token.role,
      action: "PROBLEM_CREATE",
      subjectType: "PROBLEM",
      subjectId: problemId,
      detailJson: JSON.stringify({ slug: fields.slug, title: fields.title }),
      nowMs,
    });
    return c.json({ problemId, lifecycleState: "DRAFT" }, 201);
  });

  app.patch("/problems/:problemId", async (c) => {
    const problem = await repo.findProblemById(asProblemId(c.req.param("problemId")));
    if (problem === null) throw new ApiError(404, "problem not found");
    const fields = await parseJson(c);
    const nowMs = deps.nowMs?.() ?? Date.now();
    if (typeof fields.title === "string") problem.title = fields.title;
    const limits = fields.limits;
    if (typeof limits === "object" && limits !== null) {
      const record = limits as Record<string, unknown>;
      if (typeof record.timeLimitMs === "number") problem.limits.timeLimitMs = record.timeLimitMs;
      if (typeof record.memoryLimitKb === "number") problem.limits.memoryLimitKb = record.memoryLimitKb;
      if (typeof record.outputLimitBytes === "number") problem.limits.outputLimitBytes = record.outputLimitBytes;
    }
    problem.updatedAtMs = nowMs;
    return c.json({
      id: problem.id,
      slug: problem.slug,
      title: problem.title,
      lifecycleState: problem.lifecycleState,
      activeVersion: problem.activeVersion,
      limits: problem.limits,
    });
  });

  app.post("/problems/:problemId/versions", async (c) => {
    const auth = await requireAuth(c, repo);
    const problem = await repo.findProblemById(asProblemId(c.req.param("problemId")));
    if (problem === null) throw new ApiError(404, "problem not found");
    const fields = await parseJson(c);
    const version = fields.version;
    if (typeof version !== "number") throw new ApiError(400, "version required");
    const requestedLanguages = fields.languages ?? SUPPORTED_LANGUAGES;
    if (
      !Array.isArray(requestedLanguages) ||
      requestedLanguages.length === 0 ||
      !requestedLanguages.every((language) => typeof language === "string" && isSubmissionLanguage(language))
    ) {
      throw new ApiError(400, "languages must be a non-empty array of supported language ids");
    }
    const existing = await repo.findProblemVersion(problem.id, version);
    if (existing !== null) throw new ApiError(409, "version already exists");
    const nowMs = deps.nowMs?.() ?? Date.now();
    await repo.createProblemVersion({
      problemId: problem.id,
      version,
      languagePolicy: requestedLanguages.join(","),
      compilerImageVersion: "gcc-12_python3_nodejs",
      comparatorVersion: "normalized-v1",
      runnerImageVersion: "judge-runner-v1",
      limits: { ...problem.limits },
      nowMs,
    });
    await repo.createAuditLog({
      id: newAuditLogId(),
      actorId: participantIdOf(auth),
      actorRole: auth.token.role,
      action: "PROBLEM_VERSION_CREATE",
      subjectType: "PROBLEM",
      subjectId: problem.id,
      detailJson: JSON.stringify({ version }),
      nowMs,
    });
    return c.json({ problemId: problem.id, version, languages: requestedLanguages }, 201);
  });

  app.post("/problems/:problemId/versions/:version/tests", async (c) => {
    const auth = await requireAuth(c, repo);
    const problem = await repo.findProblemById(asProblemId(c.req.param("problemId")));
    if (problem === null) throw new ApiError(404, "problem not found");
    const version = Number(c.req.param("version"));
    const versionRecord = await repo.findProblemVersion(problem.id, version);
    if (versionRecord === null) throw new ApiError(404, "problem version not found");
    // Frozen-versioning guard (business-logic section 6): the ACTIVE version's
    // hidden tests are immutable once live; changing them would silently alter
    // the contest problem. New tests must go to a new version.
    if (problem.lifecycleState === "ACTIVE" && problem.activeVersion === version) {
      throw new ApiError(409, "the active version is frozen; upload tests to a new version");
    }
    const fields = await parseJson(c);
    const tests = fields.tests;
    if (!Array.isArray(tests)) throw new ApiError(400, "tests array required");
    for (const item of tests) {
      if (typeof item !== "object" || item === null) throw new ApiError(400, "invalid test entry");
      const record = item as Record<string, unknown>;
      if (typeof record.kind !== "string" || typeof record.ordinal !== "number") {
        throw new ApiError(400, "test kind and ordinal required");
      }
      if (typeof record.input !== "string" || typeof record.expected !== "string") {
        throw new ApiError(400, "test input and expected required");
      }
      const kind = record.kind as TestCaseKind;
      if (kind !== "CORRECTNESS" && kind !== "BENCHMARK") throw new ApiError(400, "invalid test kind");
      const comparator = (record.comparator ?? "NORMALIZED") as ComparatorPolicy;
      const weight = typeof record.weight === "number" ? record.weight : 1;
      const file = String(record.ordinal).padStart(3, "0");
      const inputR2Key = `${TEST_INPUT_R2_PREFIX}/${problem.id}/v${version}/${kind === "CORRECTNESS" ? "tests" : "benchmarks"}/${file}.in`;
      const expectedR2Key = `${TEST_INPUT_R2_PREFIX}/${problem.id}/v${version}/${kind === "CORRECTNESS" ? "tests" : "benchmarks"}/${file}.out`;
      await deps.artifacts.write(inputR2Key, record.input);
      await deps.artifacts.write(expectedR2Key, record.expected);
      // Test integrity (business-logic section 80): hash the exact artifact
      // bytes at upload so later tampering is detectable; the hash is stored
      // with the row, never the hidden content.
      const testCaseId = newTestCaseId();
      await repo.createTestCase({
        id: testCaseId,
        problemId: problem.id,
        problemVersion: version,
        kind,
        ordinal: record.ordinal,
        inputR2Key,
        expectedR2Key,
        comparator,
        weight,
        inputSha256: createHash("sha256").update(record.input, "utf8").digest("hex"),
        expectedSha256: createHash("sha256").update(record.expected, "utf8").digest("hex"),
      });
    }
    const nowMs = deps.nowMs?.() ?? Date.now();
    await repo.createAuditLog({
      id: newAuditLogId(),
      actorId: participantIdOf(auth),
      actorRole: auth.token.role,
      action: "TEST_UPLOAD",
      subjectType: "PROBLEM",
      subjectId: problem.id,
      detailJson: JSON.stringify({ version, count: tests.length }),
      nowMs,
    });
    return c.json({ problemId: problem.id, version, uploaded: tests.length }, 201);
  });

  app.post("/problems/:problemId/activate/:version", async (c) => {
    const auth = await requireAuth(c, repo);
    const problem = await repo.findProblemById(asProblemId(c.req.param("problemId")));
    if (problem === null) throw new ApiError(404, "problem not found");
    const version = Number(c.req.param("version"));
    const versionRecord = await repo.findProblemVersion(problem.id, version);
    if (versionRecord === null) throw new ApiError(404, "problem version not found");
    // Activation guard (business-logic section 78): never activate a version
    // with no test cases - participants would submit into an unjudgeable hole.
    const tests = await repo.listTestCases(problem.id, version);
    if (tests.length === 0) {
      throw new ApiError(409, "cannot activate a version with no test cases");
    }
    const nowMs = deps.nowMs?.() ?? Date.now();
    const activated = await repo.activateProblemVersion(problem.id, version, nowMs);
    if (activated === null) throw new ApiError(409, "problem version could not be activated");
    await repo.createAuditLog({
      id: newAuditLogId(),
      actorId: participantIdOf(auth),
      actorRole: auth.token.role,
      action: "PROBLEM_ACTIVATE",
      subjectType: "PROBLEM",
      subjectId: problem.id,
      detailJson: JSON.stringify({ version }),
      nowMs,
    });
    return c.json({
      id: activated.id,
      lifecycleState: activated.lifecycleState,
      activeVersion: activated.activeVersion,
    });
  });

  app.post("/problems/:problemId/close", async (c) => {
    const auth = await requireAuth(c, repo);
    const problem = await repo.findProblemById(asProblemId(c.req.param("problemId")));
    if (problem === null) throw new ApiError(404, "problem not found");
    // Lifecycle DRAFT -> ACTIVE -> CLOSED (business-logic section 5): only an
    // ACTIVE problem can be closed; CLOSED stops accepting submissions.
    if (problem.lifecycleState !== "ACTIVE") {
      throw new ApiError(409, "only an ACTIVE problem can be closed");
    }
    const nowMs = deps.nowMs?.() ?? Date.now();
    problem.lifecycleState = "CLOSED";
    problem.updatedAtMs = nowMs;
    await repo.createAuditLog({
      id: newAuditLogId(),
      actorId: participantIdOf(auth),
      actorRole: auth.token.role,
      action: "PROBLEM_CLOSE",
      subjectType: "PROBLEM",
      subjectId: problem.id,
      detailJson: JSON.stringify({ fromActiveVersion: problem.activeVersion }),
      nowMs,
    });
    return c.json({ id: problem.id, lifecycleState: "CLOSED" });
  });

  app.post("/submissions/:submissionId/rejudge", async (c) => {
    const submission = await repo.findSubmissionById(asSubmissionId(c.req.param("submissionId")));
    if (submission === null) throw new ApiError(404, "submission not found");
    const auth = await requireAuth(c, repo);
    const nowMs = deps.nowMs?.() ?? Date.now();
    if (submission.status !== "QUEUED") {
      await repo.resetForRejudge(submission.id, nowMs);
    }
    // Persist the rejudge request (business-logic sections 46/94): who asked,
    // from which status, and when, so judge changes can be audited.
    await repo.createAuditLog({
      id: newAuditLogId(),
      actorId: participantIdOf(auth),
      actorRole: auth.token.role,
      action: "SUBMISSION_REJUDGE",
      subjectType: "SUBMISSION",
      subjectId: submission.id,
      detailJson: JSON.stringify({ fromStatus: submission.status, problemId: submission.problemId }),
      nowMs,
    });
    await repo.markDispatchAttempt(submission.id, nowMs);
    try {
      await deps.queue.enqueue(submission.id);
    } catch (error) {
      console.error(
        JSON.stringify({
          event: "rejudge_dispatch_failed",
          submissionId: submission.id,
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    }
    return c.json({ submissionId: submission.id, status: "QUEUED" }, 202);
  });

  // Admin audit log view (business-logic section 94): who did what, when.
  app.get("/audit", async (c) => {
    const subjectType = c.req.query("subjectType");
    const subjectId = c.req.query("subjectId");
    if (subjectType === undefined || subjectId === undefined) {
      throw new ApiError(400, "subjectType and subjectId query parameters required");
    }
    const rows = await repo.listAuditLogs(subjectType, subjectId);
    return c.json({
      audit: rows.map((row) => ({
        id: row.id,
        actorId: row.actorId,
        actorRole: row.actorRole,
        action: row.action,
        subjectType: row.subjectType,
        subjectId: row.subjectId,
        detailJson: row.detailJson,
        createdAtMs: row.createdAtMs,
      })),
    });
  });

  app.get("/judge-errors", async (c) => {
    const problems = await repo.listProblems();
    const errors: Array<Record<string, unknown>> = [];
    for (const problem of problems) {
      const submissions = await repo.listSubmissionsByProblem(problem.id);
      for (const submission of submissions) {
        if (submission.status !== "JUDGE_ERROR") continue;
        errors.push({
          id: submission.id,
          participantId: submission.participantId,
          problemId: submission.problemId,
          status: submission.status,
          errorId: submission.errorId,
          createdAtMs: submission.createdAtMs,
          updatedAtMs: submission.updatedAtMs,
        });
      }
    }
    return c.json({ errors });
  });

  app.get("/judge-errors/:submissionId", async (c) => {
    const submissionId = asSubmissionId(c.req.param("submissionId"));
    const submission = await repo.findSubmissionById(submissionId);
    if (submission === null || submission.status !== "JUDGE_ERROR") {
      throw new ApiError(404, "judge error not found");
    }
    // Admin-facing infrastructure detail (backend 40, bl 76): attempt history,
    // sandbox ids, infra error classification, correlation id. Never includes
    // hidden test content or secrets.
    const attempts = (await repo.listJudgeAttempts(submissionId)).map((attempt) => ({
      attemptNumber: attempt.attemptNumber,
      status: attempt.status,
      sandboxId: attempt.sandboxId,
      infrastructureError: attempt.infrastructureError,
      errorId: attempt.errorId,
      startedAtMs: attempt.startedAtMs,
      completedAtMs: attempt.completedAtMs,
    }));
    return c.json({
      submissionId: submission.id,
      participantId: submission.participantId,
      problemId: submission.problemId,
      status: submission.status,
      errorId: submission.errorId,
      createdAtMs: submission.createdAtMs,
      attempts,
    });
  });

  app.post("/tokens/:tokenId/revoke", async (c) => {
    const auth = await requireAuth(c, repo);
    const tokenId = asApiTokenId(c.req.param("tokenId"));
    const nowMs = deps.nowMs?.() ?? Date.now();
    const token = await repo.revokeToken(tokenId, nowMs);
    if (token === null) throw new ApiError(404, "token not found");
    await repo.createAuditLog({
      id: newAuditLogId(),
      actorId: participantIdOf(auth),
      actorRole: auth.token.role,
      action: "TOKEN_REVOKE",
      subjectType: "API_TOKEN",
      subjectId: token.id,
      detailJson: JSON.stringify({ participantId: token.participantId, role: token.role }),
      nowMs,
    });
    return c.json({ tokenId: token.id, revokedAtMs: token.revokedAtMs });
  });

  app.post("/tokens", async (c) => {
    const auth = await requireAuth(c, repo);
    const fields = await parseJson(c);
    const participantIdRaw = fields.participantId;
    const role = fields.role;
    if (typeof participantIdRaw !== "string") throw new ApiError(400, "participantId required");
    if (role !== "PARTICIPANT" && role !== "ADMIN") throw new ApiError(400, "role must be PARTICIPANT or ADMIN");
    const participantId = asParticipantId(participantIdRaw);
    const participant = await repo.findParticipantById(participantId);
    if (participant === null) throw new ApiError(404, "participant not found");

    // High-entropy 32-byte secret returned exactly once; only its SHA-256
    // hash is persisted (business-logic sections 2.1/2.2, backend 41/42).
    const nowMs = deps.nowMs?.() ?? Date.now();
    const secret = randomBytes(32).toString("base64url");
    const tokenId = newApiTokenId();
    await repo.createApiToken({
      id: tokenId,
      participantId,
      tokenHash: createHash("sha256").update(secret).digest("hex"),
      role: role as Role,
      nowMs,
    });
    await repo.createAuditLog({
      id: newAuditLogId(),
      actorId: participantIdOf(auth),
      actorRole: auth.token.role,
      action: "TOKEN_CREATE",
      subjectType: "API_TOKEN",
      subjectId: tokenId,
      detailJson: JSON.stringify({ participantId, role }),
      nowMs,
    });
    return c.json({ tokenId, token: secret, role, participantId }, 201);
  });

  return app;
}
