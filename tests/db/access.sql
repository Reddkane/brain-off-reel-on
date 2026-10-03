-- Keep suite writes rollback-only inside the psql-owned transaction.
SAVEPOINT access_suite;
-- SYNTHETIC TEST DATA — not provider records or personal preferences.
DO $$
DECLARE role_name text; item record; name text; table_name text; subject text; n integer; expected text; answer jsonb; before_row jsonb; column_name text; allowed boolean;
BEGIN
  FOREACH name IN ARRAY ARRAY['profile-isolation','feedback-isolation','anon-private-read','account-column-grant','service-ownership','authenticated-ownership'] LOOP PERFORM test_support.acceptance(name); END LOOP;
  FOR item IN SELECT rolname,rolsuper,rolbypassrls FROM pg_roles WHERE rolname IN ('anon','authenticated','service_role') LOOP
    PERFORM test_support.ok('role-'||item.rolname,NOT item.rolsuper AND item.rolbypassrls=(item.rolname='service_role') AND NOT pg_has_role(item.rolname,'bor_migrator','MEMBER'));
  END LOOP;
  FOR n IN 1..4 LOOP
    subject:=CASE WHEN n<3 THEN '10000000-0000-4000-8000-'||lpad(n::text,12,'0') ELSE '' END;
    answer:=test_support.statement('SELECT jsonb_build_object(''role'',current_user,''uid'',auth.uid(),''super'',(SELECT rolsuper FROM pg_roles WHERE rolname=current_user),''bypass'',(SELECT rolbypassrls FROM pg_roles WHERE rolname=current_user))','authenticated',subject);
    PERFORM test_support.ok('identity-context-'||n,answer->>'role'='authenticated' AND answer->>'super'='false' AND answer->>'bypass'='false' AND (answer->>'uid') IS NOT DISTINCT FROM nullif(subject,''));
    FOREACH table_name IN ARRAY ARRAY['profiles','profile_subscriptions','profile_movies','selection_sessions','recommendations','feedback_events'] LOOP
      column_name:=CASE table_name WHEN 'profile_subscriptions' THEN 'profile_id' WHEN 'profile_movies' THEN 'profile_id' ELSE 'id' END;
      expected:=CASE WHEN n>2 THEN '[]' ELSE '["'||CASE table_name WHEN 'profiles' THEN '2' WHEN 'profile_subscriptions' THEN '2' WHEN 'profile_movies' THEN '2' WHEN 'selection_sessions' THEN '7' WHEN 'recommendations' THEN '8' ELSE '9' END||'0000000-0000-4000-8000-'||lpad(n::text,12,'0')||'"]' END;
      answer:=test_support.statement(format('SELECT coalesce(jsonb_agg(%I ORDER BY %I),''[]''::jsonb) FROM app.%I',column_name,column_name,table_name),'authenticated',subject);
      PERFORM test_support.ok('owned-ids-'||table_name||'-'||n,answer=expected::jsonb);
    END LOOP;
  END LOOP;
  PERFORM test_support.statement($q$DO $ctx$ BEGIN
    PERFORM set_config('request.jwt.claims','{"sub":"10000000-0000-4000-8000-000000000002"}',true);
    IF auth.uid()<>'10000000-0000-4000-8000-000000000002'::uuid THEN RAISE EXCEPTION 'claims fallback mismatch'; END IF;
    PERFORM set_config('request.jwt.claims','{"sub":null}',true);
    IF auth.uid() IS NOT NULL THEN RAISE EXCEPTION 'null claims mismatch'; END IF;
  END $ctx$;$q$,'authenticated');
  PERFORM test_support.ok('claims-json-fallback-and-null',true);
  -- Effective ACLs, including individual columns; table-wide writes would override these.
  FOREACH role_name IN ARRAY ARRAY['anon','authenticated','service_role'] LOOP
    PERFORM test_support.ok('actual-role-context-'||role_name,test_support.statement('SELECT to_jsonb(current_user)',role_name)=to_jsonb(role_name));
    PERFORM test_support.ok('schema-usage-'||role_name,has_schema_privilege(role_name,'app','USAGE')=(role_name<>'anon') AND NOT has_schema_privilege(role_name,'app','CREATE'));
    FOR item IN SELECT tablename FROM pg_tables WHERE schemaname='app' LOOP
      table_name:=item.tablename;
      FOREACH name IN ARRAY ARRAY['TRUNCATE','REFERENCES','TRIGGER','MAINTAIN'] LOOP
        PERFORM test_support.ok('acl-'||role_name||'-'||table_name||'-'||name,NOT has_table_privilege(role_name,'app.'||table_name,name));
      END LOOP;
      PERFORM test_support.ok('select-acl-'||role_name||'-'||table_name,has_table_privilege(role_name,'app.'||table_name,'SELECT')=(role_name='service_role' OR (role_name='authenticated' AND table_name<>'refresh_runs')));
      FOREACH name IN ARRAY ARRAY['INSERT','UPDATE','DELETE'] LOOP
        allowed:=role_name='service_role' OR (role_name='authenticated' AND name='DELETE' AND table_name IN ('profile_subscriptions','profile_movies'));
        PERFORM test_support.ok('table-acl-'||role_name||'-'||table_name||'-'||name,has_table_privilege(role_name,'app.'||table_name,name)=allowed);
      END LOOP;
      FOR column_name IN SELECT c.column_name FROM information_schema.columns c WHERE c.table_schema='app' AND c.table_name=item.tablename LOOP
        FOREACH name IN ARRAY ARRAY['INSERT','UPDATE'] LOOP
          allowed:=role_name='service_role' OR (role_name='authenticated' AND (
            (table_name='profiles' AND name='UPDATE' AND column_name IN ('region','runtime_ceiling_minutes','known_languages','subtitle_policy','content_policy')) OR
            (table_name='profile_subscriptions' AND ((name='INSERT' AND column_name IN ('profile_id','provider_id','enabled')) OR (name='UPDATE' AND column_name='enabled'))) OR
            (table_name='profile_movies' AND ((name='INSERT' AND column_name IN ('profile_id','movie_id','watched','watched_on','taste_rating','tired_viewing_rating','permanent_exclusion')) OR (name='UPDATE' AND column_name IN ('watched','watched_on','taste_rating','tired_viewing_rating','permanent_exclusion'))))));
          PERFORM test_support.ok('column-acl-'||role_name||'-'||table_name||'-'||column_name||'-'||name,has_column_privilege(role_name,'app.'||table_name,column_name,name)=allowed);
        END LOOP;
      END LOOP;
    END LOOP;
    FOR item IN SELECT oid,proname FROM pg_proc WHERE pronamespace='app'::regnamespace LOOP
      allowed:=role_name<>'anon' AND item.proname IN ('text_array_nonblank','profile_content_policy_valid');
      PERFORM test_support.ok('function-acl-'||role_name||'-'||item.proname,has_function_privilege(role_name,item.oid,'EXECUTE')=allowed);
    END LOOP;
  END LOOP;
  PERFORM test_support.ok('no-public-object-acls',NOT EXISTS(SELECT 1 FROM pg_class c CROSS JOIN LATERAL aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) a WHERE c.relnamespace='app'::regnamespace AND a.grantee=0) AND NOT EXISTS(SELECT 1 FROM pg_proc p CROSS JOIN LATERAL aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a WHERE p.pronamespace='app'::regnamespace AND a.grantee=0));
  PERFORM test_support.ok('default-table-acls',NOT EXISTS(SELECT 1 FROM pg_default_acl d CROSS JOIN LATERAL aclexplode(d.defaclacl) a WHERE d.defaclrole='bor_migrator'::regrole AND d.defaclobjtype IN ('r','S') AND a.grantee IN (0,'anon'::regrole,'authenticated'::regrole,'service_role'::regrole)));
  PERFORM test_support.ok('test-support-private',NOT has_schema_privilege('authenticated','test_support','USAGE') AND NOT has_schema_privilege('service_role','test_support','USAGE'));
  -- Foreign writes return zero; read back unchanged values under the owner.
  before_row:=(SELECT to_jsonb(p) FROM app.profiles p WHERE id='20000000-0000-4000-8000-000000000002');
  answer:=test_support.statement($q$WITH changed AS (UPDATE app.profiles SET region='CA' WHERE id='20000000-0000-4000-8000-000000000002' RETURNING id) SELECT to_jsonb(count(*)) FROM changed$q$,'authenticated','10000000-0000-4000-8000-000000000001');
  PERFORM test_support.ok('foreign-update-zero',answer='0' AND before_row=(SELECT to_jsonb(p) FROM app.profiles p WHERE id='20000000-0000-4000-8000-000000000002'));
  FOREACH table_name IN ARRAY ARRAY['profile_subscriptions','profile_movies'] LOOP
    before_row:=test_support.statement(format('SELECT to_jsonb(t) FROM app.%I t WHERE profile_id=''20000000-0000-4000-8000-000000000002''',table_name));
    answer:=test_support.statement(format('WITH changed AS (DELETE FROM app.%I WHERE profile_id=''20000000-0000-4000-8000-000000000002'' RETURNING *) SELECT to_jsonb(count(*)) FROM changed',table_name),'authenticated','10000000-0000-4000-8000-000000000001');
    PERFORM test_support.ok('foreign-delete-zero-'||table_name,answer='0' AND before_row=test_support.statement(format('SELECT to_jsonb(t) FROM app.%I t WHERE profile_id=''20000000-0000-4000-8000-000000000002''',table_name)));
    answer:=test_support.statement(format('WITH changed AS (UPDATE app.%I SET %I=false WHERE profile_id=''20000000-0000-4000-8000-000000000002'' RETURNING *) SELECT to_jsonb(count(*)) FROM changed',table_name,CASE table_name WHEN 'profile_subscriptions' THEN 'enabled' ELSE 'watched' END),'authenticated','10000000-0000-4000-8000-000000000001');
    PERFORM test_support.ok('foreign-update-zero-'||table_name,answer='0' AND before_row=test_support.statement(format('SELECT to_jsonb(t) FROM app.%I t WHERE profile_id=''20000000-0000-4000-8000-000000000002''',table_name)));
  END LOOP;
  PERFORM test_support.denied('foreign-subscription-insert',$q$INSERT INTO app.profile_subscriptions(profile_id,provider_id) VALUES('20000000-0000-4000-8000-000000000002','40000000-0000-4000-8000-000000000003')$q$,'42501',NULL,'authenticated','10000000-0000-4000-8000-000000000001');
  PERFORM test_support.denied('foreign-state-insert',$q$INSERT INTO app.profile_movies(profile_id,movie_id) VALUES('20000000-0000-4000-8000-000000000002','30000000-0000-4000-8000-000000000002')$q$,'42501',NULL,'authenticated','10000000-0000-4000-8000-000000000001');
  PERFORM test_support.statement($q$UPDATE app.profiles SET runtime_ceiling_minutes=95,known_languages=ARRAY['synthetic-language'],content_policy='{"exclude_horror":false}',subtitle_policy='allowed',region='CA' WHERE id='20000000-0000-4000-8000-000000000001'$q$,'authenticated','10000000-0000-4000-8000-000000000001');
  PERFORM test_support.ok('own-preferences-revision',(SELECT revision=2 AND updated_at=now() AND created_at='2026-01-01Z' FROM app.profiles WHERE id='20000000-0000-4000-8000-000000000001'));
  PERFORM test_support.statement($q$INSERT INTO app.profile_subscriptions(profile_id,provider_id,enabled) VALUES('20000000-0000-4000-8000-000000000001','40000000-0000-4000-8000-000000000003',false)$q$,'authenticated','10000000-0000-4000-8000-000000000001');
  PERFORM test_support.statement($q$UPDATE app.profile_subscriptions SET enabled=true WHERE profile_id='20000000-0000-4000-8000-000000000001'$q$,'authenticated','10000000-0000-4000-8000-000000000001');
  PERFORM test_support.statement($q$DELETE FROM app.profile_subscriptions WHERE profile_id='20000000-0000-4000-8000-000000000001' AND provider_id='40000000-0000-4000-8000-000000000003'$q$,'authenticated','10000000-0000-4000-8000-000000000001');
  PERFORM test_support.statement($q$INSERT INTO app.profile_movies(profile_id,movie_id,watched,taste_rating,tired_viewing_rating,permanent_exclusion) VALUES('20000000-0000-4000-8000-000000000001','30000000-0000-4000-8000-000000000002',true,'loved',0,true)$q$,'authenticated','10000000-0000-4000-8000-000000000001');
  PERFORM test_support.statement($q$UPDATE app.profile_movies SET watched_on='2026-01-01' WHERE profile_id='20000000-0000-4000-8000-000000000001' AND movie_id='30000000-0000-4000-8000-000000000002'$q$,'authenticated','10000000-0000-4000-8000-000000000001');
  PERFORM test_support.ok('own-state-timestamp',(SELECT updated_at=now() AND watched_on='2026-01-01' FROM app.profile_movies WHERE profile_id='20000000-0000-4000-8000-000000000001' AND movie_id='30000000-0000-4000-8000-000000000002'));
  PERFORM test_support.statement($q$DELETE FROM app.profile_movies WHERE profile_id='20000000-0000-4000-8000-000000000001' AND movie_id='30000000-0000-4000-8000-000000000002'$q$,'authenticated','10000000-0000-4000-8000-000000000001');
  PERFORM test_support.ok('own-personal-writes',(SELECT count(*)=3 FROM app.profile_movies) AND (SELECT count(*)=3 FROM app.profile_subscriptions));
  FOR item IN SELECT * FROM (VALUES
    ('profile-id',$q$UPDATE app.profiles SET id=gen_random_uuid()$q$),('profile-owner',$q$UPDATE app.profiles SET account_id=NULL$q$),
    ('profile-revision',$q$UPDATE app.profiles SET revision=10$q$),('profile-created',$q$UPDATE app.profiles SET created_at=now()$q$),('profile-updated',$q$UPDATE app.profiles SET updated_at=now()$q$),
    ('subscription-key',$q$UPDATE app.profile_subscriptions SET provider_id=gen_random_uuid()$q$),('state-key',$q$UPDATE app.profile_movies SET profile_id=gen_random_uuid()$q$),
    ('session-server',$q$UPDATE app.selection_sessions SET outcome='active'$q$),('recommendation-server',$q$INSERT INTO app.recommendations(id) VALUES(gen_random_uuid())$q$),('feedback-server',$q$DELETE FROM app.feedback_events$q$),
    ('shared-write',$q$UPDATE app.movies SET title='forbidden'$q$),('refresh-read',$q$SELECT count(*) FROM app.refresh_runs$q$),('ddl',$q$CREATE TABLE app.forbidden(id integer)$q$),('truncate',$q$TRUNCATE app.profiles$q$),('trigger-call',$q$SELECT app.guard_identity()$q$)
  ) cases(name,sql) LOOP PERFORM test_support.denied('authenticated-'||item.name,item.sql,'42501',NULL,'authenticated','10000000-0000-4000-8000-000000000001'); END LOOP;
  PERFORM test_support.denied('authenticated-native-policy-check',$q$UPDATE app.profiles SET content_policy='{"exclude_horror":null}' WHERE id='20000000-0000-4000-8000-000000000001'$q$,'23514','profiles_content_policy_check','authenticated','10000000-0000-4000-8000-000000000001');
  FOREACH table_name IN ARRAY ARRAY['movies','movie_external_ids','movie_credits','movie_classifications','streaming_providers','streaming_provider_external_ids','availability_snapshots','movie_availability','availability_tracks','availability_observations'] LOOP
    PERFORM test_support.ok('shared-readable-'||table_name,test_support.statement(format('SELECT to_jsonb(count(*)) FROM app.%I',table_name),'authenticated')=test_support.statement(format('SELECT to_jsonb(count(*)) FROM app.%I',table_name)));
  END LOOP;
  FOREACH table_name IN ARRAY ARRAY['profiles','selection_sessions','recommendations','feedback_events','refresh_runs','movies'] LOOP
    PERFORM test_support.denied('anon-read-'||table_name,format('SELECT count(*) FROM app.%I',table_name),'42501',NULL,'anon');
    PERFORM test_support.denied('anon-delete-'||table_name,format('DELETE FROM app.%I',table_name),'42501',NULL,'anon');
  END LOOP;
  PERFORM test_support.denied('anon-ddl','CREATE TABLE app.forbidden(id integer)','42501',NULL,'anon');
  PERFORM test_support.denied('anon-truncate','TRUNCATE app.profiles','42501',NULL,'anon');
  PERFORM test_support.denied('anon-helper','SELECT app.text_array_nonblank(ARRAY[''a''])','42501',NULL,'anon');
  PERFORM test_support.ok('service-bypass-visible',test_support.statement('SELECT to_jsonb(count(*)) FROM app.profiles','service_role')='3');
  PERFORM test_support.statement($q$INSERT INTO app.movies(title,metadata_source,metadata_refreshed_at,genres) VALUES('Synthetic Service Insert','synthetic_catalog','2026-01-01Z',ARRAY['synthetic genre'])$q$,'service_role');
  PERFORM test_support.statement($q$UPDATE app.refresh_runs SET processed_count=4 WHERE id='a0000000-0000-4000-8000-000000000001'$q$,'service_role');
  PERFORM test_support.ok('service-refresh-write',(SELECT processed_count=4 FROM app.refresh_runs WHERE id='a0000000-0000-4000-8000-000000000001'));
  PERFORM test_support.denied('service-native-genres',$q$INSERT INTO app.movies(title,metadata_source,metadata_refreshed_at,genres) VALUES('Synthetic Invalid','synthetic','2026-01-01Z',ARRAY[''])$q$,'23514','movies_genres_check','service_role');
  PERFORM test_support.denied('service-no-ddl','CREATE TABLE app.forbidden(id integer)','42501',NULL,'service_role');
  PERFORM test_support.denied('service-no-trigger-call','SELECT app.guard_immutable_record()','42501',NULL,'service_role');
END $$;
-- Temporarily remove the schema/table grant barriers to test RLS and helper ACLs independently.
SAVEPOINT anon_rls;
GRANT USAGE ON SCHEMA app TO anon;
GRANT SELECT ON ALL TABLES IN SCHEMA app TO anon;
DO $$ DECLARE table_name text; BEGIN
  FOR table_name IN SELECT tablename FROM pg_tables WHERE schemaname='app' LOOP
    PERFORM test_support.ok('anon-independent-rls-'||table_name,test_support.statement(format('SELECT to_jsonb(count(*)) FROM app.%I',table_name),'anon')='0');
  END LOOP;
  PERFORM test_support.denied('anon-independent-array-execute','SELECT app.text_array_nonblank(ARRAY[''a''])','42501',NULL,'anon');
  PERFORM test_support.denied('anon-independent-policy-execute','SELECT app.profile_content_policy_valid(''{}'')','42501',NULL,'anon');
END $$;
ROLLBACK TO anon_rls;
SELECT test_support.ok('nonzero-access-cases',(SELECT count(*)>1000 FROM test_support.results));
SAVEPOINT default_function_probe;
CREATE FUNCTION app.default_execute_probe() RETURNS boolean
LANGUAGE sql SECURITY INVOKER SET search_path=pg_catalog AS 'SELECT true';
DO $$ DECLARE role_name text; BEGIN
  FOREACH role_name IN ARRAY ARRAY['anon','authenticated','service_role'] LOOP
    PERFORM test_support.ok('default-function-public-execute-'||role_name,has_function_privilege(role_name,'app.default_execute_probe()','EXECUTE'));
  END LOOP;
END $$;
REVOKE ALL ON FUNCTION app.default_execute_probe() FROM PUBLIC,anon,authenticated,service_role;
DO $$ DECLARE role_name text; BEGIN
  FOREACH role_name IN ARRAY ARRAY['anon','authenticated','service_role'] LOOP
    PERFORM test_support.ok('explicit-function-revoke-'||role_name,NOT has_function_privilege(role_name,'app.default_execute_probe()','EXECUTE'));
  END LOOP;
END $$;
ROLLBACK TO default_function_probe;
ROLLBACK TO access_suite;
RELEASE SAVEPOINT access_suite;
