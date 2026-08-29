import { Database, type SQLQueryBindings } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import { asParticipantId, asProblemId, asSubmissionId, type SubmissionId } from "../../src/domain/ids";
import { type D1Like, D1Repository } from "../../src/storage/d1-repository";

const NOW = 1_700_000_000_000;
const iso = (ms: number): string => new Date(ms).toISOString();

class D1Shim {
  private readonly db: Database;

  constructor(db: Database) {
    this.db = db;
  }

  prepare(sql: string) {
    const stmt = this.db.prepare(sql);
    return {
      bind: (...params: SQLQueryBindings[]) => ({
        all: async <T>() => ({ results: stmt.all(...params) as T[] }),
        first: async <T>() => (stmt.get(...params) as T | null) ?? null,
        run: async () => {
          const info = stmt.run(...params);
          return { meta: { changes: Number(info.changes) } };
        },
      }),
      all: async <T>(...params: SQLQueryBindings[]) => ({ results: stmt.all(...params) as T[] }),
      first: async <T>(...params: SQLQueryBindings[]) => (stmt.get(...params) as T | null) ?? null,
      run: async (...params: SQLQueryBindings[]) => {
        const info = stmt.run(...params);
        return { meta: { changes: Number(info.changes) } };
      },
    };
  }
}

let db: Database;
let repo: D1Repository;
const submissions: SubmissionId[] = [];

async function migratedDb(): Promise<Database> {
  const database = new Database(":memory:");
  const files = (await readdir("migrations")).filter((f) => f.endsWith(".sql")).sort();
  for (const file of files) {
    database.exec(await readFile(`migrations/${file}`, "utf8"));
  }
  return database;
}

function seedBase(): void {
  db.exec(
    `INSERT INTO participants (id, display_name, status, created_at)
     VALUES ('participant_seed_alpha', 'Alpha', 'ACTIVE', '${iso(NOW)}')`,
  );
  db.exec(
    `INSERT INTO problems (id, slug, title, lifecycle_state, active_version, time_limit_ms, memory_limit_kb, output_limit_bytes, created_at, updated_at)
     VALUES ('problem_seed_two_sum', 'two-sum', 'Two Sum', 'ACTIVE', 1, 2000, 262144, 1048576, '${iso(NOW)}', '${iso(NOW)}')`,
  );
  db.exec(
    `INSERT INTO problem_versions (problem_id, version, language_policy, compiler_image_version, comparator_version, runner_image_version, created_at)
     VALUES ('problem_seed_two_sum', 1, 'cpp17', 'gcc-13.2.0-cpp17', 'normalized-v1', 'judge-runner-v1', '${iso(NOW)}')`,
  );
}

function insertSubmission(
  id: string,
  status: string,
  executionToken: string | null,
  leaseUntilMs: number | null,
  language = "cpp17",
): void {
  db.exec(
    `INSERT INTO submissions (id, participant_id, problem_id, problem_version, language, source_r2_key, status, attempt_count, execution_token, lease_until, created_at, updated_at)
     VALUES ('${id}', 'participant_seed_alpha', 'problem_seed_two_sum', 1, '${language}', 'submissions/${id}/source.cpp', '${status}', 1, ${
       executionToken === null ? "NULL" : `'${executionToken}'`
}, ${leaseUntilMs === null ? "NULL" : `'${iso(leaseUntilMs)}'`}, '${iso(NOW)}', '${iso(NOW)}')`,
  );
  submissions.push(asSubmissionId(id));
}

function claim(id: SubmissionId, token: string, nowMs: number = NOW) {
  return repo.claimExecution({ submissionId: id, executionToken: token, leaseUntilMs: nowMs + 600_000, nowMs });
}

beforeEach(async () => {
  db = await migratedDb();
  seedBase();
  repo = new D1Repository(new D1Shim(db) as unknown as D1Like);
});

afterEach(() => {
  db.close();
  submissions.length = 0;
});

describe("D1Repository claimExecution (backend 11 claim predicate)", () => {
  test("maps the persisted submission language instead of assuming C++", async () => {
    insertSubmission("sub_python", "QUEUED", null, null, "python3");
    const stored = await repo.findSubmissionById(submissions[0]!);
    expect(stored?.language).toBe("python3");
  });

  test("an expired-lease RUNNING attempt is reclaimed with a fresh token and incremented attempt count", async () => {
    insertSubmission("sub_expired", "RUNNING", "old-token", NOW - 10_000);
    const id = submissions[0]!;
    const outcome = await claim(id, "new-token");
    expect(outcome.ok).toBe(true);
    const stored = (await repo.findSubmissionById(id))!;
    expect(stored.executionToken).toBe("new-token");
    expect(stored.attemptCount).toBe(2);
    expect(stored.status).toBe("RUNNING");
  });

  test("a RUNNING attempt with a valid lease is not reclaimed (LEASE_VALID)", async () => {
    insertSubmission("sub_leased", "RUNNING", "old-token", NOW + 10_000);
    const id = submissions[0]!;
    const outcome = await claim(id, "new-token");
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.reason).toBe("LEASE_VALID");
    const stored = (await repo.findSubmissionById(id))!;
    expect(stored.executionToken).toBe("old-token");
  });

  test("a QUEUED submission is claimed normally", async () => {
    insertSubmission("sub_queued", "QUEUED", null, null);
    const id = submissions[0]!;
    const outcome = await claim(id, "fresh-token");
    expect(outcome.ok).toBe(true);
    if (outcome.ok) expect(outcome.attemptNumber).toBe(2);
  });

  test("a terminal submission is never claimed (TERMINAL)", async () => {
    insertSubmission("sub_terminal", "ACCEPTED", null, null);
    const id = submissions[0]!;
    const outcome = await claim(id, "fresh-token");
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.reason).toBe("TERMINAL");
  });

  test("a JUDGE_RETRY submission (migration 0003) is claimable by a redelivered message", async () => {
    insertSubmission("sub_retry", "JUDGE_RETRY", null, null);
    const id = submissions[0]!;
    const outcome = await claim(id, "retry-token");
    expect(outcome.ok).toBe(true);
    if (outcome.ok) expect(outcome.attemptNumber).toBe(2);
    const stored = (await repo.findSubmissionById(id))!;
    expect(stored.executionToken).toBe("retry-token");
  });
});

describe("D1Repository submitResult", () => {
  test("a terminal JUDGE_ERROR commit persists the errorId correlation id", async () => {
    insertSubmission("sub_err", "RUNNING", "tok", NOW + 600_000);
    const id = submissions[0]!;
    const outcome = await repo.submitResult({
      submissionId: id,
      executionToken: "tok",
      status: "JUDGE_ERROR",
      errorId: "judge_err_abc123",
      nowMs: NOW + 1,
    });
    expect(outcome).toBe("COMMITTED");
    const stored = (await repo.findSubmissionById(id))!;
    expect(stored.status).toBe("JUDGE_ERROR");
    expect(stored.errorId).toBe("judge_err_abc123");
  });
});

describe("D1Repository security-sensitive mutations", () => {
  test("problem updates and ACTIVE -> CLOSED transitions persist in D1", async () => {
    const problemId = asProblemId("problem_seed_two_sum");
    const updated = await repo.updateProblem(problemId, { title: "Updated", timeLimitMs: 1234 }, NOW + 1);
    expect(updated?.title).toBe("Updated");
    expect(updated?.limits.timeLimitMs).toBe(1234);

    const closed = await repo.closeProblem(problemId, NOW + 2);
    expect(closed?.lifecycleState).toBe("CLOSED");
    expect((await repo.findProblemById(problemId))?.lifecycleState).toBe("CLOSED");
    expect(await repo.closeProblem(problemId, NOW + 3)).toBeNull();
  });

  test("submission rate-limit increments are atomic at the D1 statement boundary", async () => {
    const participantId = asParticipantId("participant_seed_alpha");
    const outcomes = await Promise.all(
      Array.from({ length: 12 }, () => repo.consumeSubmissionRateLimit(participantId, NOW, 5, 10_000)),
    );
    expect(outcomes.filter(Boolean)).toHaveLength(5);
    expect(await repo.consumeSubmissionRateLimit(participantId, NOW + 10_000, 5, 10_000)).toBe(true);
  });
});
