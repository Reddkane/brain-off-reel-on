CREATE TABLE app.profiles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), account_id uuid CONSTRAINT profiles_account_fk REFERENCES auth.users(id) ON DELETE CASCADE,
  region text NOT NULL DEFAULT 'US' CHECK (region ~ '^[A-Z]{2}$'), runtime_ceiling_minutes integer CHECK (runtime_ceiling_minutes > 0),
  known_languages text[] NOT NULL DEFAULT '{}', subtitle_policy text NOT NULL DEFAULT 'unknown' CHECK (subtitle_policy IN ('unknown','allowed','disallowed')),
  content_policy jsonb NOT NULL DEFAULT '{}', revision bigint NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_profiles_account ON app.profiles(account_id) WHERE account_id IS NOT NULL;
CREATE TABLE app.profile_subscriptions (
  profile_id uuid NOT NULL CONSTRAINT profile_subscriptions_profile_fk REFERENCES app.profiles ON DELETE CASCADE,
  provider_id uuid NOT NULL CONSTRAINT profile_subscriptions_provider_fk REFERENCES app.streaming_providers ON DELETE RESTRICT,
  enabled boolean NOT NULL DEFAULT true, PRIMARY KEY(profile_id,provider_id)
);
CREATE INDEX idx_profile_subscriptions_provider ON app.profile_subscriptions(provider_id);
CREATE TABLE app.profile_movies (
  profile_id uuid NOT NULL CONSTRAINT profile_movies_profile_fk REFERENCES app.profiles ON DELETE CASCADE,
  movie_id uuid NOT NULL CONSTRAINT profile_movies_movie_fk REFERENCES app.movies ON DELETE RESTRICT,
  watched boolean NOT NULL DEFAULT false, watched_on date, taste_rating text CHECK (taste_rating IN ('loved','liked','meh','disliked')),
  tired_viewing_rating smallint CHECK (tired_viewing_rating BETWEEN 0 AND 4), permanent_exclusion boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT profile_movies_watched_date_check CHECK (watched OR watched_on IS NULL), PRIMARY KEY(profile_id,movie_id)
);
CREATE INDEX idx_profile_movies_movie ON app.profile_movies(movie_id);
CREATE TABLE app.selection_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), profile_id uuid NOT NULL CONSTRAINT selection_sessions_profile_fk REFERENCES app.profiles ON DELETE CASCADE,
  started_at timestamptz NOT NULL DEFAULT now(), last_activity_at timestamptz NOT NULL, ended_at timestamptz,
  outcome text NOT NULL DEFAULT 'active' CHECK (outcome IN ('active','selected_provisional','selected_intent','availability_failure','abandoned','refresh_stale','refresh_failed','backend_unavailable','eligible_pool_exhausted')),
  selected_recommendation_id uuid, selected_at timestamptz, correction_deadline timestamptz,
  experiment_arm text CHECK (experiment_arm IN ('personalized','quality_first')), experiment_seed text CHECK (experiment_seed ~ '\S'), experiment_version text CHECK (experiment_version ~ '\S'),
  CONSTRAINT selection_sessions_time_check CHECK (last_activity_at >= started_at AND (ended_at IS NULL OR ended_at >= last_activity_at) AND (selected_at IS NULL OR selected_at >= started_at) AND (correction_deadline IS NULL OR correction_deadline >= selected_at)),
  CONSTRAINT selection_sessions_selection_check CHECK (CASE WHEN outcome IN ('selected_provisional','selected_intent') THEN num_nonnulls(selected_recommendation_id,selected_at,correction_deadline)=3 ELSE num_nonnulls(selected_recommendation_id,selected_at,correction_deadline)=0 END),
  CONSTRAINT selection_sessions_end_check CHECK ((outcome IN ('active','selected_provisional')) = (ended_at IS NULL)),
  CONSTRAINT selection_sessions_experiment_check CHECK (num_nonnulls(experiment_arm,experiment_seed,experiment_version) IN (0,3))
);
CREATE INDEX idx_selection_sessions_profile ON app.selection_sessions(profile_id,started_at DESC,id);
CREATE INDEX idx_selection_sessions_correction ON app.selection_sessions(correction_deadline) WHERE outcome='selected_provisional';
CREATE INDEX idx_selection_sessions_active ON app.selection_sessions(last_activity_at) WHERE outcome='active';
CREATE TABLE app.recommendations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), session_id uuid NOT NULL CONSTRAINT recommendations_session_fk REFERENCES app.selection_sessions ON DELETE CASCADE,
  movie_id uuid NOT NULL CONSTRAINT recommendations_movie_fk REFERENCES app.movies ON DELETE RESTRICT,
  sequence integer NOT NULL CHECK (sequence > 0), idempotency_key text NOT NULL CHECK (idempotency_key ~ '\S'), explanation text NOT NULL CHECK (explanation ~ '\S'),
  algorithm_version text NOT NULL CHECK (algorithm_version ~ '\S'), config_version text NOT NULL CHECK (config_version ~ '\S'), rubric_version text NOT NULL CHECK (rubric_version ~ '\S'),
  classification_id uuid, profile_revision bigint NOT NULL CHECK (profile_revision > 0), trace jsonb NOT NULL CHECK (jsonb_typeof(trace)='object'), created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT recommendations_idempotency_key UNIQUE(session_id,idempotency_key), CONSTRAINT recommendations_sequence_key UNIQUE(session_id,sequence), CONSTRAINT recommendations_session_id_key UNIQUE(session_id,id),
  CONSTRAINT recommendations_classification_fk FOREIGN KEY(classification_id,movie_id) REFERENCES app.movie_classifications(id,movie_id) ON DELETE RESTRICT
);
CREATE INDEX idx_recommendations_movie ON app.recommendations(movie_id);
CREATE INDEX idx_recommendations_classification ON app.recommendations(classification_id,movie_id) WHERE classification_id IS NOT NULL;
ALTER TABLE app.selection_sessions ADD CONSTRAINT selection_sessions_selected_recommendation_fk FOREIGN KEY(id,selected_recommendation_id) REFERENCES app.recommendations(session_id,id) ON DELETE NO ACTION NOT DEFERRABLE;
CREATE TABLE app.feedback_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), recommendation_id uuid NOT NULL CONSTRAINT feedback_events_recommendation_fk REFERENCES app.recommendations ON DELETE CASCADE,
  event_type text NOT NULL CHECK (event_type IN ('skip','not_interested','seen','too_heavy','not_available','choose','post_watch')), reason text,
  taste_rating text CHECK (taste_rating IN ('loved','liked','meh','disliked')), tired_viewing_rating smallint CHECK (tired_viewing_rating BETWEEN 0 AND 4),
  idempotency_key text NOT NULL CHECK (idempotency_key ~ '\S'), created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT feedback_events_rating_check CHECK (CASE WHEN event_type='post_watch' THEN num_nonnulls(taste_rating,tired_viewing_rating)>0 ELSE num_nonnulls(taste_rating,tired_viewing_rating)=0 END),
  CONSTRAINT feedback_events_idempotency_key UNIQUE(recommendation_id,idempotency_key)
);
CREATE TABLE app.refresh_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), job_name text NOT NULL CHECK (job_name ~ '\S'), started_at timestamptz NOT NULL DEFAULT now(), ended_at timestamptz,
  outcome text NOT NULL CHECK (outcome IN ('running','success','partial','failed')), processed_count integer NOT NULL DEFAULT 0 CHECK (processed_count>=0), failed_count integer NOT NULL DEFAULT 0 CHECK (failed_count>=0),
  checkpoint jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(checkpoint)='object'), diagnostic_summary text,
  CONSTRAINT refresh_runs_end_check CHECK ((outcome='running') = (ended_at IS NULL) AND (ended_at IS NULL OR ended_at>=started_at))
);
CREATE INDEX idx_refresh_runs_job ON app.refresh_runs(job_name,started_at DESC,id);
REVOKE ALL ON ALL TABLES IN SCHEMA app FROM PUBLIC, anon, authenticated, service_role;
