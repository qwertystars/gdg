#!/usr/bin/env node

/**
 * Seeds the local MVP with deterministic demo data and prints a summary.
 *
 * Entry point:  bun run db:seed
 * Package hook: package.json -> "db:seed": "bun run scripts/seed-problem.ts"
 * Direct run:   bun scripts/seed-problem.ts
 *
 * Constructs the in-memory repository and local artifact store from
 * seedData() and the demo fixtures (src/api/local-runtime.ts), then prints a
 * deterministic summary: participants, token ids (with their documented
 * plaintext), and the seed problem's id/slug/activeVersion plus correctness
 * vs benchmark test-case counts. No Cloudflare account is needed. Exits 0
 * on success.
 */

import { buildLocalRuntime } from "../src/api/local-runtime";
import type { ApiTokenRecord } from "../src/domain/entities";
import {
  SEED_ADMIN_ID,
  SEED_ADMIN_TOKEN,
  SEED_PARTICIPANT_ID,
  SEED_PARTICIPANT_TOKEN,
  SEED_PROBLEM_ID,
} from "../src/domain/seed";

const { repo } = buildLocalRuntime();

const participants = await repo.listParticipants();
const tokens = await repo.listTokens();
const problems = await repo.listProblems();
const problem = problems.find((p) => p.id === SEED_PROBLEM_ID);
if (problem === undefined) throw new Error(`Seed problem not found: ${SEED_PROBLEM_ID}`);
const activeVersion = problem.activeVersion;
if (activeVersion === null) throw new Error(`Seed problem ${problem.id} has no active version`);

const testCases = await repo.listTestCases(problem.id, activeVersion);
const correctnessCount = testCases.filter((t) => t.kind === "CORRECTNESS").length;
const benchmarkCount = testCases.filter((t) => t.kind === "BENCHMARK").length;

function plaintextOf(token: ApiTokenRecord): string {
  if (token.participantId === SEED_PARTICIPANT_ID && token.role === "PARTICIPANT") return SEED_PARTICIPANT_TOKEN;
  if (token.participantId === SEED_ADMIN_ID && token.role === "ADMIN") return SEED_ADMIN_TOKEN;
  return "<unknown>";
}

const participantIds = participants
  .map((p) => p.id)
  .sort()
  .join(", ");
const tokenSummary = tokens
  .sort((a, b) => a.id.localeCompare(b.id))
  .map((t) => `${t.id} (role ${t.role}, plaintext ${plaintextOf(t)})`)
  .join(", ");

console.log("GDG Remote Runtime seed summary");
console.log(`participants: ${participants.length} (${participantIds})`);
console.log(`tokens: ${tokenSummary}`);
console.log(`problem: ${problem.id} (slug: ${problem.slug}, title: ${problem.title}), activeVersion: ${activeVersion}`);
console.log(`test cases: ${correctnessCount} correctness, ${benchmarkCount} benchmark`);
