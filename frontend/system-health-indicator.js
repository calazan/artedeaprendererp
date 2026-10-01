// Indicador compacto de proteção dos dados no canto superior direito.
(() => {
  if (window.__arteDeAprenderHealthIndicatorLoaded) return;
  window.__arteDeAprenderHealthIndicatorLoaded = true;

  const STORAGE_KEY = "arteDeAprenderERP.v4";
  const AUTO_BACKUP_PREFIX = "arteDeAprenderERP.autoBackup.";
  const AUTO_BACKUP_LAST_KEY = "arteDeAprenderERP.autoBackup.last";

  function localDateISO(date = new Date()) {
    const adjusted = new Date(date.getTime() - date.getTimezoneOffset() * 60000);
    return adjusted.toISOString().slice(0, 10);
  }

  function latestBackup() {
    const lastKey = localStorage.getItem(AUTO_BACKUP_LAST_KEY) || "";
    const raw = lastKey ? localStorage.getItem(lastKey) : "";
    let timestamp = "";
    if (raw) {
      try {
        const parsed = JSON.parse(raw);
        timestamp = String(parsed?.exportedAt || "");
      } catch {}
    }
    return { lastKey, raw, timestamp };
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
    const stateSaved = Boolean(localStorage.getItem(STORAGE_KEY));
    const now = new Date();
    const todayKey = AUTO_BACKUP_PREFIX + localDateISO(now);
    const todayBackup = localStorage.getItem(todayKey);
    const last = latestBackup();

    if (!stateSaved) {
      setPill("#backupHealthPill", "#backupHealthText", "working", "Backup aguardando", "Os dados locais ainda estão sendo inicializados.");
      return;
    }

    if (now.getHours() >= 18 && !todayBackup) {
      setPill("#backupHealthPill", "#backupHealthText", "working", "Backup em preparo", "O backup diário será criado automaticamente nesta sessão.");
      return;
    }

    let detail = "Dados locais protegidos automaticamente.";
    if (last.timestamp) {
      const date = new Date(last.timestamp);
      if (!Number.isNaN(date.getTime())) detail = "Último backup diário: " + date.toLocaleString("pt-BR");
    } else if (last.lastKey) {
      detail = "Último backup diário: " + last.lastKey.replace(AUTO_BACKUP_PREFIX, "").split("-").reverse().join("/");
    }
    setPill("#backupHealthPill", "#backupHealthText", "ok", todayBackup ? "Backup diário OK" : "Backup ativo", detail);
  }

  function updateSync() {
    const api = window.__arteDeAprenderSync || window.__saberMaisSupabase;
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
  window.addEventListener("focus", refresh);
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) refresh();
  });
})();
