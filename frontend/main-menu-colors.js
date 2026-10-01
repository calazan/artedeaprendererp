// Paleta permanente do menu principal: nenhum item fica branco, inclusive em estado inativo.
(() => {
  if (document.querySelector("#saberMainMenuColors")) return;

  const style = document.createElement("style");
  style.id = "saberMainMenuColors";
  style.textContent = `
    .tabs.menu-final-v414 .tab,
    .tabs.menu-final-v414 .teacher-tab-link {
      color: #ffffff !important;
      border: 1px solid rgba(255,255,255,.34) !important;
      box-shadow: 0 8px 20px rgba(49,31,54,.12), inset 0 1px 0 rgba(255,255,255,.28) !important;
      text-shadow: 0 1px 1px rgba(0,0,0,.08);
      transition: transform .16s ease, filter .16s ease, box-shadow .16s ease !important;
    }

    .tabs.menu-final-v414 .tab:hover,
    .tabs.menu-final-v414 .teacher-tab-link:hover {
      transform: translateY(-1px);
      filter: brightness(1.07) saturate(1.06);
      box-shadow: 0 11px 24px rgba(49,31,54,.17), inset 0 1px 0 rgba(255,255,255,.34) !important;
    }

    .tabs.menu-final-v414 .tab.is-active {
      transform: translateX(3px);
      filter: saturate(1.08) brightness(.96);
      box-shadow: 0 12px 27px rgba(49,31,54,.22), inset 0 1px 0 rgba(255,255,255,.32) !important;
    }

    .tabs.menu-final-v414 .tab[data-view="dashboard"] { background: linear-gradient(135deg, #a86bb1, #7f4389) !important; }
    .tabs.menu-final-v414 .tab[data-view="dashboard"].is-active { background: linear-gradient(135deg, #8f5199, #66336f) !important; }

    .tabs.menu-final-v414 .tab[data-view="finance"] {
      background: linear-gradient(135deg, #f5bd35, #dd921c) !important;
      color: #563405 !important;
      text-shadow: none;
    }
    .tabs.menu-final-v414 .tab[data-view="finance"].is-active {
      background: linear-gradient(135deg, #e7a821, #c67b12) !important;
      color: #ffffff !important;
    }

    .tabs.menu-final-v414 .tab[data-view="employees"] { background: linear-gradient(135deg, #6f7fca, #555aa8) !important; }
    .tabs.menu-final-v414 .tab[data-view="employees"].is-active { background: linear-gradient(135deg, #5b68b7, #41488f) !important; }

    .tabs.menu-final-v414 .tab[data-view="students"] { background: linear-gradient(135deg, #f06b65, #d8413b) !important; }
    .tabs.menu-final-v414 .tab[data-view="students"].is-active { background: linear-gradient(135deg, #e4514a, #bd302a) !important; }

    .tabs.menu-final-v414 .tab[data-view="attendance"] { background: linear-gradient(135deg, #55a7cd, #2f7fa9) !important; }
    .tabs.menu-final-v414 .tab[data-view="attendance"].is-active { background: linear-gradient(135deg, #3f94bd, #246b91) !important; }

    .tabs.menu-final-v414 .tab[data-view="extraEvents"] { background: linear-gradient(135deg, #f49a4b, #df6f2c) !important; }
    .tabs.menu-final-v414 .tab[data-view="extraEvents"].is-active { background: linear-gradient(135deg, #e78337, #c75a20) !important; }

    .tabs.menu-final-v414 .tab[data-view="agenda"] { background: linear-gradient(135deg, #55b7a7, #338f82) !important; }
    .tabs.menu-final-v414 .tab[data-view="agenda"].is-active { background: linear-gradient(135deg, #3ca291, #277669) !important; }

    .tabs.menu-final-v414 .tab[data-view="reports"] { background: linear-gradient(135deg, #e97947, #c9512d) !important; }
    .tabs.menu-final-v414 .tab[data-view="reports"].is-active { background: linear-gradient(135deg, #d96537, #aa4024) !important; }

    .tabs.menu-final-v414 .tab[data-view="proposals"] { background: linear-gradient(135deg, #8b78c6, #6853a9) !important; }
    .tabs.menu-final-v414 .tab[data-view="proposals"].is-active { background: linear-gradient(135deg, #7762b4, #554193) !important; }

    .tabs.menu-final-v414 .tab[data-view="preRegistrations"] {
      background: linear-gradient(135deg, #e96aa7, #c94f8b) !important;
      color: #ffffff !important;
    }
    .tabs.menu-final-v414 .tab[data-view="preRegistrations"].is-active { background: linear-gradient(135deg, #d85b98, #ad3e77) !important; }

    .tabs.menu-final-v414 .tab[data-view="settings"] { background: linear-gradient(135deg, #76507e, #55345d) !important; }
    .tabs.menu-final-v414 .tab[data-view="settings"].is-active { background: linear-gradient(135deg, #633d6b, #432649) !important; }

    .tabs.menu-final-v414 .teacher-tab-link {
      background: linear-gradient(135deg, #527c67, #37604d) !important;
      color: #ffffff !important;
      text-decoration: none !important;
    }

    .tabs.menu-final-v414 .tab:not([data-view]),
    .tabs.menu-final-v414 .tab[data-view]:not([data-view="dashboard"]):not([data-view="finance"]):not([data-view="employees"]):not([data-view="students"]):not([data-view="attendance"]):not([data-view="extraEvents"]):not([data-view="agenda"]):not([data-view="reports"]):not([data-view="proposals"]):not([data-view="preRegistrations"]):not([data-view="settings"]) {
      background: linear-gradient(135deg, #92709a, #6c4c75) !important;
      color: #ffffff !important;
    }
  `;

  document.head.appendChild(style);
})();

// Fallback para páginas que carreguem este arquivo isoladamente. No app principal,
// a fila central de módulos carrega payment-deletion-persistence-fix.js no ponto correto.
(() => {
  if (window.__saberOrderedModulesManaged) return;
  if (document.querySelector('script[data-payment-deletion-persistence-fix]')) return;
  const script = document.createElement("script");
  script.src = "payment-deletion-persistence-fix.js?v=2";
  script.async = false;
  script.dataset.paymentDeletionPersistenceFix = "true";
  document.body.appendChild(script);
})();
