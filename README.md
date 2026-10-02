# Arte de Aprender ERP

ERP para gestão de espaço de contraturno escolar, baseado na arquitetura do projeto anterior e iniciado com dados limpos.

## Estrutura
- Backend Python / FastAPI
- Frontend web empacotado no próprio repositório
- Integração opcional com Supabase/PostgreSQL
- Deploy compatível com Vercel

## Configuração
Copie `.env.example` para o ambiente de desenvolvimento/produção e configure apenas credenciais do novo projeto. Nenhuma credencial, banco de dados ou endpoint do ERP anterior deve ser reutilizado.

## Estado inicial
Este repositório contém somente código, estrutura e migrations. Não inclui alunos, responsáveis, funcionários, lançamentos financeiros, documentos, uploads ou registros operacionais do projeto de origem.


## Neon / PostgreSQL

O ERP usa PostgreSQL diretamente pelo backend FastAPI. Na Vercel, conecte o projeto ao Neon e confirme que a integração criou `DATABASE_URL` em **Production** (e em Preview se desejar).

Variáveis mínimas:

```env
DATABASE_URL=postgresql://...
SESSION_SECRET=gere-um-segredo-aleatorio-com-pelo-menos-32-bytes
```

A aplicação cria de forma idempotente as tabelas principais e as tabelas de autenticação. A migration de referência para autenticação está em `neon/migrations/001_auth.sql`.

### Criar o primeiro administrador

Com `DATABASE_URL` disponível no ambiente local, execute:

```bash
python scripts/bootstrap_admin.py \
  --email admin@exemplo.com \
  --name "Administrador" \
  --organization "Arte de Aprender"
```

A senha é solicitada interativamente e armazenada apenas como **Argon2id**. Para automação protegida, use temporariamente `BOOTSTRAP_ADMIN_PASSWORD`; nunca versione esse valor.

Depois do primeiro usuário, acesse `/login` e entre com o e-mail e a senha criados.

### Endpoints de diagnóstico

- `/api/health`: disponibilidade do banco e schema.
- `/api/neon-health`: diagnóstico detalhado para usuário autenticado.
- `/api/integrity`: integridade do banco para administradores.

As antigas rotas com “supabase” no nome permanecem somente como aliases de compatibilidade com versões anteriores do frontend; elas usam o mesmo Neon/PostgreSQL e não acessam Supabase Auth.

## Agendamentos automáticos

Os disparos automáticos usam os endpoints FastAPI protegidos pela variável
`CRON_SECRET`. A Vercel envia o segredo no cabeçalho
`Authorization: Bearer <CRON_SECRET>`; o valor nunca deve ser colocado em
`vercel.json`, no código ou na URL.

O `vercel.json` registra dois jobs diários, compatíveis também com o plano
Hobby:

- `GET /api/tasks?action=dispatch` às 09:00 UTC;
- `GET /api/whatsapp-reminders?action=dispatch` às 10:00 UTC.

Na Vercel, o plano Hobby atualmente limita a frequência de cada Cron Job a uma
execução por dia e possui precisão menor que os planos Pro/Enterprise. Por isso,
o dispatcher de tarefas mantém uma janela de recuperação de 26 horas: uma
execução atrasada não perde a notificação e a chave idempotente evita envio
duplicado.

Para notificações de tarefas próximas do horário programado, use um scheduler
externo a cada 5 minutos (por exemplo, GitHub Actions agendado ou cron-job.org)
chamando:

```text
GET https://SEU_DOMINIO/api/tasks?action=dispatch
Authorization: Bearer <CRON_SECRET>
```

O mesmo `CRON_SECRET` configurado em Production deve ser cadastrado como
segredo do scheduler externo. Não o coloque em parâmetros de URL. O job diário
da Vercel continua como fallback de recuperação.

Referência da Vercel:
https://vercel.com/docs/cron-jobs/manage-cron-jobs

### Migrações antigas do Supabase

A antiga migration que disparava workers via `pg_net/net.http_post` foi movida
para `supabase/legacy/`. Ela é mantida somente como histórico e não deve ser
executada no Neon. Os agendamentos vigentes usam HTTP + `CRON_SECRET`.

