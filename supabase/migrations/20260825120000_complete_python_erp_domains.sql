-- Registros relacionais por módulo. A migração é aditiva e não altera dados existentes.
CREATE TABLE IF NOT EXISTS public.smg_domain_records (
  resource_type text NOT NULL,
  id text NOT NULL,
  data jsonb NOT NULL DEFAULT '{}'::jsonb,
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  deleted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(resource_type,id)
);
CREATE INDEX IF NOT EXISTS smg_domain_records_active_idx ON public.smg_domain_records(resource_type,updated_at DESC) WHERE deleted_at IS NULL;
CREATE TABLE IF NOT EXISTS public.smg_backup_revisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), checksum text NOT NULL,
  reason text NOT NULL DEFAULT 'manual', snapshot jsonb NOT NULL,
  created_by text NOT NULL DEFAULT '', created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS smg_backup_revisions_created_idx ON public.smg_backup_revisions(created_at DESC);
ALTER TABLE public.smg_domain_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.smg_backup_revisions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.smg_domain_records FROM anon, authenticated;
REVOKE ALL ON TABLE public.smg_backup_revisions FROM anon, authenticated;
