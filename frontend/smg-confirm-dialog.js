// Modal assíncrono para confirmações de ações administrativas.
(() => {
  if (window.smgConfirm) return;

  function ensureDialog() {
    let dialog = document.querySelector("#smgConfirmDialog");
    if (dialog) return dialog;
    dialog = document.createElement("dialog");
    dialog.id = "smgConfirmDialog";
    dialog.className = "smg-confirm-dialog";
    dialog.innerHTML = `
      <form method="dialog" class="smg-confirm-card">
        <div class="smg-confirm-icon" aria-hidden="true">!</div>
        <div class="smg-confirm-copy">
          <h2>Confirmar ação</h2>
          <p id="smgConfirmMessage"></p>
        </div>
        <div class="smg-confirm-actions">
          <button type="submit" value="cancel" class="secondary">Cancelar</button>
          <button type="submit" value="confirm" class="danger">Confirmar</button>
        </div>
      </form>`;
    document.body.appendChild(dialog);

    if (!document.querySelector("#smgConfirmDialogStyle")) {
      const style = document.createElement("style");
      style.id = "smgConfirmDialogStyle";
      style.textContent = `
        .smg-confirm-dialog{border:0;padding:0;background:transparent;max-width:min(92vw,460px);width:100%}
        .smg-confirm-dialog::backdrop{background:rgba(28,18,31,.48);backdrop-filter:blur(4px)}
        .smg-confirm-card{display:grid;grid-template-columns:44px 1fr;gap:14px;background:var(--card,#fff);color:var(--text,#302536);border-radius:20px;padding:22px;box-shadow:0 24px 70px rgba(30,18,33,.3);border:1px solid rgba(113,57,120,.15)}
        .smg-confirm-icon{width:44px;height:44px;border-radius:14px;display:grid;place-items:center;background:#fff0f2;color:#b4233b;font-weight:900;font-size:22px}
        .smg-confirm-copy h2{margin:1px 0 7px;font-size:18px}.smg-confirm-copy p{margin:0;color:var(--muted,#6f6571);line-height:1.45;white-space:pre-wrap}
        .smg-confirm-actions{grid-column:1/-1;display:flex;justify-content:flex-end;gap:10px;margin-top:8px}.smg-confirm-actions button{min-width:110px}
        @media(max-width:640px){.smg-confirm-card{grid-template-columns:36px 1fr;padding:18px;border-radius:18px}.smg-confirm-icon{width:36px;height:36px}.smg-confirm-actions{display:grid;grid-template-columns:1fr 1fr}.smg-confirm-actions button{width:100%;min-width:0}}
      `;
      document.head.appendChild(style);
    }
    return dialog;
  }

  window.smgConfirm = function smgConfirm(message) {
    const dialog = ensureDialog();
    const messageNode = dialog.querySelector("#smgConfirmMessage");
    if (messageNode) messageNode.textContent = String(message || "Deseja continuar?");
    return new Promise((resolve) => {
      const finish = () => resolve(dialog.returnValue === "confirm");
      dialog.addEventListener("close", finish, { once: true });
      dialog.returnValue = "cancel";
      dialog.showModal();
    });
  };
})();
