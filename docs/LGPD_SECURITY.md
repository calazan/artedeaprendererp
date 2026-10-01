# Privacidade e LGPD — implementação técnica

## Criptografia do pré-cadastro

Os campos sensíveis definidos na auditoria são cifrados no backend antes da persistência no Neon com AES-256-GCM. Cada valor usa nonce aleatório de 96 bits e AAD versionado (`arte-de-aprender-prereg-v1`).

A variável `DATA_ENCRYPTION_KEY` deve conter exatamente 32 bytes codificados em base64-url. A chave não é armazenada no banco nem no repositório.

A migração de registros existentes é feita por `scripts/migrate_preregistration_encryption.py`. A rotina usa transação e só atualiza registros que ainda possuam campos sensíveis em texto simples.

## Retenção

Pré-cadastros com status `rejected` são apagados após o prazo configurado em `PREREG_REJECTED_RETENTION_DAYS`. Buckets de rate limit expirados há mais de um dia também são removidos.

## Documentos de funcionários

O upload legado aceita somente conteúdo cuja assinatura real (magic bytes) seja PDF, JPEG, PNG ou WEBP. O MIME declarado pelo navegador não é aceito como prova. Downloads são enviados como `attachment`, com `nosniff` e `Content-Security-Policy: sandbox`.

Upload, listagem/download e exclusão são registrados na auditoria.
