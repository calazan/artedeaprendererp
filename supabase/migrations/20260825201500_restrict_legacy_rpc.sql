-- Arte de Aprender ERP 4.8.0 — endpoints públicos/cliente agora passam pelo FastAPI.
-- Estes RPCs pertencem a fluxos legados e não são usados pelo repositório Python.
-- Mantemos as funções no banco para rollback controlado, mas removemos execução
-- direta via PostgREST por anon/authenticated.

REVOKE EXECUTE ON FUNCTION public.initial_setup_available() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.submit_public_preregistration(text, text, date, text, text, jsonb) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.get_push_public_key() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.register_push_subscription(text, text, text, text) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.unregister_push_subscription(text) FROM PUBLIC, anon, authenticated;
