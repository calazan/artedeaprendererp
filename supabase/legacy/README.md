# Migrações legadas do Supabase

Os arquivos desta pasta são mantidos apenas como histórico e **não devem ser
executados no Neon/PostgreSQL atual**.

O arquivo `20260825195000_python_worker_cutover.sql` dependia de
`pg_net/net.http_post` e de tokens gravados em `smg_meta`. O ERP atual usa
endpoints FastAPI protegidos por `CRON_SECRET`, acionados por Vercel Cron Jobs
ou por um scheduler HTTP externo.

As migrations ativas continuam em `supabase/migrations/` até a fase de higiene
que consolidará o provisionamento do Neon.
