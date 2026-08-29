-- Remote Runtime Environment: indexes.
--
-- D1 processes queries on one database serially, so every frequent query
-- should hit a small index instead of scanning. See architecture section 17.
-- Verify new queries with EXPLAIN QUERY PLAN during development.

-- Own submission history (participant profile page).
CREATE INDEX idx_submissions_participant_created
    ON submissions(participant_id, created_at);

-- Problem status listing, e.g. admin problem dashboards.
CREATE INDEX idx_submissions_problem_status
    ON submissions(problem_id, status);

-- Leaderboard: best accepted score per problem.
CREATE INDEX idx_submissions_problem_score
    ON submissions(problem_id, status, performance_score_ns);

-- Lease reclaim: QUEUED or RUNNING-with-expired-lease lookups.
CREATE INDEX idx_submissions_lease
    ON submissions(status, lease_until);

-- Deterministic testcase enumeration in ordinal order.
CREATE INDEX idx_test_cases_problem_version_kind
    ON test_cases(problem_id, problem_version, kind, ordinal);

-- Admin audit history lookups.
CREATE INDEX idx_audit_subject
    ON audit_log(subject_type, subject_id, created_at);
