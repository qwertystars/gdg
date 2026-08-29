-- Atomic participant submission limiter. Fixed windows are sufficient for
-- burst control; old buckets can be removed by scheduled maintenance.
CREATE TABLE submission_rate_limits (
    participant_id TEXT NOT NULL,
    window_ms INTEGER NOT NULL,
    bucket_start_ms INTEGER NOT NULL,
    request_count INTEGER NOT NULL CHECK (request_count > 0),
    updated_at TEXT NOT NULL,
    PRIMARY KEY (participant_id, window_ms, bucket_start_ms),
    FOREIGN KEY (participant_id) REFERENCES participants(id)
);

CREATE INDEX idx_submission_rate_limits_updated_at
    ON submission_rate_limits(updated_at);
