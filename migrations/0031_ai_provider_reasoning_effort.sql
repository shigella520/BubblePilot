ALTER TABLE ai_providers
  ADD COLUMN reasoning_effort TEXT NOT NULL DEFAULT 'default'
  CHECK (reasoning_effort IN (
    'default', 'none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'
  ));
