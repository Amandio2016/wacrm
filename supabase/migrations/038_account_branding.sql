-- ============================================================
-- 038_account_branding
--
-- Per-account white-label branding.
--
-- Each customer account can upload its own logo and set its own
-- product name. The app renders these everywhere the wacrm mark used
-- to be hardcoded (sidebar, header, auth pages, page title, favicon),
-- so a reseller's customers see their own brand rather than ours.
--
-- Storage path convention (mirrors `avatars`, migration 008):
--   branding/{account_id}/logo-<timestamp>.<ext>
-- The first path segment is the ACCOUNT id, not the user id — the
-- logo belongs to the account, and any admin of that account may
-- replace it. Policies below check membership via is_account_member()
-- rather than comparing to auth.uid().
--
-- The bucket is public: logos render as plain <img> on the login page,
-- which is served to signed-OUT visitors. A signed URL is impossible
-- there, and a logo is not a secret.
--
-- Idempotent — safe to re-run.
-- ============================================================

ALTER TABLE accounts
  ADD COLUMN IF NOT EXISTS logo_url TEXT,
  ADD COLUMN IF NOT EXISTS brand_name TEXT;

-- ------------------------------------------------------------
-- Storage bucket
-- ------------------------------------------------------------
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'branding',
  'branding',
  TRUE,
  2097152, -- 2 MB
  ARRAY['image/png', 'image/jpeg', 'image/webp', 'image/svg+xml']
)
ON CONFLICT (id) DO UPDATE
SET
  public = EXCLUDED.public,
  file_size_limit = EXCLUDED.file_size_limit,
  allowed_mime_types = EXCLUDED.allowed_mime_types;

DROP POLICY IF EXISTS "Branding is publicly readable" ON storage.objects;
CREATE POLICY "Branding is publicly readable"
  ON storage.objects FOR SELECT
  USING (bucket_id = 'branding');

-- Writes are admin-only: an agent shouldn't be able to rebrand the
-- workspace out from under the owner.
DROP POLICY IF EXISTS "Account admins can upload branding" ON storage.objects;
CREATE POLICY "Account admins can upload branding"
  ON storage.objects FOR INSERT
  WITH CHECK (
    bucket_id = 'branding'
    AND is_account_member(((storage.foldername(name))[1])::uuid, 'admin')
  );

DROP POLICY IF EXISTS "Account admins can update branding" ON storage.objects;
CREATE POLICY "Account admins can update branding"
  ON storage.objects FOR UPDATE
  USING (
    bucket_id = 'branding'
    AND is_account_member(((storage.foldername(name))[1])::uuid, 'admin')
  );

DROP POLICY IF EXISTS "Account admins can delete branding" ON storage.objects;
CREATE POLICY "Account admins can delete branding"
  ON storage.objects FOR DELETE
  USING (
    bucket_id = 'branding'
    AND is_account_member(((storage.foldername(name))[1])::uuid, 'admin')
  );
