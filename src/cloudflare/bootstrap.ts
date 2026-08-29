/**
 * Idempotent startup bootstrap for the Cloudflare runtime: seeds the D1
 * database and R2 bucket with participants, a demo problem, and fixtures when
 * empty. It intentionally never creates API tokens: production credentials
 * must be provisioned explicitly and must not derive from public seed data.
 */

import { SEED_ADMIN_ID, SEED_PARTICIPANT_ID, seedData } from "../domain/seed";
import type { D1Like } from "../storage/d1-repository";

export async function bootstrapCloudflare(env: {
  DB: unknown;
  ARTIFACTS: unknown;
  R2_ARTIFACTS?: unknown;
}): Promise<void> {
  const db = env.DB as D1Like;
  const store = new (await import("../storage/r2-artifact-store")).R2ArtifactStore(env.ARTIFACTS as never);
  const seeded = await db.prepare("SELECT COUNT(*) AS n FROM participants").bind().first<{ n: number }>();
  if (seeded && Number((seeded as { n?: unknown }).n) > 0) return;

  const data = seedData();
  const now = new Date().toISOString();

  await db
    .prepare("INSERT INTO participants (id, display_name, status, created_at) VALUES (?, ?, 'ACTIVE', ?)")
    .bind(SEED_PARTICIPANT_ID, "Seed Participant", now)
    .run();
  await db
    .prepare("INSERT INTO participants (id, display_name, status, created_at) VALUES (?, ?, 'ACTIVE', ?)")
    .bind(SEED_ADMIN_ID, "Seed Admin", now)
    .run();

  const problem = data.problems[0];
  if (!problem) throw new Error("seed problem missing");
  await db
    .prepare(
      `INSERT INTO problems (id, slug, title, lifecycle_state, active_version, time_limit_ms, memory_limit_kb, output_limit_bytes, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      problem.id,
      problem.slug,
      problem.title,
      problem.lifecycleState,
      problem.activeVersion,
      problem.limits.timeLimitMs,
      problem.limits.memoryLimitKb,
      problem.limits.outputLimitBytes,
      now,
      now,
    )
    .run();

  const version = data.problemVersions[0];
  if (!version) throw new Error("seed problem version missing");
  await db
    .prepare(
      `INSERT INTO problem_versions (problem_id, version, language_policy, compiler_image_version, comparator_version, runner_image_version,
       time_limit_ms, memory_limit_kb, output_limit_bytes, compile_time_limit_ms, compile_output_limit_bytes, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      version.problemId,
      version.version,
      version.languagePolicy,
      version.compilerImageVersion,
      version.comparatorVersion,
      version.runnerImageVersion,
      version.limits.timeLimitMs,
      version.limits.memoryLimitKb,
      version.limits.outputLimitBytes,
      version.limits.compileTimeLimitMs,
      version.limits.compileOutputLimitBytes,
      now,
    )
    .run();

  for (const tc of data.testCases) {
    await db
      .prepare(
        `INSERT INTO test_cases (id, problem_id, problem_version, kind, ordinal, input_r2_key, expected_r2_key, comparator, weight, input_sha256, expected_sha256)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        tc.id,
        tc.problemId,
        tc.problemVersion,
        tc.kind,
        tc.ordinal,
        tc.inputR2Key,
        tc.expectedR2Key,
        tc.comparator,
        tc.weight,
        tc.inputSha256,
        tc.expectedSha256,
      )
      .run();
    await store.write(tc.inputR2Key, await fixtureFor(tc.inputR2Key));
    await store.write(tc.expectedR2Key, await fixtureFor(tc.expectedR2Key));
  }
}

async function fixtureFor(key: string): Promise<string> {
  // Inline the demo fixture content so the worker is fully workerd-safe
  // (no Bun, no process.cwd(), no fs reads). Mirrors LocalArtifactStore:
  // tests/*.in = "21\n", tests/*.out = "42\n",
  // benchmarks/*.in = "100000\n", benchmarks/*.out = "200000\n".
  const parts = key.split("/");
  const kindDir = parts[3] ?? "tests";
  const file = parts.at(-1) ?? "";
  const isBenchmark = kindDir === "benchmarks";
  const isOut = file.endsWith(".out");
  if (isBenchmark) return isOut ? "200000\n" : "100000\n";
  return isOut ? "42\n" : "21\n";
}
