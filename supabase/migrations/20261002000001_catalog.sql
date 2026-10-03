-- PostgreSQL 17; platform roles and auth prerequisites are supplied externally.
CREATE SCHEMA app;
REVOKE ALL ON SCHEMA app FROM PUBLIC, anon, authenticated, service_role;
-- Schema-scoped revokes cannot remove global defaults, including PUBLIC function
-- EXECUTE. Every migration must explicitly revoke API/PUBLIC access on each new
-- object in its creation transaction; leave platform-wide defaults unchanged.

CREATE TABLE app.movies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title text NOT NULL CHECK (title ~ '\S'),
  release_date date,
  release_date_source text CHECK (release_date_source ~ '\S'),
  release_date_semantics text CHECK (release_date_semantics IN ('original_release','theatrical','digital','other')),
  release_date_checked_at timestamptz,
  runtime_minutes integer CHECK (runtime_minutes > 0),
  original_language text CHECK (original_language ~ '\S'),
  us_certification text CHECK (us_certification IN ('G','PG','PG-13','R','NC-17','NR')),
  certification_source text CHECK (certification_source ~ '\S'),
  certification_checked_at timestamptz,
  overview text, poster_path text CHECK (poster_path ~ '\S'),
  genres text[] NOT NULL DEFAULT '{}', keywords text[] NOT NULL DEFAULT '{}',
  production_company_evidence jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(production_company_evidence) = 'array'),
  origin_group text NOT NULL DEFAULT 'unknown' CHECK (origin_group IN ('streamer_produced_financed','traditional_studio','independent','mixed','unknown')),
  origin_evidence jsonb NOT NULL DEFAULT '[]' CONSTRAINT movies_origin_evidence_array_check CHECK (jsonb_typeof(origin_evidence) = 'array'),
  origin_mapping_version text CHECK (origin_mapping_version ~ '\S'), origin_checked_at timestamptz,
  rating numeric(4,2) CHECK (rating BETWEEN 0 AND 10), vote_count integer CHECK (vote_count >= 0),
  metadata_source text NOT NULL CHECK (metadata_source ~ '\S'), metadata_refreshed_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT movies_release_evidence_check CHECK (num_nonnulls(release_date,release_date_source,release_date_semantics,release_date_checked_at) IN (0,4)),
  CONSTRAINT movies_certification_evidence_check CHECK (num_nonnulls(us_certification,certification_source,certification_checked_at) IN (0,3)),
  CONSTRAINT movies_origin_evidence_check CHECK (origin_group = 'unknown' OR (jsonb_array_length(origin_evidence)>0 AND origin_mapping_version IS NOT NULL AND origin_checked_at IS NOT NULL))
);
CREATE TABLE app.movie_external_ids (
  movie_id uuid NOT NULL CONSTRAINT movie_external_ids_movie_fk REFERENCES app.movies ON DELETE CASCADE,
  source text NOT NULL CHECK (source ~ '\S'), external_id text NOT NULL CHECK (external_id ~ '\S'),
  PRIMARY KEY (movie_id,source), CONSTRAINT movie_external_ids_source_external_id_key UNIQUE (source,external_id)
);
CREATE TABLE app.movie_credits (
  movie_id uuid NOT NULL CONSTRAINT movie_credits_movie_fk REFERENCES app.movies ON DELETE CASCADE,
  source text NOT NULL CHECK (source ~ '\S'), person_external_id text NOT NULL CHECK (person_external_id ~ '\S'),
  name text NOT NULL CHECK (name ~ '\S'), role text NOT NULL CHECK (role ~ '\S'), billing_order integer CHECK (billing_order >= 0),
  PRIMARY KEY (movie_id,source,person_external_id,role)
);
CREATE TABLE app.movie_classifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), movie_id uuid NOT NULL CONSTRAINT movie_classifications_movie_fk REFERENCES app.movies ON DELETE RESTRICT,
  rubric_version text NOT NULL CHECK (rubric_version ~ '\S'),
  narrative_complexity smallint CHECK (narrative_complexity BETWEEN 0 AND 4), attention_demand smallint CHECK (attention_demand BETWEEN 0 AND 4),
  emotional_burden smallint CHECK (emotional_burden BETWEEN 0 AND 4), on_screen_text_dependence smallint CHECK (on_screen_text_dependence BETWEEN 0 AND 4),
  pacing text CHECK (pacing ~ '\S'), tone text[] NOT NULL DEFAULT '{}', content_tags text[] NOT NULL DEFAULT '{}',
  field_provenance jsonb NOT NULL CHECK (jsonb_typeof(field_provenance)='object'), field_uncertainty jsonb NOT NULL CHECK (jsonb_typeof(field_uncertainty)='object'),
  input_evidence jsonb NOT NULL CHECK (jsonb_typeof(input_evidence)='object'), input_fingerprint text NOT NULL CHECK (input_fingerprint ~ '\S'),
  model_id text CHECK (model_id ~ '\S'), prompt_id text CHECK (prompt_id ~ '\S'),
  review_status text NOT NULL CHECK (review_status IN ('unreviewed','needs_review','reviewed')), created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT movie_classifications_id_movie_key UNIQUE (id,movie_id)
);
CREATE INDEX idx_movie_classifications_history ON app.movie_classifications(movie_id,created_at DESC,id);
CREATE TABLE app.streaming_providers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), display_name text NOT NULL CHECK (display_name ~ '\S'),
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE app.streaming_provider_external_ids (
  provider_id uuid NOT NULL CONSTRAINT streaming_provider_external_ids_provider_fk REFERENCES app.streaming_providers ON DELETE CASCADE,
  source text NOT NULL CHECK (source ~ '\S'), external_id text NOT NULL CHECK (external_id ~ '\S'),
  PRIMARY KEY(provider_id,source), CONSTRAINT streaming_provider_external_ids_source_external_id_key UNIQUE(source,external_id)
);
CREATE TABLE app.availability_snapshots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), movie_id uuid NOT NULL CONSTRAINT availability_snapshots_movie_fk REFERENCES app.movies ON DELETE RESTRICT,
  region text NOT NULL CHECK (region ~ '^[A-Z]{2}$'), source text NOT NULL CHECK (source ~ '\S'),
  checked_at timestamptz NOT NULL, refresh_deadline timestamptz NOT NULL CHECK (refresh_deadline >= checked_at),
  outcome text NOT NULL CHECK (outcome IN ('success','failed')), watch_page_url text CHECK (watch_page_url LIKE 'https://%'), diagnostic_code text CHECK (diagnostic_code ~ '\S'),
  created_at timestamptz NOT NULL DEFAULT now(), creation_xid xid8 NOT NULL DEFAULT pg_current_xact_id(),
  CONSTRAINT availability_snapshots_failed_url_check CHECK (outcome='success' OR watch_page_url IS NULL),
  CONSTRAINT availability_snapshots_history_key UNIQUE(movie_id,region,source,checked_at),
  CONSTRAINT availability_snapshots_identity_key UNIQUE(id,movie_id,region,source)
);
CREATE INDEX idx_availability_snapshots_success ON app.availability_snapshots(movie_id,region,source,checked_at DESC) WHERE outcome='success';
CREATE TABLE app.movie_availability (
  snapshot_id uuid NOT NULL CONSTRAINT movie_availability_snapshot_fk REFERENCES app.availability_snapshots ON DELETE CASCADE,
  provider_id uuid NOT NULL CONSTRAINT movie_availability_provider_fk REFERENCES app.streaming_providers ON DELETE RESTRICT,
  offer_type text NOT NULL CHECK (offer_type IN ('subscription','ads','free','rental','purchase')), PRIMARY KEY(snapshot_id,provider_id,offer_type)
);
CREATE INDEX idx_movie_availability_provider ON app.movie_availability(provider_id,offer_type,snapshot_id);
CREATE TABLE app.availability_tracks (
  movie_id uuid NOT NULL CONSTRAINT availability_tracks_movie_fk REFERENCES app.movies ON DELETE CASCADE,
  provider_id uuid NOT NULL CONSTRAINT availability_tracks_provider_fk REFERENCES app.streaming_providers ON DELETE RESTRICT,
  region text NOT NULL CHECK (region ~ '^[A-Z]{2}$'), source text NOT NULL CHECK (source ~ '\S'),
  offer_type text NOT NULL CHECK (offer_type IN ('subscription','ads','free','rental','purchase')), tracked_since timestamptz NOT NULL,
  PRIMARY KEY(movie_id,provider_id,region,source,offer_type)
);
CREATE INDEX idx_availability_tracks_provider ON app.availability_tracks(provider_id);
CREATE TABLE app.availability_observations (
  snapshot_id uuid NOT NULL, movie_id uuid NOT NULL, provider_id uuid NOT NULL, region text NOT NULL, source text NOT NULL,
  offer_type text NOT NULL CHECK (offer_type IN ('subscription','ads','free','rental','purchase')), state text NOT NULL CHECK (state IN ('present','absent')),
  provider_arrival_date date, provider_arrival_source text CHECK (provider_arrival_source ~ '\S'), provider_arrival_semantics text CHECK (provider_arrival_semantics ~ '\S'),
  PRIMARY KEY(snapshot_id,provider_id,offer_type),
  CONSTRAINT availability_observations_snapshot_fk FOREIGN KEY(snapshot_id,movie_id,region,source) REFERENCES app.availability_snapshots(id,movie_id,region,source) ON DELETE CASCADE,
  CONSTRAINT availability_observations_track_fk FOREIGN KEY(movie_id,provider_id,region,source,offer_type) REFERENCES app.availability_tracks ON DELETE CASCADE,
  CONSTRAINT availability_observations_arrival_check CHECK (num_nonnulls(provider_arrival_date,provider_arrival_source,provider_arrival_semantics) IN (0,3) AND (state='present' OR provider_arrival_date IS NULL))
);
CREATE INDEX idx_availability_observations_track ON app.availability_observations(movie_id,provider_id,region,source,offer_type,snapshot_id);
REVOKE ALL ON ALL TABLES IN SCHEMA app FROM PUBLIC, anon, authenticated, service_role;
