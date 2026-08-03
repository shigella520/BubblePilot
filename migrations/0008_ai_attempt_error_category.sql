ALTER TABLE ai_provider_attempts
  ADD COLUMN error_category TEXT
  CHECK (
    error_category IS NULL OR error_category IN (
      'timeout',
      'connection',
      'rate-limit',
      'server-error',
      'authentication',
      'model',
      'invalid-response',
      'empty-output',
      'content-safety',
      'configuration'
    )
  );
