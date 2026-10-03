-- SYNTHETIC TEST DATA — not provider records or personal preferences.
INSERT INTO auth.users(id) VALUES ('10000000-0000-4000-8000-000000000001'),('10000000-0000-4000-8000-000000000002');
INSERT INTO app.movies(id,title,metadata_source,metadata_refreshed_at,created_at,updated_at) SELECT
  ('30000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,'Synthetic Movie '||chr(64+n),'synthetic_catalog','2026-01-01Z','2026-01-01Z','2026-01-01Z' FROM generate_series(1,5) n;
INSERT INTO app.movie_external_ids(movie_id,source,external_id) VALUES
 ('30000000-0000-4000-8000-000000000001','synthetic_catalog','fixture-1'),
 ('30000000-0000-4000-8000-000000000001','synthetic_namespace_2','fixture-1'),
 ('30000000-0000-4000-8000-000000000002','synthetic_catalog','00002');
INSERT INTO app.movie_credits(movie_id,source,person_external_id,name,role,billing_order) VALUES
 ('30000000-0000-4000-8000-000000000001','synthetic_catalog','person-1','Synthetic Person','actor',0),
 ('30000000-0000-4000-8000-000000000001','synthetic_catalog','person-1','Synthetic Person','director',NULL);
UPDATE app.movies SET release_date='2099-01-01',release_date_source='synthetic_catalog',release_date_semantics='original_release',release_date_checked_at='2026-01-01Z',runtime_minutes=90,us_certification='NR',certification_source='synthetic_catalog',certification_checked_at='2026-01-01Z',rating=0,vote_count=0 WHERE id='30000000-0000-4000-8000-000000000001';
UPDATE app.movies SET origin_group=CASE right(id::text,1) WHEN '2' THEN 'traditional_studio' WHEN '3' THEN 'independent' WHEN '4' THEN 'mixed' ELSE 'streamer_produced_financed' END,
 origin_evidence='[{"source":"synthetic_catalog","checked_at":"2026-01-01Z","relationship":"production","evidence_text":"Invented production evidence"}]',
 production_company_evidence='[{"source":"synthetic_catalog","name":"Synthetic Company","checked_at":"2026-01-01Z"}]',origin_mapping_version='synthetic-v1',origin_checked_at='2026-01-01Z' WHERE id<>'30000000-0000-4000-8000-000000000001';
UPDATE app.movies SET origin_evidence='[{"source":"synthetic_catalog","checked_at":"2026-01-01Z","relationship":"acquisition","evidence_text":"Invented acquisition only"}]' WHERE id='30000000-0000-4000-8000-000000000001';
INSERT INTO app.streaming_providers(id,display_name,created_at,updated_at) VALUES
 ('40000000-0000-4000-8000-000000000001','Synthetic Base','2026-01-01Z','2026-01-01Z'),
 ('40000000-0000-4000-8000-000000000002','Synthetic Add-on','2026-01-01Z','2026-01-01Z'),
 ('40000000-0000-4000-8000-000000000003','Synthetic Base','2026-01-01Z','2026-01-01Z');
INSERT INTO app.streaming_provider_external_ids(provider_id,source,external_id) VALUES
 ('40000000-0000-4000-8000-000000000001','synthetic_catalog','fixture-1'),
 ('40000000-0000-4000-8000-000000000001','synthetic_namespace_2','fixture-1'),
 ('40000000-0000-4000-8000-000000000002','synthetic_catalog','00002');
INSERT INTO app.movie_classifications(id,movie_id,rubric_version,narrative_complexity,attention_demand,emotional_burden,on_screen_text_dependence,field_provenance,field_uncertainty,input_evidence,input_fingerprint,review_status,created_at) SELECT
 ('60000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,'30000000-0000-4000-8000-000000000001','synthetic-v1',0,4,NULL,NULL,
 '{"narrative_complexity":"supplied_evidence","attention_demand":"human_judgment","tone":"model_prior_knowledge"}','{"emotional_burden":"unknown"}','{"synthetic":true,"overview":"Invented supplied content"}','same-synthetic-input',CASE n WHEN 1 THEN 'reviewed' ELSE 'unreviewed' END,'2026-01-01Z' FROM generate_series(1,2) n;
INSERT INTO app.profiles(id,account_id,created_at,updated_at) SELECT
 ('20000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,CASE WHEN n<3 THEN ('10000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid END,'2026-01-01Z','2026-01-01Z' FROM generate_series(1,3) n;
INSERT INTO app.profile_subscriptions(profile_id,provider_id,enabled) SELECT id,'40000000-0000-4000-8000-000000000001',true FROM app.profiles;
INSERT INTO app.profile_movies(profile_id,movie_id,watched,taste_rating,tired_viewing_rating,permanent_exclusion,created_at,updated_at) SELECT id,'30000000-0000-4000-8000-000000000001',right(id::text,1)='2',CASE WHEN right(id::text,1)='2' THEN 'liked' END,CASE WHEN right(id::text,1)='3' THEN 4 END,right(id::text,1)='3','2026-01-01Z','2026-01-01Z' FROM app.profiles;
INSERT INTO app.availability_tracks(movie_id,provider_id,region,source,offer_type,tracked_since) VALUES
 ('30000000-0000-4000-8000-000000000001','40000000-0000-4000-8000-000000000001','US','synthetic_availability','subscription','2026-01-01Z'),
 ('30000000-0000-4000-8000-000000000001','40000000-0000-4000-8000-000000000002','US','synthetic_availability','subscription','2026-06-01Z'),
 ('30000000-0000-4000-8000-000000000001','40000000-0000-4000-8000-000000000001','CA','synthetic_namespace_2','rental','2026-01-01Z');
-- Absence, presence, repeat, removal, reappearance, outage, long gap and empty success.
INSERT INTO app.availability_snapshots(id,movie_id,region,source,checked_at,refresh_deadline,outcome,creation_xid) SELECT
 ('50000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,'30000000-0000-4000-8000-000000000001','US','synthetic_availability',
 '2026-01-01Z'::timestamptz+n*interval '1 day', '2026-01-03Z'::timestamptz+n*interval '1 day',CASE WHEN n=6 THEN 'failed' ELSE 'success' END,'1'::xid8 FROM generate_series(1,8) n;
INSERT INTO app.movie_availability(snapshot_id,provider_id,offer_type) SELECT id,'40000000-0000-4000-8000-000000000001','subscription' FROM app.availability_snapshots WHERE right(id::text,1) IN ('2','3','5');
INSERT INTO app.availability_observations(snapshot_id,movie_id,provider_id,region,source,offer_type,state) SELECT id,movie_id,'40000000-0000-4000-8000-000000000001',region,source,'subscription',CASE WHEN right(id::text,1) IN ('2','3','5') THEN 'present' ELSE 'absent' END FROM app.availability_snapshots WHERE right(id::text,1) IN ('1','2','3','4','5');
INSERT INTO app.availability_snapshots(id,movie_id,region,source,checked_at,refresh_deadline,outcome) VALUES
 ('50000000-0000-4000-8000-000000000009','30000000-0000-4000-8000-000000000001','US','synthetic_availability','2026-09-01Z','2026-09-03Z','success'),
 ('50000000-0000-4000-8000-000000000010','30000000-0000-4000-8000-000000000001','CA','synthetic_namespace_2','2026-01-02Z','2026-01-04Z','success');
INSERT INTO app.movie_availability(snapshot_id,provider_id,offer_type) VALUES
 ('50000000-0000-4000-8000-000000000009','40000000-0000-4000-8000-000000000002','subscription'),
 ('50000000-0000-4000-8000-000000000010','40000000-0000-4000-8000-000000000001','rental');
INSERT INTO app.availability_observations(snapshot_id,movie_id,provider_id,region,source,offer_type,state,provider_arrival_date,provider_arrival_source,provider_arrival_semantics) VALUES
 ('50000000-0000-4000-8000-000000000009','30000000-0000-4000-8000-000000000001','40000000-0000-4000-8000-000000000002','US','synthetic_availability','subscription','present','2026-07-01','synthetic_availability','invented_source_date');
INSERT INTO app.selection_sessions(id,profile_id,started_at,last_activity_at) SELECT
 ('70000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,('20000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,'2026-01-01Z','2026-01-01Z' FROM generate_series(1,3) n;
INSERT INTO app.recommendations(id,session_id,movie_id,sequence,idempotency_key,explanation,algorithm_version,config_version,rubric_version,classification_id,profile_revision,trace,created_at) SELECT
 ('80000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,('70000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,'30000000-0000-4000-8000-000000000001',1,'synthetic-key','Synthetic structural pick','synthetic-v1','synthetic-v1','synthetic-v1','60000000-0000-4000-8000-000000000001',1,'{"synthetic":true,"profile":{"unconfirmed":true},"inputs":{"title":"Synthetic Movie A"}}','2026-01-01Z' FROM generate_series(1,3) n;
UPDATE app.selection_sessions SET outcome='selected_provisional',selected_recommendation_id=('80000000-0000-4000-8000-'||right(id::text,12))::uuid,selected_at='2026-01-01Z',correction_deadline='2026-01-01T00:30Z';
UPDATE app.selection_sessions SET outcome='selected_intent',ended_at='2026-01-01T00:30Z' WHERE id='70000000-0000-4000-8000-000000000001';
UPDATE app.selection_sessions SET outcome='availability_failure',selected_recommendation_id=NULL,selected_at=NULL,correction_deadline=NULL,ended_at='2026-01-01T00:10Z' WHERE id='70000000-0000-4000-8000-000000000003';
INSERT INTO app.selection_sessions(id,profile_id,started_at,last_activity_at) VALUES('70000000-0000-4000-8000-000000000004','20000000-0000-4000-8000-000000000003','2026-01-01Z','2026-01-01Z');
INSERT INTO app.feedback_events(id,recommendation_id,event_type,idempotency_key,created_at) SELECT
 ('90000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,('80000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,'choose','synthetic-key','2026-01-01Z' FROM generate_series(1,3) n;
INSERT INTO app.refresh_runs(id,job_name,started_at,outcome,failed_count) VALUES ('a0000000-0000-4000-8000-000000000001','synthetic-refresh','2026-01-01Z','running',2);
