BEGIN;
-- Verified direct US services; stable internal identities are shared by every environment.
INSERT INTO app.streaming_providers(id,display_name) VALUES
  ('60000000-0000-4000-8000-000000000203','Netflix'),
  ('60000000-0000-4000-8000-000000000387','HBO Max'),
  ('60000000-0000-4000-8000-000000000372','Disney+'),
  ('60000000-0000-4000-8000-000000000157','Hulu');
-- A conflicting source identity aborts the entire migration, including provider inserts.
INSERT INTO app.streaming_provider_external_ids(provider_id,source,external_id) VALUES
  ('60000000-0000-4000-8000-000000000203','watchmode','203'),
  ('60000000-0000-4000-8000-000000000387','watchmode','387'),
  ('60000000-0000-4000-8000-000000000372','watchmode','372'),
  ('60000000-0000-4000-8000-000000000157','watchmode','157');
CREATE FUNCTION app.guard_watchmode_provider_mapping() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $$
BEGIN
  IF OLD.source='watchmode' OR (TG_OP='UPDATE' AND NEW.source='watchmode') THEN
    RAISE EXCEPTION 'Watchmode provider identity is immutable' USING ERRCODE='23514';
  END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app.guard_watchmode_provider_mapping() FROM PUBLIC,anon,authenticated,service_role;
-- No trigger-depth exemption: provider cascades must preserve the same identity.
CREATE TRIGGER watchmode_provider_mapping_immutable BEFORE UPDATE OR DELETE ON app.streaming_provider_external_ids
FOR EACH ROW EXECUTE FUNCTION app.guard_watchmode_provider_mapping();
COMMIT;
