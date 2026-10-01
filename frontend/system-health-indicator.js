// Indicador compacto de proteção dos dados no canto superior direito.
(() => {
  if (window.__arteDeAprenderHealthIndicatorLoaded) return;
  window.__arteDeAprenderHealthIndicatorLoaded = true;

  let backupStatus = { checkedAt: 0, busy: false, last: null, denied: false, error: "" };

  async function refreshBackupFromServer(force = false) {
    if (backupStatus.busy) return;
    if (!force && Date.now() - backupStatus.checkedAt < 60_000) return;
    backupStatus.busy = true;
    try {
      const response = await fetch("/api/backups?limit=1", {
        method: "GET",
        cache: "no-store",
        credentials: "same-origin",
        headers: { Accept: "application/json" },
      });
      if (response.status === 403) {
        backupStatus = { checkedAt: Date.now(), busy: false, last: null, denied: true, error: "" };
        return;
      }
      const data = await response.json().catch(() => ({}));
      if (!response.ok || data.ok === false) throw new Error(data.detail || data.error || "Falha ao consultar backups.");
      backupStatus = {
        checkedAt: Date.now(),
        busy: false,
        last: Array.isArray(data.items) ? data.items[0] || null : null,
        denied: false,
        error: "",
      };
    } catch (error) {
      backupStatus = { checkedAt: Date.now(), busy: false, last: null, denied: false, error: error?.message || "Falha ao consultar backups." };
    }
  }

  function mount() {
    const topbar = document.querySelector(".topbar");
    const actions = topbar?.querySelector(".actions");
    if (!topbar || !actions) return false;
    if (document.querySelector("#systemHealthIndicator")) return true;

    const style = document.createElement("style");
    style.id = "systemHealthIndicatorStyle";
    style.textContent = `
      .system-health-indicator{margin-left:auto;display:flex;gap:8px;align-items:center;flex-wrap:wrap;justify-content:flex-end}
      .system-health-pill{display:inline-flex;align-items:center;gap:7px;min-height:34px;padding:7px 10px;border-radius:999px;border:1px solid rgba(88,65,96,.14);background:rgba(255,255,255,.76);color:#55445c;font-size:12px;font-weight:800;line-height:1;white-space:nowrap;box-shadow:0 5px 15px rgba(60,39,67,.07)}
      .system-health-dot{width:9px;height:9px;border-radius:50%;background:#9ca3af;box-shadow:0 0 0 3px rgba(156,163,175,.14)}
      .system-health-pill[data-tone="ok"] .system-health-dot{background:#2eaa82;box-shadow:0 0 0 3px rgba(46,170,130,.14)}
      .system-health-pill[data-tone="working"] .system-health-dot{background:#e3a51b;box-shadow:0 0 0 3px rgba(227,165,27,.16);animation:systemHealthPulse 1.15s ease-in-out infinite}
      .system-health-pill[data-tone="error"] .system-health-dot{background:#cf4c67;box-shadow:0 0 0 3px rgba(207,76,103,.14)}
      @keyframes systemHealthPulse{50%{transform:scale(1.35);opacity:.66}}
      @media(max-width:980px){.system-health-indicator{order:3;width:100%;justify-content:flex-start;margin-left:0}.system-health-pill{font-size:11px}}
    `;
    document.head.appendChild(style);

    const holder = document.createElement("div");
    holder.id = "systemHealthIndicator";
    holder.className = "system-health-indicator";
    holder.setAttribute("aria-label", "Status de proteção dos dados");
    holder.innerHTML = `
      <span class="system-health-pill" id="backupHealthPill" data-tone="working" role="status">
        <span class="system-health-dot" aria-hidden="true"></span>
        <span id="backupHealthText">Backup verificando</span>
      </span>
      <span class="system-health-pill" id="syncHealthPill" data-tone="working" role="status">
        <span class="system-health-dot" aria-hidden="true"></span>
        <span id="syncHealthText">Sincronizando</span>
      </span>
    `;
    actions.insertAdjacentElement("beforebegin", holder);
    return true;
  }

  function setPill(id, textId, tone, label, title) {
    const pill = document.querySelector(id);
    const text = document.querySelector(textId);
    if (!pill || !text) return;
    pill.dataset.tone = tone;
    text.textContent = label;
    pill.title = title || label;
  }

  function updateBackup() {
    refreshBackupFromServer().catch(() => {});
    if (backupStatus.busy && !backupStatus.checkedAt) {
      setPill("#backupHealthPill", "#backupHealthText", "working", "Backup verificando", "Consultando snapshots protegidos no servidor.");
      return;
    }
    if (backupStatus.denied) {
      setPill("#backupHealthPill", "#backupHealthText", "ok", "Backup protegido", "Os backups do servidor são administrados apenas por owner/admin.");
      return;
    }
    if (backupStatus.error) {
      setPill("#backupHealthPill", "#backupHealthText", "working", "Backup aguardando", backupStatus.error);
      return;
    }
    if (backupStatus.last?.createdAt) {
      const date = new Date(backupStatus.last.createdAt);
      const detail = Number.isNaN(date.getTime())
        ? "Snapshot de proteção disponível no servidor."
        : "Último snapshot protegido: " + date.toLocaleString("pt-BR");
      setPill("#backupHealthPill", "#backupHealthText", "ok", "Backup servidor OK", detail);
      return;
    }
    setPill("#backupHealthPill", "#backupHealthText", "ok", "Backup servidor ativo", "Snapshots são criados antes de sincronizações destrutivas e restaurações.");
  }

  function updateSync() {
    const api = window.__arteDeAprenderSync;
    if (!api?.status) {
      setPill("#syncHealthPill", "#syncHealthText", "working", "Conectando banco", "A sincronização está sendo inicializada.");
      return;
    }
    let status = {};
    try { status = api.status() || {}; } catch {}

    if (status.busy) {
      setPill("#syncHealthPill", "#syncHealthText", "working", "Sincronizando", "Alterações sendo enviadas ou atualizadas.");
      return;
    }
    if (status.pendingPush) {
      setPill("#syncHealthPill", "#syncHealthText", "working", "Aguardando envio", "Há alterações locais aguardando sincronização.");
      return;
    }
    if (status.ready) {
      let detail = "Banco Neon conectado e sincronização automática ativa.";
      if (status.lastSyncAt) {
        const date = new Date(status.lastSyncAt);
        if (!Number.isNaN(date.getTime())) detail = "Última sincronização: " + date.toLocaleString("pt-BR");
      }
      setPill("#syncHealthPill", "#syncHealthText", "ok", "Sincronização OK", detail);
      return;
    }
    setPill("#syncHealthPill", "#syncHealthText", "error", "Sincronização offline", "Não foi possível confirmar a sincronização com o banco.");
  }

  function refresh() {
    if (!mount()) return;
    updateBackup();
    updateSync();
  }

  refresh();
  const mountTimer = setInterval(() => {
    refresh();
    if (document.querySelector("#systemHealthIndicator")) clearInterval(mountTimer);
  }, 500);
  setInterval(refresh, 2000);
  window.addEventListener("focus", () => { refreshBackupFromServer(true).catch(() => {}); refresh(); });
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) refresh();
  });
})();
