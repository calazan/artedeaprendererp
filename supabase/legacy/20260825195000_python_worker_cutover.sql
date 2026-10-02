-- LEGACY: arquivo histórico do período Supabase/pg_net.
-- NÃO executar no Neon/PostgreSQL atual. Os agendamentos vigentes são feitos
-- por Vercel Cron Jobs (ou scheduler HTTP externo) com CRON_SECRET.
--
-- Arte de Aprender ERP 4.8.0 — remove dependência operacional das Edge Functions legadas.
-- Mantém os jobs e tokens existentes para permitir rollback, mas os disparos passam
-- a chamar exclusivamente o backend FastAPI deste repositório.

CREATE OR REPLACE FUNCTION public.dart20_dispatch_task_push()
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'extensions', 'net'
AS $function$
DECLARE
  request_id bigint;
  cron_token text;
BEGIN
  SELECT value->>'token' INTO cron_token
  FROM public.smg_meta
  WHERE key='task_push_cron'
  LIMIT 1;

  IF coalesce(length(cron_token),0) < 32 THEN
    RAISE EXCEPTION 'task push cron token not configured';
  END IF;

  SELECT net.http_post(
    url := 'https://artedeaprendererp.vercel.app/api/tasks?action=dispatch',
    headers := jsonb_build_object(
      'x-task-cron-token', cron_token,
      'Content-Type', 'application/json',
      'User-Agent', 'ArteDeAprender-Python-Cron/1.0'
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 15000
  ) INTO request_id;

  RETURN request_id;
END;
$function$;

CREATE OR REPLACE FUNCTION public.dart_dispatch_whatsapp()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'extensions', 'net'
AS $function$
DECLARE
  cron_token text;
  request_id bigint;
BEGIN
  SELECT value->>'token' INTO cron_token
  FROM public.smg_meta
  WHERE key='dart_whatsapp_cron'
  LIMIT 1;

  IF coalesce(length(cron_token),0) < 32 THEN
    RAISE EXCEPTION 'whatsapp cron token not configured';
  END IF;

  SELECT net.http_post(
    url := 'https://artedeaprendererp.vercel.app/api/internal/whatsapp-dispatch',
    headers := jsonb_build_object(
      'x-whatsapp-cron-token', cron_token,
      'Content-Type', 'application/json',
      'User-Agent', 'ArteDeAprender-Python-Cron/1.0'
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 15000
  ) INTO request_id;
END;
$function$;

REVOKE ALL ON FUNCTION public.dart20_dispatch_task_push() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.dart_dispatch_whatsapp() FROM PUBLIC, anon, authenticated;
