/**
 * Hono app assembly for the Remote Runtime API.
 *
 * Mounts the public and admin route groups under /api/v1, adds the
 * unauthenticated health route, and converts thrown ApiErrors into JSON
 * responses. Unknown routes fall through to a JSON 404.
 */

import { Hono } from "hono";
import type { Judge } from "../judge";
import { JudgeConsumer } from "../judge/consumer";
import type { ArtifactStore } from "../storage/artifact-store";
import type { Repository } from "../storage/repository";
import { adminRoutes } from "./admin";
import { ApiError } from "./errors";
import { leaderboardRoutes } from "./leaderboard";
import { problemsRoutes } from "./problems";
import { LocalQueueAdapter, type SubmissionQueue } from "./queue-adapter";
import { submissionsRoutes } from "./submissions";

export interface AppDeps {
  repo: Repository;
  /** Optional so tests and the dev server get a consumer-wired queue for free. */
  queue?: SubmissionQueue;
  store: ArtifactStore;
  judge: Judge;
  nowMs?: () => number;
  /** Infra retries allowed after the first JUDGE_ERROR before terminating (default 3). */
  maxJudgeRetries?: number;
  /** Submission rate limit: max submissions per window per participant (backend 45, bl 64). */
  rateLimitSubmissions?: number;
  /** Submission rate limit window in ms (backend 45, bl 64). */
  rateLimitWindowMs?: number;
}

export function createApp(deps: AppDeps): Hono {
  const app = new Hono();

  app.use("*", async (c, next) => {
    await next();
    c.header("X-Content-Type-Options", "nosniff");
    c.header("Referrer-Policy", "no-referrer");
    c.header("Cache-Control", "no-store");
  });

  // Wire the judge consumer into the queue: a submission enqueued by the API
  // is judged when the local queue is flushed. Callers may pass their own
  // queue (Cloudflare adapter); the local default judges synchronously.
  const consumer = new JudgeConsumer({
    repo: deps.repo,
    artifacts: deps.store,
    judge: deps.judge,
    ...(deps.nowMs === undefined ? {} : { nowMs: deps.nowMs }),
    ...(deps.maxJudgeRetries === undefined ? {} : { maxJudgeRetries: deps.maxJudgeRetries }),
  });
  const queue = deps.queue ?? new LocalQueueAdapter(consumer);
  if (queue instanceof LocalQueueAdapter) queue.setConsumer(consumer);

  app.get("/api/v1/health", (c) => c.json({ status: "ok" }));

  app.route("/api/v1/problems", problemsRoutes(deps.repo));
  app.route(
    "/api/v1/submissions",
    submissionsRoutes({
      repo: deps.repo,
      queue,
      store: deps.store,
      ...(deps.nowMs === undefined ? {} : { nowMs: deps.nowMs }),
      ...(deps.rateLimitSubmissions === undefined ? {} : { rateLimitSubmissions: deps.rateLimitSubmissions }),
      ...(deps.rateLimitWindowMs === undefined ? {} : { rateLimitWindowMs: deps.rateLimitWindowMs }),
    }),
  );
  app.route("/api/v1/leaderboard", leaderboardRoutes(deps.repo));
  app.route(
    "/api/v1/admin",
    adminRoutes({
      repo: deps.repo,
      queue,
      artifacts: deps.store,
      ...(deps.nowMs === undefined ? {} : { nowMs: deps.nowMs }),
    }),
  );

  app.notFound((c) => c.json({ error: "not found" }, 404));

  app.onError((error, c) => {
    if (error instanceof ApiError) {
      const body: Record<string, unknown> = { error: error.message };
      if (error.code !== null) body.code = error.code;
      return c.json(body, error.status as 400);
    }
    return c.json({ error: "internal server error" }, 500);
  });

  return app;
}
