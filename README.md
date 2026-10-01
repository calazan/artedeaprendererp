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
