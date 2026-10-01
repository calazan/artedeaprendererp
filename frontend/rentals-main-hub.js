// Central de Locações e Repasses no menu principal, com cadastros em Configurações.
(() => {
  if (window.__saberRentalsMainHubLoaded) return;
  window.__saberRentalsMainHubLoaded = true;

  const REPASS_CATEGORY = "Repasses e parcerias";
  let activeRentalTab = "psych";
  let renderQueued = false;
  let wrappedRenderAll = false;

  const money = (value) => Number(Number(value || 0).toFixed(2));
  const same = (a, b) => String(a ?? "").trim() === String(b ?? "").trim();
  const normalize = (value) => String(value || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").trim().toLowerCase();
  const esc = (value) => {
    try { return escapeHTML(value); } catch {
      return String(value ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#039;");
    }
  };
  const attr = (value) => esc(value).replaceAll("`", "&#096;");
  const brlLocal = (value) => {
    try { return brl(value); } catch { return Number(value || 0).toLocaleString("pt-BR", { style: "currency", currency: "BRL" }); }
  };
  const today = () => {
    try { return todayISO(); } catch { return new Date().toISOString().slice(0, 10); }
  };
  const currentPeriod = () => {
    try { return selectedPeriodKey(); } catch {
      const d = new Date();
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
    }
  };
  const periodName = (value = currentPeriod()) => {
    try { return periodLabel(value); } catch {
      const [year, month] = String(value).split("-");
      return `${month}/${year}`;
    }
  };
  const makeId = () => {
    try { return uid(); } catch { return globalThis.crypto?.randomUUID?.() || `rental-${Date.now()}-${Math.random().toString(16).slice(2)}`; }
  };

  function loadScript(src, marker) {
    return new Promise((resolve, reject) => {
      const existing = document.querySelector(`script[${marker}]`);
      if (existing) {
        if (existing.dataset.loaded === "1") return resolve();
        existing.addEventListener("load", resolve, { once: true });
        existing.addEventListener("error", reject, { once: true });
        return;
      }
      const script = document.createElement("script");
      script.src = src;
      script.async = false;
      script.setAttribute(marker, "1");
      script.addEventListener("load", () => { script.dataset.loaded = "1"; resolve(); }, { once: true });
      script.addEventListener("error", reject, { once: true });
      document.body.appendChild(script);
    });
  }

  async function ensureLegacyRentalModule() {
    if (window.renderRentalsFinance && document.querySelector("#financeRentalsPane")) return;
    await loadScript("rentals-repasses-finance.js?v=2", "data-rentals-base");
  }

  function ensureStyles() {
    if (document.querySelector("#rentalsMainHubStyles")) return;
    const style = document.createElement("style");
    style.id = "rentalsMainHubStyles";
    style.textContent = `
      .tab[data-view="rentals"]{background:linear-gradient(135deg,#3f9c8d,#26786c)!important;color:#fff!important;border-color:rgba(255,255,255,.22)!important}
      .tab[data-view="rentals"].is-active{background:linear-gradient(135deg,#318b7d,#1f655c)!important}
      #rentalsView{gap:18px}
      #rentalsView.is-active{display:block}
      .rentals-hub-shell{display:grid;gap:16px}
      .rental-main-tabs{display:flex;gap:8px;flex-wrap:wrap;padding:10px;border:1px solid rgba(63,156,141,.18);border-radius:16px;background:rgba(255,255,255,.55);margin:0 0 16px}
      .rental-main-tab{border:1px solid rgba(63,156,141,.22)!important;background:rgba(63,156,141,.10)!important;color:#216e62!important;box-shadow:none!important;min-height:38px;padding:8px 13px;border-radius:12px;font-weight:800}
      .rental-main-tab.is-active{background:linear-gradient(135deg,#3f9c8d,#26786c)!important;color:#fff!important}
      .rental-main-tab small{font-size:10px;opacity:.78;margin-left:4px}
      .rental-main-pane{display:none}.rental-main-pane.is-active{display:block}
      #financeRentalsPane{display:grid!important}
      #financeRentalsPane>.rental-section-grid{display:none!important}
      .rental-settings-grid{display:grid;gap:16px}
      .rental-settings-slot{padding:14px;border-radius:14px;border:1px solid rgba(113,57,120,.12);background:rgba(255,255,255,.45)}
      .rental-settings-slot h4{margin:0 0 5px}.rental-settings-slot>p{margin:0 0 10px;color:var(--muted,#64748b);font-size:12px}
      .partner-config-form{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:12px;align-items:end}
      .partner-config-form label{display:grid;gap:6px;font-size:12px;font-weight:700}.partner-config-form .span-2{grid-column:span 2}.partner-config-form .span-4{grid-column:span 4}
      .partner-config-list{display:grid;gap:9px;margin-top:14px}.partner-config-row{display:grid;grid-template-columns:minmax(160px,1.4fr) minmax(100px,.8fr) minmax(110px,.8fr) 1fr auto;gap:10px;align-items:center;padding:11px 12px;border:1px solid rgba(148,163,184,.2);border-radius:13px;background:rgba(255,255,255,.62)}
      .partner-config-row.is-archived{opacity:.6}.partner-config-row small{display:block;color:var(--muted,#64748b)}
      .partner-kind{display:inline-flex;width:max-content;padding:4px 8px;border-radius:999px;font-size:10px;font-weight:850;background:rgba(63,156,141,.11);color:#216e62}
      .partner-actions{display:flex;gap:6px;flex-wrap:wrap;justify-content:flex-end}
      .generic-partner-card{padding:18px}.generic-partner-head{display:flex;justify-content:space-between;gap:14px;align-items:flex-start;margin-bottom:14px}.generic-partner-head h2{margin:0}.generic-partner-head p{margin:5px 0 0;color:var(--muted,#64748b)}
      .partner-summary{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:10px;margin:12px 0 16px}.partner-stat{padding:12px;border:1px solid rgba(148,163,184,.2);border-radius:13px;background:rgba(255,255,255,.55)}.partner-stat span{display:block;font-size:11px;color:var(--muted,#64748b)}.partner-stat strong{display:block;margin-top:4px;font-size:18px}.partner-stat.good{background:rgba(220,252,231,.55)}.partner-stat.warn{background:rgba(254,243,199,.58)}
      .partner-entry-form{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:11px;align-items:end;margin:14px 0}.partner-entry-form label{display:grid;gap:6px;font-size:12px;font-weight:700}.partner-entry-form .span-2{grid-column:span 2}.partner-entry-form .span-3{grid-column:span 3}
      .partner-calculated{padding:11px 13px;border-radius:12px;border:1px solid rgba(63,156,141,.18);background:rgba(63,156,141,.08)}.partner-calculated span{display:block;font-size:11px;color:var(--muted,#64748b)}.partner-calculated strong{display:block;margin-top:4px;font-size:18px;color:#216e62}
      .partner-status{display:inline-flex;padding:4px 8px;border-radius:999px;font-size:10px;font-weight:850}.partner-status.paid{background:#dcfce7;color:#166534}.partner-status.open{background:#fef3c7;color:#92400e}
      .partner-pending-list{display:grid;gap:7px;margin:12px 0}.partner-pending-item{display:flex;justify-content:space-between;gap:10px;padding:10px 12px;border-radius:12px;background:rgba(254,226,226,.55);border:1px solid rgba(220,38,38,.15)}
      .finance-subtab[data-finance-pane="rentals"][data-rental-stub="1"],#financeRentalsStub{display:none!important}
      @media(max-width:980px){.partner-config-form,.partner-entry-form{grid-template-columns:repeat(2,minmax(0,1fr))}.partner-config-row{grid-template-columns:1fr 1fr}.partner-config-row .partner-actions{grid-column:span 2}.partner-summary{grid-template-columns:repeat(2,1fr)}}
      @media(max-width:650px){.partner-config-form,.partner-entry-form,.partner-summary,.partner-config-row{grid-template-columns:1fr}.partner-config-form .span-2,.partner-config-form .span-4,.partner-entry-form .span-2,.partner-entry-form .span-3,.partner-config-row .partner-actions{grid-column:auto}.generic-partner-head{display:grid}.partner-actions{justify-content:flex-start}}
    `;
    document.head.appendChild(style);
  }

  function rental() {
    state.rentalManagement ||= {};
    const data = state.rentalManagement;
    data.partnerConfigs = Array.isArray(data.partnerConfigs) ? data.partnerConfigs : [];
    data.manualRepasses = Array.isArray(data.manualRepasses) ? data.manualRepasses : [];
    data.genericRentalReceipts = Array.isArray(data.genericRentalReceipts) ? data.genericRentalReceipts : [];
    data.repasses = Array.isArray(data.repasses) ? data.repasses : [];
    data.clinicReceipts = Array.isArray(data.clinicReceipts) ? data.clinicReceipts : [];
    data.equipment = Array.isArray(data.equipment) ? data.equipment : [];
    return data;
  }

  function ensureExpenseCategory() {
    state.expenseCategories ||= [];
    if (state.expenseCategories.some((item) => normalize(item?.name) === normalize(REPASS_CATEGORY))) return;
    try { state.expenseCategories.push(normalizeExpenseCategory({ name: REPASS_CATEGORY })); }
    catch { state.expenseCategories.push({ id: makeId(), name: REPASS_CATEGORY, createdAt: today() }); }
  }

  function seedPartnerConfigsFromLegacy() {
    const data = rental();
    let changed = false;
    const psychName = normalize(data.psychopedagogy?.professionalName || "Psicopedagogia");

    data.manualRepasses.forEach((record) => {
      if (!record?.beneficiary) return;
      const beneficiary = String(record.beneficiary).trim();
      const key = normalize(beneficiary);
      if (!key || key.includes("psicopedagog") || key === psychName) return;

      let config = data.partnerConfigs.find((item) => item.kind === "repass" && normalize(item.name) === key);
      if (!config) {
        config = {
          id: `partner-${record.id || makeId()}`,
          name: beneficiary,
          kind: "repass",
          percent: Number(record.percent || 0),
          monthlyAmount: 0,
          dueDay: record.dueDate ? Number(String(record.dueDate).slice(8, 10)) || 10 : 10,
          startDate: record.period ? `${record.period}-01` : "",
          spaceName: "",
          defaultBankAccountId: record.bankAccountId || "",
          notes: "Importado automaticamente dos repasses já existentes.",
          active: true,
          createdAt: record.createdAt || new Date().toISOString(),
        };
        data.partnerConfigs.push(config);
        changed = true;
      }
      if (!record.partnerConfigId) {
        record.partnerConfigId = config.id;
        changed = true;
      }
    });
    return changed;
  }

  function activeConfigs() {
    return rental().partnerConfigs
      .filter((item) => item && item.active !== false && item.name)
      .slice()
      .sort((a, b) => {
        if (a.kind !== b.kind) return a.kind === "repass" ? -1 : 1;
        return String(a.name).localeCompare(String(b.name), "pt-BR", { sensitivity: "base" });
      });
  }

  function accountOptions(selected = "") {
    try { return bankAccountOptions(selected); } catch {
      return `<option value="">Escolher conta</option>${(state.bankAccounts || []).map((account) => `<option value="${attr(account.id)}" ${same(account.id, selected) ? "selected" : ""}>${esc(account.name || "Conta")}</option>`).join("")}`;
    }
  }

  function accountById(id) {
    try { return getBankAccount(id); } catch { return (state.bankAccounts || []).find((item) => same(item.id, id)) || null; }
  }

  function accountName(id) {
    try { return bankAccountLabel(id); } catch { return accountById(id)?.name || "-"; }
  }

  function mountMainView() {
    let tab = document.querySelector('.tab[data-view="rentals"]');
    if (!tab) {
      tab = document.createElement("button");
      tab.type = "button";
      tab.className = "tab";
      tab.dataset.view = "rentals";
      tab.textContent = "Locações e repasses";
      const financeTab = document.querySelector('.tab[data-view="finance"]');
      financeTab?.insertAdjacentElement("afterend", tab);
      tab.addEventListener("click", () => {
        switchView("rentals");
        queueRender();
      });
    }

    let view = document.querySelector("#rentalsView");
    if (!view) {
      view = document.createElement("section");
      view.className = "view";
      view.id = "rentalsView";
      view.innerHTML = `<div class="rentals-hub-shell" id="rentalsHubShell"></div>`;
      const financeView = document.querySelector("#financeView");
      financeView?.insertAdjacentElement("afterend", view);
    }

    try {
      views.rentals = view;
      titles.rentals = "Locações e repasses";
    } catch (error) {
      console.warn("Não foi possível registrar a nova área de locações no roteador do app.", error);
    }
  }

  function moveLegacyPaneToMain() {
    const financeView = document.querySelector("#financeView");
    const financeTabs = financeView?.querySelector(".finance-subtabs");
    const realPane = document.querySelector("#financeRentalsPane");
    const shell = document.querySelector("#rentalsHubShell");
    if (!financeView || !financeTabs || !realPane || !shell) return false;

    let rentalTab = financeTabs.querySelector('[data-finance-pane="rentals"]');
    if (!rentalTab) {
      rentalTab = document.createElement("button");
      rentalTab.type = "button";
      rentalTab.className = "finance-subtab";
      rentalTab.dataset.financePane = "rentals";
      financeTabs.appendChild(rentalTab);
    }
    rentalTab.dataset.rentalStub = "1";
    rentalTab.hidden = true;
    rentalTab.classList.remove("is-active");

    if (!financeView.querySelector("#financeRentalsStub")) {
      const stub = document.createElement("div");
      stub.id = "financeRentalsStub";
      stub.className = "finance-pane";
      stub.dataset.financePaneContent = "rentals";
      financeView.appendChild(stub);
    }

    if (realPane.parentElement !== shell) shell.appendChild(realPane);
    realPane.classList.remove("finance-pane");
    realPane.removeAttribute("data-finance-pane-content");
    realPane.classList.add("is-active");

    if (!realPane.querySelector("#rentalMainTabs")) {
      const tabs = document.createElement("div");
      tabs.id = "rentalMainTabs";
      tabs.className = "rental-main-tabs";
      const hero = realPane.querySelector(".rental-hero");
      hero?.insertAdjacentElement("afterend", tabs);
      tabs.addEventListener("click", (event) => {
        const button = event.target.closest("[data-rental-main-tab]");
        if (!button) return;
        activeRentalTab = button.dataset.rentalMainTab || "psych";
        renderMainTabs();
      });
    }

    let panes = realPane.querySelector("#rentalMainPanes");
    if (!panes) {
      panes = document.createElement("div");
      panes.id = "rentalMainPanes";
      realPane.appendChild(panes);
    }

    let psychPane = panes.querySelector('[data-rental-main-pane="psych"]');
    if (!psychPane) {
      psychPane = document.createElement("div");
      psychPane.className = "rental-main-pane";
      psychPane.dataset.rentalMainPane = "psych";
      panes.appendChild(psychPane);
    }
    const psychCard = realPane.querySelector(".rental-psych-card");
    if (psychCard && psychCard.parentElement !== psychPane) psychPane.appendChild(psychCard);

    let clinicPane = panes.querySelector('[data-rental-main-pane="clinic"]');
    if (!clinicPane) {
      clinicPane = document.createElement("div");
      clinicPane.className = "rental-main-pane";
      clinicPane.dataset.rentalMainPane = "clinic";
      panes.appendChild(clinicPane);
    }
    const clinicCard = realPane.querySelector(".rental-clinic-card");
    if (clinicCard && clinicCard.parentElement !== clinicPane) clinicPane.appendChild(clinicCard);

    const oldGrid = realPane.querySelector(":scope > .rental-section-grid");
    if (oldGrid && !oldGrid.children.length) oldGrid.remove();
    return true;
  }

  function installSettingsRouting() {
    if (window.__saberRentalsSettingsRoutingInstalled) return;
    window.__saberRentalsSettingsRoutingInstalled = true;
    const original = switchSettingsPane;
    switchSettingsPane = function switchSettingsPaneWithRentals(paneName = "school") {
      if (paneName !== "rentals") return original(paneName);
      document.querySelectorAll(".settings-subtab").forEach((button) => button.classList.toggle("is-active", button.dataset.settingsPane === "rentals"));
      document.querySelectorAll("[data-settings-pane-content]").forEach((pane) => pane.classList.toggle("is-active", pane.dataset.settingsPaneContent === "rentals"));
      renderSettingsArea();
    };
  }

  function mountSettingsArea() {
    const subtabs = document.querySelector(".settings-subtabs");
    const settingsGrid = subtabs?.parentElement;
    if (!subtabs || !settingsGrid) return;

    let button = subtabs.querySelector('[data-settings-pane="rentals"]');
    if (!button) {
      button = document.createElement("button");
      button.type = "button";
      button.className = "settings-subtab";
      button.dataset.settingsPane = "rentals";
      button.textContent = "Locações e repasses";
      const categories = subtabs.querySelector('[data-settings-pane="categories"]');
      categories?.insertAdjacentElement("afterend", button);
      button.addEventListener("click", () => switchSettingsPane("rentals"));
    }

    let pane = settingsGrid.querySelector('[data-settings-pane-content="rentals"]');
    if (!pane) {
      pane = document.createElement("div");
      pane.className = "settings-pane";
      pane.dataset.settingsPaneContent = "rentals";
      pane.innerHTML = `
        <div class="rental-settings-grid">
          <div class="settings-card">
            <h3>Cadastro de repasses e sublocações</h3>
            <p>Cadastre cada parceria uma única vez. Cada cadastro ativo vira automaticamente uma subaba em <strong>Locações e repasses</strong> no menu principal.</p>
            <form id="partnerConfigForm" class="partner-config-form">
              <input id="partnerConfigId" type="hidden" />
              <label>Nome da subaba / parceiro<input id="partnerConfigName" required placeholder="Ex.: Ballet, Fonoaudióloga, Sala 2..." /></label>
              <label>Tipo<select id="partnerConfigKind"><option value="repass">Repasse</option><option value="sublocation">Sublocação</option></select></label>
              <label data-config-repass-field>Percentual padrão (%)<input id="partnerConfigPercent" type="number" min="0" max="100" step="0.01" value="50" /></label>
              <label data-config-rental-field class="is-hidden">Valor mensal da locação<input id="partnerConfigMonthlyAmount" type="number" min="0" step="0.01" value="0" /></label>
              <label>Conta bancária padrão<select id="partnerConfigAccount"></select></label>
              <label data-config-rental-field class="is-hidden">Dia do vencimento<input id="partnerConfigDueDay" type="number" min="1" max="31" value="10" /></label>
              <label>Data de início<input id="partnerConfigStartDate" type="date" /></label>
              <label data-config-rental-field class="is-hidden">Sala / espaço<input id="partnerConfigSpace" placeholder="Ex.: Sala 3" /></label>
              <label class="span-4">Observações<input id="partnerConfigNotes" placeholder="Contrato, regra do repasse, reajustes, condições..." /></label>
              <div class="form-actions span-4"><button type="submit">Salvar cadastro</button><button type="button" class="secondary" id="clearPartnerConfig">Limpar</button></div>
            </form>
            <div class="partner-config-list" id="partnerConfigList"></div>
          </div>
          <div class="settings-card" id="psychSettingsCard">
            <h3>Psicopedagogia</h3>
            <p>Configuração fixa da Psicopedagogia. O acompanhamento e os lançamentos continuam na subaba Psicopedagogia da área principal.</p>
            <div class="rental-settings-slot" id="psychConfigSettingsSlot"></div>
          </div>
          <div class="settings-card" id="clinicSettingsCard">
            <h3>Clínica</h3>
            <p>Configuração fixa da sublocação da Clínica. Recebimentos, pendências e materiais continuam na subaba Clínica.</p>
            <div class="rental-settings-slot" id="clinicConfigSettingsSlot"></div>
          </div>
        </div>`;
      const firstPane = settingsGrid.querySelector("[data-settings-pane-content]");
      firstPane?.parentElement?.appendChild(pane);

      pane.querySelector("#partnerConfigKind")?.addEventListener("change", updateConfigFieldVisibility);
      pane.querySelector("#partnerConfigForm")?.addEventListener("submit", savePartnerConfigFromForm);
      pane.querySelector("#clearPartnerConfig")?.addEventListener("click", clearPartnerConfigForm);
      pane.addEventListener("click", handleSettingsClick);
    }
    moveLegacyConfigForms();
  }

  function moveLegacyConfigForms() {
    const psychForm = document.querySelector("#psychRentalConfigForm");
    const psychSlot = document.querySelector("#psychConfigSettingsSlot");
    if (psychForm && psychSlot && psychForm.parentElement !== psychSlot) psychSlot.appendChild(psychForm);

    const clinicForm = document.querySelector("#clinicRentalConfigForm");
    const clinicSlot = document.querySelector("#clinicConfigSettingsSlot");
    if (clinicForm && clinicSlot && clinicForm.parentElement !== clinicSlot) clinicSlot.appendChild(clinicForm);
  }

  function updateConfigFieldVisibility() {
    const kind = document.querySelector("#partnerConfigKind")?.value || "repass";
    document.querySelectorAll("[data-config-repass-field]").forEach((field) => field.classList.toggle("is-hidden", kind !== "repass"));
    document.querySelectorAll("[data-config-rental-field]").forEach((field) => field.classList.toggle("is-hidden", kind !== "sublocation"));
  }

  function clearPartnerConfigForm() {
    const form = document.querySelector("#partnerConfigForm");
    if (!form) return;
    form.reset();
    document.querySelector("#partnerConfigId").value = "";
    document.querySelector("#partnerConfigKind").value = "repass";
    document.querySelector("#partnerConfigPercent").value = "50";
    document.querySelector("#partnerConfigDueDay").value = "10";
    document.querySelector("#partnerConfigStartDate").value = today();
    document.querySelector("#partnerConfigAccount").innerHTML = accountOptions("");
    updateConfigFieldVisibility();
  }

  function savePartnerConfigFromForm(event) {
    event.preventDefault();
    const data = rental();
    const id = document.querySelector("#partnerConfigId")?.value || makeId();
    const existing = data.partnerConfigs.find((item) => same(item.id, id));
    const kind = document.querySelector("#partnerConfigKind")?.value === "sublocation" ? "sublocation" : "repass";
    const name = document.querySelector("#partnerConfigName")?.value.trim() || "";
    if (!name) return showToast("Informe o nome do repasse ou da sublocação.");
    const duplicate = data.partnerConfigs.find((item) => !same(item.id, id) && item.active !== false && item.kind === kind && normalize(item.name) === normalize(name));
    if (duplicate) return showToast("Já existe um cadastro ativo com este nome e tipo.");

    const payload = {
      id,
      name,
      kind,
      percent: kind === "repass" ? Math.min(Math.max(Number(document.querySelector("#partnerConfigPercent")?.value || 0), 0), 100) : 0,
      monthlyAmount: kind === "sublocation" ? Math.max(Number(document.querySelector("#partnerConfigMonthlyAmount")?.value || 0), 0) : 0,
      dueDay: Math.min(Math.max(Number(document.querySelector("#partnerConfigDueDay")?.value || 10), 1), 31),
      startDate: document.querySelector("#partnerConfigStartDate")?.value || "",
      spaceName: kind === "sublocation" ? (document.querySelector("#partnerConfigSpace")?.value.trim() || "") : "",
      defaultBankAccountId: document.querySelector("#partnerConfigAccount")?.value || "",
      notes: document.querySelector("#partnerConfigNotes")?.value.trim() || "",
      active: existing?.active !== false,
      createdAt: existing?.createdAt || new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    if (existing) Object.assign(existing, payload);
    else data.partnerConfigs.push(payload);
    saveState();
    clearPartnerConfigForm();
    activeRentalTab = `partner:${id}`;
    renderSettingsArea();
    renderMainTabs();
    showToast(`${kind === "repass" ? "Repasse" : "Sublocação"} salvo. A subaba ${name} já está disponível em Locações e repasses.`);
  }

  function fillPartnerConfigForm(config) {
    switchView("settings");
    switchSettingsPane("rentals");
    const values = {
      partnerConfigId: config.id,
      partnerConfigName: config.name,
      partnerConfigKind: config.kind,
      partnerConfigPercent: Number(config.percent || 0),
      partnerConfigMonthlyAmount: Number(config.monthlyAmount || 0),
      partnerConfigDueDay: Number(config.dueDay || 10),
      partnerConfigStartDate: config.startDate || "",
      partnerConfigSpace: config.spaceName || "",
      partnerConfigNotes: config.notes || "",
    };
    Object.entries(values).forEach(([id, value]) => { const el = document.querySelector(`#${id}`); if (el) el.value = value; });
    const account = document.querySelector("#partnerConfigAccount");
    if (account) {
      account.innerHTML = accountOptions(config.defaultBankAccountId || "");
      account.value = config.defaultBankAccountId || "";
    }
    updateConfigFieldVisibility();
    document.querySelector("#partnerConfigForm")?.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  async function handleSettingsClick(event) {
    const editId = event.target.closest("[data-partner-config-edit]")?.dataset.partnerConfigEdit;
    if (editId) {
      const config = rental().partnerConfigs.find((item) => same(item.id, editId));
      if (config) fillPartnerConfigForm(config);
      return;
    }
    const toggleId = event.target.closest("[data-partner-config-toggle]")?.dataset.partnerConfigToggle;
    if (!toggleId) return;
    const config = rental().partnerConfigs.find((item) => same(item.id, toggleId));
    if (!config) return;
    if (config.active !== false) {
      let ok = true;
      try { ok = await smgConfirm(`Arquivar a subaba ${config.name}? Os lançamentos históricos serão mantidos.`); }
      catch { ok = confirm(`Arquivar a subaba ${config.name}?`); }
      if (!ok) return;
      config.active = false;
      if (activeRentalTab === `partner:${config.id}`) activeRentalTab = "psych";
    } else config.active = true;
    saveState();
    renderSettingsArea();
    renderMainTabs();
    showToast(config.active === false ? "Cadastro arquivado; o histórico foi preservado." : "Cadastro reativado e subaba restaurada.");
  }

  function renderSettingsArea() {
    mountSettingsArea();
    moveLegacyConfigForms();
    const account = document.querySelector("#partnerConfigAccount");
    if (account && !document.querySelector("#partnerConfigId")?.value) account.innerHTML = accountOptions(account.value || "");
    if (!document.querySelector("#partnerConfigStartDate")?.value) document.querySelector("#partnerConfigStartDate").value = today();
    updateConfigFieldVisibility();

    const list = document.querySelector("#partnerConfigList");
    if (!list) return;
    const configs = rental().partnerConfigs.slice().sort((a, b) => String(a.name || "").localeCompare(String(b.name || ""), "pt-BR", { sensitivity: "base" }));
    list.innerHTML = configs.length ? configs.map((config) => {
      const typeLabel = config.kind === "sublocation" ? "Sublocação" : "Repasse";
      const rule = config.kind === "sublocation" ? `${brlLocal(config.monthlyAmount || 0)} / mês` : `${Number(config.percent || 0).toLocaleString("pt-BR", { maximumFractionDigits: 2 })}%`;
      return `<div class="partner-config-row ${config.active === false ? "is-archived" : ""}">
        <div><strong>${esc(config.name)}</strong><small>${esc(config.spaceName || config.notes || "")}</small></div>
        <div><span class="partner-kind">${typeLabel}</span></div>
        <div><strong>${esc(rule)}</strong><small>${config.startDate ? `Desde ${formatDateBR(config.startDate)}` : "Sem data de início"}</small></div>
        <div><strong>${esc(accountName(config.defaultBankAccountId || ""))}</strong><small>${config.active === false ? "Arquivado" : "Subaba ativa"}</small></div>
        <div class="partner-actions"><button type="button" class="small secondary" data-partner-config-edit="${attr(config.id)}">Editar</button><button type="button" class="small ${config.active === false ? "secondary" : "danger"}" data-partner-config-toggle="${attr(config.id)}">${config.active === false ? "Reativar" : "Arquivar"}</button></div>
      </div>`;
    }).join("") : `<div class="empty"><strong>Nenhum parceiro adicional cadastrado</strong><span>Cadastre um repasse ou sublocação acima. Psicopedagogia e Clínica já possuem cadastros próprios.</span></div>`;
  }

  function repassRows(config, period = currentPeriod()) {
    return rental().manualRepasses
      .filter((item) => item.period === period && (same(item.partnerConfigId, config.id) || (!item.partnerConfigId && normalize(item.beneficiary) === normalize(config.name))))
      .slice()
      .sort((a, b) => String(a.dueDate || a.createdAt || "").localeCompare(String(b.dueDate || b.createdAt || "")));
  }

  function addRepassExpense(record, config) {
    ensureExpenseCategory();
    state.expenses ||= [];
    const expenseId = record.expenseId || `manual-repass-${record.id}`;
    if (state.expenses.some((item) => same(item.id, expenseId))) return expenseId;
    const payload = {
      id: expenseId,
      description: `Repasse - ${config.name}${record.description ? ` - ${record.description}` : ""}`,
      category: REPASS_CATEGORY,
      amount: Number(record.amount || 0),
      date: record.paidDate || record.dueDate || today(),
      dueDate: record.dueDate || record.paidDate || today(),
      status: "paid",
      paidDate: record.paidDate || today(),
      paidFromAccountId: record.bankAccountId || "",
    };
    let expense;
    try { expense = normalizeExpense(payload); } catch { expense = payload; }
    state.expenses.push(expense);
    if (record.bankAccountId) {
      const account = accountById(record.bankAccountId);
      if (account) account.balance = money(Number(account.balance || 0) - Number(record.amount || 0));
    }
    return expenseId;
  }

  function reverseRepassExpense(record) {
    if (!record.expenseId) return;
    const expense = (state.expenses || []).find((item) => same(item.id, record.expenseId));
    if (expense?.status === "paid" && expense.paidFromAccountId) {
      const account = accountById(expense.paidFromAccountId);
      if (account) account.balance = money(Number(account.balance || 0) + Number(expense.amount || 0));
    }
    state.expenses = (state.expenses || []).filter((item) => !same(item.id, record.expenseId));
    record.expenseId = "";
  }

  function renderRepassPane(config) {
    const rows = repassRows(config);
    const total = money(rows.reduce((sum, row) => sum + Number(row.amount || 0), 0));
    const paid = money(rows.filter((row) => row.status === "paid").reduce((sum, row) => sum + Number(row.amount || 0), 0));
    const pending = money(total - paid);
    const table = rows.length ? rows.map((row) => `<tr>
      <td>${row.dueDate ? formatDateBR(row.dueDate) : "-"}</td><td>${brlLocal(row.baseAmount || 0)}</td><td>${Number(row.percent || 0).toLocaleString("pt-BR", { maximumFractionDigits: 2 })}%</td><td><strong>${brlLocal(row.amount)}</strong></td><td><span class="partner-status ${row.status === "paid" ? "paid" : "open"}">${row.status === "paid" ? "Pago" : "Pendente"}</span></td><td>${row.paidDate ? formatDateBR(row.paidDate) : "-"}</td><td>${esc(accountName(row.bankAccountId || ""))}</td><td>${esc(row.note || "-")}</td><td><div class="row-actions">${row.status === "paid" ? `<button type="button" class="small secondary" data-generic-repass-reverse="${attr(row.id)}">Estornar</button>` : `<button type="button" class="small" data-generic-repass-pay="${attr(row.id)}">Pagar</button>`}<button type="button" class="small danger" data-generic-repass-delete="${attr(row.id)}">Excluir</button></div></td>
    </tr>`).join("") : `<tr><td colspan="9">Nenhum repasse lançado em ${esc(periodName())}.</td></tr>`;

    return `<section class="panel glass-card generic-partner-card">
      <div class="generic-partner-head"><div><span class="rental-kicker">Repasse</span><h2>${esc(config.name)}</h2><p>${esc(config.notes || "Controle mensal do repasse desta parceria.")}</p></div><span class="rental-badge">${Number(config.percent || 0).toLocaleString("pt-BR", { maximumFractionDigits: 2 })}% padrão</span></div>
      <div class="partner-summary"><div class="partner-stat"><span>Lançamentos</span><strong>${rows.length}</strong></div><div class="partner-stat"><span>Total do período</span><strong>${brlLocal(total)}</strong></div><div class="partner-stat good"><span>Pago</span><strong>${brlLocal(paid)}</strong></div><div class="partner-stat ${pending > 0 ? "warn" : "good"}"><span>Pendente</span><strong>${brlLocal(pending)}</strong></div></div>
      <div class="rental-subsection"><div class="panel-head compact-head"><div><h3>Lançar repasse de ${esc(periodName())}</h3><span>O percentual parte do cadastro em Configurações e pode ser ajustado neste lançamento.</span></div></div>
      <form class="partner-entry-form" data-generic-repass-form="${attr(config.id)}">
        <label>Valor-base<input name="baseAmount" type="number" min="0.01" step="0.01" required /></label>
        <label>Percentual (%)<input name="percent" type="number" min="0" max="100" step="0.01" value="${Number(config.percent || 0)}" required /></label>
        <label>Vencimento<input name="dueDate" type="date" value="${attr(today())}" /></label>
        <label>Status<select name="status"><option value="open">Pendente</option><option value="paid">Já pago</option></select></label>
        <label>Conta de saída<select name="bankAccountId">${accountOptions(config.defaultBankAccountId || "")}</select></label>
        <label>Data do pagamento<input name="paidDate" type="date" value="${attr(today())}" /></label>
        <label class="span-2">Descrição / referência<input name="description" placeholder="Ex.: aulas do mês, comissão..." /></label>
        <label class="span-3">Observação<input name="note" placeholder="Informações adicionais" /></label>
        <div class="partner-calculated"><span>Valor do repasse</span><strong data-repass-calculated="${attr(config.id)}">R$ 0,00</strong></div>
        <div><button type="submit">Registrar repasse</button></div>
      </form></div>
      <div class="table-wrap"><table><thead><tr><th>Vencimento</th><th>Base</th><th>%</th><th>Repasse</th><th>Status</th><th>Pagamento</th><th>Conta</th><th>Observação</th><th>Ações</th></tr></thead><tbody>${table}</tbody></table></div>
    </section>`;
  }

  function nextPeriod(period) {
    const [year, month] = String(period).split("-").map(Number);
    const date = new Date(year, month, 1);
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
  }

  function rentalExpected(config, period = currentPeriod()) {
    if (!(Number(config.monthlyAmount || 0) > 0)) return 0;
    if (config.startDate && String(config.startDate).slice(0, 7) > period) return 0;
    return Number(config.monthlyAmount || 0);
  }

  function rentalReceipts(config, period = currentPeriod()) {
    return rental().genericRentalReceipts.filter((item) => same(item.partnerConfigId, config.id) && item.period === period);
  }

  function rentalPeriodSummary(config, period = currentPeriod()) {
    const expected = money(rentalExpected(config, period));
    const received = money(rentalReceipts(config, period).reduce((sum, item) => sum + Number(item.amount || 0), 0));
    return { expected, received, pending: money(Math.max(expected - received, 0)) };
  }

  function outstandingRentalPeriods(config, endPeriod = currentPeriod()) {
    if (!(Number(config.monthlyAmount || 0) > 0)) return [];
    let cursor = config.startDate ? String(config.startDate).slice(0, 7) : endPeriod;
    if (!/^\d{4}-\d{2}$/.test(cursor) || cursor > endPeriod) return [];
    const rows = [];
    let guard = 0;
    while (cursor <= endPeriod && guard < 120) {
      const summary = rentalPeriodSummary(config, cursor);
      if (summary.pending > 0.009) rows.push({ period: cursor, ...summary });
      cursor = nextPeriod(cursor);
      guard += 1;
    }
    return rows;
  }

  function addRentalIncome(record, config) {
    state.otherIncomes ||= [];
    const incomeId = record.incomeId || `generic-rental-${record.id}`;
    if (state.otherIncomes.some((item) => same(item.id, incomeId))) return incomeId;
    const payload = {
      id: incomeId,
      description: `Sublocação ${config.spaceName || config.name} - ${config.name} - ${periodName(record.period)}`,
      category: `Sublocação - ${config.name}`,
      amount: Number(record.amount || 0),
      date: record.date || today(),
      bankAccountId: record.bankAccountId || "",
      createdAt: today(),
    };
    let income;
    try { income = normalizeOtherIncome(payload); } catch { income = payload; }
    if (record.bankAccountId) {
      const account = accountById(record.bankAccountId);
      if (account) {
        account.balance = money(Number(account.balance || 0) + Number(record.amount || 0));
        income.creditedAccountId = account.id;
        income.creditedAmount = Number(record.amount || 0);
      }
    }
    state.otherIncomes.push(income);
    return incomeId;
  }

  function reverseRentalIncome(record) {
    if (!record.incomeId) return;
    const income = (state.otherIncomes || []).find((item) => same(item.id, record.incomeId));
    if (income?.creditedAccountId && Number(income.creditedAmount || 0)) {
      const account = accountById(income.creditedAccountId);
      if (account) account.balance = money(Number(account.balance || 0) - Number(income.creditedAmount || 0));
    }
    state.otherIncomes = (state.otherIncomes || []).filter((item) => !same(item.id, record.incomeId));
    record.incomeId = "";
  }

  function renderSublocationPane(config) {
    const summary = rentalPeriodSummary(config);
    const outstanding = outstandingRentalPeriods(config);
    const outstandingTotal = money(outstanding.reduce((sum, item) => sum + item.pending, 0));
    const receipts = rentalReceipts(config).slice().sort((a, b) => String(b.date || "").localeCompare(String(a.date || "")));
    const pendingList = outstanding.length ? outstanding.map((row) => `<div class="partner-pending-item"><div><strong>${esc(periodName(row.period))}</strong><small> Previsto ${brlLocal(row.expected)} · recebido ${brlLocal(row.received)}</small></div><strong>${brlLocal(row.pending)}</strong></div>`).join("") : `<div class="empty"><strong>Nenhuma pendência</strong><span>Todos os meses até ${esc(periodName())} estão quitados.</span></div>`;
    const history = receipts.length ? receipts.map((item) => `<tr><td>${formatDateBR(item.date)}</td><td>${esc(periodName(item.period))}</td><td><strong>${brlLocal(item.amount)}</strong></td><td>${esc(accountName(item.bankAccountId || ""))}</td><td>${esc(item.note || "-")}</td><td><button type="button" class="small danger" data-generic-rental-delete="${attr(item.id)}">Excluir</button></td></tr>`).join("") : `<tr><td colspan="6">Nenhum recebimento registrado em ${esc(periodName())}.</td></tr>`;

    return `<section class="panel glass-card generic-partner-card">
      <div class="generic-partner-head"><div><span class="rental-kicker">Sublocação</span><h2>${esc(config.name)}</h2><p>${esc(config.spaceName || config.notes || "Controle mensal da sublocação.")}</p></div><span class="rental-badge clinic-badge">${brlLocal(config.monthlyAmount || 0)} / mês</span></div>
      <div class="partner-summary"><div class="partner-stat"><span>Previsto no mês</span><strong>${brlLocal(summary.expected)}</strong></div><div class="partner-stat good"><span>Recebido</span><strong>${brlLocal(summary.received)}</strong></div><div class="partner-stat ${summary.pending > 0 ? "warn" : "good"}"><span>Saldo do mês</span><strong>${brlLocal(summary.pending)}</strong></div><div class="partner-stat ${outstandingTotal > 0 ? "warn" : "good"}"><span>Total pendente</span><strong>${brlLocal(outstandingTotal)}</strong></div></div>
      <div class="rental-subsection"><div class="panel-head compact-head"><div><h3>Pendências</h3><span>Competências ainda não quitadas.</span></div></div><div class="partner-pending-list">${pendingList}</div></div>
      <div class="rental-subsection"><div class="panel-head compact-head"><div><h3>Registrar recebimento</h3><span>O valor será lançado em Outras entradas e creditado na conta escolhida.</span></div></div>
        <form class="partner-entry-form" data-generic-rental-form="${attr(config.id)}">
          <label>Competência<input name="period" type="month" value="${attr(currentPeriod())}" required /></label>
          <label>Valor recebido<input name="amount" type="number" min="0.01" step="0.01" value="${summary.pending > 0 ? summary.pending.toFixed(2) : ""}" required /></label>
          <label>Data do recebimento<input name="date" type="date" value="${attr(today())}" required /></label>
          <label>Conta de entrada<select name="bankAccountId">${accountOptions(config.defaultBankAccountId || "")}</select></label>
          <label class="span-3">Observação<input name="note" placeholder="Ex.: aluguel integral, parcela..." /></label><div><button type="submit">Registrar recebimento</button></div>
        </form>
      </div>
      <div class="table-wrap"><table><thead><tr><th>Data</th><th>Competência</th><th>Valor</th><th>Conta</th><th>Observação</th><th>Ações</th></tr></thead><tbody>${history}</tbody></table></div>
    </section>`;
  }

  function renderMainTabs() {
    const tabs = document.querySelector("#rentalMainTabs");
    const panes = document.querySelector("#rentalMainPanes");
    if (!tabs || !panes) return;

    panes.querySelectorAll('[data-rental-main-pane^="partner:"]').forEach((pane) => pane.remove());
    const configs = activeConfigs();
    const validIds = new Set(["psych", "clinic", ...configs.map((item) => `partner:${item.id}`)]);
    if (!validIds.has(activeRentalTab)) activeRentalTab = "psych";

    const repassConfigs = configs.filter((item) => item.kind === "repass");
    const rentalConfigs = configs.filter((item) => item.kind === "sublocation");
    const tabData = [
      { id: "psych", label: "Psicopedagogia", type: "Repasse" },
      ...repassConfigs.map((item) => ({ id: `partner:${item.id}`, label: item.name, type: "Repasse" })),
      { id: "clinic", label: "Clínica", type: "Sublocação" },
      ...rentalConfigs.map((item) => ({ id: `partner:${item.id}`, label: item.name, type: "Sublocação" })),
    ];
    tabs.innerHTML = tabData.map((item) => `<button type="button" class="rental-main-tab ${activeRentalTab === item.id ? "is-active" : ""}" data-rental-main-tab="${attr(item.id)}">${esc(item.label)}<small>${esc(item.type)}</small></button>`).join("");

    configs.forEach((config) => {
      const pane = document.createElement("div");
      pane.className = "rental-main-pane";
      pane.dataset.rentalMainPane = `partner:${config.id}`;
      pane.innerHTML = config.kind === "sublocation" ? renderSublocationPane(config) : renderRepassPane(config);
      panes.appendChild(pane);
    });

    panes.querySelectorAll(".rental-main-pane").forEach((pane) => pane.classList.toggle("is-active", pane.dataset.rentalMainPane === activeRentalTab));
    bindDynamicCalculators();
  }

  function bindDynamicCalculators() {
    document.querySelectorAll("[data-generic-repass-form]").forEach((form) => {
      const configId = form.dataset.genericRepassForm;
      const recalc = () => {
        const base = Number(form.elements.baseAmount?.value || 0);
        const pct = Number(form.elements.percent?.value || 0);
        const out = document.querySelector(`[data-repass-calculated="${CSS.escape(configId)}"]`);
        if (out) out.textContent = brlLocal(money(base * pct / 100));
      };
      form.elements.baseAmount?.addEventListener("input", recalc);
      form.elements.percent?.addEventListener("input", recalc);
      recalc();
    });
  }

  async function handleMainSubmit(event) {
    const repassForm = event.target.closest("[data-generic-repass-form]");
    if (repassForm) {
      event.preventDefault();
      const config = rental().partnerConfigs.find((item) => same(item.id, repassForm.dataset.genericRepassForm));
      if (!config) return;
      const baseAmount = Number(repassForm.elements.baseAmount?.value || 0);
      const percent = Math.min(Math.max(Number(repassForm.elements.percent?.value || 0), 0), 100);
      const amount = money(baseAmount * percent / 100);
      const status = repassForm.elements.status?.value === "paid" ? "paid" : "open";
      const bankAccountId = status === "paid" ? (repassForm.elements.bankAccountId?.value || config.defaultBankAccountId || "") : "";
      if (!(baseAmount > 0) || !(percent > 0) || !(amount > 0)) return showToast("Informe valor-base e percentual válidos.");
      if (status === "paid" && !accountById(bankAccountId)) return showToast("Escolha uma conta de saída para registrar como pago.");
      const record = {
        id: makeId(),
        partnerConfigId: config.id,
        period: currentPeriod(),
        beneficiary: config.name,
        description: repassForm.elements.description?.value.trim() || "",
        baseAmount: money(baseAmount),
        percent: money(percent),
        amount,
        dueDate: repassForm.elements.dueDate?.value || "",
        status,
        paidDate: status === "paid" ? (repassForm.elements.paidDate?.value || today()) : "",
        bankAccountId,
        note: repassForm.elements.note?.value.trim() || "",
        expenseId: "",
        createdAt: new Date().toISOString(),
      };
      if (record.status === "paid") record.expenseId = addRepassExpense(record, config);
      rental().manualRepasses.push(record);
      saveState();
      renderMainTabs();
      showToast(record.status === "paid" ? "Repasse registrado e lançado nas despesas." : "Repasse registrado como pendente.");
      return;
    }

    const rentForm = event.target.closest("[data-generic-rental-form]");
    if (!rentForm) return;
    event.preventDefault();
    const config = rental().partnerConfigs.find((item) => same(item.id, rentForm.dataset.genericRentalForm));
    if (!config) return;
    const amount = Number(rentForm.elements.amount?.value || 0);
    const bankAccountId = rentForm.elements.bankAccountId?.value || config.defaultBankAccountId || "";
    if (!(amount > 0)) return showToast("Informe o valor recebido.");
    if (!accountById(bankAccountId)) return showToast("Escolha a conta que recebeu a sublocação.");
    const record = {
      id: makeId(),
      partnerConfigId: config.id,
      period: rentForm.elements.period?.value || currentPeriod(),
      amount: money(amount),
      date: rentForm.elements.date?.value || today(),
      bankAccountId,
      note: rentForm.elements.note?.value.trim() || "",
      incomeId: "",
      createdAt: new Date().toISOString(),
    };
    record.incomeId = addRentalIncome(record, config);
    rental().genericRentalReceipts.push(record);
    saveState();
    renderMainTabs();
    showToast("Recebimento da sublocação lançado no financeiro.");
  }

  async function handleMainClick(event) {
    const payId = event.target.closest("[data-generic-repass-pay]")?.dataset.genericRepassPay;
    if (payId) {
      const record = rental().manualRepasses.find((item) => same(item.id, payId));
      const config = rental().partnerConfigs.find((item) => same(item.id, record?.partnerConfigId));
      if (!record || !config || record.status === "paid") return;
      const accountId = config.defaultBankAccountId || "";
      if (!accountById(accountId)) return showToast(`Defina uma conta bancária padrão para ${config.name} em Configurações > Locações e repasses.`);
      record.status = "paid";
      record.paidDate = today();
      record.bankAccountId = accountId;
      record.expenseId = addRepassExpense(record, config);
      saveState();
      renderMainTabs();
      try { renderAll(); } catch {}
      showToast("Repasse pago e debitado da conta padrão.");
      return;
    }

    const reverseId = event.target.closest("[data-generic-repass-reverse]")?.dataset.genericRepassReverse;
    if (reverseId) {
      const record = rental().manualRepasses.find((item) => same(item.id, reverseId));
      if (!record) return;
      reverseRepassExpense(record);
      record.status = "open";
      record.paidDate = "";
      record.bankAccountId = "";
      saveState();
      renderMainTabs();
      try { renderAll(); } catch {}
      showToast("Pagamento do repasse estornado.");
      return;
    }

    const deleteRepassId = event.target.closest("[data-generic-repass-delete]")?.dataset.genericRepassDelete;
    if (deleteRepassId) {
      const record = rental().manualRepasses.find((item) => same(item.id, deleteRepassId));
      if (!record) return;
      let ok = true;
      try { ok = await smgConfirm(`Excluir este repasse de ${record.beneficiary || "parceiro"}?`); } catch { ok = confirm("Excluir este repasse?"); }
      if (!ok) return;
      if (record.status === "paid") reverseRepassExpense(record);
      rental().manualRepasses = rental().manualRepasses.filter((item) => !same(item.id, record.id));
      saveState();
      renderMainTabs();
      try { renderAll(); } catch {}
      showToast("Repasse excluído.");
      return;
    }

    const deleteRentalId = event.target.closest("[data-generic-rental-delete]")?.dataset.genericRentalDelete;
    if (!deleteRentalId) return;
    const record = rental().genericRentalReceipts.find((item) => same(item.id, deleteRentalId));
    if (!record) return;
    let ok = true;
    try { ok = await smgConfirm("Excluir este recebimento da sublocação? O crédito será estornado da conta."); } catch { ok = confirm("Excluir este recebimento?"); }
    if (!ok) return;
    reverseRentalIncome(record);
    rental().genericRentalReceipts = rental().genericRentalReceipts.filter((item) => !same(item.id, record.id));
    saveState();
    renderMainTabs();
    try { renderAll(); } catch {}
    showToast("Recebimento excluído e crédito estornado.");
  }

  function installMainDelegation() {
    const shell = document.querySelector("#rentalsHubShell");
    if (!shell || shell.dataset.eventsBound === "1") return;
    shell.dataset.eventsBound = "1";
    shell.addEventListener("submit", handleMainSubmit);
    shell.addEventListener("click", handleMainClick);
  }

  function wrapRenderAll() {
    if (wrappedRenderAll) return;
    wrappedRenderAll = true;
    const original = renderAll;
    renderAll = function renderAllWithRentalHub(...args) {
      const result = original(...args);
      queueRender();
      return result;
    };
    try { window.renderAll = renderAll; } catch {}
  }

  function queueRender() {
    if (renderQueued) return;
    renderQueued = true;
    queueMicrotask(() => {
      renderQueued = false;
      try {
        const changed = seedPartnerConfigsFromLegacy();
        moveLegacyPaneToMain();
        mountSettingsArea();
        renderSettingsArea();
        renderMainTabs();
        installMainDelegation();
        if (changed) saveState();
      } catch (error) {
        console.warn("Não foi possível atualizar a central de locações e repasses.", error);
      }
    });
  }

  async function boot() {
    try {
      ensureStyles();
      installSettingsRouting();
      mountMainView();
      await ensureLegacyRentalModule();
      seedPartnerConfigsFromLegacy();
      moveLegacyPaneToMain();
      mountSettingsArea();
      clearPartnerConfigForm();
      renderSettingsArea();
      renderMainTabs();
      installMainDelegation();
      wrapRenderAll();
      saveState();

      document.querySelector("#globalMonth")?.addEventListener("change", queueRender);
      document.querySelector("#globalYear")?.addEventListener("change", queueRender);
      window.addEventListener("focus", queueRender);
    } catch (error) {
      console.error("Falha ao iniciar Locações e repasses no menu principal.", error);
    }
  }

  boot();
})();