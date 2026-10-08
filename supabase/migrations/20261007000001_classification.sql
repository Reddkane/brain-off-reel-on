-- Additive only: immutable legacy revisions stay unchanged and operator-only.
ALTER TABLE app.movie_classifications ADD COLUMN subject_classification_id uuid;
ALTER TABLE app.movie_classifications
  ADD CONSTRAINT classification_subject_fk FOREIGN KEY(subject_classification_id,movie_id)
    REFERENCES app.movie_classifications(id,movie_id) ON DELETE RESTRICT,
  ADD CONSTRAINT classification_subject_not_self CHECK(subject_classification_id IS NULL OR subject_classification_id<>id),
  ADD CONSTRAINT classification_kind_parent CHECK (
    (NOT (input_evidence ? 'version') AND subject_classification_id IS NULL)
    OR COALESCE(input_evidence->>'version'='classification-evidence-v1' AND (
      (input_evidence->>'kind'='human_review' AND subject_classification_id IS NOT NULL)
      OR (input_evidence->>'kind' IN ('model','human_anchor') AND subject_classification_id IS NULL)
    ),false)
  );
DROP POLICY shared_select ON app.movie_classifications;
CREATE POLICY shared_select ON app.movie_classifications FOR SELECT TO authenticated
  USING (input_evidence->>'version'='classification-evidence-v1' AND input_evidence->>'kind'='model');
-- No new function, role, write grant, bypass or rewrite of immutable history.
