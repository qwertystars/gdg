-- Make judge inputs reproducible and recover submissions stranded between
-- the D1 commit and Queue delivery. Existing versions inherit the limits
-- that were current when this migration is applied.

ALTER TABLE problem_versions ADD COLUMN time_limit_ms INTEGER;
ALTER TABLE problem_versions ADD COLUMN memory_limit_kb INTEGER;
ALTER TABLE problem_versions ADD COLUMN output_limit_bytes INTEGER;
ALTER TABLE problem_versions ADD COLUMN compile_time_limit_ms INTEGER;
ALTER TABLE problem_versions ADD COLUMN compile_output_limit_bytes INTEGER;

UPDATE problem_versions
SET time_limit_ms = (SELECT time_limit_ms FROM problems WHERE problems.id = problem_versions.problem_id),
    memory_limit_kb = (SELECT memory_limit_kb FROM problems WHERE problems.id = problem_versions.problem_id),
    output_limit_bytes = (SELECT output_limit_bytes FROM problems WHERE problems.id = problem_versions.problem_id),
    compile_time_limit_ms = (SELECT compile_time_limit_ms FROM problems WHERE problems.id = problem_versions.problem_id),
    compile_output_limit_bytes = (SELECT compile_output_limit_bytes FROM problems WHERE problems.id = problem_versions.problem_id);

ALTER TABLE submissions ADD COLUMN source_sha256 TEXT;
ALTER TABLE submissions ADD COLUMN dispatch_attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE submissions ADD COLUMN last_dispatch_at TEXT;

CREATE INDEX idx_submissions_dispatch_recovery
    ON submissions(status, last_dispatch_at, created_at);
