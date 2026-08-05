ALTER TABLE ai_provider_attempts
  ADD COLUMN client_request_id TEXT CHECK (LENGTH(client_request_id) <= 512),
  ADD COLUMN provider_request_id TEXT CHECK (LENGTH(provider_request_id) <= 512),
  ADD COLUMN http_status INTEGER CHECK (http_status BETWEEN 100 AND 599),
  ADD COLUMN request_hash TEXT,
  ADD COLUMN request_message_count INTEGER CHECK (request_message_count >= 0),
  ADD COLUMN request_characters INTEGER CHECK (request_characters >= 0),
  ADD COLUMN response_bytes INTEGER CHECK (response_bytes >= 0),
  ADD COLUMN response_body_hash TEXT,
  ADD COLUMN response_finish_reason TEXT,
  ADD COLUMN response_content_characters INTEGER
    CHECK (response_content_characters >= 0),
  ADD COLUMN response_reasoning_characters INTEGER
    CHECK (response_reasoning_characters >= 0),
  ADD COLUMN prompt_tokens INTEGER CHECK (prompt_tokens >= 0),
  ADD COLUMN completion_tokens INTEGER CHECK (completion_tokens >= 0),
  ADD COLUMN reasoning_tokens INTEGER CHECK (reasoning_tokens >= 0),
  ADD COLUMN total_tokens INTEGER CHECK (total_tokens >= 0),
  ADD COLUMN cached_prompt_tokens INTEGER CHECK (cached_prompt_tokens >= 0),
  ADD COLUMN cache_write_prompt_tokens INTEGER
    CHECK (cache_write_prompt_tokens >= 0),
  ADD COLUMN cache_miss_prompt_tokens INTEGER
    CHECK (cache_miss_prompt_tokens >= 0);
