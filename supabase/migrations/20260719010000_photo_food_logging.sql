-- Photo food logging ("Snap a Meal") — see docs/PRD-photo-food-logging.md.
--
-- 1) nutrition_logs grows provenance + the itemized Plate-card breakdown.
--    One aggregate row per meal keeps buckets/totals/chat tools unchanged;
--    `items` is only populated for photo logs (null elsewhere).
-- 2) Private `meal-photos` storage bucket. Writes go through the backend
--    service role only (bypasses RLS); users get owner-only read so the app
--    can render thumbnails via signed URLs. Paths:
--      {user_id}/pending/{analysis_id}.jpg  — analyzed, not yet confirmed
--      {user_id}/{log_id}.jpg               — confirmed log photo
-- 3) model_pricing rows for the vision models. REQUIRED: without these,
--    photo scans accrue $0 against the free-tier $0.10/day backstop and the
--    premium $0.80/12h cap (silent uncapped spend).

-- 1) nutrition_logs columns ---------------------------------------------------

ALTER TABLE nutrition_logs
  ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'text',
  ADD COLUMN IF NOT EXISTS image_path text,
  ADD COLUMN IF NOT EXISTS items jsonb;

DO $$ BEGIN
  ALTER TABLE nutrition_logs
    ADD CONSTRAINT nutrition_logs_source_check
    CHECK (source IN ('text', 'barcode', 'photo'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- 2) meal-photos bucket + owner-only read ------------------------------------

INSERT INTO storage.buckets (id, name, public)
VALUES ('meal-photos', 'meal-photos', false)
ON CONFLICT (id) DO NOTHING;

DO $$ BEGIN
  CREATE POLICY "meal_photos_owner_read" ON storage.objects
    FOR SELECT TO authenticated
    USING (
      bucket_id = 'meal-photos'
      AND (storage.foldername(name))[1] = auth.uid()::text
    );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- 3) vision model pricing (per-million-token USD, July 2026 OpenAI rates;
--    cache read = 90% off input) ---------------------------------------------

INSERT INTO model_pricing
  (model_name, provider, input_price_per_million, output_price_per_million, cache_read_price_per_million)
VALUES
  ('gpt-5.4-mini', 'openai', 0.75, 4.50, 0.075),
  ('gpt-5.4',      'openai', 2.50, 15.00, 0.25)
ON CONFLICT (model_name) DO UPDATE SET
  input_price_per_million = EXCLUDED.input_price_per_million,
  output_price_per_million = EXCLUDED.output_price_per_million,
  cache_read_price_per_million = EXCLUDED.cache_read_price_per_million,
  updated_at = now();
