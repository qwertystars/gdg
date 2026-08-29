/**
 * Cloudflare Worker entry for the GDG Remote Runtime API.
 *
 * Exports the Worker-shaped `fetch` and `queue` handlers. When the Cloudflare
 * bindings are present (D1, R2, Sandbox), it builds the Cloudflare runtime:
 * D1 repository, R2 artifact store, Sandbox execution, and the real Queue
 * producer. Without them (tests, `bun run dev`), it falls back to the local
 * in-memory runtime. In local dev, `DEV_INLINE_JUDGE` makes judging
 * deterministic after enqueue instead of relying on a queue consumer.
 */

import { getSandbox, Sandbox } from "@cloudflare/sandbox";
import type { Hono } from "hono";
import { createApp } from "./api/app";
import { buildLocalRuntime, type LocalRuntime } from "./api/local-runtime";
import { LocalQueueAdapter, type SubmissionQueue } from "./api/queue-adapter";
import { reconcileSubmissionDispatches } from "./api/reconcile";
import { bootstrapCloudflare } from "./cloudflare/bootstrap";
import { asSubmissionId, type SubmissionId } from "./domain/ids";
import type { Judge } from "./judge";
import { CloudflareSandboxJudge } from "./judge/cloudflare/sandbox";
import { JudgeConsumer } from "./judge/consumer";
import { type D1Like, D1Repository } from "./storage/d1-repository";
import { R2ArtifactStore } from "./storage/r2-artifact-store";

export { Sandbox };

interface SandboxDurableObjectNamespace {
  get(id: string): Sandbox;
  get(id: string, options?: unknown): Sandbox;
}

interface Env {
  DB: D1Like;
  ARTIFACTS: ArtifactsLike;
  JUDGE_QUEUE: unknown;
  DEV_INLINE_JUDGE?: boolean;
  SOURCE_LIMIT_BYTES?: number;
  DEFAULT_TIME_LIMIT_MS?: number;
  DEFAULT_MEMORY_LIMIT_KB?: number;
  DEFAULT_OUTPUT_LIMIT_BYTES?: number;
  LEASE_DURATION_MS?: number;
  MAX_JUDGE_RETRIES?: number;
  COMPILER_OUTPUT_LIMIT_BYTES?: number;
  RATE_LIMIT_SUBMISSIONS?: number;
  RATE_LIMIT_WINDOW_MS?: number;
  Sandbox: SandboxDurableObjectNamespace;
}

interface ArtifactsLike {
  put(key: string, value: string | ArrayBuffer | ReadableStream): Promise<unknown>;
  get(key: string): Promise<{ body: ReadableStream | null; size: number } | null>;
  delete(key: string): Promise<unknown>;
}

interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
  passThroughOnException(): void;
  props: unknown;
  exports?: unknown;
}

interface ScheduledController {
  readonly scheduledTime: number;
}

interface QueueMessage {
  readonly id: string;
  readonly timestamp: number;
  readonly attempts: number;
  readonly message: unknown;
  ack(): void;
  retry(): void;
}

interface MessageBatch {
  readonly queue: string;
  readonly messages: QueueMessage[];
  retryAll(): void;
  ackAll(): void;
}

interface AppRuntime {
  app: Hono;
  repo: D1Repository | LocalRuntime["repo"];
  store: R2ArtifactStore | LocalRuntime["store"];
  queue: SubmissionQueue;
  consumer: JudgeConsumer | null;
  inlineJudge: boolean;
}

let runtime: AppRuntime | null = null;

function hasCloudflareBindings(env: Env): boolean {
  return env.DB !== undefined && env.ARTIFACTS !== undefined && env.Sandbox !== undefined;
}

async function buildCloudflareRuntime(env: Env): Promise<AppRuntime> {
  await bootstrapCloudflare(env);
  const repo = new D1Repository(env.DB);
  const store = new R2ArtifactStore(env.ARTIFACTS);
  const sandbox = new CloudflareSandboxJudge({
    getSandbox: (sandboxId: string) =>
      getSandbox(env.Sandbox, sandboxId, { enableDefaultSession: false, sleepAfter: "1m" }),
  });
  const judge: Judge = {
    judge: (request) => sandbox.judge(request, `attempt-${randomSandboxToken()}`),
  };
  const consumer = new JudgeConsumer({
    repo,
    artifacts: store,
    judge,
    ...(env.MAX_JUDGE_RETRIES === undefined ? {} : { maxJudgeRetries: env.MAX_JUDGE_RETRIES }),
  });
  const inlineJudge = env.DEV_INLINE_JUDGE === true;
  const queue: SubmissionQueue = inlineJudge
    ? new LocalQueueAdapter(consumer)
    : {
        enqueue: async (submissionId: SubmissionId) => {
          await (env.JUDGE_QUEUE as { send: (payload: unknown) => Promise<unknown> }).send({ submissionId });
        },
      };
  const app = createApp({
    repo,
    queue,
    store,
    judge,
    ...(env.MAX_JUDGE_RETRIES === undefined ? {} : { maxJudgeRetries: env.MAX_JUDGE_RETRIES }),
    ...(env.RATE_LIMIT_SUBMISSIONS === undefined ? {} : { rateLimitSubmissions: env.RATE_LIMIT_SUBMISSIONS }),
    ...(env.RATE_LIMIT_WINDOW_MS === undefined ? {} : { rateLimitWindowMs: env.RATE_LIMIT_WINDOW_MS }),
  });
  return { app, repo, store, queue, consumer: inlineJudge ? null : consumer, inlineJudge };
}

async function getRuntime(env: Env): Promise<AppRuntime> {
  if (runtime !== null && runtime !== undefined) {
    if (hasCloudflareBindings(env)) return runtime;
  }
  if (hasCloudflareBindings(env)) {
    runtime = await buildCloudflareRuntime(env);
    return runtime;
  }
  const local = buildLocalRuntime();
  runtime = {
    app: local.app,
    repo: local.repo,
    store: local.store,
    queue: local.queue,
    consumer: local.consumer,
    inlineJudge: true,
  };
  return runtime;
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const rt = await getRuntime(env);
    const response = await rt.app.fetch(request, env, ctx);
    if (rt.inlineJudge && rt.queue instanceof LocalQueueAdapter) {
      void rt.queue.flush().catch((error) => console.error("local judge flush failed:", error));
    }
    return response;
  },
  async queue(batch: MessageBatch, env: Env, _ctx: ExecutionContext): Promise<void> {
    const rt = await getRuntime(env);
    if (rt.consumer === null) {
      console.error("queue handler called but inline judge is enabled; acking message");
      batch.ackAll();
      return;
    }
    for (const message of batch.messages) {
      const raw = messageBody(message);
      const submissionId = submissionIdOf(raw);
      if (submissionId === null) {
        console.error(`Ignoring malformed judge queue message: ${JSON.stringify(raw)}`);
        message.ack();
        continue;
      }
      try {
        await rt.consumer.consume(submissionId);
        message.ack();
      } catch (error) {
        console.error(`Judge consumer failed for submission ${submissionId}; message will be retried.`, error);
        throw error;
      }
    }
  },
  async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    const rt = await getRuntime(env);
    ctx.waitUntil(
      reconcileSubmissionDispatches(rt.repo, rt.queue, controller.scheduledTime).then((count) => {
        if (count > 0) console.log(JSON.stringify({ event: "submission_dispatch_reconciled", count }));
      }),
    );
  },
} as const;

function messageBody(message: QueueMessage): unknown {
  const record = message as unknown as Record<string, unknown>;
  if ("body" in record) return record.body;
  return message.message;
}

function submissionIdOf(body: unknown): SubmissionId | null {
  if (typeof body === "string") return asSubmissionId(body);
  if (typeof body === "object" && body !== null) {
    const submissionId = (body as Record<string, unknown>).submissionId;
    if (typeof submissionId === "string") return asSubmissionId(submissionId);
  }
  return null;
}

function randomSandboxToken(): string {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}
