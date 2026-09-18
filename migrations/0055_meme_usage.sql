ALTER TABLE meme_assets
  ADD COLUMN usage_count bigint NOT NULL DEFAULT 0 CHECK (usage_count >= 0),
  ADD COLUMN last_used_at timestamptz;
ALTER TABLE outbound_deliveries ADD COLUMN usage_counted boolean NOT NULL DEFAULT false;

-- Only surviving, attributable confirmations can be reconstructed.
UPDATE meme_assets m SET usage_count=s.n, last_used_at=s.latest
FROM (
  SELECT meme_id, count(*) AS n, max(confirmed_at) AS latest
  FROM outbound_deliveries WHERE kind='meme' AND status='confirmed' AND meme_id IS NOT NULL
  GROUP BY meme_id
) s WHERE m.id=s.meme_id;
UPDATE outbound_deliveries SET usage_counted=true
WHERE kind='meme' AND status='confirmed' AND meme_id IS NOT NULL;

CREATE FUNCTION count_confirmed_meme_usage() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='UPDATE' THEN
    NEW.usage_counted := OLD.usage_counted;
  ELSE
    NEW.usage_counted := false;
  END IF;
  IF NOT NEW.usage_counted AND NEW.kind='meme' AND NEW.status='confirmed'
     AND NEW.meme_id IS NOT NULL AND NEW.closed_at IS NULL THEN
    UPDATE meme_assets SET usage_count=usage_count+1,
      last_used_at=greatest(last_used_at, NEW.confirmed_at)
    WHERE id=NEW.meme_id;
    IF FOUND THEN NEW.usage_counted := true; END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER confirmed_meme_usage BEFORE INSERT OR UPDATE ON outbound_deliveries
FOR EACH ROW EXECUTE FUNCTION count_confirmed_meme_usage();
