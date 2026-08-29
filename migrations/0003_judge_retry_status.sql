-- Remote Runtime Environment: extend the submissions status CHECK with the
-- non-terminal infrastructure-retry status JUDGE_RETRY.
--
-- SQLite cannot alter a table CHECK constraint in place, so the standard
-- table-rebuild recipe is used: create a shadow table with the extended
-- schema, copy the rows, drop the old table, rename, then recreate the
-- indexes that referenced it (from 0002_indexes.sql). FK pragmas bracket
-- the swap so referencing tables do not block the DROP.

PRAGMA foreign_keys=OFF;
-- D1 wraps each migration in a transaction, where changing foreign_keys is
-- ignored by SQLite. Deferring checks makes the table swap valid for a
-- populated database because the submissions table exists again at commit.
PRAGMA defer_foreign_keys=ON;

CREATE TABLE submissions_new (
    id TEXT PRIMARY KEY,
    participant_id TEXT NOT NULL,
    problem_id TEXT NOT NULL,
    problem_version INTEGER NOT NULL,
    language TEXT NOT NULL,
    source_r2_key TEXT NOT NULL,

    -- CREATED/QUEUED/RUNNING/JUDGE_RETRY are in-flight; the rest are
    -- terminal. JUDGE_RETRY is the non-terminal infrastructure-retry
    -- status (a judge attempt failed with JUDGE_ERROR but the retry budget
    -- is not exhausted).
    status TEXT NOT NULL
        CHECK (status IN (
            'CREATED', 'QUEUED', 'RUNNING', 'JUDGE_RETRY',
            'COMPILE_ERROR', 'WRONG_ANSWER', 'RUNTIME_ERROR',
            'TIME_LIMIT_EXCEEDED', 'MEMORY_LIMIT_EXCEEDED',
            'OUTPUT_LIMIT_EXCEEDED', 'ACCEPTED', 'JUDGE_ERROR'
        )),
    attempt_count INTEGER NOT NULL DEFAULT 0,

    -- Claim/lease fields, see business-logic sections 15-17.
    execution_token TEXT,
    lease_until TEXT,

    compiler_version TEXT,
    compiler_flags TEXT,
    runner_image_version TEXT,
    compile_log_r2_key TEXT,
    error_id TEXT,

    passed_tests INTEGER,
    total_tests INTEGER,

    performance_score_ns INTEGER,
    peak_memory_kb INTEGER,

    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    queued_at TEXT,
    started_at TEXT,
    completed_at TEXT,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,

    FOREIGN KEY (participant_id) REFERENCES participants(id),
    FOREIGN KEY (problem_id, problem_version)
        REFERENCES problem_versions(problem_id, version)
);

INSERT INTO submissions_new (
    id, participant_id, problem_id, problem_version, language, source_r2_key,
    status, attempt_count, execution_token, lease_until,
    compiler_version, compiler_flags, runner_image_version, compile_log_r2_key, error_id,
    passed_tests, total_tests, performance_score_ns, peak_memory_kb,
    created_at, queued_at, started_at, completed_at, updated_at
)
SELECT
    id, participant_id, problem_id, problem_version, language, source_r2_key,
    status, attempt_count, execution_token, lease_until,
    compiler_version, compiler_flags, runner_image_version, compile_log_r2_key, error_id,
    passed_tests, total_tests, performance_score_ns, peak_memory_kb,
    created_at, queued_at, started_at, completed_at, updated_at
FROM submissions;

-- D1 migrations run transactionally, so PRAGMA foreign_keys cannot disable
-- checks. Preserve and temporarily remove all child tables before swapping
-- the referenced parent table; recreate them and their rows afterwards.
CREATE TABLE submission_test_results_backup AS SELECT * FROM submission_test_results;
CREATE TABLE submission_benchmarks_backup AS SELECT * FROM submission_benchmarks;
CREATE TABLE judge_attempts_backup AS SELECT * FROM judge_attempts;
DROP TABLE submission_test_results;
DROP TABLE submission_benchmarks;
DROP TABLE judge_attempts;

DROP TABLE submissions;

ALTER TABLE submissions_new RENAME TO submissions;

CREATE TABLE submission_test_results (
    submission_id TEXT NOT NULL,
    test_case_id TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN (
        'PASS', 'WRONG_ANSWER', 'RUNTIME_ERROR', 'TIME_LIMIT_EXCEEDED',
        'MEMORY_LIMIT_EXCEEDED', 'OUTPUT_LIMIT_EXCEEDED'
    )),
    cpu_time_ns INTEGER,
    wall_time_ns INTEGER,
    peak_memory_kb INTEGER,
    exit_code INTEGER,
    signal INTEGER,
    PRIMARY KEY (submission_id, test_case_id),
    FOREIGN KEY (submission_id) REFERENCES submissions(id),
    FOREIGN KEY (test_case_id) REFERENCES test_cases(id)
);
INSERT INTO submission_test_results SELECT * FROM submission_test_results_backup;
DROP TABLE submission_test_results_backup;

CREATE TABLE submission_benchmarks (
    submission_id TEXT NOT NULL,
    test_case_id TEXT NOT NULL,
    run_number INTEGER NOT NULL,
    cpu_time_ns INTEGER NOT NULL,
    wall_time_ns INTEGER NOT NULL,
    peak_memory_kb INTEGER NOT NULL,
    PRIMARY KEY (submission_id, test_case_id, run_number),
    FOREIGN KEY (submission_id) REFERENCES submissions(id),
    FOREIGN KEY (test_case_id) REFERENCES test_cases(id)
);
INSERT INTO submission_benchmarks SELECT * FROM submission_benchmarks_backup;
DROP TABLE submission_benchmarks_backup;

CREATE TABLE judge_attempts (
    submission_id TEXT NOT NULL,
    attempt_number INTEGER NOT NULL,
    execution_token TEXT NOT NULL,
    sandbox_id TEXT,
    status TEXT NOT NULL CHECK (status IN (
        'CLAIMED', 'RUNNING', 'SUCCEEDED', 'FAILED_RETRYABLE', 'FAILED_TERMINAL'
    )),
    infrastructure_error TEXT,
    error_id TEXT,
    started_at TEXT NOT NULL,
    completed_at TEXT,
    PRIMARY KEY (submission_id, attempt_number),
    FOREIGN KEY (submission_id) REFERENCES submissions(id)
);
INSERT INTO judge_attempts SELECT * FROM judge_attempts_backup;
DROP TABLE judge_attempts_backup;

-- Recreate the submission indexes from 0002_indexes.sql.
CREATE INDEX idx_submissions_participant_created
    ON submissions(participant_id, created_at);

CREATE INDEX idx_submissions_problem_status
    ON submissions(problem_id, status);

CREATE INDEX idx_submissions_problem_score
    ON submissions(problem_id, status, performance_score_ns);

CREATE INDEX idx_submissions_lease
    ON submissions(status, lease_until);

PRAGMA foreign_keys=ON;
