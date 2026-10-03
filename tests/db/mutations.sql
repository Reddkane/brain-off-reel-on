-- Keep suite writes rollback-only inside the psql-owned transaction.
SAVEPOINT mutations_suite;
-- Each nested exception rolls back BOTH the temporary DDL and test writes.
DO $$
DECLARE control record; diagnostic text; definition text; message text;
BEGIN
  FOR control IN SELECT * FROM (VALUES
    ('duplicate-mapping','ALTER TABLE app.movie_external_ids DROP CONSTRAINT movie_external_ids_source_external_id_key'),
    ('profile-isolation','ALTER TABLE app.profiles DISABLE ROW LEVEL SECURITY'),
    ('feedback-isolation','ALTER POLICY owned_select ON app.feedback_events USING (true)'),
    ('anon-private-read','GRANT USAGE ON SCHEMA app TO anon; GRANT SELECT ON app.profiles TO anon; CREATE POLICY broken_anon ON app.profiles FOR SELECT TO anon USING (true)'),
    ('account-column-grant','GRANT UPDATE(account_id) ON app.profiles TO authenticated'),
    ('service-ownership','ALTER TABLE app.profiles DISABLE TRIGGER trg_profiles_identity'),
    -- PostgreSQL also applies the SELECT predicate to the updated row.
    ('authenticated-ownership','GRANT UPDATE(account_id) ON app.profiles TO authenticated; ALTER TABLE app.profiles DISABLE TRIGGER trg_profiles_identity; ALTER POLICY owned_update ON app.profiles WITH CHECK (true); ALTER POLICY owned_select ON app.profiles USING (true)'),
    ('classification-immutable','ALTER TABLE app.movie_classifications DISABLE TRIGGER trg_movie_classifications_immutable'),
    ('session-delete','ALTER TABLE app.selection_sessions DISABLE TRIGGER trg_selection_sessions_delete'),
    ('same-session-selection','ALTER TABLE app.selection_sessions DROP CONSTRAINT selection_sessions_selected_recommendation_fk'),
    ('snapshot-sealed','seal'),
    ('observation-offer','ALTER TABLE app.availability_observations DISABLE TRIGGER trg_availability_observations_evidence')
  ) AS controls(name,setup) LOOP
    BEGIN
      IF control.setup='seal' THEN
        SELECT pg_get_functiondef('app.check_availability_evidence()'::regprocedure) INTO definition;
        definition:=replace(definition,$seal$IF snapshot.creation_xid<>pg_current_xact_id() THEN
    RAISE EXCEPTION 'Snapshot membership sealed' USING ERRCODE='23514', CONSTRAINT='availability_snapshot_sealed_check';
  END IF;$seal$,'');
        IF definition=pg_get_functiondef('app.check_availability_evidence()'::regprocedure) THEN RAISE EXCEPTION 'Seal mutation setup did not match'; END IF;
        EXECUTE definition;
      ELSE EXECUTE control.setup;
      END IF;
      PERFORM test_support.acceptance(control.name);
      RAISE EXCEPTION 'Mutation not detected: %',control.name USING ERRCODE='XX000';
    EXCEPTION WHEN SQLSTATE 'P0001' THEN
      GET STACKED DIAGNOSTICS diagnostic=CONSTRAINT_NAME,message=MESSAGE_TEXT;
      IF diagnostic<>control.name THEN RAISE; END IF;
      RAISE NOTICE 'EXPECTED RED mutation %: named assertion %; %',control.name,diagnostic,message;
    END;
  END LOOP;
END $$;
ROLLBACK TO mutations_suite;
RELEASE SAVEPOINT mutations_suite;
