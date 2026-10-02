# Proposta — criptografia de campos sensíveis do pré-cadastro

## Objetivo

Proteger em nível de aplicação os dados mais sensíveis do pré-cadastro armazenados em `public.smg_preregistrations.data`, sem depender apenas da criptografia de disco/infraestrutura do PostgreSQL.

Esta proposta **não altera os dados existentes nesta fase**. A migração deve ser feita em uma etapa controlada porque envolve rotação de chave, compatibilidade com registros históricos, backups e rollback.

## Campos propostos

### Criptografados

- `guardianCpf`;
- `hasAllergy` e `allergyDetails`;
- `hasFoodRestriction` e `foodRestrictionDetails`;
- `usesMedication` e `medicationDetails`;
- `hasHealthCondition` e `healthConditionDetails`;
- `diagnosisStatus` e `diagnosisDetails`;
- `routineDetails` quando contiver informação clínica/comportamental;
- `healthPlan`;
- `preferredHospital`.

Os campos de saúde podem ser agrupados em um único objeto criptografado, reduzindo nonce/metadata e evitando exposição parcial.

## Formato sugerido

Usar AES-256-GCM com nonce aleatório por registro/campo e AAD contendo o id/protocolo do pré-cadastro.

Exemplo lógico:

```json
{
  "guardianCpfEncrypted": {
    "v": 1,
    "alg": "AES-256-GCM",
    "nonce": "...",
    "ciphertext": "..."
  },
  "guardianCpfHash": "...",
  "healthEncrypted": {
    "v": 1,
    "alg": "AES-256-GCM",
    "nonce": "...",
    "ciphertext": "..."
  }
}
```

A chave deve existir somente no backend por variável de ambiente, por exemplo:

`PREREGISTRATION_FIELD_KEY`

A chave não deve ser derivada de `DATABASE_URL`, `REMOTE_SYNC_KEY` ou `SESSION_SECRET`.

## Busca e duplicidade

Campos criptografados com nonce aleatório não são pesquisáveis diretamente. Para os campos que precisam de comparação exata, manter um índice derivado por HMAC-SHA-256.

Para CPF:

```text
guardianCpfHash = HMAC-SHA256(search_key, normalize_cpf(cpf))
```

A chave de busca deve ser derivada da chave principal por HKDF com contexto separado, ou armazenada separadamente.

O hash deve ser **HMAC**, não SHA-256 puro, porque CPF possui espaço de busca pequeno e um hash sem chave seria vulnerável a enumeração.

A duplicidade atual usa nome da criança + nascimento + telefone. Essa regra pode continuar funcionando sem alteração. Se CPF passar a participar da deduplicação, a comparação deve usar `guardianCpfHash` e um índice PostgreSQL próprio.

## Leitura e gravação

### Criação

1. normalizar e validar os dados em memória;
2. calcular os hashes pesquisáveis;
3. criptografar CPF e bloco de saúde;
4. descartar os valores sensíveis em texto puro antes de montar o `Jsonb`;
5. gravar apenas ciphertext + hashes.

### Leitura administrativa

1. buscar o registro;
2. descriptografar somente no backend;
3. devolver o formato atual para a interface autenticada;
4. nunca registrar plaintext em logs, auditoria ou mensagens de exceção.

## Migração de dados existentes

A migração deve:

1. adicionar suporte de leitura dupla: formato legado em claro e formato criptografado;
2. processar registros em lotes pequenos;
3. para cada registro legado, validar/normalizar, gerar HMAC e ciphertext;
4. atualizar o JSON na mesma transação;
5. marcar a versão de criptografia;
6. confirmar a contagem migrada;
7. somente depois remover o fallback de leitura em claro.

Antes da migração deve existir backup e uma chave de recuperação armazenada fora do banco.

## Rotação de chave

O envelope precisa carregar `v` ou `keyVersion`.

Durante uma rotação:

- o backend aceita a chave atual e a anterior para leitura;
- novas gravações usam apenas a chave atual;
- um job controlado recriptografa os registros antigos;
- a chave anterior só é retirada depois de a migração chegar a 100%.

## Impacto operacional

- **Segurança:** vazamento de dump/backup do PostgreSQL deixa CPF e dados de saúde ilegíveis sem a chave.
- **Busca:** busca textual dentro dos detalhes de saúde deixa de ser possível sem criar índices derivados específicos.
- **Backups:** snapshots passam a conter ciphertext; a chave precisa ser preservada separadamente para restauração útil.
- **Desempenho:** custo criptográfico é pequeno para o volume esperado, mas há processamento extra em criação/listagem.
- **Observabilidade:** logs e auditoria devem continuar excluindo dados descriptografados.
- **Desastre:** perda da chave torna os campos criptografados irrecuperáveis; por isso a chave precisa de política de backup/rotação.
- **Frontend:** nenhuma mudança estrutural é necessária se o backend descriptografar antes de responder.
- **Migração:** requer operação controlada e reversível; não deve ser executada implicitamente no startup da aplicação.

## Recomendação para uma fase futura

Implementar isso em uma fase própria, com:
- módulo `smg/field_crypto.py`;
- AES-256-GCM e HKDF via biblioteca `cryptography`;
- `guardianCpfHash` indexável;
- leitura dupla durante migração;
- comando explícito de migração;
- testes de rotação, perda de chave, tamper detection e compatibilidade com backups.
