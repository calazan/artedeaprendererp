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

Variáveis mínimas (o `SESSION_SECRET` é obrigatório e não possui fallback):

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


## Política de dados locais

O ERP é operado como sistema online. Durante uma sessão autenticada, a versão atual ainda mantém um estado transitório no navegador por compatibilidade com o frontend legado; esse estado é apagado no logout, na expiração da sessão e ao abrir a tela de login. Esta etapa é temporária até a migração do frontend para APIs por entidade.

Não são permitidos backups locais automáticos, cópias de erro ou filas offline contendo dados pessoais. O Service Worker guarda somente assets estáticos versionados (JavaScript, CSS e imagens), nunca HTML autenticado nem respostas de API.

O navegador pode manter apenas preferências não pessoais enquanto a sessão estiver ativa, por exemplo cores de navegação e estado visual. Nenhuma preferência desse tipo deve conter nomes, CPF, contatos, dados de saúde, financeiro ou documentos. Ao encerrar a sessão, todas as chaves com prefixo `arteDeAprenderERP.` são removidas de `localStorage` e `sessionStorage`, e os caches do aplicativo são apagados.


## Matriz de permissões

| Ação | owner | admin | manager | teacher |
| --- | --- | --- | --- | --- |
| Gestão administrativa geral | Sim | Sim | Sim | Não |
| Chamada de professores | Sim | Sim | Sim | Sim |
| Sincronização normal | Sim | Sim | Sim | Não |
| Sincronização forçada / exclusões via sync | Sim | Sim | Não | Não |
| Excluir funcionários | Sim | Sim | Não | Não |
| Ler/baixar/enviar/excluir documentos de funcionários | Sim | Sim | Não | Não |
| Alterar configuração/destinatários do WhatsApp | Sim | Sim | Não | Não |

O papel efetivo é consultado no Neon em cada autorização, com cache em memória de no máximo 60 segundos. O papel gravado no cookie não é usado como fonte de autorização. Se o banco de autorização estiver indisponível, o acesso é negado.


## Proteção de dados sensíveis

O pré-cadastro protege em nível de aplicação com AES-256-GCM o CPF do responsável, detalhes de saúde/medicação/diagnóstico e documentos de pessoas autorizadas. A chave `DATA_ENCRYPTION_KEY` é obrigatória para criar ou consultar esses registros e não deve ser versionada.

Registros legados em texto simples devem ser migrados, depois de configurar a mesma chave no ambiente, com:

`PYTHONPATH=. python scripts/migrate_preregistration_encryption.py`

Pré-cadastros rejeitados são excluídos após `PREREG_REJECTED_RETENTION_DAYS` (30 dias por padrão), e buckets de rate limit expirados são limpos pela rotina de retenção.


## Rotas e autenticação legadas

As rotas de runtime com nome `supabase` e a autenticação por `REMOTE_SYNC_KEY` foram removidas. Frontend e backend usam somente as rotas Neon/PostgreSQL atuais e a sessão HttpOnly validada contra o vínculo ativo no banco.

O disparo de lembretes do WhatsApp usa exclusivamente `CRON_SECRET` no cabeçalho `Authorization: Bearer <segredo>`. Nenhum token de cron é lido de `smg_meta`.
