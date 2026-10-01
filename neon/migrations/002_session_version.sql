ALTER TABLE public.app_users
  ADD COLUMN IF NOT EXISTS session_version integer NOT NULL DEFAULT 1;
