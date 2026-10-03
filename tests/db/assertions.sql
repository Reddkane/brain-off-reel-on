-- Test-only invoker harness. API roles have no test_support privileges.
CREATE TABLE test_support.results (name text PRIMARY KEY);
CREATE FUNCTION test_support.ok(name text, condition boolean) RETURNS void
LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $$
BEGIN
  IF condition IS DISTINCT FROM true THEN RAISE EXCEPTION 'Assertion failed: %',name USING ERRCODE='P0001',CONSTRAINT=name; END IF;
  INSERT INTO test_support.results VALUES(name) ON CONFLICT DO NOTHING;
  RAISE NOTICE 'PASS %',name;
END $$;
CREATE FUNCTION test_support.statement(sql text, role_name text DEFAULT 'bor_migrator', subject text DEFAULT '') RETURNS jsonb
LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $$
DECLARE answer jsonb;
BEGIN
  PERFORM set_config('request.jwt.claim.sub',subject,true);
  PERFORM set_config('request.jwt.claims','{}',true);
  EXECUTE format('SET LOCAL ROLE %I',role_name);
  IF ltrim(sql) ~* '^(SELECT|WITH)\s' THEN EXECUTE sql INTO answer;
  ELSE EXECUTE sql;
  END IF;
  RESET ROLE;
  RETURN answer;
END $$;
CREATE FUNCTION test_support.denied(name text,sql text,state text,constraint_name text DEFAULT NULL,role_name text DEFAULT 'bor_migrator',subject text DEFAULT '') RETURNS void
LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $$
DECLARE actual_state text; actual_constraint text;
BEGIN
  BEGIN
    PERFORM test_support.statement(sql,role_name,subject);
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS actual_state=RETURNED_SQLSTATE,actual_constraint=CONSTRAINT_NAME;
  END;
  IF actual_state IS DISTINCT FROM state OR (constraint_name IS NOT NULL AND actual_constraint IS DISTINCT FROM constraint_name) THEN
    RAISE EXCEPTION 'Expected %/%; actual %/%',state,constraint_name,coalesce(actual_state,'success'),actual_constraint USING ERRCODE='P0001',CONSTRAINT=name;
  END IF;
  PERFORM test_support.ok(name,true);
END $$;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA test_support FROM PUBLIC,anon,authenticated,service_role;

-- Prove that the error helper itself rejects success, wrong SQLSTATE and wrong name.
DO $$
DECLARE probe text; diagnostic text; message text;
BEGIN
  PERFORM test_support.denied('helper-correct-error','SELECT 1/0','22012');
  FOREACH probe IN ARRAY ARRAY['unexpected-success','wrong-state','wrong-constraint'] LOOP
    BEGIN
      IF probe='unexpected-success' THEN
        PERFORM test_support.denied(probe,'SELECT 1','23505');
      ELSIF probe='wrong-state' THEN
        PERFORM test_support.denied(probe,'DO $x$ BEGIN RAISE EXCEPTION USING ERRCODE=''23514'',CONSTRAINT=''actual''; END $x$','23505');
      ELSE
        PERFORM test_support.denied(probe,'DO $x$ BEGIN RAISE EXCEPTION USING ERRCODE=''23514'',CONSTRAINT=''actual''; END $x$','23514','different');
      END IF;
      RAISE EXCEPTION 'Helper self-test unexpectedly passed' USING ERRCODE='XX000';
    EXCEPTION WHEN SQLSTATE 'P0001' THEN
      GET STACKED DIAGNOSTICS diagnostic=CONSTRAINT_NAME,message=MESSAGE_TEXT;
      IF diagnostic<>probe OR (CASE probe WHEN 'unexpected-success' THEN message NOT LIKE '%actual success/%' WHEN 'wrong-state' THEN message NOT LIKE '%actual 23514/actual%' ELSE message NOT LIKE '%different; actual 23514/actual%' END) THEN RAISE; END IF;
      RAISE NOTICE 'EXPECTED RED helper %',probe;
    END;
  END LOOP;
END $$;

-- Reused by green suites and rollback-only regression controls.
CREATE FUNCTION test_support.acceptance(name text) RETURNS void
LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $$
DECLARE sql text; answer jsonb;
BEGIN
  CASE name
    WHEN 'duplicate-mapping' THEN
      PERFORM test_support.denied(name,$q$INSERT INTO app.movie_external_ids VALUES ('30000000-0000-4000-8000-000000000003','synthetic_catalog','fixture-1')$q$,'23505','movie_external_ids_source_external_id_key');
    WHEN 'profile-isolation' THEN
      answer:=test_support.statement('SELECT coalesce(jsonb_agg(id ORDER BY id),''[]''::jsonb) FROM app.profiles','authenticated','10000000-0000-4000-8000-000000000001');
      PERFORM test_support.ok(name,answer='["20000000-0000-4000-8000-000000000001"]');
    WHEN 'feedback-isolation' THEN
      answer:=test_support.statement('SELECT coalesce(jsonb_agg(id ORDER BY id),''[]''::jsonb) FROM app.feedback_events','authenticated','10000000-0000-4000-8000-000000000001');
      PERFORM test_support.ok(name,answer='["90000000-0000-4000-8000-000000000001"]');
    WHEN 'anon-private-read' THEN
      PERFORM test_support.denied(name,'SELECT count(*) FROM app.profiles','42501',NULL,'anon');
    WHEN 'account-column-grant' THEN
      PERFORM test_support.ok(name,NOT has_column_privilege('authenticated','app.profiles','account_id','UPDATE'));
    WHEN 'service-ownership' THEN
      PERFORM test_support.denied(name,$q$UPDATE app.profiles SET account_id='10000000-0000-4000-8000-000000000002' WHERE id='20000000-0000-4000-8000-000000000001'$q$,'23514','profiles_ownership_check','service_role');
    WHEN 'authenticated-ownership' THEN
      PERFORM test_support.denied(name,$q$UPDATE app.profiles SET account_id='10000000-0000-4000-8000-000000000002' WHERE id='20000000-0000-4000-8000-000000000001'$q$,'42501',NULL,'authenticated','10000000-0000-4000-8000-000000000001');
      PERFORM test_support.ok(name,(SELECT account_id='10000000-0000-4000-8000-000000000001' FROM app.profiles WHERE id='20000000-0000-4000-8000-000000000001'));
    WHEN 'classification-immutable' THEN
      PERFORM test_support.denied(name,$q$UPDATE app.movie_classifications SET review_status='needs_review' WHERE id='60000000-0000-4000-8000-000000000001'$q$,'23514','movie_classifications_immutable_check');
    WHEN 'session-delete' THEN
      PERFORM test_support.denied(name,$q$DELETE FROM app.selection_sessions WHERE id='70000000-0000-4000-8000-000000000003'$q$,'23514','selection_sessions_immutable_check','service_role');
    WHEN 'same-session-selection' THEN
      PERFORM test_support.denied(name,$q$UPDATE app.selection_sessions SET selected_recommendation_id='80000000-0000-4000-8000-000000000002' WHERE id='70000000-0000-4000-8000-000000000001'$q$,'23503','selection_sessions_selected_recommendation_fk');
    WHEN 'snapshot-sealed' THEN
      PERFORM test_support.denied(name,$q$INSERT INTO app.movie_availability VALUES ('50000000-0000-4000-8000-000000000008','40000000-0000-4000-8000-000000000003','free')$q$,'23514','availability_snapshot_sealed_check');
    WHEN 'observation-offer' THEN
      INSERT INTO app.availability_snapshots(id,movie_id,region,source,checked_at,refresh_deadline,outcome) VALUES('50000000-0000-4000-8000-000000000099','30000000-0000-4000-8000-000000000001','US','synthetic_availability','2026-10-01Z','2026-10-03Z','success');
      PERFORM test_support.denied(name,$q$INSERT INTO app.availability_observations(snapshot_id,movie_id,provider_id,region,source,offer_type,state) VALUES ('50000000-0000-4000-8000-000000000099','30000000-0000-4000-8000-000000000001','40000000-0000-4000-8000-000000000001','US','synthetic_availability','subscription','present')$q$,'23514','availability_observation_offer_check');
    ELSE RAISE EXCEPTION 'Unknown acceptance case %',name;
  END CASE;
END $$;
REVOKE ALL ON FUNCTION test_support.acceptance(text) FROM PUBLIC,anon,authenticated,service_role;
