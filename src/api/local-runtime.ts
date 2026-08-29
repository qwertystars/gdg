/**
 * Local adapter runtime for the Remote Runtime MVP.
 *
 * Wires the in-memory repository, local artifact store, local C++17 judge,
 * and local queue adapter into the Hono API exactly once, so the Worker
 * entry (src/index.ts), the dev server (scripts/dev-server.ts), and the seed
 * script (scripts/seed-problem.ts) all operate on the SAME repo/store/judge
 * instances.
 *
 * The production Cloudflare deployment replaces these local adapters with
 * D1/R2/Queues/Sandbox-backed implementations behind the same interfaces;
 * see README.md, "Local vs Cloudflare: the adapter boundary".
 */

import type { Hono } from "hono";
import { seedData } from "../domain/seed";
import { LocalCpp17Judge } from "../judge";
import { JudgeConsumer } from "../judge/consumer";
import { LocalArtifactStore } from "../storage/artifact-store";
import { MemoryRepository } from "../storage/memory-repository";
import { createApp } from "./app";
import { LocalQueueAdapter } from "./queue-adapter";

/** Repository-relative fixture root that backs the seed problem's R2 keys. */
export const DEMO_FIXTURES_ROOT = "scripts/fixtures/demo";

export interface LocalRuntime {
  app: Hono;
  repo: MemoryRepository;
  store: LocalArtifactStore;
  judge: LocalCpp17Judge;
  consumer: JudgeConsumer;
  queue: LocalQueueAdapter;
}

export function buildLocalRuntime(fixturesRoot: string = DEMO_FIXTURES_ROOT): LocalRuntime {
  const repo = new MemoryRepository();
  repo.seed(seedData());
  const store = new LocalArtifactStore(fixturesRoot);
  const judge = new LocalCpp17Judge();
  const consumer = new JudgeConsumer({ repo, artifacts: store, judge });
  const queue = new LocalQueueAdapter(consumer);
  const app = createApp({ repo, queue, store, judge });
  return { app, repo, store, judge, consumer, queue };
}
