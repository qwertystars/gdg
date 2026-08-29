/**
 * Submission routes: create (POST), list own (GET), and detail (GET :id).
 *
 * Creation follows business-logic sections 8-9: auth, problem active,
 * language supported, source non-empty and under the byte cap, then the
 * rate limit (5 per 10 s per participant). A rejected request is never
 * stored. Accepted submissions return 202 { submissionId, status: "QUEUED" }
 * after enqueueing the submission id.
 *
 * Participant-facing results (section 42) never include storage keys or
 * hidden test content; a participant reading another participant's
 * submission gets 404 so existence is never revealed.
 */

import { createHash } from "node:crypto";
import type { Context } from "hono";
import { Hono } from "hono";
import type { SubmissionRecord } from "../domain/entities";
import { asProblemId, asSubmissionId, newSubmissionId, type ParticipantId } from "../domain/ids";
import { sourceR2KeyFor } from "../domain/seed";
import { isSubmissionLanguage } from "../judge/languages";
import type { ArtifactStore } from "../storage/artifact-store";
import type { Repository } from "../storage/repository";
import { participantIdOf, requireAuth } from "./auth";
import { ApiError } from "./errors";
import type { SubmissionQueue } from "./queue-adapter";

export const SOURCE_LIMIT_BYTES = 131_072;
export const RATE_LIMIT_SUBMISSIONS = 5;
export const RATE_LIMIT_WINDOW_MS = 10_000;
export const COMPILER_OUTPUT_LIMIT_BYTES = 65_536;

export interface SubmissionRouteDeps {
  repo: Repository;
  queue: SubmissionQueue;
  store: ArtifactStore;
  nowMs?: () => number;
  /** Max submissions per window per participant; defaults to RATE_LIMIT_SUBMISSIONS (5). */
  rateLimitSubmissions?: number;
  /** Rate limit window in ms; defaults to RATE_LIMIT_WINDOW_MS (10 s). */
  rateLimitWindowMs?: number;
}

interface SubmissionInput {
  problemId: string;
  language: string;
  source: string;
}

async function parseSubmissionBody(c: Context): Promise<SubmissionInput> {
  if (c.req.raw.body === null) throw new ApiError(400, "request body required");
  const raw = JSON.parse(await c.req.text()) as unknown;
  if (typeof raw !== "object" || raw === null) throw new ApiError(400, "request body must be an object");
  const fields = raw as Record<string, unknown>;
  if (typeof fields.problemId !== "string") throw new ApiError(400, "problemId required");
  if (typeof fields.language !== "string") throw new ApiError(400, "language required");
  if (typeof fields.source !== "string") throw new ApiError(400, "source required");
  return { problemId: fields.problemId, language: fields.language, source: fields.source };
}

export function submissionResultView(submission: SubmissionRecord): Record<string, unknown> {
  return {
    id: submission.id,
    submissionId: submission.id,
    problemId: submission.problemId,
    status: submission.status,
    passedTests: submission.passedTests,
    totalTests: submission.totalTests,
    performanceScoreNs: submission.performanceScoreNs,
    peakMemoryKb: submission.peakMemoryKb,
    createdAtMs: submission.createdAtMs,
    completedAtMs: submission.completedAtMs,
  };
}

export function submissionsRoutes(deps: SubmissionRouteDeps): Hono {
  const app = new Hono();
  const repo = deps.repo;

  app.get("/", async (c) => {
    const auth = await requireAuth(c, repo);
    const participantId = participantIdOf(auth);
    const list = await repo.listSubmissions({ participantId }, null, 100);
    return c.json({ submissions: list.items.map(submissionResultView) });
  });

  app.get("/:submissionId", async (c) => {
    const auth = await requireAuth(c, repo);
    const submission = await repo.findSubmissionById(asSubmissionId(c.req.param("submissionId")));
    if (submission === null) throw new ApiError(404, "submission not found");
    if (auth.token.role !== "ADMIN" && submission.participantId !== participantIdOf(auth)) {
      throw new ApiError(404, "submission not found");
    }
    const body = submissionResultView(submission);
    // COMPILE_ERROR exposes a bounded compiler diagnostic (sections 42/44);
    // the log is read from the artifact store, never leaked as a storage key.
    if (submission.status === "COMPILE_ERROR" && submission.compileLogR2Key !== null) {
      const log = await deps.store.read(submission.compileLogR2Key);
      body.compilerOutput = log.slice(0, COMPILER_OUTPUT_LIMIT_BYTES);
    }
    return c.json(body);
  });

  // Participant source view (business-logic section 58): the owner (or an
  // admin) may read their own submission source. The public leaderboard and
  // submission views never expose source; this is the explicit opt-in.
  app.get("/:submissionId/source", async (c) => {
    const auth = await requireAuth(c, repo);
    const submission = await repo.findSubmissionById(asSubmissionId(c.req.param("submissionId")));
    if (submission === null) throw new ApiError(404, "submission not found");
    if (auth.token.role !== "ADMIN" && submission.participantId !== participantIdOf(auth)) {
      throw new ApiError(404, "submission not found");
    }
    const source = await deps.store.read(submission.sourceR2Key);
    return c.json({
      submissionId: submission.id,
      problemId: submission.problemId,
      language: submission.language,
      source,
    });
  });

  // Per-test-case results + benchmark runs (business-logic 42/74, backend 14):
  // the participant (owner) or an admin can inspect the detailed run data.
  app.get("/:submissionId/test-results", async (c) => {
    const auth = await requireAuth(c, repo);
    const submission = await repo.findSubmissionById(asSubmissionId(c.req.param("submissionId")));
    if (submission === null) throw new ApiError(404, "submission not found");
    if (auth.token.role !== "ADMIN" && submission.participantId !== participantIdOf(auth)) {
      throw new ApiError(404, "submission not found");
    }
    const testResults = (await repo.listTestResults(submission.id)).map((row) => ({
      testCaseId: row.testCaseId,
      status: row.status,
      cpuTimeNs: row.cpuTimeNs,
      wallTimeNs: row.wallTimeNs,
      peakMemoryKb: row.peakMemoryKb,
      exitCode: row.exitCode,
      signal: row.signal,
    }));
    const benchmarkRuns = (await repo.listBenchmarkRuns(submission.id)).map((row) => ({
      testCaseId: row.testCaseId,
      runNumber: row.runNumber,
      cpuTimeNs: row.cpuTimeNs,
      wallTimeNs: row.wallTimeNs,
      peakMemoryKb: row.peakMemoryKb,
    }));
    return c.json({ submissionId: submission.id, testResults, benchmarkRuns });
  });

  app.post("/", async (c) => {
    const auth = await requireAuth(c, repo);
    const participantId = participantIdOf(auth);
    const input = await parseSubmissionBody(c);

    const problem = await repo.findProblemById(asProblemId(input.problemId));
    if (problem === null || problem.lifecycleState !== "ACTIVE" || problem.activeVersion === null) {
      throw new ApiError(404, "problem not found");
    }
    if (!isSubmissionLanguage(input.language)) {
      throw new ApiError(422, "unsupported language", "UNSUPPORTED_LANGUAGE");
    }
    const problemVersion = await repo.findProblemVersion(problem.id, problem.activeVersion);
    const allowedLanguages = new Set(problemVersion?.languagePolicy.split(",").map((value) => value.trim()) ?? []);
    if (!allowedLanguages.has(input.language)) {
      throw new ApiError(422, "language is not enabled for this problem version", "UNSUPPORTED_LANGUAGE");
    }
    const byteLength = new TextEncoder().encode(input.source).byteLength;
    if (input.source.length === 0 || byteLength > SOURCE_LIMIT_BYTES) {
      throw new ApiError(422, "source must be non-empty and at most 128 KiB");
    }
    const nowMs = deps.nowMs?.() ?? Date.now();
    const rateLimitSubmissions = deps.rateLimitSubmissions ?? RATE_LIMIT_SUBMISSIONS;
    const rateLimitWindowMs = deps.rateLimitWindowMs ?? RATE_LIMIT_WINDOW_MS;
    await enforceRateLimit(repo, participantId, nowMs, rateLimitSubmissions, rateLimitWindowMs);

    const submissionId = newSubmissionId();
    // Persist the source BEFORE the metadata row (business-logic section 10):
    // if the write fails the request fails with no orphan CREATED row that is
    // never queued. The submitted source is what the judge reads.
    const sourceKey = sourceR2KeyFor(submissionId, input.language);
    await deps.store.write(sourceKey, input.source);
    const sourceSha256 = createHash("sha256").update(input.source, "utf8").digest("hex");
    const submission = await repo.createSubmission({
      participantId,
      problemId: problem.id,
      language: input.language,
      sourceR2Key: sourceKey,
      sourceSha256,
      nowMs,
    });
    // The local memory repository assigns its own submission id; the queue
    // and response must use the STORED id so the consumer finds the row.
    await repo.setSubmissionStatus(submission.id, "QUEUED", nowMs);
    await repo.markDispatchAttempt(submission.id, nowMs);
    try {
      await deps.queue.enqueue(submission.id);
    } catch (error) {
      // The durable D1 row is authoritative. The scheduled reconciler will
      // retry this handoff; returning 202 avoids encouraging a duplicate
      // participant submission when Queue is briefly unavailable.
      console.error(
        JSON.stringify({
          event: "submission_dispatch_failed",
          submissionId: submission.id,
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    }
    return c.json({ submissionId: submission.id, status: "QUEUED" }, 202);
  });

  return app;
}

async function enforceRateLimit(
  repo: Repository,
  participantId: ParticipantId,
  nowMs: number,
  rateLimitSubmissions: number,
  rateLimitWindowMs: number,
): Promise<void> {
  const cutoff = nowMs - rateLimitWindowMs;
  const list = await repo.listSubmissions({ participantId }, null, rateLimitSubmissions);
  let recent = 0;
  for (const item of list.items) {
    if (item.createdAtMs < cutoff) break;
    recent++;
  }
  if (recent >= rateLimitSubmissions) {
    throw new ApiError(429, "submission rate limit exceeded");
  }
}
