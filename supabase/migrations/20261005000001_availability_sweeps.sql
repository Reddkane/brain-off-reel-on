BEGIN;
-- Cached observations are append-only until Availability: evidence adds its age guard.
CREATE TABLE app.watchmode_sweeps (
  id uuid PRIMARY KEY, batch_id uuid NOT NULL, source_id integer NOT NULL CHECK(source_id IN (203,387,372,157)),
  generation text NOT NULL CHECK(generation ~ '^[a-zA-Z0-9_-]{1,64}$'),
  observed_at timestamptz NOT NULL,
  UNIQUE(batch_id,source_id)
);
CREATE INDEX watchmode_sweeps_service ON app.watchmode_sweeps(source_id,observed_at DESC,id);
CREATE TABLE app.watchmode_pages (
  sweep_id uuid NOT NULL REFERENCES app.watchmode_sweeps ON DELETE CASCADE,
  page integer NOT NULL CHECK(page BETWEEN 1 AND 60),
  total_pages integer NOT NULL CHECK(total_pages BETWEEN 0 AND 60),
  total_results integer NOT NULL CHECK(total_results BETWEEN 0 AND 15000),
  row_count integer NOT NULL CHECK(row_count BETWEEN 0 AND 250),
  unresolved_count integer NOT NULL CHECK(unresolved_count BETWEEN 0 AND 250),
  excluded_count integer NOT NULL DEFAULT 0 CHECK(excluded_count BETWEEN 0 AND 250),
  excluded_ids integer[] NOT NULL DEFAULT '{}',
  signature text NOT NULL CHECK(signature ~ '^[a-f0-9]{64}$'),
  creation_xid xid8 NOT NULL DEFAULT pg_current_xact_id(),
  observed_at timestamptz NOT NULL,
  PRIMARY KEY(sweep_id,page),
  CHECK(total_pages=(total_results+249)/250), CHECK(page<=greatest(1,total_pages)),
  CHECK(cardinality(excluded_ids)=excluded_count AND array_position(excluded_ids,NULL) IS NULL)
);
CREATE TABLE app.watchmode_memberships (
  sweep_id uuid NOT NULL, page integer NOT NULL,
  watchmode_id integer NOT NULL CHECK(watchmode_id>0),
  tmdb_id text CHECK(tmdb_id ~ '^[1-9][0-9]{0,9}$' AND tmdb_id::bigint<=2147483647),
  popularity double precision CHECK(popularity BETWEEN 0 AND 100),
  observed_at timestamptz NOT NULL,
  PRIMARY KEY(sweep_id,watchmode_id),
  FOREIGN KEY(sweep_id,page) REFERENCES app.watchmode_pages ON DELETE CASCADE
);
CREATE INDEX watchmode_memberships_identity ON app.watchmode_memberships(watchmode_id,tmdb_id);
CREATE INDEX watchmode_memberships_age ON app.watchmode_memberships(observed_at);
CREATE TABLE app.watchmode_sweep_events (
  sweep_id uuid PRIMARY KEY REFERENCES app.watchmode_sweeps ON DELETE CASCADE,
  outcome text NOT NULL CHECK(outcome IN ('complete','failed','expired','generation_changed','superseded')),
  code text NOT NULL CHECK(code ~ '^[a-z_]{1,64}$'), observed_at timestamptz NOT NULL
);
-- Advancement is per promoted set, separate from movie writes; an interrupted write can
-- repeat safely through the existing metadata store's identity/idempotence checks.
CREATE TABLE app.watchmode_enrichment_checks (
  sweep_id uuid NOT NULL REFERENCES app.watchmode_sweeps ON DELETE CASCADE,
  watchmode_id integer NOT NULL CHECK(watchmode_id>0),
  outcome text NOT NULL CHECK(outcome IN ('created','updated','unchanged','stale','failed','not_found','identity_conflict')),
  observed_at timestamptz NOT NULL, checked_at timestamptz NOT NULL,
  PRIMARY KEY(sweep_id,watchmode_id,checked_at),
  FOREIGN KEY(sweep_id,watchmode_id) REFERENCES app.watchmode_memberships ON DELETE CASCADE
);
CREATE INDEX watchmode_enrichment_checks_time ON app.watchmode_enrichment_checks(checked_at DESC);
-- Operational request identities and outcomes, independent of current memberships.
-- The evidence stage supplies their age-based DELETE path before any retained run.
CREATE TABLE app.metadata_detail_attempts (
  tmdb_id text NOT NULL CHECK(tmdb_id ~ '^[1-9][0-9]{0,9}$' AND tmdb_id::bigint<=2147483647),
  outcome text NOT NULL CHECK(outcome IN ('created','updated','unchanged','stale','failed','not_found','identity_conflict')),
  checked_at timestamptz NOT NULL, PRIMARY KEY(tmdb_id,checked_at)
);
CREATE INDEX metadata_detail_attempts_time ON app.metadata_detail_attempts(checked_at);
CREATE FUNCTION app.check_watchmode_evidence() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $$
DECLARE parent_time timestamptz; page_xid xid8; page_count integer; expected integer; results integer; oldest integer; newest integer; members integer;
BEGIN
  IF TG_TABLE_NAME='watchmode_pages' THEN
    IF EXISTS(SELECT 1 FROM unnest(NEW.excluded_ids) id WHERE id<=0) THEN
      RAISE EXCEPTION 'Invalid excluded identity' USING ERRCODE='23514';
    END IF;
    IF EXISTS(SELECT 1 FROM app.watchmode_sweep_events WHERE sweep_id=NEW.sweep_id) THEN
      RAISE EXCEPTION 'Sweep sealed' USING ERRCODE='23514';
    END IF;
    SELECT observed_at INTO parent_time FROM app.watchmode_sweeps WHERE id=NEW.sweep_id;
    IF NEW.observed_at<parent_time THEN RAISE EXCEPTION 'Observation before sweep' USING ERRCODE='23514'; END IF;
    NEW.creation_xid:=pg_current_xact_id();
  ELSIF TG_TABLE_NAME='watchmode_memberships' THEN
    SELECT creation_xid,observed_at INTO page_xid,parent_time FROM app.watchmode_pages WHERE sweep_id=NEW.sweep_id AND page=NEW.page;
    IF FOUND AND page_xid<>pg_current_xact_id() THEN
      RAISE EXCEPTION 'Page membership sealed' USING ERRCODE='23514';
    END IF;
    NEW.observed_at:=parent_time;
  ELSIF TG_TABLE_NAME='watchmode_enrichment_checks' THEN
    IF NOT EXISTS(SELECT 1 FROM app.watchmode_sweep_events WHERE sweep_id=NEW.sweep_id AND outcome='complete') THEN
      RAISE EXCEPTION 'Enrichment requires promotion' USING ERRCODE='23514';
    END IF;
    SELECT observed_at INTO parent_time FROM app.watchmode_memberships WHERE sweep_id=NEW.sweep_id AND watchmode_id=NEW.watchmode_id;
    IF NEW.checked_at<parent_time THEN RAISE EXCEPTION 'Check before observation' USING ERRCODE='23514'; END IF;
    -- An enrichment operation cannot renew the provider ID's acquisition age.
    NEW.observed_at:=parent_time;
  ELSIF TG_TABLE_NAME='watchmode_sweep_events' THEN
    SELECT observed_at INTO parent_time FROM app.watchmode_sweeps WHERE id=NEW.sweep_id;
    IF NEW.observed_at<parent_time OR NEW.observed_at<(SELECT max(observed_at) FROM app.watchmode_pages WHERE sweep_id=NEW.sweep_id) THEN
      RAISE EXCEPTION 'Completion before observation' USING ERRCODE='23514';
    END IF;
    IF NEW.outcome='complete' THEN
      SELECT count(*),min(total_pages),min(total_results),min(page),max(page) INTO page_count,expected,results,oldest,newest FROM app.watchmode_pages WHERE sweep_id=NEW.sweep_id;
      SELECT count(*) INTO members FROM app.watchmode_memberships WHERE sweep_id=NEW.sweep_id;
      IF expected IS NULL OR page_count<>greatest(1,expected) OR oldest<>1 OR newest<>page_count OR
        members+(SELECT coalesce(sum(excluded_count),0) FROM app.watchmode_pages WHERE sweep_id=NEW.sweep_id)<>results OR
        EXISTS(SELECT 1 FROM app.watchmode_pages p WHERE sweep_id=NEW.sweep_id AND
          (total_pages<>expected OR total_results<>results OR unresolved_count<>0 OR
           row_count+excluded_count<>least(250,greatest(0,results-(page-1)*250)) OR
           row_count<>(SELECT count(*) FROM app.watchmode_memberships m WHERE m.sweep_id=p.sweep_id AND m.page=p.page))) THEN
        RAISE EXCEPTION 'Incomplete sweep' USING ERRCODE='23514';
      END IF;
      IF EXISTS(SELECT id FROM (
          SELECT watchmode_id AS id FROM app.watchmode_memberships WHERE sweep_id=NEW.sweep_id
          UNION ALL
          SELECT unnest(excluded_ids) FROM app.watchmode_pages WHERE sweep_id=NEW.sweep_id
        ) ids GROUP BY id HAVING count(*)>1) THEN
        RAISE EXCEPTION 'Repeated sweep identity' USING ERRCODE='23514';
      END IF;
    END IF;
  ELSE
    RAISE EXCEPTION 'Unknown evidence table' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app.check_watchmode_evidence() FROM PUBLIC,anon,authenticated,service_role;
CREATE TRIGGER watchmode_pages_seal BEFORE INSERT ON app.watchmode_pages FOR EACH ROW EXECUTE FUNCTION app.check_watchmode_evidence();
CREATE TRIGGER watchmode_memberships_seal BEFORE INSERT ON app.watchmode_memberships FOR EACH ROW EXECUTE FUNCTION app.check_watchmode_evidence();
CREATE TRIGGER watchmode_sweep_events_seal BEFORE INSERT ON app.watchmode_sweep_events FOR EACH ROW EXECUTE FUNCTION app.check_watchmode_evidence();
CREATE TRIGGER watchmode_enrichment_checks_age BEFORE INSERT ON app.watchmode_enrichment_checks FOR EACH ROW EXECUTE FUNCTION app.check_watchmode_evidence();
REVOKE ALL ON app.watchmode_sweeps,app.watchmode_pages,app.watchmode_memberships,
  app.watchmode_sweep_events,app.watchmode_enrichment_checks,app.metadata_detail_attempts FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT,INSERT,UPDATE,DELETE ON app.watchmode_sweeps,app.watchmode_pages,
  app.watchmode_memberships,app.watchmode_sweep_events,app.watchmode_enrichment_checks,app.metadata_detail_attempts TO service_role;
ALTER TABLE app.watchmode_sweeps ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.watchmode_pages ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.watchmode_memberships ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.watchmode_sweep_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.watchmode_enrichment_checks ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.metadata_detail_attempts ENABLE ROW LEVEL SECURITY;
CREATE TRIGGER watchmode_sweeps_immutable BEFORE UPDATE OR DELETE ON app.watchmode_sweeps FOR EACH ROW EXECUTE FUNCTION app.guard_immutable_record();
CREATE TRIGGER watchmode_pages_immutable BEFORE UPDATE OR DELETE ON app.watchmode_pages FOR EACH ROW EXECUTE FUNCTION app.guard_immutable_record();
CREATE TRIGGER watchmode_memberships_immutable BEFORE UPDATE OR DELETE ON app.watchmode_memberships FOR EACH ROW EXECUTE FUNCTION app.guard_immutable_record();
CREATE TRIGGER watchmode_sweep_events_immutable BEFORE UPDATE OR DELETE ON app.watchmode_sweep_events FOR EACH ROW EXECUTE FUNCTION app.guard_immutable_record();
CREATE TRIGGER watchmode_enrichment_checks_immutable BEFORE UPDATE OR DELETE ON app.watchmode_enrichment_checks FOR EACH ROW EXECUTE FUNCTION app.guard_immutable_record();
CREATE TRIGGER metadata_detail_attempts_immutable BEFORE UPDATE OR DELETE ON app.metadata_detail_attempts FOR EACH ROW EXECUTE FUNCTION app.guard_immutable_record();
COMMIT;
