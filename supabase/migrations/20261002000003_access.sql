CREATE FUNCTION app.text_array_nonblank(value text[]) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE SECURITY INVOKER SET search_path=pg_catalog AS $$
DECLARE element text;
BEGIN
  IF value IS NULL THEN RETURN false; END IF;
  IF cardinality(value)=0 THEN RETURN true; END IF;
  IF array_ndims(value)<>1 THEN RETURN false; END IF;
  FOREACH element IN ARRAY value LOOP
    IF element IS NULL OR element !~ '\S' THEN RETURN false; END IF;
  END LOOP;
  RETURN true;
END $$;
CREATE FUNCTION app.profile_content_policy_valid(value jsonb) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE SECURITY INVOKER SET search_path=pg_catalog AS $$
DECLARE entry record; element jsonb;
BEGIN
  IF value IS NULL OR jsonb_typeof(value)<>'object' THEN RETURN false; END IF;
  FOR entry IN SELECT key,val FROM jsonb_each(value) AS pairs(key,val) LOOP
    CASE entry.key
      WHEN 'exclude_horror' THEN
        IF jsonb_typeof(entry.val)<>'boolean' THEN RETURN false; END IF;
      WHEN 'us_certification_ceiling' THEN
        IF jsonb_typeof(entry.val)<>'string' OR entry.val #>> '{}' NOT IN ('G','PG','PG-13','R','NC-17') THEN RETURN false; END IF;
      WHEN 'emotional_burden_cap' THEN
        IF jsonb_typeof(entry.val)<>'number' THEN RETURN false; END IF;
        IF (entry.val #>> '{}')::numeric NOT BETWEEN 0 AND 4 OR trunc((entry.val #>> '{}')::numeric)<>(entry.val #>> '{}')::numeric THEN RETURN false; END IF;
      WHEN 'strict_theme_exclusions' THEN
        IF jsonb_typeof(entry.val)<>'array' THEN RETURN false; END IF;
        FOR element IN SELECT jsonb_array_elements(entry.val) LOOP
          IF jsonb_typeof(element)<>'string' OR element #>> '{}' !~ '\S' THEN RETURN false; END IF;
        END LOOP;
      ELSE RETURN false;
    END CASE;
  END LOOP;
  RETURN true;
END $$;
ALTER TABLE app.movies ADD CONSTRAINT movies_genres_check CHECK (app.text_array_nonblank(genres)), ADD CONSTRAINT movies_keywords_check CHECK (app.text_array_nonblank(keywords));
ALTER TABLE app.movie_classifications ADD CONSTRAINT movie_classifications_tone_check CHECK (app.text_array_nonblank(tone)), ADD CONSTRAINT movie_classifications_content_tags_check CHECK (app.text_array_nonblank(content_tags));
ALTER TABLE app.profiles ADD CONSTRAINT profiles_known_languages_check CHECK (app.text_array_nonblank(known_languages)), ADD CONSTRAINT profiles_content_policy_check CHECK (app.profile_content_policy_valid(content_policy));

CREATE FUNCTION app.guard_identity() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $$
DECLARE old_row jsonb := to_jsonb(OLD); new_row jsonb := to_jsonb(NEW); field text;
BEGIN
  FOREACH field IN ARRAY TG_ARGV LOOP
    IF old_row->field IS DISTINCT FROM new_row->field THEN
      RAISE EXCEPTION 'Immutable identity or server field: %',field USING ERRCODE='23514', CONSTRAINT=TG_TABLE_NAME || '_identity_check';
    END IF;
  END LOOP;
  IF TG_TABLE_NAME='profiles' THEN
    IF OLD.account_id IS DISTINCT FROM NEW.account_id AND
      (OLD.account_id IS NOT NULL OR (current_user<>'service_role' AND current_user<>pg_get_userbyid((SELECT relowner FROM pg_class WHERE oid=TG_RELID)))) THEN
      RAISE EXCEPTION 'Immutable profile ownership' USING ERRCODE='23514', CONSTRAINT='profiles_ownership_check';
    END IF;
    IF (OLD.region,OLD.runtime_ceiling_minutes,OLD.known_languages,OLD.subtitle_policy,OLD.content_policy)
      IS DISTINCT FROM (NEW.region,NEW.runtime_ceiling_minutes,NEW.known_languages,NEW.subtitle_policy,NEW.content_policy) THEN
      NEW.revision := OLD.revision+1;
    END IF;
    NEW.updated_at := now();
  END IF;
  RETURN NEW;
END $$;
CREATE FUNCTION app.touch_updated_at() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $$
BEGIN
  IF NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'Immutable creation time' USING ERRCODE='23514', CONSTRAINT=TG_TABLE_NAME || '_identity_check';
  END IF;
  NEW.updated_at := now(); RETURN NEW;
END $$;
CREATE FUNCTION app.guard_immutable_record() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $$
BEGIN
  -- Only FK cascade triggers issue nested DELETE in this exact trigger inventory.
  IF TG_OP='UPDATE' OR pg_trigger_depth()<=1 THEN
    RAISE EXCEPTION 'Append-only record' USING ERRCODE='23514', CONSTRAINT=TG_TABLE_NAME || '_immutable_check';
  END IF;
  RETURN OLD;
END $$;
CREATE FUNCTION app.check_availability_evidence() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $$
DECLARE snapshot app.availability_snapshots%ROWTYPE; track_start timestamptz; has_offer boolean;
BEGIN
  IF TG_TABLE_NAME='availability_snapshots' THEN NEW.creation_xid := pg_current_xact_id(); RETURN NEW; END IF;
  SELECT * INTO snapshot FROM app.availability_snapshots WHERE id=NEW.snapshot_id;
  -- Missing parents are diagnosed by the native foreign key.
  IF NOT FOUND THEN RETURN NEW; END IF;
  IF snapshot.creation_xid<>pg_current_xact_id() THEN
    RAISE EXCEPTION 'Snapshot membership sealed' USING ERRCODE='23514', CONSTRAINT='availability_snapshot_sealed_check';
  END IF;
  IF snapshot.outcome<>'success' THEN
    RAISE EXCEPTION 'Evidence requires success' USING ERRCODE='23514', CONSTRAINT='availability_success_check';
  END IF;
  IF TG_TABLE_NAME='movie_availability' THEN
    IF EXISTS (SELECT 1 FROM app.availability_observations WHERE snapshot_id=NEW.snapshot_id AND provider_id=NEW.provider_id AND offer_type=NEW.offer_type AND state='absent') THEN
      RAISE EXCEPTION 'Offer contradicts absence' USING ERRCODE='23514', CONSTRAINT='availability_offer_absence_check';
    END IF;
  ELSE
    SELECT tracked_since INTO track_start FROM app.availability_tracks WHERE movie_id=NEW.movie_id AND provider_id=NEW.provider_id AND region=NEW.region AND source=NEW.source AND offer_type=NEW.offer_type;
    IF snapshot.checked_at<track_start THEN
      RAISE EXCEPTION 'Observation predates track' USING ERRCODE='23514', CONSTRAINT='availability_track_time_check';
    END IF;
    SELECT EXISTS (SELECT 1 FROM app.movie_availability WHERE snapshot_id=NEW.snapshot_id AND provider_id=NEW.provider_id AND offer_type=NEW.offer_type) INTO has_offer;
    IF (NEW.state='present')<>has_offer THEN
      RAISE EXCEPTION 'Observation disagrees with offers' USING ERRCODE='23514', CONSTRAINT='availability_observation_offer_check';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_movies_identity BEFORE UPDATE ON app.movies FOR EACH ROW EXECUTE FUNCTION app.guard_identity('id','created_at');
CREATE TRIGGER trg_streaming_providers_identity BEFORE UPDATE ON app.streaming_providers FOR EACH ROW EXECUTE FUNCTION app.guard_identity('id','created_at');
CREATE TRIGGER trg_profiles_identity BEFORE UPDATE ON app.profiles FOR EACH ROW EXECUTE FUNCTION app.guard_identity('id','revision','created_at');
CREATE TRIGGER trg_profile_subscriptions_identity BEFORE UPDATE ON app.profile_subscriptions FOR EACH ROW EXECUTE FUNCTION app.guard_identity('profile_id','provider_id');
CREATE TRIGGER trg_profile_movies_identity BEFORE UPDATE ON app.profile_movies FOR EACH ROW EXECUTE FUNCTION app.guard_identity('profile_id','movie_id','created_at');
CREATE TRIGGER trg_selection_sessions_delete BEFORE DELETE ON app.selection_sessions FOR EACH ROW EXECUTE FUNCTION app.guard_immutable_record();
CREATE TRIGGER trg_selection_sessions_identity BEFORE UPDATE ON app.selection_sessions FOR EACH ROW EXECUTE FUNCTION app.guard_identity('id','profile_id','started_at');
CREATE TRIGGER trg_refresh_runs_identity BEFORE UPDATE ON app.refresh_runs FOR EACH ROW EXECUTE FUNCTION app.guard_identity('id','started_at');
CREATE TRIGGER trg_movies_updated_at BEFORE UPDATE ON app.movies FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();
CREATE TRIGGER trg_streaming_providers_updated_at BEFORE UPDATE ON app.streaming_providers FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();
CREATE TRIGGER trg_profile_movies_updated_at BEFORE UPDATE ON app.profile_movies FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();
CREATE TRIGGER trg_movie_classifications_immutable BEFORE UPDATE OR DELETE ON app.movie_classifications FOR EACH ROW EXECUTE FUNCTION app.guard_immutable_record();
CREATE TRIGGER trg_availability_snapshots_immutable BEFORE UPDATE OR DELETE ON app.availability_snapshots FOR EACH ROW EXECUTE FUNCTION app.guard_immutable_record();
CREATE TRIGGER trg_movie_availability_immutable BEFORE UPDATE OR DELETE ON app.movie_availability FOR EACH ROW EXECUTE FUNCTION app.guard_immutable_record();
CREATE TRIGGER trg_availability_tracks_immutable BEFORE UPDATE OR DELETE ON app.availability_tracks FOR EACH ROW EXECUTE FUNCTION app.guard_immutable_record();
CREATE TRIGGER trg_availability_observations_immutable BEFORE UPDATE OR DELETE ON app.availability_observations FOR EACH ROW EXECUTE FUNCTION app.guard_immutable_record();
CREATE TRIGGER trg_recommendations_immutable BEFORE UPDATE OR DELETE ON app.recommendations FOR EACH ROW EXECUTE FUNCTION app.guard_immutable_record();
CREATE TRIGGER trg_feedback_events_immutable BEFORE UPDATE OR DELETE ON app.feedback_events FOR EACH ROW EXECUTE FUNCTION app.guard_immutable_record();
CREATE TRIGGER trg_availability_snapshots_evidence BEFORE INSERT ON app.availability_snapshots FOR EACH ROW EXECUTE FUNCTION app.check_availability_evidence();
CREATE TRIGGER trg_movie_availability_evidence BEFORE INSERT ON app.movie_availability FOR EACH ROW EXECUTE FUNCTION app.check_availability_evidence();
CREATE TRIGGER trg_availability_observations_evidence BEFORE INSERT ON app.availability_observations FOR EACH ROW EXECUTE FUNCTION app.check_availability_evidence();

REVOKE ALL ON SCHEMA app FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON ALL TABLES IN SCHEMA app FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA app FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA app FROM PUBLIC, anon, authenticated, service_role;
GRANT USAGE ON SCHEMA app TO authenticated, service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA app TO service_role;
GRANT SELECT ON app.movies,app.movie_external_ids,app.movie_credits,app.movie_classifications,app.streaming_providers,app.streaming_provider_external_ids,app.availability_snapshots,app.movie_availability,app.availability_tracks,app.availability_observations,app.profiles,app.profile_subscriptions,app.profile_movies,app.selection_sessions,app.recommendations,app.feedback_events TO authenticated;
GRANT UPDATE(region,runtime_ceiling_minutes,known_languages,subtitle_policy,content_policy) ON app.profiles TO authenticated;
GRANT INSERT(profile_id,provider_id,enabled), UPDATE(enabled), DELETE ON app.profile_subscriptions TO authenticated;
GRANT INSERT(profile_id,movie_id,watched,watched_on,taste_rating,tired_viewing_rating,permanent_exclusion), UPDATE(watched,watched_on,taste_rating,tired_viewing_rating,permanent_exclusion), DELETE ON app.profile_movies TO authenticated;
GRANT EXECUTE ON FUNCTION app.text_array_nonblank(text[]),app.profile_content_policy_valid(jsonb) TO authenticated,service_role;

DO $$
DECLARE table_name text; predicate text; action text;
BEGIN
  FOR table_name IN SELECT tablename FROM pg_tables WHERE schemaname='app' LOOP
    EXECUTE format('ALTER TABLE app.%I ENABLE ROW LEVEL SECURITY',table_name);
    EXECUTE format('ALTER TABLE app.%I FORCE ROW LEVEL SECURITY',table_name);
    IF table_name IN ('movies','movie_external_ids','movie_credits','movie_classifications','streaming_providers','streaming_provider_external_ids','availability_snapshots','movie_availability','availability_tracks','availability_observations') THEN
      EXECUTE format('CREATE POLICY shared_select ON app.%I FOR SELECT TO authenticated USING (true)',table_name);
    ELSIF table_name<>'refresh_runs' THEN
      predicate := CASE table_name
        WHEN 'profiles' THEN 'profiles.account_id IS NOT NULL AND profiles.account_id = (SELECT auth.uid())'
        WHEN 'recommendations' THEN 'EXISTS (SELECT 1 FROM app.selection_sessions s JOIN app.profiles p ON p.id=s.profile_id WHERE s.id=recommendations.session_id AND p.account_id IS NOT NULL AND p.account_id=(SELECT auth.uid()))'
        WHEN 'feedback_events' THEN 'EXISTS (SELECT 1 FROM app.recommendations r JOIN app.selection_sessions s ON s.id=r.session_id JOIN app.profiles p ON p.id=s.profile_id WHERE r.id=feedback_events.recommendation_id AND p.account_id IS NOT NULL AND p.account_id=(SELECT auth.uid()))'
        ELSE format('EXISTS (SELECT 1 FROM app.profiles p WHERE p.id=%I.profile_id AND p.account_id IS NOT NULL AND p.account_id=(SELECT auth.uid()))',table_name) END;
      EXECUTE format('CREATE POLICY owned_select ON app.%I FOR SELECT TO authenticated USING (%s)',table_name,predicate);
      IF table_name IN ('profiles','profile_subscriptions','profile_movies') THEN
        EXECUTE format('CREATE POLICY owned_update ON app.%I FOR UPDATE TO authenticated USING (%s) WITH CHECK (%s)',table_name,predicate,predicate);
      END IF;
      IF table_name IN ('profile_subscriptions','profile_movies') THEN
        FOREACH action IN ARRAY ARRAY['insert','delete'] LOOP
          EXECUTE format('CREATE POLICY owned_%s ON app.%I FOR %s TO authenticated %s (%s)',action,table_name,action,CASE action WHEN 'insert' THEN 'WITH CHECK' ELSE 'USING' END,predicate);
        END LOOP;
      END IF;
    END IF;
  END LOOP;
END $$;
