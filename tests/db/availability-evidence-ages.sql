-- Invented disposable graphs. A DO statement fixes statement_timestamp at exact boundaries.
DO $$
DECLARE age interval; snap uuid; sweep uuid; provider uuid; gen text;
  relation text; predicate text; column_name text; was_denied boolean; affected integer;
BEGIN
  SELECT provider_id INTO STRICT provider FROM app.streaming_provider_external_ids WHERE source='watchmode' AND external_id='203';
  FOREACH age IN ARRAY ARRAY[interval '29 days',interval '30 days',interval '31 days'] LOOP
    snap:=gen_random_uuid(); sweep:=gen_random_uuid(); gen:='ages_'||replace(sweep::text,'-','');
    INSERT INTO app.watchmode_sweeps VALUES(sweep,sweep,203,gen,statement_timestamp()-age);
    INSERT INTO app.watchmode_pages(sweep_id,page,total_pages,total_results,row_count,unresolved_count,signature,observed_at)
      VALUES(sweep,1,1,1,1,0,repeat('a',64),statement_timestamp()-age);
    INSERT INTO app.watchmode_memberships VALUES(sweep,1,778899,'998811',NULL,statement_timestamp()-age);
    INSERT INTO app.watchmode_sweep_events VALUES(sweep,'complete','complete',statement_timestamp()-age);
    INSERT INTO app.watchmode_enrichment_checks VALUES(sweep,778899,'unchanged',statement_timestamp(),statement_timestamp());
    INSERT INTO app.metadata_detail_attempts VALUES('998812','failed',statement_timestamp()-age);
    INSERT INTO app.availability_tracks VALUES('30000000-0000-4000-8000-000000000001',provider,'US',gen,'subscription',statement_timestamp()-age);
    INSERT INTO app.availability_snapshots(id,movie_id,region,source,checked_at,refresh_deadline,outcome)
      VALUES(snap,'30000000-0000-4000-8000-000000000001','US',gen,statement_timestamp()-age,statement_timestamp(),'success');
    INSERT INTO app.movie_availability(snapshot_id,provider_id,offer_type) VALUES(snap,provider,'subscription');
    INSERT INTO app.availability_observations(snapshot_id,movie_id,provider_id,region,source,offer_type,state)
      VALUES(snap,'30000000-0000-4000-8000-000000000001',provider,'US',gen,'subscription','present');
    INSERT INTO app.watchmode_offer_variants(snapshot_id,provider_id,offer_type,requested_variant,source_id,retention_at)
      VALUES(snap,provider,'subscription','without_ads',203,statement_timestamp());
    INSERT INTO app.watchmode_links(snapshot_id,provider_id,offer_type,requested_variant,web_url,observed_at,expires_at)
      VALUES(snap,provider,'subscription','without_ads','https://www.netflix.com/title/synthetic',statement_timestamp(),statement_timestamp()+interval '30 days');
    INSERT INTO app.watchmode_arrivals(movie_id,source_id,generation,current_sweep,presence_sweep,state,reason,retention_at)
      VALUES('30000000-0000-4000-8000-000000000001',203,gen,sweep,sweep,'present','first_sweep',statement_timestamp());
    FOR relation,column_name,predicate IN SELECT * FROM (VALUES
      ('watchmode_links','observed_at',format('snapshot_id=%L',snap)),
      ('watchmode_offer_variants','retention_at',format('snapshot_id=%L',snap)),
      ('watchmode_arrivals','retention_at',format('current_sweep=%L',sweep)),
      ('availability_observations','retention_at',format('snapshot_id=%L',snap)),
      ('movie_availability','retention_at',format('snapshot_id=%L',snap)),
      ('availability_snapshots','checked_at',format('id=%L',snap)),
      ('availability_tracks','tracked_since',format('source=%L',gen)),
      ('watchmode_enrichment_checks','observed_at',format('sweep_id=%L',sweep)),
      ('watchmode_memberships','observed_at',format('sweep_id=%L',sweep)),
      ('watchmode_pages','observed_at',format('sweep_id=%L',sweep)),
      ('watchmode_sweep_events','observed_at',format('sweep_id=%L',sweep)),
      ('watchmode_sweeps','observed_at',format('id=%L',sweep)),
      ('metadata_detail_attempts','checked_at',format('tmdb_id=%L AND checked_at=statement_timestamp()-%L::interval','998812',age))
    ) cases LOOP
      was_denied:=false;
      BEGIN
        EXECUTE format('UPDATE app.%I SET %I=%I WHERE %s',relation,column_name,column_name,predicate);
      EXCEPTION WHEN check_violation OR insufficient_privilege THEN was_denied:=true; END;
      IF NOT was_denied THEN RAISE EXCEPTION 'UPDATE unexpectedly allowed: %',relation; END IF;
      IF age<=interval '30 days' THEN
        was_denied:=false;
        BEGIN EXECUTE format('DELETE FROM app.%I WHERE %s',relation,predicate);
        EXCEPTION WHEN check_violation THEN was_denied:=true; END;
        IF NOT was_denied THEN RAISE EXCEPTION 'DELETE unexpectedly allowed: %',relation; END IF;
      ELSE
        EXECUTE format('DELETE FROM app.%I WHERE %s',relation,predicate);
        GET DIAGNOSTICS affected=ROW_COUNT;
        IF affected<>1 THEN RAISE EXCEPTION 'Expired DELETE failed positive control: %',relation; END IF;
      END IF;
    END LOOP;
  END LOOP;
END $$;
