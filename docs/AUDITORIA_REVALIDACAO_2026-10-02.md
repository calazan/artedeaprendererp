# Revalidação da auditoria de segurança — 2026-10-02

Branch auditada: `security/audit-fixes`

Esta revalidação foi feita após reconciliar a branch de segurança com o `main` mais recente, preservando as correções funcionais recentes de chamada, sincronização e pré-cadastro. O deploy da branch continua desabilitado na Vercel; nenhuma alteração desta auditoria deve chegar à produção antes de autorização explícita do proprietário.

## Resultado por etapa

### Etapa 1 — modo online e dados locais

- O namespace operacional `arteDeAprenderERP.*` é virtualizado em memória antes do bundle principal.
- Somente `arteDeAprenderERP.navigationColors.v2` pode persistir, pois contém apenas preferência visual.
- Logout, 401 e abertura do login limpam localStorage/sessionStorage do namespace, CacheStorage e o IndexedDB legado de pasta de backup.
- Backups locais automáticos e cópias `*_backup_erro_*` estão desativados.
- A chamada de professores não usa fila offline persistente.
- O pré-cadastro mantém no sessionStorage somente o ID do registro.
- O marcador de lembrete local de tarefas foi movido para o namespace virtualizado e não persiste em disco.
- O Service Worker não cacheia HTML autenticado nem respostas de API; navegação offline mostra tela “Sem conexão”.
- Risco remanescente: o frontend legado ainda utiliza um snapshot amplo em memória durante a sessão. A migração final para APIs por entidade está em `docs/PLANO_ONLINE_ONLY.md`.

### Etapa 2 — sessão e autenticação

- `SESSION_SECRET` é obrigatório, com no mínimo 32 bytes; não existe fallback por `DATABASE_URL` ou chave de sync.
- Sessões possuem `session_version`; logout, desativação e reset de credencial podem invalidar cookies anteriores.
- Papel, vínculo e organização são revalidados no Neon com cache de até 60 s; falha de banco nega acesso.
- O papel efetivo vem do banco, não do cookie.
- Rate limit de login usa e-mail+IP e bucket global por IP.
- Conta inexistente executa Argon2 contra hash fictício para reduzir enumeração temporal.
- IP de cliente usa cabeçalhos compatíveis com Vercel (`x-real-ip` / `x-forwarded-for`) e não usa `cf-connecting-ip`.
- Matriz owner/admin/manager/teacher documentada; manager não pode sync destrutivo, excluir funcionário, acessar documentos de funcionário nem alterar WhatsApp.

### Etapa 3 — headers e XSS

Headers globais:
- `Strict-Transport-Security: max-age=31536000; includeSubDomains`
- `X-Content-Type-Options: nosniff`
- `Referrer-Policy: same-origin`
- `Permissions-Policy: camera=(), microphone=(), geolocation=()`
- `X-Frame-Options: DENY`
- CSP compatível com o aplicativo, bloqueante por padrão e com modo temporário report-only via `CSP_REPORT_ONLY=true`.

A auditoria de sinks HTML e as correções de scripts inline/handlers estão documentadas em `docs/CSP_AUDIT.md`.

### Etapa 4 — sincronização, backups e limite da Vercel

Documentação oficial da Vercel revalidada em 2026-10-02:
- request body de Function: máximo 4,5 MB;
- response body de Function: máximo 4,5 MB.

Referências:
- https://vercel.com/docs/errors/function_payload_too_large
- https://vercel.com/docs/errors/function_response_payload_too_large

O ERP usa margem de 4 MiB para sync e 2,75 MB para binário de documento enviado em base64. Excesso retorna HTTP 413 com mensagem explícita.

A revisão do sync é atualizada atomicamente na mesma transação do estado. Conflito retorna 409 `REMOTE_CONFLICT`. Backup pré-destrutivo e migração de estado suplementar participam da mesma transação.

Backups server-side:
- snapshot antes de sync destrutivo/restauração;
- retenção: todos por 30 dias + 1 mensal por até 12 meses;
- endpoints owner/admin para listar, criar e restaurar;
- snapshot não é enviado ao navegador na listagem;
- restauração exige `confirm="RESTAURAR"`, cria backup do estado atual e registra auditoria.

Upload direto para object storage não foi implementado sem credenciais/provedor definido. Plano: `docs/PLANO_DOCUMENTOS_STORAGE.md`.

### Etapa 5 — privacidade/LGPD e uploads

- Pré-cadastro: AES-256-GCM em campos sensíveis via `DATA_ENCRYPTION_KEY`.
- Migração de registros legados: `scripts/migrate_preregistration_encryption.py`.
- Retenção de rejeitados configurável e limpeza de rate limits expirados.
- Documentos de funcionário validam magic bytes de PDF/JPEG/PNG/WEBP; download é attachment com CSP sandbox.
- Auditoria cobre login, falha de login, logout, documentos, pré-cadastro, WhatsApp, restauração de backup e atribuição administrativa de papel.
- Detalhes: `docs/LGPD_SECURITY.md`.

### Etapa 6 — endpoints e cron

- `/api/health` público executa somente `SELECT 1`.
- Diagnóstico detalhado exige sessão.
- Rotas legadas com “supabase” e autenticação `REMOTE_SYNC_KEY` foram removidas.
- Frontend usa sessão HttpOnly/same-origin.
- Cron agendado de WhatsApp tem um único endpoint: `POST /api/internal/whatsapp-dispatch`, autorizado por `Authorization: Bearer $CRON_SECRET`.
- “Processar agora” no painel continua ação administrativa autenticada, não é mecanismo de cron.

### Etapa 7 — qualidade

- Versão central: `smg/__init__.py`.
- CI executa sintaxe, pytest, pip-audit, Bandit e Gitleaks.
- Dependabot configurado para pip e GitHub Actions.
- Testes específicos cobrem sessão/revogação, papéis, dados locais, CSP/headers, 413, conflitos, backups/restauração, criptografia, uploads e endpoints.

## Variáveis obrigatórias/recomendadas antes do deploy

Obrigatórias para produção:
1. `DATABASE_URL` — fornecida pela integração Neon/Vercel.
2. `SESSION_SECRET` — aleatório, mínimo 32 bytes.
3. `DATA_ENCRYPTION_KEY` — exatamente 32 bytes codificados em base64-url, se o pré-cadastro for usado.
4. `CRON_SECRET` — segredo aleatório forte, mínimo recomendado 32 bytes, se o cron do WhatsApp for usado.

WhatsApp, se habilitado:
- `WHATSAPP_ACCESS_TOKEN`
- `WHATSAPP_PHONE_NUMBER_ID`
- `WHATSAPP_APP_SECRET`
- `WHATSAPP_WEBHOOK_VERIFY_TOKEN`
- `WHATSAPP_TEMPLATE_NAME`
- `WHATSAPP_TEMPLATE_LANGUAGE`
- `WHATSAPP_GRAPH_API_VERSION`

Outras:
- `PREREG_REJECTED_RETENTION_DAYS` (padrão 30)
- `CSP_REPORT_ONLY=false` em produção
- `SMG_FRONTEND_DIR` somente se o frontend não estiver em `frontend`

Não configurar/reintroduzir:
- `REMOTE_SYNC_KEY`
- `ALLOW_LEGACY_SYNC_KEY`

## Ordem segura de implantação

1. Não alterar a produção até a aprovação explícita.
2. Gerar e configurar `SESSION_SECRET`, `DATA_ENCRYPTION_KEY` e `CRON_SECRET` na Vercel.
3. Confirmar `DATABASE_URL` do Neon.
4. Aplicar/revalidar `neon/migrations/002_session_version.sql`.
5. Se existirem pré-cadastros legados, executar a migração de criptografia usando a MESMA `DATA_ENCRYPTION_KEY` configurada na Vercel.
6. Fazer Preview da branch somente após autorização explícita.
7. Executar testes manuais abaixo.
8. Somente depois promover/mesclar para `main` e produzir novo deploy.

## Testes manuais antes da produção

1. Login válido e inválido; confirmar rate limit sem enumeração perceptível.
2. Logout; confirmar cookie encerrado e localStorage/sessionStorage do namespace vazios.
3. Abrir `/login` depois de fechar a aba sem logout e confirmar limpeza do storage/cache.
4. Forçar 401 e confirmar limpeza + redirecionamento.
5. Desativar/revogar um usuário e confirmar que cookie antigo deixa de funcionar.
6. Testar owner/admin/manager/teacher contra a matriz de permissões.
7. Testar sync em dois navegadores e confirmar 409 em revisão conflitante.
8. Testar chamada em dois aparelhos e confirmar que registro mais novo não é sobrescrito.
9. Criar sync destrutivo controlado, verificar backup server-side e restaurá-lo com confirmação.
10. Enviar payload > 4 MiB e documento acima do limite e confirmar HTTP 413.
11. Testar PDF/JPEG/PNG/WEBP válido e conteúdo com MIME falso.
12. Criar pré-cadastro sensível, confirmar que os campos aparecem criptografados no banco e legíveis apenas no endpoint admin.
13. Colocar o navegador offline e confirmar que o ERP autenticado não abre a partir de cache.
14. Validar WhatsApp manual e cron separadamente.

## Riscos remanescentes / fase 2

- O bundle legado ainda trabalha com snapshot operacional completo em memória durante a sessão. O objetivo arquitetural é substituir isso por APIs por entidade/paginação.
- Documentos de funcionários ainda atravessam a Function em base64; migrar para object storage com upload direto e URL assinada.
- A aplicação ainda carrega código legado de backup/local password no bundle minificado, embora os caminhos de persistência/autenticação estejam desativados pelo bridge e pela UI. Remover esse código em uma refatoração do frontend reduzirá superfície e dívida técnica.
- Recomenda-se adicionar E2E real de navegador para verificar Storage/Cache/IndexedDB, expiração, múltiplos navegadores e CSP em ambiente Preview.
- A branch de segurança está deliberadamente sem deploy automático na Vercel.
