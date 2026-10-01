# Plano para modo online-only

## Estado atual

A interface legado ainda trabalha com um objeto amplo de estado durante a sessão, mas esse snapshot não é mais persistido no disco do navegador: o bridge de autenticação virtualiza o namespace `arteDeAprenderERP.*` em memória antes de `app.min.js` iniciar.

A única preferência que pode permanecer em `localStorage` durante a sessão é `arteDeAprenderERP.navigationColors.v2`, que contém somente cores do menu. Logout, expiração/401 e a página de login limpam o namespace e caches.

## Fase 2

A virtualização é uma camada de transição. A arquitetura final deve:

1. criar APIs por entidade para crianças, responsáveis, financeiro, chamada, eventos, configurações e funcionários;
2. trocar o carregamento de snapshot completo por consultas paginadas e sob demanda;
3. manter no frontend somente caches em memória e dados necessários à tela atual;
4. separar preferências não pessoais em namespace próprio;
5. invalidar todo cache em memória no logout e na revogação de sessão;
6. adicionar testes E2E de navegador verificando localStorage, sessionStorage, IndexedDB e CacheStorage após navegação, expiração e logout.

Nenhuma fila offline com dados pessoais ou backup local deve ser reintroduzido.
