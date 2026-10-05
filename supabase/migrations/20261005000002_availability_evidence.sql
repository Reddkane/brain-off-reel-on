BEGIN;
-- Per-page integrity checks are prepared once per service, with indexed member counts.
CREATE INDEX watchmode_memberships_page ON app.watchmode_memberships(sweep_id,page);
CREATE TABLE app.provider_retention_policy (
  singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),
  watchmode_window interval NOT NULL CHECK(watchmode_window>interval '0' AND watchmode_window<=interval '30 days')
);
INSERT INTO app.provider_retention_policy VALUES(true,interval '30 days');
REVOKE ALL ON app.provider_retention_policy FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT ON app.provider_retention_policy TO service_role;
ALTER TABLE app.provider_retention_policy ENABLE ROW LEVEL SECURITY;
CREATE FUNCTION app.guard_retention_policy() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog SET timezone='UTC' AS $$
BEGIN RAISE EXCEPTION 'Migration-owned retention policy' USING ERRCODE='23514'; END $$;
REVOKE ALL ON FUNCTION app.guard_retention_policy() FROM PUBLIC,anon,authenticated,service_role;
CREATE TRIGGER retention_policy_seal BEFORE INSERT OR UPDATE OR DELETE ON app.provider_retention_policy
FOR EACH ROW EXECUTE FUNCTION app.guard_retention_policy();

ALTER TABLE app.movie_availability ADD COLUMN retention_at timestamptz;
ALTER TABLE app.availability_observations ADD COLUMN retention_at timestamptz;
-- Temporarily unbind ONLY these UPDATE guards to perform deterministic migration backfill.
DROP TRIGGER trg_movie_availability_immutable ON app.movie_availability;
DROP TRIGGER trg_availability_observations_immutable ON app.availability_observations;
UPDATE app.movie_availability o SET retention_at=s.checked_at FROM app.availability_snapshots s WHERE s.id=o.snapshot_id;
UPDATE app.availability_observations o SET retention_at=s.checked_at FROM app.availability_snapshots s WHERE s.id=o.snapshot_id;
ALTER TABLE app.movie_availability ALTER COLUMN retention_at SET NOT NULL;
ALTER TABLE app.availability_observations ALTER COLUMN retention_at SET NOT NULL;
CREATE FUNCTION app.stamp_availability_age() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog SET timezone='UTC' AS $$
BEGIN
  SELECT checked_at INTO NEW.retention_at FROM app.availability_snapshots WHERE id=NEW.snapshot_id;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app.stamp_availability_age() FROM PUBLIC,anon,authenticated,service_role;
CREATE TRIGGER trg_movie_availability_age BEFORE INSERT ON app.movie_availability FOR EACH ROW EXECUTE FUNCTION app.stamp_availability_age();
CREATE TRIGGER trg_availability_observations_age BEFORE INSERT ON app.availability_observations FOR EACH ROW EXECUTE FUNCTION app.stamp_availability_age();

ALTER TABLE app.movies ADD COLUMN metadata_state text NOT NULL DEFAULT 'active' CHECK(metadata_state IN ('active','retired'));
CREATE TABLE app.movie_external_id_acquisitions (
  movie_id uuid NOT NULL, source text NOT NULL,
  acquisition_path text NOT NULL CHECK(acquisition_path IN ('tmdb_metadata','watchmode_membership','first_party_ratings')),
  acquired_at timestamptz NOT NULL,
  PRIMARY KEY(movie_id,source,acquisition_path,acquired_at),
  FOREIGN KEY(movie_id,source) REFERENCES app.movie_external_ids(movie_id,source) ON DELETE RESTRICT
);
INSERT INTO app.movie_external_id_acquisitions
SELECT e.movie_id,e.source,'tmdb_metadata',m.metadata_refreshed_at FROM app.movie_external_ids e JOIN app.movies m ON m.id=e.movie_id;
CREATE FUNCTION app.guard_external_id_acquisition() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog SET timezone='UTC' AS $$
DECLARE retention_window interval;
BEGIN
  IF TG_OP='UPDATE' OR OLD.acquisition_path='first_party_ratings' THEN
    RAISE EXCEPTION 'Immutable identity acquisition' USING ERRCODE='23514';
  END IF;
  IF OLD.acquisition_path='tmdb_metadata' THEN retention_window:=interval '6 months';
  ELSE SELECT watchmode_window INTO retention_window FROM app.provider_retention_policy WHERE singleton; END IF;
  IF retention_window IS NULL OR NOT (OLD.acquired_at+retention_window<statement_timestamp()) THEN
    RAISE EXCEPTION 'Identity acquisition retained' USING ERRCODE='23514';
  END IF;
  RETURN OLD;
END $$;
REVOKE ALL ON FUNCTION app.guard_external_id_acquisition() FROM PUBLIC,anon,authenticated,service_role;
CREATE TRIGGER external_id_acquisitions_immutable BEFORE UPDATE OR DELETE ON app.movie_external_id_acquisitions
FOR EACH ROW EXECUTE FUNCTION app.guard_external_id_acquisition();

CREATE TABLE app.watchmode_offer_variants (
  snapshot_id uuid NOT NULL, provider_id uuid NOT NULL, offer_type text NOT NULL,
  requested_variant text NOT NULL CHECK(requested_variant IN ('without_ads','standard','bundle_with_ads')),
  mapping_scope text NOT NULL DEFAULT 'direct_service' CHECK(mapping_scope='direct_service'),
  tier_inclusion text NOT NULL DEFAULT 'unknown' CHECK(tier_inclusion IN ('unknown','included','excluded')),
  source_id integer NOT NULL CHECK(source_id IN (203,387,372,157)),
  retention_at timestamptz NOT NULL,
  PRIMARY KEY(snapshot_id,provider_id,offer_type,requested_variant),
  FOREIGN KEY(snapshot_id,provider_id,offer_type) REFERENCES app.movie_availability ON DELETE CASCADE
);
CREATE TABLE app.watchmode_links (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), snapshot_id uuid NOT NULL, provider_id uuid NOT NULL,
  offer_type text NOT NULL, requested_variant text NOT NULL,
  format text CHECK(length(format)<=40),
  web_url text CHECK(web_url LIKE 'https://%'),
  missing_reason text CHECK(missing_reason IN ('missing','restricted','refused')),
  observed_at timestamptz NOT NULL, expires_at timestamptz NOT NULL,
  CHECK((web_url IS NULL)=(missing_reason IS NOT NULL)),
  CHECK(expires_at>observed_at AND expires_at<=observed_at+interval '30 days'),
  FOREIGN KEY(snapshot_id,provider_id,offer_type,requested_variant) REFERENCES app.watchmode_offer_variants ON DELETE CASCADE
);
-- Independent derivations: never add children to sealed historical snapshots.
CREATE TABLE app.watchmode_arrivals (
  movie_id uuid NOT NULL REFERENCES app.movies ON DELETE RESTRICT,
  source_id integer NOT NULL CHECK(source_id IN (203,387,372,157)), generation text NOT NULL,
  current_sweep uuid NOT NULL REFERENCES app.watchmode_sweeps ON DELETE CASCADE,
  absence_sweep uuid REFERENCES app.watchmode_sweeps ON DELETE CASCADE,
  presence_sweep uuid REFERENCES app.watchmode_sweeps ON DELETE CASCADE,
  drift_sweep uuid REFERENCES app.watchmode_sweeps ON DELETE CASCADE,
  state text NOT NULL CHECK(state IN ('present','absent','unknown')),
  reason text NOT NULL CHECK(reason IN ('interval','first_sweep','generation','gap','interrupted','expired','drift','absent')),
  episode text, absence_at timestamptz, presence_at timestamptz,
  retention_at timestamptz NOT NULL, derived_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  PRIMARY KEY(movie_id,source_id,current_sweep),
  CHECK(reason<>'interval' OR (absence_at IS NOT NULL AND presence_at IS NOT NULL AND presence_at>=absence_at AND presence_at<=absence_at+interval '48 hours'))
);
CREATE FUNCTION app.stamp_watchmode_cache_age() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog SET timezone='UTC' AS $$
BEGIN
  IF TG_TABLE_NAME IN ('watchmode_offer_variants','watchmode_links') THEN
    IF NOT EXISTS(SELECT 1 FROM app.availability_snapshots WHERE id=NEW.snapshot_id AND creation_xid=pg_current_xact_id()) THEN
      RAISE EXCEPTION 'Snapshot cache membership sealed' USING ERRCODE='23514';
    END IF;
  END IF;
  IF TG_TABLE_NAME='watchmode_offer_variants' THEN
    SELECT checked_at INTO NEW.retention_at FROM app.availability_snapshots WHERE id=NEW.snapshot_id;
  ELSIF TG_TABLE_NAME='watchmode_links' THEN
    SELECT checked_at INTO NEW.observed_at FROM app.availability_snapshots WHERE id=NEW.snapshot_id;
    SELECT NEW.observed_at+watchmode_window INTO NEW.expires_at FROM app.provider_retention_policy WHERE singleton;
  ELSE
    SELECT min(observed_at) INTO NEW.retention_at FROM app.watchmode_sweeps
      WHERE id IN (NEW.current_sweep,NEW.absence_sweep,NEW.presence_sweep,NEW.drift_sweep);
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app.stamp_watchmode_cache_age() FROM PUBLIC,anon,authenticated,service_role;
CREATE TRIGGER variants_age BEFORE INSERT ON app.watchmode_offer_variants FOR EACH ROW EXECUTE FUNCTION app.stamp_watchmode_cache_age();
CREATE TRIGGER links_age BEFORE INSERT ON app.watchmode_links FOR EACH ROW EXECUTE FUNCTION app.stamp_watchmode_cache_age();
CREATE TRIGGER arrivals_age BEFORE INSERT ON app.watchmode_arrivals FOR EACH ROW EXECUTE FUNCTION app.stamp_watchmode_cache_age();

CREATE FUNCTION app.guard_provider_cache() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog SET timezone='UTC' AS $$
DECLARE age timestamptz; retention_window interval;
BEGIN
  IF TG_OP='UPDATE' THEN RAISE EXCEPTION 'Append-only cache' USING ERRCODE='23514'; END IF;
  age:=(to_jsonb(OLD)->>TG_ARGV[0])::timestamptz;
  SELECT watchmode_window INTO retention_window FROM app.provider_retention_policy WHERE singleton;
  -- Every depth checks its own age. No deleted-parent lookup and no role exception.
  IF age IS NULL OR retention_window IS NULL OR NOT(age+retention_window<statement_timestamp()) THEN
    RAISE EXCEPTION 'Append-only provider cache retained' USING ERRCODE='23514';
  END IF;
  RETURN OLD;
END $$;
REVOKE ALL ON FUNCTION app.guard_provider_cache() FROM PUBLIC,anon,authenticated,service_role;
DROP TRIGGER trg_availability_snapshots_immutable ON app.availability_snapshots;
DROP TRIGGER trg_availability_tracks_immutable ON app.availability_tracks;
DROP TRIGGER watchmode_sweeps_immutable ON app.watchmode_sweeps;
DROP TRIGGER watchmode_pages_immutable ON app.watchmode_pages;
DROP TRIGGER watchmode_memberships_immutable ON app.watchmode_memberships;
DROP TRIGGER watchmode_sweep_events_immutable ON app.watchmode_sweep_events;
DROP TRIGGER watchmode_enrichment_checks_immutable ON app.watchmode_enrichment_checks;
DROP TRIGGER metadata_detail_attempts_immutable ON app.metadata_detail_attempts;
CREATE TRIGGER trg_availability_snapshots_immutable BEFORE UPDATE OR DELETE ON app.availability_snapshots FOR EACH ROW EXECUTE FUNCTION app.guard_provider_cache('checked_at');
CREATE TRIGGER trg_movie_availability_immutable BEFORE UPDATE OR DELETE ON app.movie_availability FOR EACH ROW EXECUTE FUNCTION app.guard_provider_cache('retention_at');
CREATE TRIGGER trg_availability_observations_immutable BEFORE UPDATE OR DELETE ON app.availability_observations FOR EACH ROW EXECUTE FUNCTION app.guard_provider_cache('retention_at');
CREATE TRIGGER trg_availability_tracks_immutable BEFORE UPDATE OR DELETE ON app.availability_tracks FOR EACH ROW EXECUTE FUNCTION app.guard_provider_cache('tracked_since');
CREATE TRIGGER watchmode_sweeps_immutable BEFORE UPDATE OR DELETE ON app.watchmode_sweeps FOR EACH ROW EXECUTE FUNCTION app.guard_provider_cache('observed_at');
CREATE TRIGGER watchmode_pages_immutable BEFORE UPDATE OR DELETE ON app.watchmode_pages FOR EACH ROW EXECUTE FUNCTION app.guard_provider_cache('observed_at');
CREATE TRIGGER watchmode_memberships_immutable BEFORE UPDATE OR DELETE ON app.watchmode_memberships FOR EACH ROW EXECUTE FUNCTION app.guard_provider_cache('observed_at');
CREATE TRIGGER watchmode_sweep_events_immutable BEFORE UPDATE OR DELETE ON app.watchmode_sweep_events FOR EACH ROW EXECUTE FUNCTION app.guard_provider_cache('observed_at');
CREATE TRIGGER watchmode_enrichment_checks_immutable BEFORE UPDATE OR DELETE ON app.watchmode_enrichment_checks FOR EACH ROW EXECUTE FUNCTION app.guard_provider_cache('observed_at');
CREATE TRIGGER metadata_detail_attempts_immutable BEFORE UPDATE OR DELETE ON app.metadata_detail_attempts FOR EACH ROW EXECUTE FUNCTION app.guard_provider_cache('checked_at');
CREATE TRIGGER variants_immutable BEFORE UPDATE OR DELETE ON app.watchmode_offer_variants FOR EACH ROW EXECUTE FUNCTION app.guard_provider_cache('retention_at');
CREATE TRIGGER links_immutable BEFORE UPDATE OR DELETE ON app.watchmode_links FOR EACH ROW EXECUTE FUNCTION app.guard_provider_cache('observed_at');
CREATE TRIGGER arrivals_immutable BEFORE UPDATE OR DELETE ON app.watchmode_arrivals FOR EACH ROW EXECUTE FUNCTION app.guard_provider_cache('retention_at');
REVOKE ALL ON app.movie_external_id_acquisitions,app.watchmode_offer_variants,app.watchmode_links,app.watchmode_arrivals FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT,INSERT,DELETE ON app.movie_external_id_acquisitions,app.watchmode_offer_variants,app.watchmode_links,app.watchmode_arrivals TO service_role;
ALTER TABLE app.movie_external_id_acquisitions ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.watchmode_offer_variants ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.watchmode_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.watchmode_arrivals ENABLE ROW LEVEL SECURITY;
COMMIT;
