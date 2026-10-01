-- Arte de Aprender ERP 4.8.0 — armazenamento exclusivo do backend Python.
-- Aditiva e de hardening: não remove nem altera registros existentes.

CREATE TABLE IF NOT EXISTS public.smg_manual_backups (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  checksum text NOT NULL,
  reason text NOT NULL DEFAULT 'manual',
  snapshot jsonb NOT NULL,
  created_by text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS smg_manual_backups_created_idx
  ON public.smg_manual_backups(created_at DESC);

DO $$
DECLARE
  table_row record;
BEGIN
  FOR table_row IN
    SELECT c.relname
    FROM pg_class c
    JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='public'
      AND c.relkind='r'
      AND c.relname LIKE 'smg_%'
  LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', table_row.relname);
    EXECUTE format('REVOKE ALL PRIVILEGES ON TABLE public.%I FROM anon, authenticated', table_row.relname);
  END LOOP;
END $$;

COMMENT ON TABLE public.smg_manual_backups IS
  'Backups manuais versionados do ERP Python; separados dos snapshots automáticos smg_backup_revisions.';
