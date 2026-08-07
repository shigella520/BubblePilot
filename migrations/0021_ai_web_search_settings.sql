CREATE TABLE ai_web_search_settings (
  id SMALLINT PRIMARY KEY CHECK (id = 1),
  max_attempts SMALLINT NOT NULL CHECK (max_attempts BETWEEN 1 AND 5),
  attempt_timeout_ms INTEGER NOT NULL
    CHECK (attempt_timeout_ms BETWEEN 1000 AND 60000),
  total_timeout_ms INTEGER NOT NULL
    CHECK (total_timeout_ms BETWEEN 1000 AND 120000),
  retry_delay_ms INTEGER NOT NULL
    CHECK (retry_delay_ms BETWEEN 0 AND 5000),
  max_results SMALLINT NOT NULL CHECK (max_results BETWEEN 1 AND 20),
  failure_policy TEXT NOT NULL
    CHECK (failure_policy IN ('mode-default', 'fail', 'continue')),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (total_timeout_ms >= attempt_timeout_ms)
);
