# Plano para modo online-only

A interface atual ainda usa um objeto de estado amplo no navegador durante a sessão. Remover essa dependência de uma só vez seria uma refatoração de alto risco.

Plano de fase 2:

1. criar APIs por entidade para crianças, responsáveis, financeiro, chamada, eventos, configurações e funcionários;
2. trocar o carregamento inicial de snapshot por consultas paginadas e sob demanda;
3. remover a gravação do estado completo em localStorage;
4. manter no navegador apenas preferências não pessoais, com namespace separado;
5. implementar cache somente em memória para a sessão ativa e invalidá-lo no logout;
6. adicionar testes E2E verificando que localStorage/sessionStorage/CacheStorage não contêm dados pessoais após navegação, expiração e logout.

Até essa migração, o estado transitório legado é limpo agressivamente no fim da sessão e nenhum backup local automático é criado.
