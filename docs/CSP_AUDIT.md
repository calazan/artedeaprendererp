# Auditoria CSP e sinks HTML

Política avaliada:

`default-src 'self'; img-src 'self' data:; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'`

## Teste em Report-Only

O middleware aceita `CSP_REPORT_ONLY=true` para emitir `Content-Security-Policy-Report-Only`. O teste automatizado valida esse modo antes do modo bloqueante.

A inspeção estática encontrou estes bloqueios incompatíveis com `script-src 'self'`:

- script inline de login em `smg/auth.py`;
- registro inline do Service Worker em `frontend/index.html`;
- script inline de atualização em `frontend/atualizar.html`;
- handlers `onclick="window.print()"` em relatórios, recibos e etiquetas escritos em pop-ups.

Todos foram removidos ou externalizados. O modo padrão agora envia CSP bloqueante.

## Auditoria de XSS

Foram revisados os usos de `innerHTML`, `document.write` e templates HTML nos módulos de pré-cadastro, tarefas, funcionários, WhatsApp, chamada e relatórios.

Correções aplicadas nesta etapa:

- dados do pré-cadastro continuam passando por `escapeHTML` antes de entrar em HTML;
- tarefas usam `esc`/`attr` para título, observações, responsável e checklist;
- funcionários usam `escapeHTML`/`escapeAttr` para campos vindos do banco;
- histórico e destinatários do WhatsApp usam `esc`/`attr`;
- identificadores interpolados em atributos de receitas/despesas/contas do bundle legado foram reforçados com `escapeAttr`;
- handlers inline dos documentos de impressão foram removidos;
- conteúdo de relatórios escritos com `document.write` permanece composto por helpers que escapam os campos textuais provenientes dos usuários.

`document.write` ainda existe exclusivamente para documentos de impressão em janelas `about:blank`; não é usado para renderizar respostas arbitrárias da API no documento principal.
