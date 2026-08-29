-- Remote Runtime Environment: initial D1 schema.
--
-- Mirrors the reference schema in remote-runtime-backend-architecture.md
-- section 16 and the state machine in section 12 of the same document.
-- Wrangler applies migration files in filename order and records each applied
-- file in its own bookkeeping table, so never edit an applied migration.
-- Add a new numbered file instead.

CREATE TABLE participants (
    id TEXT PRIMARY KEY,
    display_name TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'ACTIVE'
        CHECK (status IN ('ACTIVE', 'SUSPENDED')),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE api_tokens (
    id TEXT PRIMARY KEY,
    participant_id TEXT,
    token_hash TEXT NOT NULL UNIQUE,
    role TEXT NOT NULL
        CHECK (role IN ('PARTICIPANT', 'ADMIN')),
    revoked_at TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (participant_id) REFERENCES participants(id)
);

CREATE TABLE problems (
    id TEXT PRIMARY KEY,
    slug TEXT NOT NULL UNIQUE,
    title TEXT NOT NULL,
    -- DRAFT -> ACTIVE -> CLOSED, see business-logic section 5.
    lifecycle_state TEXT NOT NULL DEFAULT 'DRAFT'
        CHECK (lifecycle_state IN ('DRAFT', 'ACTIVE', 'CLOSED')),
    active_version INTEGER,
    time_limit_ms INTEGER NOT NULL,
    memory_limit_kb INTEGER NOT NULL,
    output_limit_bytes INTEGER NOT NULL,
    -- Compilation has separate, usually larger, bounds than the runtime
    -- limits above, see business-logic section 67.
    compile_time_limit_ms INTEGER NOT NULL DEFAULT 10000,
    compile_output_limit_bytes INTEGER NOT NULL DEFAULT 262144,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE problem_versions (
    problem_id TEXT NOT NULL,
    version INTEGER NOT NULL,
    language_policy TEXT NOT NULL,
    compiler_image_version TEXT NOT NULL,
    comparator_version TEXT NOT NULL DEFAULT 'normalized-v1',
    runner_image_version TEXT NOT NULL DEFAULT 'judge-runner-v1',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (problem_id, version),
    FOREIGN KEY (problem_id) REFERENCES problems(id)
);

CREATE TABLE test_cases (
    id TEXT PRIMARY KEY,
    problem_id TEXT NOT NULL,
    problem_version INTEGER NOT NULL,
    kind TEXT NOT NULL
        CHECK (kind IN ('CORRECTNESS', 'BENCHMARK')),
    ordinal INTEGER NOT NULL,
    input_r2_key TEXT NOT NULL,
    expected_r2_key TEXT NOT NULL,
    comparator TEXT NOT NULL DEFAULT 'NORMALIZED',
    input_sha256 TEXT,
    expected_sha256 TEXT,
    weight REAL NOT NULL DEFAULT 1,
    UNIQUE (problem_id, problem_version, kind, ordinal),
    FOREIGN KEY (problem_id, problem_version)
        REFERENCES problem_versions(problem_id, version)
);

CREATE TABLE submissions (
    id TEXT PRIMARY KEY,
    participant_id TEXT NOT NULL,
    problem_id TEXT NOT NULL,
    problem_version INTEGER NOT NULL,
    language TEXT NOT NULL,
    source_r2_key TEXT NOT NULL,

    -- CREATED/QUEUED/RUNNING are in-flight; the rest are terminal.
    status TEXT NOT NULL
        CHECK (status IN (
            'CREATED', 'QUEUED', 'RUNNING',
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
    -- Bounded compiler diagnostics live in R2, never in this table.
    compile_log_r2_key TEXT,
    -- Correlation id shown to participants on JUDGE_ERROR.
    error_id TEXT,

    passed_tests INTEGER,
    total_tests INTEGER,

    -- Integer nanoseconds; no floating point in ranking math.
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

CREATE TABLE submission_test_results (
    submission_id TEXT NOT NULL,
    test_case_id TEXT NOT NULL,
    status TEXT NOT NULL
        CHECK (status IN (
            'PASS', 'WRONG_ANSWER', 'RUNTIME_ERROR',
            'TIME_LIMIT_EXCEEDED', 'MEMORY_LIMIT_EXCEEDED',
            'OUTPUT_LIMIT_EXCEEDED'
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

CREATE TABLE judge_attempts (
    submission_id TEXT NOT NULL,
    attempt_number INTEGER NOT NULL,
    execution_token TEXT NOT NULL,
    sandbox_id TEXT,
    status TEXT NOT NULL
        CHECK (status IN (
            'CLAIMED', 'RUNNING', 'SUCCEEDED',
            'FAILED_RETRYABLE', 'FAILED_TERMINAL'
        )),
    infrastructure_error TEXT,
    error_id TEXT,
    started_at TEXT NOT NULL,
    completed_at TEXT,
    PRIMARY KEY (submission_id, attempt_number),
    FOREIGN KEY (submission_id) REFERENCES submissions(id)
);

-- Lightweight admin audit trail, see business-logic section 94.
CREATE TABLE audit_log (
    id TEXT PRIMARY KEY,
    actor_id TEXT,
    actor_role TEXT
        CHECK (actor_role IN ('PARTICIPANT', 'ADMIN', 'SYSTEM')),
    action TEXT NOT NULL,
    subject_type TEXT NOT NULL,
    subject_id TEXT NOT NULL,
    detail_json TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
