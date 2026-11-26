-- Sign in with Google: each one-time value (nonce) the server hands out can be used for ONE sign-in. Without this, a Google token captured from a
-- browser could be replayed for as long as the nonce and the token both stay valid (up to 10 minutes). The table keeps only a hash, and a day of rows.
CREATE TABLE google_nonce_used (
  nonce_hash  text PRIMARY KEY,
  used_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX google_nonce_used_at ON google_nonce_used (used_at);
ALTER TABLE google_nonce_used ENABLE ROW LEVEL SECURITY;   -- no policy and no grant: only the function below can touch it

-- True the first time a nonce is used, false every time after. Server only, before anybody is signed in.
CREATE FUNCTION google_nonce_take(p_hash text) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE n int;
BEGIN
  IF app_user_id() IS NOT NULL THEN RAISE EXCEPTION 'Only the server does this.'; END IF;
  DELETE FROM google_nonce_used WHERE used_at < now() - interval '1 day';   -- a nonce is only good for 10 minutes, so a day is plenty
  INSERT INTO google_nonce_used (nonce_hash) VALUES (p_hash) ON CONFLICT DO NOTHING;
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n = 1;
END $$;
REVOKE ALL ON FUNCTION google_nonce_take(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION google_nonce_take(text) TO nusuh_app;
