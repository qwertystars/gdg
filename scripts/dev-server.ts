#!/usr/bin/env node

/**
 * Local dev server for the Remote Runtime API.
 *
 * Entry point:  bun run dev
 * Package hook: package.json -> "dev": "bun run scripts/dev-server.ts"
 * Direct run:   bun scripts/dev-server.ts
 *
 * Serves the seeded Hono app through Bun.serve on port 8787 (the wrangler
 * dev default port) with no Cloudflare account and no wrangler binary.
 * Queue dispatch is local: the API enqueues submission ids into the local
 * queue adapter, and a flush after each request judges them with the same
 * repo/store/judge instances the API uses (see src/api/local-runtime.ts).
 * The two development seed tokens are printed on startup.
 */

import { buildLocalRuntime } from "../src/api/local-runtime";
import { SEED_ADMIN_TOKEN, SEED_PARTICIPANT_TOKEN } from "../src/domain/seed";

const PORT = 8787;

const { app, queue } = buildLocalRuntime();

const server = Bun.serve({
  port: PORT,
  async fetch(request) {
    const response = await app.fetch(request);
    // Judge anything the API enqueued once the request is handled.
    void queue.flush().catch((error) => console.error("Failed to judge queued submission:", error));
    return response;
  },
});

console.log(`GDG Remote Runtime API listening on http://127.0.0.1:${server.port}`);
console.log(`Participant token: ${SEED_PARTICIPANT_TOKEN}`);
console.log(`Admin token: ${SEED_ADMIN_TOKEN}`);
