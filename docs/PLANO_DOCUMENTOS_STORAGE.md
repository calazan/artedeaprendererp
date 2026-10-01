# Limites de payload e plano de documentos

## Limite da Vercel Functions

Em 01/10/2026, a documentação oficial da Vercel informa limite máximo de **4,5 MB** para o corpo de requisição **e** de resposta de uma Function. Acima disso, a plataforma pode responder com `FUNCTION_PAYLOAD_TOO_LARGE` / HTTP 413 ou `FUNCTION_RESPONSE_PAYLOAD_TOO_LARGE`.

Referências oficiais:

- https://vercel.com/docs/functions/limitations#request-body-size
- https://vercel.com/docs/errors/function_payload_too_large
- https://vercel.com/docs/errors/function_response_payload_too_large

O ERP usa margem operacional de **4 MiB** para JSON de sincronização. Respostas de sync também são recusadas antes de ultrapassar essa margem. O upload legado de documentos em base64 fica limitado a **2,75 MB de arquivo binário**, pois base64 aumenta o tamanho em aproximadamente 33% e ainda há envelope JSON.

## Migração de documentos para object storage

O upload base64 pelo backend é mantido apenas como compatibilidade temporária. A fase seguinte deve usar Vercel Blob, S3 ou storage equivalente com upload direto do navegador:

1. owner/admin solicita ao backend um token ou URL assinada de curta duração;
2. navegador envia o binário diretamente ao storage, sem atravessar a Vercel Function;
3. backend registra no Neon apenas metadados, checksum, proprietário, tipo e chave/URL do objeto;
4. download exige autorização owner/admin e gera URL assinada curta;
5. exclusão remove metadado e objeto, com auditoria;
6. migration posterior move os documentos existentes de `smg_employee_documents.content` para o storage e só então remove o BLOB do PostgreSQL.

Não foi implementada integração com storage nesta etapa porque não há credenciais/configuração de object storage versionadas ou fornecidas para este projeto. Isso evita inventar segredos ou escolher um provedor sem configuração explícita.
