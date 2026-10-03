-- Keep suite writes rollback-only inside the psql-owned transaction.
SAVEPOINT schema_suite;
-- SYNTHETIC TEST DATA — not provider records or personal preferences.
SELECT test_support.ok('migration-owner',current_user='bor_migrator' AND (SELECT NOT rolsuper AND rolbypassrls AND rolcreatedb AND rolcreaterole AND rolreplication FROM pg_roles WHERE rolname=current_user));
SELECT test_support.ok('no-superuser-membership',NOT pg_has_role('bor_migrator','postgres','MEMBER'));
SELECT test_support.ok('explicit-auth-references',has_column_privilege('bor_migrator','auth.users','id','REFERENCES'));
SELECT test_support.ok('marker-version',current_database()='bor_pr02_test' AND current_setting('server_version_num')::integer BETWEEN 170000 AND 179999 AND (SELECT count(*)=1 FROM test_support.marker WHERE name='bor-pr02-disposable'));
SELECT test_support.ok('17-forced-tables',(SELECT count(*)=17 AND bool_and(relrowsecurity AND relforcerowsecurity AND relowner='bor_migrator'::regrole) FROM pg_class WHERE relnamespace='app'::regnamespace AND relkind='r'));
SELECT test_support.ok('six-invoker-functions',(SELECT count(*)=6 AND bool_and(NOT prosecdef AND proconfig=ARRAY['search_path=pg_catalog']) AND count(*) FILTER(WHERE prorettype='trigger'::regtype)=4 AND count(*) FILTER(WHERE provolatile='i' AND prorettype='boolean'::regtype)=2 FROM pg_proc WHERE pronamespace='app'::regnamespace));
SELECT test_support.ok('no-sequences-or-custom-types',NOT EXISTS(SELECT 1 FROM pg_class WHERE relnamespace='app'::regnamespace AND relkind IN ('S','v','m')) AND NOT EXISTS(SELECT 1 FROM pg_type WHERE typnamespace='app'::regnamespace AND typtype IN ('d','e')));
SELECT test_support.ok('21-exact-trigger-bindings',(SELECT count(*)=21 AND bool_and(tgenabled='O') FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid WHERE c.relnamespace='app'::regnamespace AND NOT t.tgisinternal));
SELECT test_support.ok('native-helper-checks',(SELECT count(*)=6 AND bool_and(contype='c' AND pg_get_constraintdef(oid) ~ 'app\.(text_array_nonblank|profile_content_policy_valid)') FROM pg_constraint WHERE connamespace='app'::regnamespace AND conname IN ('movies_genres_check','movies_keywords_check','movie_classifications_tone_check','movie_classifications_content_tags_check','profiles_known_languages_check','profiles_content_policy_check')));
SELECT test_support.ok('selection-fk-immediate',(SELECT NOT condeferrable AND confdeltype='a' FROM pg_constraint WHERE connamespace='app'::regnamespace AND conname='selection_sessions_selected_recommendation_fk'));
SELECT test_support.ok('xid8-storage',(SELECT atttypid='xid8'::regtype FROM pg_attribute WHERE attrelid='app.availability_snapshots'::regclass AND attname='creation_xid'));
SELECT test_support.ok('exact-function-names',(SELECT array_agg(proname::text ORDER BY proname)=ARRAY['check_availability_evidence','guard_identity','guard_immutable_record','profile_content_policy_valid','text_array_nonblank','touch_updated_at'] FROM pg_proc WHERE pronamespace='app'::regnamespace));
SELECT test_support.ok('constraint-index-policy-inventory',(SELECT count(*)=145 FROM pg_constraint WHERE connamespace='app'::regnamespace) AND (SELECT count(*)=40 FROM pg_indexes WHERE schemaname='app') AND (SELECT count(*)=23 FROM pg_policies WHERE schemaname='app'));
DO $$ DECLARE item record; table_name text; suffix text; expected_function text; expected_type integer; BEGIN
  FOR item IN SELECT * FROM (VALUES
    ('idx_movie_classifications_history','movie_id,created_at,id',NULL),
    ('idx_availability_snapshots_success','movie_id,region,source,checked_at','(outcome = ''success''::text)'),
    ('idx_movie_availability_provider','provider_id,offer_type,snapshot_id',NULL),('idx_availability_tracks_provider','provider_id',NULL),
    ('idx_availability_observations_track','movie_id,provider_id,region,source,offer_type,snapshot_id',NULL),
    ('idx_profiles_account','account_id','(account_id IS NOT NULL)'),('idx_profile_subscriptions_provider','provider_id',NULL),('idx_profile_movies_movie','movie_id',NULL),
    ('idx_selection_sessions_profile','profile_id,started_at,id',NULL),('idx_selection_sessions_correction','correction_deadline','(outcome = ''selected_provisional''::text)'),
    ('idx_selection_sessions_active','last_activity_at','(outcome = ''active''::text)'),('idx_recommendations_movie','movie_id',NULL),
    ('idx_recommendations_classification','classification_id,movie_id','(classification_id IS NOT NULL)'),('idx_refresh_runs_job','job_name,started_at,id',NULL)
  ) expected(name,columns,predicate) LOOP
    PERFORM test_support.ok('index-'||item.name,(SELECT string_agg(a.attname,',' ORDER BY key.ordinality)=item.columns AND pg_get_expr(i.indpred,i.indrelid) IS NOT DISTINCT FROM item.predicate AND bool_and(i.indisvalid AND NOT i.indisunique)
      FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid CROSS JOIN LATERAL unnest(i.indkey) WITH ORDINALITY key(attnum,ordinality) JOIN pg_attribute a ON a.attrelid=i.indrelid AND a.attnum=key.attnum
      WHERE c.relnamespace='app'::regnamespace AND c.relname=item.name GROUP BY i.indpred,i.indrelid));
  END LOOP;
  PERFORM test_support.ok('descending-history-indexes',(SELECT count(*)=4 AND bool_and(CASE WHEN c.relname='idx_availability_snapshots_success' THEN i.indoption[3]=3 ELSE i.indoption[1]=3 END) FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid WHERE c.relnamespace='app'::regnamespace AND c.relname IN ('idx_movie_classifications_history','idx_selection_sessions_profile','idx_refresh_runs_job','idx_availability_snapshots_success')));
  FOR item IN SELECT * FROM (VALUES
    ('identity','guard_identity',19,ARRAY['movies','streaming_providers','profiles','profile_subscriptions','profile_movies','selection_sessions','refresh_runs']),
    ('delete','guard_immutable_record',11,ARRAY['selection_sessions']),
    ('updated_at','touch_updated_at',19,ARRAY['movies','streaming_providers','profile_movies']),
    ('immutable','guard_immutable_record',27,ARRAY['movie_classifications','availability_snapshots','movie_availability','availability_tracks','availability_observations','recommendations','feedback_events']),
    ('evidence','check_availability_evidence',7,ARRAY['availability_snapshots','movie_availability','availability_observations'])
  ) expected(suffix,function_name,event_type,tables) LOOP
    FOREACH table_name IN ARRAY item.tables LOOP
      PERFORM test_support.ok('trigger-'||table_name||'-'||item.suffix,(SELECT t.tgtype=item.event_type AND p.proname=item.function_name AND t.tgenabled='O' FROM pg_trigger t JOIN pg_proc p ON p.oid=t.tgfoid WHERE t.tgrelid=('app.'||table_name)::regclass AND t.tgname='trg_'||table_name||'_'||item.suffix));
    END LOOP;
  END LOOP;
END $$;
SELECT test_support.ok('server-stamped-xid',(SELECT bool_and(creation_xid<>'1'::xid8 AND creation_xid<>pg_current_xact_id()) FROM app.availability_snapshots));
-- Full read-back inventory for review includes implicit PK/UNIQUE indexes and FK triggers.
SELECT table_name,column_name,data_type,is_nullable,column_default FROM information_schema.columns WHERE table_schema='app' ORDER BY table_name,ordinal_position;
SELECT conrelid::regclass,conname,pg_get_constraintdef(oid) FROM pg_constraint WHERE connamespace='app'::regnamespace ORDER BY conrelid::regclass::text,conname;
SELECT indexname,indexdef FROM pg_indexes WHERE schemaname='app' ORDER BY indexname;
SELECT c.relname,t.tgname,pg_get_triggerdef(t.oid) FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid WHERE c.relnamespace='app'::regnamespace AND NOT t.tgisinternal ORDER BY c.relname,t.tgname;
SELECT proname,prosecdef,provolatile,proacl,proconfig FROM pg_proc WHERE pronamespace='app'::regnamespace ORDER BY proname;
SELECT * FROM pg_policies WHERE schemaname='app' ORDER BY tablename,policyname;
SELECT defaclobjtype,defaclacl FROM pg_default_acl WHERE defaclrole='bor_migrator'::regrole;

DO $$
DECLARE name text; item record; policy jsonb; role_name text;
BEGIN
  FOREACH name IN ARRAY ARRAY['duplicate-mapping','classification-immutable','session-delete','same-session-selection','snapshot-sealed','observation-offer'] LOOP PERFORM test_support.acceptance(name); END LOOP;
  FOR item IN SELECT * FROM (VALUES
    ('movies','id,title,release_date,release_date_source,release_date_semantics,release_date_checked_at,runtime_minutes,original_language,us_certification,certification_source,certification_checked_at,overview,poster_path,genres,keywords,production_company_evidence,origin_group,origin_evidence,origin_mapping_version,origin_checked_at,rating,vote_count,metadata_source,metadata_refreshed_at,created_at,updated_at'),
    ('movie_external_ids','movie_id,source,external_id'),('movie_credits','movie_id,source,person_external_id,name,role,billing_order'),
    ('movie_classifications','id,movie_id,rubric_version,narrative_complexity,attention_demand,emotional_burden,on_screen_text_dependence,pacing,tone,content_tags,field_provenance,field_uncertainty,input_evidence,input_fingerprint,model_id,prompt_id,review_status,created_at'),
    ('streaming_providers','id,display_name,created_at,updated_at'),('streaming_provider_external_ids','provider_id,source,external_id'),
    ('availability_snapshots','id,movie_id,region,source,checked_at,refresh_deadline,outcome,watch_page_url,diagnostic_code,created_at,creation_xid'),
    ('movie_availability','snapshot_id,provider_id,offer_type'),('availability_tracks','movie_id,provider_id,region,source,offer_type,tracked_since'),
    ('availability_observations','snapshot_id,movie_id,provider_id,region,source,offer_type,state,provider_arrival_date,provider_arrival_source,provider_arrival_semantics'),
    ('profiles','id,account_id,region,runtime_ceiling_minutes,known_languages,subtitle_policy,content_policy,revision,created_at,updated_at'),
    ('profile_subscriptions','profile_id,provider_id,enabled'),('profile_movies','profile_id,movie_id,watched,watched_on,taste_rating,tired_viewing_rating,permanent_exclusion,created_at,updated_at'),
    ('selection_sessions','id,profile_id,started_at,last_activity_at,ended_at,outcome,selected_recommendation_id,selected_at,correction_deadline,experiment_arm,experiment_seed,experiment_version'),
    ('recommendations','id,session_id,movie_id,sequence,idempotency_key,explanation,algorithm_version,config_version,rubric_version,classification_id,profile_revision,trace,created_at'),
    ('feedback_events','id,recommendation_id,event_type,reason,taste_rating,tired_viewing_rating,idempotency_key,created_at'),
    ('refresh_runs','id,job_name,started_at,ended_at,outcome,processed_count,failed_count,checkpoint,diagnostic_summary')
  ) AS expected(table_name,columns) LOOP
    PERFORM test_support.ok('columns-'||item.table_name,(SELECT string_agg(column_name,',' ORDER BY ordinal_position)=item.columns FROM information_schema.columns WHERE table_schema='app' AND table_name=item.table_name));
  END LOOP;
  FOREACH role_name IN ARRAY ARRAY['bor_migrator','authenticated','service_role'] LOOP
    PERFORM test_support.ok('helpers-valid-'||role_name,test_support.statement($q$SELECT to_jsonb(app.text_array_nonblank('{}') AND app.text_array_nonblank(ARRAY['en',' nonblank ']) AND app.profile_content_policy_valid('{}') AND app.profile_content_policy_valid('{"exclude_horror":false,"us_certification_ceiling":"PG-13","emotional_burden_cap":4,"strict_theme_exclusions":["synthetic theme"]}'))$q$,role_name)='true');
    PERFORM test_support.ok('helpers-invalid-arrays-'||role_name,test_support.statement($q$SELECT to_jsonb(NOT app.text_array_nonblank(NULL) AND NOT app.text_array_nonblank(ARRAY[NULL::text]) AND NOT app.text_array_nonblank(ARRAY['']) AND NOT app.text_array_nonblank(ARRAY[' ']) AND NOT app.text_array_nonblank(ARRAY[E'\t']) AND NOT app.text_array_nonblank(ARRAY[E'\n']) AND NOT app.text_array_nonblank(ARRAY[['a'],['b']]))$q$,role_name)='true');
    FOR policy IN SELECT val FROM (VALUES ('null'::jsonb),('[]'),('{"unknown":true}'),('{"exclude_horror":null}'),('{"exclude_horror":"false"}'),('{"us_certification_ceiling":"NR"}'),('{"emotional_burden_cap":-1}'),('{"emotional_burden_cap":5}'),('{"emotional_burden_cap":1.5}'),('{"strict_theme_exclusions":["a",1]}'),('{"strict_theme_exclusions":[null]}'),('{"strict_theme_exclusions":[" "]}')) p(val) LOOP
      PERFORM test_support.ok('helper-policy-'||role_name||'-'||policy::text,test_support.statement(format('SELECT to_jsonb(NOT app.profile_content_policy_valid(%L::jsonb))',policy),role_name)='true');
    END LOOP;
  END LOOP;
  FOR item IN SELECT * FROM (VALUES
    ('mapping-one-per-source',$q$INSERT INTO app.movie_external_ids VALUES ('30000000-0000-4000-8000-000000000001','synthetic_catalog','other')$q$,'23505','movie_external_ids_pkey'),
    ('mapping-orphan',$q$INSERT INTO app.movie_external_ids VALUES ('30000000-0000-4000-8000-000000000099','synthetic_catalog','orphan')$q$,'23503','movie_external_ids_movie_fk'),
    ('credit-orphan',$q$INSERT INTO app.movie_credits(movie_id,source,person_external_id,name,role) VALUES ('30000000-0000-4000-8000-000000000099','synthetic','person','Synthetic','actor')$q$,'23503','movie_credits_movie_fk'),
    ('provider-duplicate',$q$INSERT INTO app.streaming_provider_external_ids VALUES ('40000000-0000-4000-8000-000000000003','synthetic_catalog','fixture-1')$q$,'23505','streaming_provider_external_ids_source_external_id_key'),
    ('runtime-bound',$q$UPDATE app.movies SET runtime_minutes=0 WHERE id='30000000-0000-4000-8000-000000000001'$q$,'23514','movies_runtime_minutes_check'),
    ('release-tuple',$q$UPDATE app.movies SET release_date_source=NULL WHERE id='30000000-0000-4000-8000-000000000001'$q$,'23514','movies_release_evidence_check'),
    ('certification-tuple',$q$UPDATE app.movies SET certification_source=NULL WHERE id='30000000-0000-4000-8000-000000000001'$q$,'23514','movies_certification_evidence_check'),
    ('origin-evidence',$q$UPDATE app.movies SET origin_group='mixed',origin_evidence='[]' WHERE id='30000000-0000-4000-8000-000000000001'$q$,'23514','movies_origin_evidence_check'),
    ('rating-bound',$q$UPDATE app.movies SET rating=11 WHERE id='30000000-0000-4000-8000-000000000001'$q$,'23514','movies_rating_check'),
    ('policy-check',$q$UPDATE app.profiles SET content_policy='{"unknown":true}' WHERE id='20000000-0000-4000-8000-000000000001'$q$,'23514','profiles_content_policy_check'),
    ('languages-check',$q$UPDATE app.profiles SET known_languages=ARRAY[E'\t'] WHERE id='20000000-0000-4000-8000-000000000001'$q$,'23514','profiles_known_languages_check'),
    ('genres-check',$q$UPDATE app.movies SET genres=ARRAY[''] WHERE id='30000000-0000-4000-8000-000000000001'$q$,'23514','movies_genres_check'),
    ('keywords-check',$q$UPDATE app.movies SET keywords=ARRAY[NULL::text] WHERE id='30000000-0000-4000-8000-000000000001'$q$,'23514','movies_keywords_check'),
    ('state-date',$q$UPDATE app.profile_movies SET watched_on='2026-01-01' WHERE profile_id='20000000-0000-4000-8000-000000000001'$q$,'23514','profile_movies_watched_date_check'),
    ('state-tired',$q$UPDATE app.profile_movies SET tired_viewing_rating=5 WHERE profile_id='20000000-0000-4000-8000-000000000001'$q$,'23514','profile_movies_tired_viewing_rating_check'),
    ('state-duplicate',$q$INSERT INTO app.profile_movies(profile_id,movie_id) VALUES ('20000000-0000-4000-8000-000000000001','30000000-0000-4000-8000-000000000001')$q$,'23505','profile_movies_pkey'),
    ('session-time',$q$UPDATE app.selection_sessions SET last_activity_at='2025-01-01Z' WHERE id='70000000-0000-4000-8000-000000000001'$q$,'23514','selection_sessions_time_check'),
    ('session-outcome',$q$UPDATE app.selection_sessions SET outcome='active',ended_at=NULL WHERE id='70000000-0000-4000-8000-000000000001'$q$,'23514','selection_sessions_selection_check'),
    ('profile-runtime',$q$UPDATE app.profiles SET runtime_ceiling_minutes=-1 WHERE id='20000000-0000-4000-8000-000000000001'$q$,'23514','profiles_runtime_ceiling_minutes_check'),
    ('late-observation',$q$INSERT INTO app.availability_observations(snapshot_id,movie_id,provider_id,region,source,offer_type,state) VALUES ('50000000-0000-4000-8000-000000000008','30000000-0000-4000-8000-000000000001','40000000-0000-4000-8000-000000000001','US','synthetic_availability','subscription','absent')$q$,'23514','availability_snapshot_sealed_check'),
    ('catalog-restrict',$q$DO $probe$ BEGIN INSERT INTO app.profile_movies(profile_id,movie_id) VALUES('20000000-0000-4000-8000-000000000001','30000000-0000-4000-8000-000000000005'); DELETE FROM app.movies WHERE id='30000000-0000-4000-8000-000000000005'; END $probe$;$q$,'23503','profile_movies_movie_fk'),
    ('provider-restrict',$q$DELETE FROM app.streaming_providers WHERE id='40000000-0000-4000-8000-000000000001'$q$,'23503',NULL)
  ) cases(name,sql,state,constraint_name) LOOP PERFORM test_support.denied(item.name,item.sql,item.state,item.constraint_name); END LOOP;
  -- Every immutable table rejects owner and service UPDATE/direct DELETE, with no owner exemption.
  FOR item IN SELECT tablename FROM pg_tables WHERE schemaname='app' AND tablename IN ('movie_classifications','availability_snapshots','movie_availability','availability_tracks','availability_observations','recommendations','feedback_events') LOOP
    FOREACH role_name IN ARRAY ARRAY['bor_migrator','service_role'] LOOP
      PERFORM test_support.denied('immutable-update-'||item.tablename||'-'||role_name,format('UPDATE app.%I SET %I=%I',item.tablename,CASE item.tablename WHEN 'movie_availability' THEN 'offer_type' WHEN 'availability_tracks' THEN 'offer_type' WHEN 'availability_observations' THEN 'state' ELSE 'id' END,CASE item.tablename WHEN 'movie_availability' THEN 'offer_type' WHEN 'availability_tracks' THEN 'offer_type' WHEN 'availability_observations' THEN 'state' ELSE 'id' END),'23514',item.tablename||'_immutable_check',role_name);
      PERFORM test_support.denied('immutable-delete-'||item.tablename||'-'||role_name,format('DELETE FROM app.%I',item.tablename),'23514',item.tablename||'_immutable_check',role_name);
    END LOOP;
  END LOOP;
END $$;

-- Exercise classification native CHECKs through real service INSERTs, not immutable UPDATEs.
SAVEPOINT additional_checks;
DO $$
DECLARE field text; item record; role_name text; sql text;
BEGIN
  FOREACH field IN ARRAY ARRAY['narrative_complexity','attention_demand','emotional_burden','on_screen_text_dependence'] LOOP
    FOR item IN SELECT val FROM (VALUES (-1),(5)) values_to_reject(val) LOOP
      sql:=format('INSERT INTO app.movie_classifications(movie_id,rubric_version,field_provenance,field_uncertainty,input_evidence,input_fingerprint,review_status,%I) VALUES(''30000000-0000-4000-8000-000000000001'',''synthetic'',''{}'',''{}'',''{}'',''synthetic'',''unreviewed'',%s)',field,item.val);
      PERFORM test_support.denied('classification-bound-'||field||'-'||item.val,sql,'23514','movie_classifications_'||field||'_check','service_role');
    END LOOP;
  END LOOP;
  FOR item IN SELECT * FROM (VALUES ('tone','ARRAY['''']','movie_classifications_tone_check'),('content_tags','ARRAY[NULL::text]','movie_classifications_content_tags_check'),('field_provenance','''[]''::jsonb','movie_classifications_field_provenance_check'),('field_uncertainty','''[]''::jsonb','movie_classifications_field_uncertainty_check'),('input_evidence','''[]''::jsonb','movie_classifications_input_evidence_check')) cases(field,value,name) LOOP
    sql:=format('INSERT INTO app.movie_classifications(movie_id,rubric_version,field_provenance,field_uncertainty,input_evidence,input_fingerprint,review_status,tone,content_tags) VALUES(''30000000-0000-4000-8000-000000000001'',''synthetic'',%s,%s,%s,''synthetic'',''unreviewed'',%s,%s)',CASE WHEN item.field='field_provenance' THEN item.value ELSE '''{}''::jsonb' END,CASE WHEN item.field='field_uncertainty' THEN item.value ELSE '''{}''::jsonb' END,CASE WHEN item.field='input_evidence' THEN item.value ELSE '''{}''::jsonb' END,CASE WHEN item.field='tone' THEN item.value ELSE 'ARRAY[]::text[]' END,CASE WHEN item.field='content_tags' THEN item.value ELSE 'ARRAY[]::text[]' END);
    PERFORM test_support.denied(item.name,sql,'23514',item.name,'service_role');
  END LOOP;
  PERFORM test_support.statement($q$INSERT INTO app.movie_classifications(movie_id,rubric_version,field_provenance,field_uncertainty,input_evidence,input_fingerprint,review_status,tone,content_tags) VALUES('30000000-0000-4000-8000-000000000001','synthetic','{}','{}','{}','synthetic','unreviewed',ARRAY['synthetic tone'],ARRAY['synthetic tag'])$q$,'service_role');
  PERFORM test_support.statement($q$UPDATE app.movies SET keywords=ARRAY['synthetic keyword'],genres=ARRAY['synthetic genre'] WHERE id='30000000-0000-4000-8000-000000000001'$q$,'service_role');
  PERFORM test_support.statement($q$UPDATE app.profiles SET content_policy='{"emotional_burden_cap":0,"strict_theme_exclusions":[]}',known_languages=ARRAY['synthetic'] WHERE id='20000000-0000-4000-8000-000000000003'$q$,'service_role');
  PERFORM test_support.denied('service-native-policy',$q$UPDATE app.profiles SET content_policy='[]' WHERE id='20000000-0000-4000-8000-000000000003'$q$,'23514','profiles_content_policy_check','service_role');
  -- Identity fields protected even with owner/service table-wide grants.
  FOR item IN SELECT * FROM (VALUES
    ('movies','id','gen_random_uuid()'),('movies','created_at','now()'),('streaming_providers','id','gen_random_uuid()'),('streaming_providers','created_at','now()'),
    ('profiles','id','gen_random_uuid()'),('profiles','created_at','now()'),('profiles','revision','10'),
    ('profile_subscriptions','profile_id','gen_random_uuid()'),('profile_subscriptions','provider_id','gen_random_uuid()'),
    ('profile_movies','profile_id','gen_random_uuid()'),('profile_movies','movie_id','gen_random_uuid()'),('profile_movies','created_at','now()'),
    ('selection_sessions','id','gen_random_uuid()'),('selection_sessions','profile_id','gen_random_uuid()'),('selection_sessions','started_at','now()'),
    ('refresh_runs','id','gen_random_uuid()'),('refresh_runs','started_at','now()')
  ) fields(table_name,field,value) LOOP
    FOREACH role_name IN ARRAY ARRAY['bor_migrator','service_role'] LOOP
      PERFORM test_support.denied('identity-'||item.table_name||'-'||item.field||'-'||role_name,format('UPDATE app.%I SET %I=%s',item.table_name,item.field,item.value),'23514',item.table_name||'_identity_check',role_name);
    END LOOP;
  END LOOP;
  PERFORM test_support.statement($q$UPDATE app.profiles SET account_id='10000000-0000-4000-8000-000000000001' WHERE id='20000000-0000-4000-8000-000000000003'$q$,'service_role');
  PERFORM test_support.ok('null-owner-link-once',(SELECT account_id='10000000-0000-4000-8000-000000000001' FROM app.profiles WHERE id='20000000-0000-4000-8000-000000000003'));
  PERFORM test_support.denied('owner-link-cannot-clear',$q$UPDATE app.profiles SET account_id=NULL WHERE id='20000000-0000-4000-8000-000000000003'$q$,'23514','profiles_ownership_check');
END $$;
ROLLBACK TO additional_checks;

SAVEPOINT evidence_cases;
INSERT INTO app.availability_snapshots(id,movie_id,region,source,checked_at,refresh_deadline,outcome,creation_xid) VALUES
 ('50000000-0000-4000-8000-000000000091','30000000-0000-4000-8000-000000000001','US','synthetic_availability','2025-01-01Z','2025-01-03Z','success','1'),
 ('50000000-0000-4000-8000-000000000092','30000000-0000-4000-8000-000000000001','US','synthetic_availability','2026-10-02Z','2026-10-04Z','success','1'),
 ('50000000-0000-4000-8000-000000000093','30000000-0000-4000-8000-000000000001','US','synthetic_availability','2026-10-03Z','2026-10-05Z','failed','1');
SAVEPOINT nested_child;
INSERT INTO app.movie_availability VALUES('50000000-0000-4000-8000-000000000092','40000000-0000-4000-8000-000000000001','subscription');
INSERT INTO app.availability_observations(snapshot_id,movie_id,provider_id,region,source,offer_type,state) VALUES('50000000-0000-4000-8000-000000000092','30000000-0000-4000-8000-000000000001','40000000-0000-4000-8000-000000000001','US','synthetic_availability','subscription','present');
SELECT test_support.ok('savepoint-full-xid-seal',(SELECT creation_xid=pg_current_xact_id() FROM app.availability_snapshots WHERE id='50000000-0000-4000-8000-000000000092'));
RELEASE nested_child;
DO $$ DECLARE item record; BEGIN
  FOR item IN SELECT * FROM (VALUES
    ('duplicate-offer',$q$INSERT INTO app.movie_availability VALUES('50000000-0000-4000-8000-000000000092','40000000-0000-4000-8000-000000000001','subscription')$q$,'23505','movie_availability_pkey'),
    ('failed-offer',$q$INSERT INTO app.movie_availability VALUES('50000000-0000-4000-8000-000000000093','40000000-0000-4000-8000-000000000001','subscription')$q$,'23514','availability_success_check'),
    ('failed-observation',$q$INSERT INTO app.availability_observations(snapshot_id,movie_id,provider_id,region,source,offer_type,state) VALUES('50000000-0000-4000-8000-000000000093','30000000-0000-4000-8000-000000000001','40000000-0000-4000-8000-000000000001','US','synthetic_availability','subscription','absent')$q$,'23514','availability_success_check'),
    ('before-track',$q$INSERT INTO app.availability_observations(snapshot_id,movie_id,provider_id,region,source,offer_type,state) VALUES('50000000-0000-4000-8000-000000000091','30000000-0000-4000-8000-000000000001','40000000-0000-4000-8000-000000000001','US','synthetic_availability','subscription','absent')$q$,'23514','availability_track_time_check'),
    ('absence-with-offer',$q$INSERT INTO app.availability_observations(snapshot_id,movie_id,provider_id,region,source,offer_type,state) VALUES('50000000-0000-4000-8000-000000000092','30000000-0000-4000-8000-000000000001','40000000-0000-4000-8000-000000000001','US','synthetic_availability','subscription','absent')$q$,'23514','availability_observation_offer_check'),
    ('snapshot-composite',$q$INSERT INTO app.availability_observations(snapshot_id,movie_id,provider_id,region,source,offer_type,state) VALUES('50000000-0000-4000-8000-000000000092','30000000-0000-4000-8000-000000000001','40000000-0000-4000-8000-000000000001','CA','synthetic_namespace_2','rental','absent')$q$,'23503','availability_observations_snapshot_fk'),
    ('track-composite',$q$INSERT INTO app.availability_observations(snapshot_id,movie_id,provider_id,region,source,offer_type,state) VALUES('50000000-0000-4000-8000-000000000092','30000000-0000-4000-8000-000000000001','40000000-0000-4000-8000-000000000003','US','synthetic_availability','subscription','absent')$q$,'23503','availability_observations_track_fk'),
    ('arrival-tuple',$q$INSERT INTO app.availability_observations(snapshot_id,movie_id,provider_id,region,source,offer_type,state,provider_arrival_date) VALUES('50000000-0000-4000-8000-000000000092','30000000-0000-4000-8000-000000000001','40000000-0000-4000-8000-000000000002','US','synthetic_availability','subscription','absent','2026-01-01')$q$,'23514','availability_observations_arrival_check'),
    ('failed-url',$q$INSERT INTO app.availability_snapshots(movie_id,region,source,checked_at,refresh_deadline,outcome,watch_page_url) VALUES('30000000-0000-4000-8000-000000000001','US','synthetic','2026-01-01Z','2026-01-03Z','failed','https://synthetic.invalid')$q$,'23514','availability_snapshots_failed_url_check')
  ) cases(name,sql,state,constraint_name) LOOP PERFORM test_support.denied(item.name,item.sql,item.state,item.constraint_name); END LOOP;
  INSERT INTO app.availability_observations(snapshot_id,movie_id,provider_id,region,source,offer_type,state) VALUES('50000000-0000-4000-8000-000000000092','30000000-0000-4000-8000-000000000001','40000000-0000-4000-8000-000000000002','US','synthetic_availability','subscription','absent');
  PERFORM test_support.denied('offer-after-absence',$q$INSERT INTO app.movie_availability VALUES('50000000-0000-4000-8000-000000000092','40000000-0000-4000-8000-000000000002','subscription')$q$,'23514','availability_offer_absence_check');
END $$;
ROLLBACK TO evidence_cases;

SAVEPOINT history_cases;
DO $$
DECLARE item record; sql text; base text; chosen_outcome text;
BEGIN
  base:='INSERT INTO app.recommendations(session_id,movie_id,sequence,idempotency_key,explanation,algorithm_version,config_version,rubric_version,classification_id,profile_revision,trace) VALUES(''70000000-0000-4000-8000-000000000001'',%s,%s,%L,''Synthetic'',%L,''synthetic'',''synthetic'',%s,%s,%L::jsonb)';
  FOR item IN SELECT * FROM (VALUES
    ('recommendation-sequence',1,'new','synthetic','''30000000-0000-4000-8000-000000000001''','NULL',1,'{}','23505','recommendations_sequence_key'),
    ('recommendation-idempotency',2,'synthetic-key','synthetic','''30000000-0000-4000-8000-000000000001''','NULL',1,'{}','23505','recommendations_idempotency_key'),
    ('classification-movie-match',2,'new','synthetic','''30000000-0000-4000-8000-000000000002''','''60000000-0000-4000-8000-000000000001''',1,'{}','23503','recommendations_classification_fk'),
    ('recommendation-positive-sequence',0,'new','synthetic','''30000000-0000-4000-8000-000000000001''','NULL',1,'{}','23514','recommendations_sequence_check'),
    ('recommendation-trace',2,'new','synthetic','''30000000-0000-4000-8000-000000000001''','NULL',1,'[]','23514','recommendations_trace_check'),
    ('recommendation-version',2,'new',' ','''30000000-0000-4000-8000-000000000001''','NULL',1,'{}','23514','recommendations_algorithm_version_check'),
    ('recommendation-revision',2,'new','synthetic','''30000000-0000-4000-8000-000000000001''','NULL',0,'{}','23514','recommendations_profile_revision_check')
  ) cases(name,sequence,key,version,movie,classification,revision,trace,state,constraint_name) LOOP
    sql:=format(base,item.movie,item.sequence,item.key,item.version,item.classification,item.revision,item.trace);
    PERFORM test_support.denied(item.name,sql,item.state,item.constraint_name);
  END LOOP;
  PERFORM test_support.denied('feedback-idempotency',$q$INSERT INTO app.feedback_events(recommendation_id,event_type,idempotency_key) VALUES('80000000-0000-4000-8000-000000000001','skip','synthetic-key')$q$,'23505','feedback_events_idempotency_key');
  PERFORM test_support.denied('feedback-postwatch-missing',$q$INSERT INTO app.feedback_events(recommendation_id,event_type,idempotency_key) VALUES('80000000-0000-4000-8000-000000000001','post_watch','new')$q$,'23514','feedback_events_rating_check');
  PERFORM test_support.denied('feedback-other-rating',$q$INSERT INTO app.feedback_events(recommendation_id,event_type,idempotency_key,taste_rating) VALUES('80000000-0000-4000-8000-000000000001','skip','new','disliked')$q$,'23514','feedback_events_rating_check');
  INSERT INTO app.feedback_events(recommendation_id,event_type,idempotency_key,taste_rating,tired_viewing_rating) VALUES('80000000-0000-4000-8000-000000000001','post_watch','post-watch','liked',0);
  PERFORM test_support.ok('feedback-postwatch-positive',(SELECT count(*)=1 FROM app.feedback_events WHERE event_type='post_watch'));
  PERFORM test_support.denied('session-end-incoherent',$q$UPDATE app.selection_sessions SET ended_at=NULL WHERE id='70000000-0000-4000-8000-000000000001'$q$,'23514','selection_sessions_end_check');
  PERFORM test_support.denied('experiment-incomplete',$q$UPDATE app.selection_sessions SET experiment_arm='personalized' WHERE id='70000000-0000-4000-8000-000000000001'$q$,'23514','selection_sessions_experiment_check');
  UPDATE app.selection_sessions SET experiment_arm='quality_first',experiment_seed='synthetic-seed',experiment_version='synthetic-v1' WHERE id='70000000-0000-4000-8000-000000000001';
  FOREACH chosen_outcome IN ARRAY ARRAY['availability_failure','abandoned','refresh_stale','refresh_failed','backend_unavailable','eligible_pool_exhausted'] LOOP
    UPDATE app.selection_sessions SET outcome=chosen_outcome,ended_at='2026-01-01T00:10Z' WHERE id='70000000-0000-4000-8000-000000000004';
    PERFORM test_support.ok('finalized-outcome-'||chosen_outcome,(SELECT ended_at IS NOT NULL FROM app.selection_sessions WHERE id='70000000-0000-4000-8000-000000000004'));
  END LOOP;
  PERFORM test_support.denied('refresh-negative-count',$q$UPDATE app.refresh_runs SET processed_count=-1$q$,'23514','refresh_runs_processed_count_check');
  PERFORM test_support.denied('refresh-end-incoherent',$q$UPDATE app.refresh_runs SET outcome='success'$q$,'23514','refresh_runs_end_check');
  PERFORM test_support.denied('refresh-checkpoint-container',$q$UPDATE app.refresh_runs SET checkpoint='[]'$q$,'23514','refresh_runs_checkpoint_check');
  UPDATE app.refresh_runs SET outcome='partial',ended_at='2026-01-02Z',processed_count=1,failed_count=5;
  PERFORM test_support.ok('refresh-independent-counts',(SELECT processed_count<failed_count AND outcome='partial' FROM app.refresh_runs));
  PERFORM test_support.ok('retained-success-after-failure',EXISTS(SELECT 1 FROM app.availability_snapshots s JOIN app.movie_availability o ON o.snapshot_id=s.id WHERE s.id='50000000-0000-4000-8000-000000000005') AND (SELECT outcome='failed' FROM app.availability_snapshots WHERE id='50000000-0000-4000-8000-000000000006'));
  PERFORM test_support.ok('failure-retains-choose-event',(SELECT s.selected_recommendation_id IS NULL AND s.outcome='availability_failure' FROM app.selection_sessions s WHERE s.id='70000000-0000-4000-8000-000000000003') AND EXISTS(SELECT 1 FROM app.feedback_events WHERE recommendation_id='80000000-0000-4000-8000-000000000003' AND event_type='choose'));
END $$;
ROLLBACK TO history_cases;

SAVEPOINT catalog_cascades;
INSERT INTO app.movie_external_ids VALUES('30000000-0000-4000-8000-000000000005','synthetic_catalog','cascade-5');
INSERT INTO app.movie_credits(movie_id,source,person_external_id,name,role) VALUES('30000000-0000-4000-8000-000000000005','synthetic','cascade-person','Synthetic','actor');
INSERT INTO app.movie_classifications(movie_id,rubric_version,field_provenance,field_uncertainty,input_evidence,input_fingerprint,review_status) VALUES('30000000-0000-4000-8000-000000000005','synthetic','{}','{}','{}','synthetic','unreviewed');
INSERT INTO app.availability_tracks VALUES('30000000-0000-4000-8000-000000000005','40000000-0000-4000-8000-000000000003','US','synthetic','free','2026-01-01Z');
INSERT INTO app.availability_snapshots(id,movie_id,region,source,checked_at,refresh_deadline,outcome) VALUES('50000000-0000-4000-8000-000000000095','30000000-0000-4000-8000-000000000005','US','synthetic','2026-01-01Z','2026-01-03Z','success');
INSERT INTO app.movie_availability VALUES('50000000-0000-4000-8000-000000000095','40000000-0000-4000-8000-000000000003','free');
INSERT INTO app.availability_observations(snapshot_id,movie_id,provider_id,region,source,offer_type,state) VALUES('50000000-0000-4000-8000-000000000095','30000000-0000-4000-8000-000000000005','40000000-0000-4000-8000-000000000003','US','synthetic','free','present');
DO $$ DECLARE role_name text; BEGIN
  FOREACH role_name IN ARRAY ARRAY['bor_migrator','service_role'] LOOP
    PERFORM test_support.denied('movie-classification-retained-'||role_name,$q$DELETE FROM app.movies WHERE id='30000000-0000-4000-8000-000000000005'$q$,'23503','movie_classifications_movie_fk',role_name);
    PERFORM test_support.denied('session-direct-delete-'||role_name,$q$DELETE FROM app.selection_sessions WHERE id='70000000-0000-4000-8000-000000000001'$q$,'23514','selection_sessions_immutable_check',role_name);
  END LOOP;
END $$;
SELECT test_support.ok('catalog-history-retained',(SELECT count(*)=1 FROM app.movie_classifications WHERE movie_id='30000000-0000-4000-8000-000000000005') AND EXISTS(SELECT 1 FROM app.availability_snapshots WHERE id='50000000-0000-4000-8000-000000000095') AND EXISTS(SELECT 1 FROM app.availability_observations WHERE snapshot_id='50000000-0000-4000-8000-000000000095'));
ROLLBACK TO catalog_cascades;
-- Snapshot restriction independently of classifications or personal references.
INSERT INTO app.availability_snapshots(movie_id,region,source,checked_at,refresh_deadline,outcome) VALUES('30000000-0000-4000-8000-000000000005','US','synthetic','2026-01-01Z','2026-01-03Z','failed');
DO $$ DECLARE role_name text; BEGIN
  FOREACH role_name IN ARRAY ARRAY['bor_migrator','service_role'] LOOP
    PERFORM test_support.denied('movie-snapshot-retained-'||role_name,$q$DELETE FROM app.movies WHERE id='30000000-0000-4000-8000-000000000005'$q$,'23503','availability_snapshots_movie_fk',role_name);
  END LOOP;
END $$;
ROLLBACK TO catalog_cascades;
INSERT INTO app.movie_external_ids VALUES('30000000-0000-4000-8000-000000000005','synthetic_catalog','cascade-5');
INSERT INTO app.movie_credits(movie_id,source,person_external_id,name,role) VALUES('30000000-0000-4000-8000-000000000005','synthetic','cascade-person','Synthetic','actor');
INSERT INTO app.availability_tracks VALUES('30000000-0000-4000-8000-000000000005','40000000-0000-4000-8000-000000000003','US','synthetic','free','2026-01-01Z');
DELETE FROM app.movies WHERE id='30000000-0000-4000-8000-000000000005';
SELECT test_support.ok('history-free-movie-cascade',NOT EXISTS(SELECT 1 FROM app.movie_external_ids WHERE movie_id='30000000-0000-4000-8000-000000000005') AND NOT EXISTS(SELECT 1 FROM app.movie_credits WHERE movie_id='30000000-0000-4000-8000-000000000005') AND NOT EXISTS(SELECT 1 FROM app.availability_tracks WHERE movie_id='30000000-0000-4000-8000-000000000005'));
INSERT INTO app.streaming_provider_external_ids VALUES('40000000-0000-4000-8000-000000000003','synthetic','cascade-3');
DELETE FROM app.streaming_providers WHERE id='40000000-0000-4000-8000-000000000003';
SELECT test_support.ok('provider-mapping-cascade',NOT EXISTS(SELECT 1 FROM app.streaming_provider_external_ids WHERE provider_id='40000000-0000-4000-8000-000000000003'));
ROLLBACK TO catalog_cascades;

-- Plain selected graph deletions: two independent graphs, no constraint deferral.
SAVEPOINT account_deletion;
DELETE FROM auth.users WHERE id='10000000-0000-4000-8000-000000000001';
SELECT test_support.ok('plain-account-delete',(SELECT count(*)=2 FROM app.profiles) AND NOT EXISTS(SELECT 1 FROM app.profiles WHERE id='20000000-0000-4000-8000-000000000001') AND (SELECT count(*)=2 FROM app.profile_subscriptions) AND (SELECT count(*)=2 FROM app.profile_movies) AND (SELECT count(*)=3 FROM app.selection_sessions) AND (SELECT count(*)=2 FROM app.recommendations) AND (SELECT count(*)=2 FROM app.feedback_events) AND (SELECT count(*)=5 FROM app.movies) AND (SELECT count(*)=3 FROM app.streaming_providers) AND (SELECT count(*)=1 FROM auth.users));
ROLLBACK TO account_deletion;
SAVEPOINT profile_deletion;
DELETE FROM app.profiles WHERE id='20000000-0000-4000-8000-000000000001';
SELECT test_support.ok('plain-profile-delete',(SELECT count(*)=2 FROM app.profiles) AND (SELECT count(*)=2 FROM app.profile_subscriptions) AND (SELECT count(*)=2 FROM app.profile_movies) AND (SELECT count(*)=3 FROM app.selection_sessions) AND (SELECT count(*)=2 FROM app.recommendations) AND (SELECT count(*)=2 FROM app.feedback_events) AND (SELECT count(*)=5 FROM app.movies) AND (SELECT count(*)=2 FROM auth.users));
ROLLBACK TO profile_deletion;
SELECT test_support.ok('nonzero-schema-cases',(SELECT count(*)>100 FROM test_support.results));
ROLLBACK TO schema_suite;
RELEASE SAVEPOINT schema_suite;
